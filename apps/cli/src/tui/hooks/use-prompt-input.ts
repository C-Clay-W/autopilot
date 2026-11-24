/** prompt 输入状态与 handleInput：字符串/光标/历史维护与按键分发。 */

import { useEffect, useState } from "react";
import type { Key } from "ink";
import { parseSlashAction } from "../../parser.js";
import type { CliAction, CliSlashCommand } from "../../types.js";
import {
  canNavigateTuiInputHistory,
  createTuiInputHistoryState,
  navigateTuiInputHistory,
  recordTuiInputHistory,
  updateTuiInputHistoryDraft,
  type TuiInputHistoryState,
} from "../../tui-input-history.js";
import { createTuiApprovalOptions } from "../approval.js";
import { isActiveTuiStatus } from "../format.js";
import { normalizeTuiInputLineEndings, splitTuiInputGraphemes } from "../input/graphemes.js";
import { applyFileMentionSuggestion, extractFileMentionToken } from "../input/file-mention.js";
import {
  hasTuiUnescapedContinuation,
  isTuiMultilineEnter,
  isTuiTerminalFocusSequence,
  isTuiViewportScrollKey,
  parseTuiControlAction,
  resolveTuiBracketedPasteBoundary,
  resolveTuiDeleteDirection,
} from "../input/keys.js";
import { createTuiPromptLayout, resolveTuiPromptCursorIndex } from "../input/prompt-layout.js";
import type { CliTuiStore } from "../types.js";
import { recordTuiPerformanceDiagnostic } from "../performance-diagnostics.js";
import { readMacClipboard, readWindowsClipboard, type CliDraftImage } from "../input/clipboard-image.js";

/** usePromptInput 的运行依赖；派生值（slash 建议、视口按键）由 app.tsx 通过 ref 注入。 */
export interface UsePromptInputInput {
  parseInput?: import("../../controller.js").CliController["parseInput"];
  store: CliTuiStore;
  columns: number;
  draftRef?: { current?: ReturnType<typeof createPromptDraft> };
  onAttachmentsChange?(names: string[]): void;
  busy: { current: boolean };
  keepOpenAfterCancel: { current: boolean };
  lastSubmittedPromptRef: { current: string | undefined };
  rawInputSequenceRef: { current: string };
  dispatchAction: (action: CliAction, prompt?: string, preserveSkillPickerQuery?: boolean) => Promise<void>;
  onEof: () => void;
  onRequestInterrupt: () => void;
  onRequestCancel: () => void;
  isPickerActive: boolean;
  dispatchPickerInput: (value: string, key: Key, controlAction: ReturnType<typeof parseTuiControlAction>) => void;
  approvalPickerIndexRef: { current: number };
  updateApprovalPickerIndex: (index: number) => void;
  slashCommandIndexRef: { current: number };
  updateSlashCommandIndex: (index: number) => void;
  fileMentionIndexRef: { current: number };
  updateFileMentionIndex: (index: number) => void;
  setFileMentionDismissedInput: (input: string | undefined) => void;
  derivedRef: {
    current: {
      slashCommandSuggestions: CliSlashCommand[];
      fileMentionSuggestions: string[];
      handleTuiViewportKey: (key: Key, value?: string) => boolean;
      handleApprovalKey?: (value: string, key: Key) => boolean;
    };
  };
}

/** 保存已打开会话的输入状态；视图卸载时不保留React子树或正文派生计算。 */
function createPromptDraft() {
  return {
    inputRef: { current: "" }, cursorIndexRef: { current: 0 },
    verticalColumnRef: { current: undefined as number | undefined }, bracketedPasteRef: { current: false },
    bracketedPasteHadContentRef: { current: false }, pasteCarriageReturnRef: { current: false },
    inputHistoryRef: { current: createTuiInputHistoryState() as TuiInputHistoryState },
    imageDraftsRef: { current: new Map<number, CliDraftImage>() }, historyImagesRef: { current: [] as Array<Map<number, CliDraftImage>> },
    historyDraftImagesRef: { current: new Map<number, CliDraftImage>() }, lastSubmittedImagesRef: { current: new Map<number, CliDraftImage>() },
    pasteQueueRef: { current: Promise.resolve() }, pastingCountRef: { current: 0 },
  };
}

/** Session宿主持有的草稿引用，不包含React生命周期。 */
export type CliTuiDraftRef = NonNullable<UsePromptInputInput["draftRef"]>;

/** 管理 prompt 输入状态、历史与按键分发，并暴露 handleInput 供 Ink 的 useInput 使用。 */
export function usePromptInput(input: UsePromptInputInput): {
  input: string;
  cursorIndex: number;
  handleInput: (value: string, key: Key) => void;
} {
  const {
    store,
    columns,
    busy,
    keepOpenAfterCancel,
    lastSubmittedPromptRef,
    rawInputSequenceRef,
    dispatchAction,
    onEof,
    onRequestInterrupt,
    onRequestCancel,
    isPickerActive,
    dispatchPickerInput,
    approvalPickerIndexRef,
    updateApprovalPickerIndex,
    slashCommandIndexRef,
    updateSlashCommandIndex,
    fileMentionIndexRef,
    updateFileMentionIndex,
    setFileMentionDismissedInput,
    derivedRef,
  } = input;
  const [draft] = useState(function initialDraft() { return input.draftRef?.current ?? createPromptDraft(); });
  if (input.draftRef) input.draftRef.current = draft;
  const { inputRef, cursorIndexRef, verticalColumnRef, bracketedPasteRef, bracketedPasteHadContentRef, pasteCarriageReturnRef, inputHistoryRef, imageDraftsRef, historyImagesRef, historyDraftImagesRef, lastSubmittedImagesRef, pasteQueueRef, pastingCountRef } = draft;
  const [inputValue, setInput] = useState(inputRef.current);
  const [cursorIndex, setCursorIndex] = useState(cursorIndexRef.current);

  /** 定位当前草稿中有附件身份的占位符，以 grapheme 位置保护原子编辑。 */
  function imageSpans(value: string): Array<{ id: number; start: number; end: number }> {
    const spans: Array<{ id: number; start: number; end: number }> = [];
    for (const match of value.matchAll(/\[Image (\d+)\]/g)) {
      const id = Number(match[1]);
      if (!imageDraftsRef.current.has(id)) continue;
      const start = splitTuiInputGraphemes(value.slice(0, match.index)).length;
      spans.push({ id, start, end: start + match[0].length });
    }
    return spans;
  }

  /** 把异步读取的剪贴板图片及文本按次序插入当前光标。 */
  function pasteClipboard(): void {
    pastingCountRef.current++;
    const pending = (process.platform === "darwin" ? readMacClipboard() : readWindowsClipboard()).then(function read(value) { return { value }; }, function failed(error: unknown) { return { error }; });
    pasteQueueRef.current = pasteQueueRef.current.then(async function insertPaste() {
      try {
        const outcome = await pending;
        if ("error" in outcome) throw outcome.error;
        const result = outcome.value;
        const currentCount = imageSpans(inputRef.current).length;
        if (currentCount + result.images.length > 10) throw new Error("一次最多发送 10 张图片");
        const currentBytes = imageSpans(inputRef.current).reduce(function total(sum, span) { return sum + (imageDraftsRef.current.get(span.id)?.bytes.byteLength ?? 0); }, 0);
        if (currentBytes + result.images.reduce(function total(sum, image) { return sum + image.bytes.byteLength; }, 0) > 20 * 1024 * 1024) throw new Error("图片总大小超过 20 MiB");
        if (result.images.some(function isGif(image) { return image.gifFirstFrame; })) store.addNotice("GIF 图片仅发送静态首帧");
        let inserted = result.text ?? "";
        for (const image of result.images) {
          const id = Math.max(0, ...imageDraftsRef.current.keys()) + 1;
          imageDraftsRef.current.set(id, image);
          inserted += `${inserted ? " " : ""}[Image ${id}]`;
        }
        if (!inserted) return;
        const chars = splitTuiInputGraphemes(inputRef.current);
        const inside = imageSpans(inputRef.current).find(function contains(span) { return cursorIndexRef.current > span.start && cursorIndexRef.current < span.end; });
        const cursor = inside?.end ?? cursorIndexRef.current;
        const addition = splitTuiInputGraphemes(inserted);
        chars.splice(cursor, 0, ...addition);
        const next = chars.join("");
        inputHistoryRef.current = updateTuiInputHistoryDraft(inputHistoryRef.current, next);
        updateInput(next, cursor + addition.length);
      } catch (error) {
        const safeMessages = ["一次最多发送 10 张图片", "一次最多粘贴 10 张图片", "剪贴板包含不支持的文件", "图片超过 20 MiB 输入上限", "图片总大小超过 20 MiB"];
        store.addNotice(error instanceof Error && safeMessages.includes(error.message) ? error.message : "剪贴板图片读取或处理失败");
      }
      finally { pastingCountRef.current--; }
    });
  }

  /** 同步维护字符串与光标位置，避免只移动光标时 React 跳过重绘；输入变化即解除 @ 菜单的 Esc 关闭标记。 */
  function updateInput(nextInput: string, nextCursorIndex: number): void {
    verticalColumnRef.current = undefined;
    for (const id of imageDraftsRef.current.keys()) if (!nextInput.includes(`[Image ${id}]`)) imageDraftsRef.current.delete(id);
    const inside = imageSpans(nextInput).find(function contains(span) { return nextCursorIndex > span.start && nextCursorIndex < span.end; });
    if (inside) nextCursorIndex = inside.end;
    inputRef.current = nextInput;
    cursorIndexRef.current = nextCursorIndex;
    setFileMentionDismissedInput(undefined);
    setInput(nextInput);
    setCursorIndex(nextCursorIndex);
  }

  /** 只移动逻辑光标，不清除上下键要保持的目标视觉列。 */
  function updateCursorIndex(nextCursorIndex: number): void {
    const inside = imageSpans(inputRef.current).find(function contains(span) { return nextCursorIndex > span.start && nextCursorIndex < span.end; });
    if (inside) nextCursorIndex = inside.end;
    cursorIndexRef.current = nextCursorIndex;
    setCursorIndex(nextCursorIndex);
  }

  /** 以当前 slash 菜单选项补全命令；带必填参数的命令保留一个输入空格。 */
  function completeSlashCommand(command: CliSlashCommand): void {
    const completion = command.usage.includes("<") ? `${command.name} ` : command.name;
    updateInput(completion, splitTuiInputGraphemes(completion).length);
  }

  /** 按 Claude Code 的 Esc 恢复边界把最后一次发送的 prompt 放回本地输入框。 */
  function restoreLastSubmittedPrompt(): void {
    const current = store.getSnapshot();
    const prompt = lastSubmittedPromptRef.current;
    if (!prompt || inputRef.current !== "" || current.pendingInputs.length > 0) return;
    imageDraftsRef.current = new Map(lastSubmittedImagesRef.current);
    updateInput(prompt, splitTuiInputGraphemes(prompt).length);
  }

  /** 分发终端按键并保持图片占位符与草稿身份一致。 */
  function handleInput(value: string, key: Key): void {
    recordTuiPerformanceDiagnostic("input_key_arrived", value && !key.ctrl && !key.meta ? "text" : "control");
    if (!bracketedPasteRef.current && (key.ctrl && (value.toLowerCase() === "c" || value === "\u0003") || /^(?:\u001b)?\[99;6u$/.test(value)) && derivedRef.current.handleTuiViewportKey(key, value)) return;
    const controlAction = parseTuiControlAction(value, key);
    if (controlAction === "eof") {
      onEof();
      return;
    }
    const current = store.getSnapshot();
    if (controlAction === "interrupt") {
      if (isActiveTuiStatus(current.status)) keepOpenAfterCancel.current = true;
      onRequestInterrupt();
      return;
    }
    if (isTuiTerminalFocusSequence(value)) return;
    const pasteBoundary = resolveTuiBracketedPasteBoundary(value);
    if (pasteBoundary === "start") {
      bracketedPasteRef.current = true;
      bracketedPasteHadContentRef.current = false;
      pasteCarriageReturnRef.current = false;
      return;
    }
    if (pasteBoundary === "end") {
      bracketedPasteRef.current = false;
      pasteCarriageReturnRef.current = false;
      if (!bracketedPasteHadContentRef.current && (process.platform === "win32" || process.platform === "darwin")) pasteClipboard();
      return;
    }
    if (bracketedPasteRef.current && (value || key.return)) bracketedPasteHadContentRef.current = true;
    if (isPickerActive) {
      dispatchPickerInput(value, key, controlAction);
      return;
    }
    if (current.status !== "waiting_approval" && !bracketedPasteRef.current && (process.platform === "win32" || process.platform === "darwin") && ((key.ctrl && value.toLowerCase() === "v") || (key.meta && value.toLowerCase() === "v") || value === "\u0016")) {
      pasteClipboard();
      return;
    }
    // 审批详情是当前顶层交互，翻页/关闭不穿透到历史滚动或 Turn 取消。
    if (current.status === "waiting_approval" && current.pendingApproval && derivedRef.current.handleApprovalKey?.(value, key)) return;
    if (controlAction === "cancel") {
      // D3：@ 菜单激活时 Esc 仅关闭菜单，prompt 保留；再次 Esc 时菜单已关，走正常取消路径。
      if (derivedRef.current.fileMentionSuggestions.length > 0) {
        setFileMentionDismissedInput(inputRef.current);
        return;
      }
      if (derivedRef.current.slashCommandSuggestions.length > 0) {
        updateInput("", 0);
        return;
      }
      if (isActiveTuiStatus(current.status)) {
        keepOpenAfterCancel.current = true;
        restoreLastSubmittedPrompt();
      }
      onRequestCancel();
      return;
    }
    if (derivedRef.current.slashCommandSuggestions.length > 0) {
      const slashCommandSuggestions = derivedRef.current.slashCommandSuggestions;
      const commandCount = slashCommandSuggestions.length;
      const selectedIndex = Math.max(0, Math.min(slashCommandIndexRef.current, commandCount - 1));
      const selectedCommand = slashCommandSuggestions[selectedIndex];
      if (selectedCommand && (key.upArrow || key.downArrow)) {
        const step = key.upArrow ? -1 : 1;
        updateSlashCommandIndex((selectedIndex + step + commandCount) % commandCount);
        return;
      }
      if (selectedCommand && key.tab) {
        completeSlashCommand(selectedCommand);
        return;
      }
      if (selectedCommand && key.return && inputRef.current.trim() !== selectedCommand.name) {
        completeSlashCommand(selectedCommand);
        return;
      }
      if (selectedCommand && key.return && selectedCommand.usage.includes("<")) {
        completeSlashCommand(selectedCommand);
        return;
      }
      if (isTuiViewportScrollKey(key)) return;
    }
    // @ 菜单激活时的键位分支（置于 slash 之后、审批之前）；↑/↓ 移动优先于历史导航，Tab/Enter 插入选中候选。
    if (derivedRef.current.fileMentionSuggestions.length > 0) {
      const fileMentionSuggestions = derivedRef.current.fileMentionSuggestions;
      if (key.upArrow || key.downArrow) {
        const nextIndex = key.upArrow
          ? Math.max(0, fileMentionIndexRef.current - 1)
          : Math.min(fileMentionSuggestions.length - 1, fileMentionIndexRef.current + 1);
        updateFileMentionIndex(nextIndex);
        return;
      }
      if (key.tab || key.return) {
        const token = extractFileMentionToken(inputRef.current, cursorIndexRef.current);
        const selected = fileMentionSuggestions[Math.max(0, Math.min(fileMentionIndexRef.current, fileMentionSuggestions.length - 1))];
        if (token && selected) {
          const applied = applyFileMentionSuggestion(inputRef.current, token, selected);
          updateInput(applied.input, applied.cursor);
        }
        return;
      }
      if (isTuiViewportScrollKey(key)) return;
    }
    if (current.status === "waiting_approval" && current.pendingApproval && !busy.current && !bracketedPasteRef.current) {
      const approvalOptions = createTuiApprovalOptions(current.pendingApproval);
      if (key.upArrow) {
        updateApprovalPickerIndex(Math.max(0, approvalPickerIndexRef.current - 1));
        return;
      }
      if (key.downArrow) {
        updateApprovalPickerIndex(Math.min(approvalOptions.length - 1, approvalPickerIndexRef.current + 1));
        return;
      }
      if (key.return) {
        const selected = approvalOptions[approvalPickerIndexRef.current];
        if (selected) void dispatchAction({ type: "approve", decision: selected.decision });
        return;
      }
      return;
    }
    if (derivedRef.current.handleTuiViewportKey(key)) return;
    if (current.compacting || busy.current && !isActiveTuiStatus(current.status) && !input.parseInput) return;
    const deleteDirection = resolveTuiDeleteDirection(value, key, rawInputSequenceRef.current);
    if (deleteDirection) {
      const characters = splitTuiInputGraphemes(inputRef.current);
      const cursor = cursorIndexRef.current;
      const removeIndex = deleteDirection === "backspace" ? cursor - 1 : cursor;
      if (removeIndex < 0 || removeIndex >= characters.length) return;
      const image = imageSpans(inputRef.current).find(function contains(span) { return removeIndex >= span.start && removeIndex < span.end; });
      if (image) {
        characters.splice(image.start, image.end - image.start);
        imageDraftsRef.current.delete(image.id);
        const next = characters.join("");
        inputHistoryRef.current = updateTuiInputHistoryDraft(inputHistoryRef.current, next);
        updateInput(next, image.start);
        return;
      }
      characters.splice(removeIndex, 1);
      const nextInput = characters.join("");
      inputHistoryRef.current = updateTuiInputHistoryDraft(inputHistoryRef.current, nextInput);
      updateInput(nextInput, deleteDirection === "backspace" ? cursor - 1 : cursor);
      return;
    }
    if (key.leftArrow) {
      const image = imageSpans(inputRef.current).find(function atEnd(span) { return cursorIndexRef.current > span.start && cursorIndexRef.current <= span.end; });
      updateInput(inputRef.current, image?.start ?? Math.max(0, cursorIndexRef.current - 1));
      return;
    }
    if (key.rightArrow) {
      const image = imageSpans(inputRef.current).find(function atStart(span) { return cursorIndexRef.current >= span.start && cursorIndexRef.current < span.end; });
      updateInput(inputRef.current, image?.end ?? Math.min(splitTuiInputGraphemes(inputRef.current).length, cursorIndexRef.current + 1));
      return;
    }
    if (key.upArrow || key.downArrow) {
      const layout = createTuiPromptLayout(inputRef.current, cursorIndexRef.current, columns);
      const direction = key.upArrow ? -1 : 1;
      const targetLine = layout.cursorLine + direction;
      if (targetLine >= 0 && targetLine < layout.lines.length) {
        const targetColumn = verticalColumnRef.current ?? layout.cursorColumn;
        const nextCursorIndex = resolveTuiPromptCursorIndex(inputRef.current, layout, targetLine, targetColumn);
        verticalColumnRef.current = targetColumn;
        updateCursorIndex(nextCursorIndex);
        return;
      }
      const historyDirection = key.upArrow ? "up" : "down";
      const canNavigateHistory = canNavigateTuiInputHistory(historyDirection, layout.cursorLine, layout.lines.length, inputHistoryRef.current.index !== undefined, false);
      const previousIndex = inputHistoryRef.current.index;
      if (canNavigateHistory && previousIndex === undefined) historyDraftImagesRef.current = new Map(imageDraftsRef.current);
      const navigation = navigateTuiInputHistory(inputHistoryRef.current, historyDirection, inputRef.current, canNavigateHistory);
      if (navigation.changed || navigation.state.index !== previousIndex) {
        inputHistoryRef.current = navigation.state;
        imageDraftsRef.current = new Map(navigation.state.index === undefined ? historyDraftImagesRef.current : historyImagesRef.current[navigation.state.index] ?? []);
        updateInput(navigation.input, splitTuiInputGraphemes(navigation.input).length);
      }
      return;
    }
    const bracketedPasteReturn = bracketedPasteRef.current && key.return;
    if (bracketedPasteRef.current && value === "\n" && pasteCarriageReturnRef.current) {
      pasteCarriageReturnRef.current = false;
      return;
    }
    const multilineEnter = isTuiMultilineEnter(value, key, rawInputSequenceRef.current);
    const cursor = cursorIndexRef.current;
    const continuation = key.return && hasTuiUnescapedContinuation(inputRef.current, cursor);
    if (bracketedPasteReturn || multilineEnter || continuation) {
      const characters = splitTuiInputGraphemes(inputRef.current);
      const newlineIndex = continuation ? cursor - 1 : cursor;
      if (continuation) characters.splice(newlineIndex, 1);
      characters.splice(newlineIndex, 0, "\n");
      const nextInput = characters.join("");
      inputHistoryRef.current = updateTuiInputHistoryDraft(inputHistoryRef.current, nextInput);
      updateInput(nextInput, newlineIndex + 1);
      pasteCarriageReturnRef.current = bracketedPasteReturn;
      return;
    }
    pasteCarriageReturnRef.current = false;
    if (key.return) {
      // 受管远端提交期间允许继续编辑草稿，但不丢弃尚未可提交的下一条消息。
      if (busy.current && !isActiveTuiStatus(current.status)) return;
      if (pastingCountRef.current > 0) { store.addNotice("图片仍在处理，请稍候发送"); return; }
      const content = inputRef.current.trim();
      if (!content) return;
      const spans = imageSpans(content);
      if (new Set(spans.map(function id(span) { return span.id; })).size !== spans.length) { store.addNotice("图片占位符重复，请删除重复内容"); return; }
      const images = spans.map(function image(span) { return imageDraftsRef.current.get(span.id)!; });
      const parsed = input.parseInput?.(content) ?? parseSlashAction(content);
      if (parsed.kind === "error") { store.addNotice(parsed.message); return; }
      if (images.length && parsed.action.type !== "submit_prompt") { store.addNotice("图片不能附加到命令，请先发送或删除图片"); return; }
      if (parsed.action.type === "submit_prompt") {
        lastSubmittedImagesRef.current = new Map(imageDraftsRef.current);
        historyImagesRef.current = [...historyImagesRef.current, new Map(imageDraftsRef.current)].slice(-100);
      }
      updateInput("", 0);
      imageDraftsRef.current = new Map();
      void (async function dispatchEnteredLine(): Promise<void> {
        const prompt = parsed.action.type === "submit_prompt" ? parsed.action.content : undefined;
        if (prompt) inputHistoryRef.current = recordTuiInputHistory(inputHistoryRef.current, prompt);
        await dispatchAction(parsed.action.type === "submit_prompt" && images.length ? { ...parsed.action, images } : parsed.action, prompt);
      })();
      return;
    }
    if (value && !key.ctrl && !key.meta) {
      const characters = splitTuiInputGraphemes(inputRef.current);
      const inside = imageSpans(inputRef.current).find(function contains(span) { return cursorIndexRef.current > span.start && cursorIndexRef.current < span.end; });
      const cursor = inside?.end ?? cursorIndexRef.current;
      const inserted = splitTuiInputGraphemes(normalizeTuiInputLineEndings(value));
      characters.splice(cursor, 0, ...inserted);
      const nextInput = characters.join("");
      inputHistoryRef.current = updateTuiInputHistoryDraft(inputHistoryRef.current, nextInput);
      updateInput(nextInput, cursor + inserted.length);
    }
  }

  const attachmentNames = [...imageDraftsRef.current.values()].map(function name(image) { return image.name; });
  /** 附件区只投影当前草稿的既有图片名，不复制图片字节或触发采样。 */
  useEffect(function publishAttachments() { input.onAttachmentsChange?.(attachmentNames); }, [attachmentNames.join("\0"), input.onAttachmentsChange]);

  return { input: inputValue, cursorIndex, handleInput };
}
