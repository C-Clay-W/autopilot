/** prompt 输入状态与 handleInput：字符串/光标/历史维护与按键分发。 */

import { useRef, useState } from "react";
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

/** usePromptInput 的运行依赖；派生值（slash 建议、视口按键）由 app.tsx 通过 ref 注入。 */
export interface UsePromptInputInput {
  store: CliTuiStore;
  columns: number;
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
      handleTuiViewportKey: (key: Key) => boolean;
    };
  };
}

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
  const [inputValue, setInput] = useState("");
  const [cursorIndex, setCursorIndex] = useState(0);
  const inputRef = useRef("");
  const cursorIndexRef = useRef(0);
  const verticalColumnRef = useRef<number | undefined>(undefined);
  const bracketedPasteRef = useRef(false);
  const pasteCarriageReturnRef = useRef(false);
  const inputHistoryRef = useRef<TuiInputHistoryState>(createTuiInputHistoryState());

  /** 同步维护字符串与光标位置，避免只移动光标时 React 跳过重绘；输入变化即解除 @ 菜单的 Esc 关闭标记。 */
  function updateInput(nextInput: string, nextCursorIndex: number): void {
    verticalColumnRef.current = undefined;
    inputRef.current = nextInput;
    cursorIndexRef.current = nextCursorIndex;
    setFileMentionDismissedInput(undefined);
    setInput(nextInput);
    setCursorIndex(nextCursorIndex);
  }

  /** 只移动逻辑光标，不清除上下键要保持的目标视觉列。 */
  function updateCursorIndex(nextCursorIndex: number): void {
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
    updateInput(prompt, splitTuiInputGraphemes(prompt).length);
  }

  function handleInput(value: string, key: Key): void {
    recordTuiPerformanceDiagnostic("input_key_arrived", value && !key.ctrl && !key.meta ? "text" : "control");
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
      pasteCarriageReturnRef.current = false;
      return;
    }
    if (pasteBoundary === "end") {
      bracketedPasteRef.current = false;
      pasteCarriageReturnRef.current = false;
      return;
    }
    if (isPickerActive) {
      dispatchPickerInput(value, key, controlAction);
      return;
    }
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
      const selectedCommand = slashCommandSuggestions[Math.max(0, Math.min(slashCommandIndexRef.current, slashCommandSuggestions.length - 1))];
      if (selectedCommand && (key.upArrow || key.downArrow)) {
        const nextIndex = key.upArrow
          ? Math.max(0, slashCommandIndexRef.current - 1)
          : Math.min(slashCommandSuggestions.length - 1, slashCommandIndexRef.current + 1);
        updateSlashCommandIndex(nextIndex);
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
    if (busy.current && !isActiveTuiStatus(current.status)) return;
    const deleteDirection = resolveTuiDeleteDirection(value, key, rawInputSequenceRef.current);
    if (deleteDirection) {
      const characters = splitTuiInputGraphemes(inputRef.current);
      const cursor = cursorIndexRef.current;
      const removeIndex = deleteDirection === "backspace" ? cursor - 1 : cursor;
      if (removeIndex < 0 || removeIndex >= characters.length) return;
      characters.splice(removeIndex, 1);
      const nextInput = characters.join("");
      inputHistoryRef.current = updateTuiInputHistoryDraft(inputHistoryRef.current, nextInput);
      updateInput(nextInput, deleteDirection === "backspace" ? cursor - 1 : cursor);
      return;
    }
    if (key.leftArrow) {
      updateInput(inputRef.current, Math.max(0, cursorIndexRef.current - 1));
      return;
    }
    if (key.rightArrow) {
      updateInput(inputRef.current, Math.min(splitTuiInputGraphemes(inputRef.current).length, cursorIndexRef.current + 1));
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
      const navigation = navigateTuiInputHistory(inputHistoryRef.current, historyDirection, inputRef.current, canNavigateHistory);
      if (navigation.changed) {
        inputHistoryRef.current = navigation.state;
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
      const content = inputRef.current.trim();
      updateInput("", 0);
      if (!content) return;
      void (async function dispatchEnteredLine(): Promise<void> {
        const parsed = parseSlashAction(content);
        if (parsed.kind === "error") {
          store.addNotice(parsed.message);
          return;
        }
        const prompt = parsed.action.type === "submit_prompt" ? parsed.action.content : undefined;
        if (prompt) inputHistoryRef.current = recordTuiInputHistory(inputHistoryRef.current, prompt);
        await dispatchAction(parsed.action, prompt);
      })();
      return;
    }
    if (value && !key.ctrl && !key.meta) {
      const characters = splitTuiInputGraphemes(inputRef.current);
      const cursor = cursorIndexRef.current;
      const inserted = splitTuiInputGraphemes(normalizeTuiInputLineEndings(value));
      characters.splice(cursor, 0, ...inserted);
      const nextInput = characters.join("");
      inputHistoryRef.current = updateTuiInputHistoryDraft(inputHistoryRef.current, nextInput);
      updateInput(nextInput, cursor + inserted.length);
    }
  }

  return { input: inputValue, cursorIndex, handleInput };
}
