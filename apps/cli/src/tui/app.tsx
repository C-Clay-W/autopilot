/** 瘦身后的 Ink 应用组件：编排 store 订阅、dispatchAction、动画时钟与渲染。 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Text, measureElement, type DOMElement, useInput, useStdin, useStdout, type Key } from "ink";
import { TuiInlineOutput } from "./inline-output.js";
import { TuiActivityLine } from "../activity-animation.js";
import { createTuiAnimationClock, type TuiAnimationClock } from "../animation-clock.js";
import type { CliController, CliControllerResult } from "../controller.js";
import { classifyCliError, CLI_THREAD_RECOVERY_HINT } from "../error-diagnostics.js";
import { resolveFileMentionContext } from "../file-mention-context.js";
import { createTimelineVisualLineCache, type TimelineLineSource, type TimelineVisualLine } from "../timeline-lines.js";
import type { CliAction, CliExitCode, CliJobView } from "../types.js";
import { TuiApprovalPrompt, createTuiApprovalOptions } from "./approval.js";
import { TuiBrandHeader, TUI_BRAND_HISTORY_ITEM, type TuiInlineHistoryItem } from "./brand/brand-header.js";
import { TuiContextReport } from "./context.js";
import { isActiveTuiStatus, isTerminalStatus, readTuiTerminalSize } from "./format.js";
import { recordTuiRuntimeErrorDiagnostic } from "./performance-diagnostics.js";
import { useFileMentionIndex } from "./hooks/use-file-mention-index.js";
import { usePickers } from "./hooks/use-pickers.js";
import { useStatusView } from "./hooks/use-status-view.js";
import { useViewport } from "./hooks/use-viewport.js";
import type { CliTuiDraftRef } from "./hooks/use-prompt-input.js";
import { TuiInputArea, type TuiInputDerivedRef, type TuiInputLayout } from "./input-area.js";
import { TuiInfoLines, TuiStatusLine } from "./status-line.js";
import { TuiJobs } from "./jobs.js";
import { TuiLiveTurn } from "./timeline/turn.js";
import { getTuiTurnTodo } from "./timeline/turn-items.js";
import { MemoizedTuiTranscriptItem, TuiPendingInputItem, TuiPromptLine } from "./transcript.js";
import type {
  CliTuiInitialOperation,
  CliTuiTranscriptItem,
  CliTuiStore,
  TuiTerminalSizeSource,
  TuiMouseInputSink,
  TuiRenderMode,
} from "./types.js";
import { getTuiSelectedText } from "./viewport/selection.js";
import { createTuiViewportSourceCache } from "./viewport/sources.js";
import { TuiViewportTimeline } from "./viewport/viewport.js";

import wrapAnsi from "wrap-ansi";

const EMPTY_VIEWPORT_SOURCES: TimelineLineSource[] = [];
const EMPTY_VIEWPORT_LINES: TimelineVisualLine[] = [];

/** Ink 应用组件；useInput 只把用户动作交给 Controller Action。 */
export function CliTuiApp(props: {
  store: CliTuiStore;
  inlineOutputKey?: string;
  sessionTitle?: string; interactionLabel?: string;
  /** 保活后台子树时禁止所有输入处理器与鼠标绑定；不依赖display:none隔离副作用。 */
  visible?: boolean;
  inputActive?: boolean;
  viewState?: { draftRef: CliTuiDraftRef; initialStarted: boolean; lastSubmittedPrompt: { current: string | undefined } };
  /** 每次事件再核对实时会话/列表模式，避免React尚未commit时旧处理器消费输入。 */
  canReceiveInput?(value?: string, key?: Key): boolean;
  bindInputHandler?(handler: ((value: string, key: Key) => void) | undefined): void;
  onDraftAttachmentsChange?(names: string[]): void;
  escapeClosesPanel?: boolean;
  availableColumns?: number;
  availableRows?: number;
  controller: CliController;
  initial?: CliTuiInitialOperation;
  closeWhenIdle: boolean;
  /** canonical 工作区根；缺省时 @ 文件候选菜单不激活。 */
  workspaceRoot?: string;
  useColor: boolean;
  screenReader: boolean;
  renderMode?: TuiRenderMode;
  reducedMotion?: boolean;
  mouseInput?: TuiMouseInputSink;
  onCopyText?(text: string): void;
  onResult(result: CliControllerResult): void;
  onRequestInterrupt(): void;
  onRequestCancel(): void;
  onEof(): void;
  onAppExit(code: CliExitCode): void;
  terminalSizeSource?: TuiTerminalSizeSource;
  onTerminalSizeChange?(size: { columns: number; rows: number }): void;
}): ReactNode {
  const { isRawModeSupported, stdin } = useStdin();
  const { stdout } = useStdout();
  const terminalSizeSource = props.terminalSizeSource ?? stdout;
  const [snapshot, setSnapshot] = useState(props.store.getSnapshot());
  const [terminalFocused, setTerminalFocused] = useState(true);
  /** Claude Code 式 Ctrl+O 切换动态区 Todo 清单的紧凑/展开形态，只影响本地视图。 */
  const [todoExpanded, setTodoExpanded] = useState(false);
  const [jobView, setJobView] = useState<CliJobView | undefined>(undefined);
  const [jobListCache, setJobListCache] = useState<Extract<CliJobView, { mode: "list" }> | undefined>(undefined);
  const [jobSelectedIndex, setJobSelectedIndex] = useState(0);
  const jobViewRef = useRef<CliJobView | undefined>(undefined);
  const jobRequestGeneration = useRef(0);
  /** /context 覆盖视图；打开时取代时间线渲染，Esc 关闭后回到正常聊天。 */
  const [contextView, setContextView] = useState<NonNullable<CliControllerResult["contextView"]> | undefined>(undefined);
  const [infoReport, setInfoReport] = useState<{ text: string; offset: number }>();
  const rawInputSequenceRef = useRef("");
  const busy = useRef(false);
  const keepOpenAfterCancel = useRef(false);
  const localLastSubmittedPromptRef = useRef<string | undefined>(undefined);
  const lastSubmittedPromptRef = props.viewState?.lastSubmittedPrompt ?? localLastSubmittedPromptRef;
  const initialStarted = useRef(props.viewState?.initialStarted ?? false);
  const lastResult = useRef<CliControllerResult | undefined>(undefined);
  const animationClockRef = useRef<TuiAnimationClock | undefined>(undefined);
  if (!animationClockRef.current) animationClockRef.current = createTuiAnimationClock({ frameMs: 120 });
  const animationClock = animationClockRef.current;
  /** 防抖后的终端尺寸；Ink 与应用布局共同使用同一份稳定快照。 */
  const [terminalSize, setTerminalSize] = useState(function createTerminalSize() {
    return readTuiTerminalSize(terminalSizeSource);
  });
  const isViewportMode = props.visible !== false && props.renderMode === "alternate-screen" && !props.screenReader;
  const columns = props.availableColumns ?? terminalSize.columns;
  const inputEnabled = props.visible !== false && props.inputActive !== false;
  const rows = props.availableRows ?? terminalSize.rows;
  const maximumFrameRows = isViewportMode ? rows : Math.max(1, rows - 1);

  const { statusView, refreshStatusView } = useStatusView(props.controller);

  /** 输入子树通过 ref 读取 slash 与 @ 建议，父级只注入视口按键处理器。 */
  const derivedRef = useRef<TuiInputDerivedRef["current"]>({
    slashCommandSuggestions: [],
    fileMentionSuggestions: [],
    handleTuiViewportKey: function noViewportKey(): boolean { return false; },
  });

  const pickers = usePickers({ dispatchAction, rawInputSequenceRef });
  const fileMentionIndex = useFileMentionIndex(props.workspaceRoot);
  const [inputLayout, setInputLayout] = useState<TuiInputLayout>({
    promptHeight: 4,
    pickerHeight: 0,
  });
  const handleInputLayoutChange = useCallback(function handleInputLayoutChange(next: TuiInputLayout): void {
    setInputLayout(function updateInputLayout(previous): TuiInputLayout {
      return previous.promptHeight === next.promptHeight && previous.pickerHeight === next.pickerHeight ? previous : next;
    });
  }, []);
  const infoMessages = snapshot.transcript
    .filter(function isNotice(item): item is Extract<CliTuiTranscriptItem, { kind: "notice" }> { return item.kind === "notice" && !item.persistent; })
    .slice(-4)
    .map(function getNoticeMessage(item): string { return item.message; });
  const reportLines = infoReport ? wrapAnsi(infoReport.text, Math.max(1, columns - 2), { hard: true, trim: false }).split("\n") : [];
  // 有配置视图时为状态、配置、Context、工作区四行和上边距留空间。
  const statusHeight = (statusView ? 5 : 1) + (props.sessionTitle ? 1 : 0);
  const reportHeight = Math.max(1, rows - statusHeight - 4);
  const reportMaximum = Math.max(0, reportLines.length - reportHeight);
  const reportOffset = Math.min(infoReport?.offset ?? 0, reportMaximum);
  const [approvalOffset, setApprovalOffset] = useState(0);
  const [approvalDetails, setApprovalDetails] = useState(false);
  const [submittedFeedback, setApprovalFeedback] = useState<string>();
  const hostStatus = props.controller.getHostApprovalStatus?.();
  const approvalFeedback = hostStatus ? undefined : submittedFeedback;
  const approvalMaximumRef = useRef(0);
  const approvalCardHeight = snapshot.pendingApproval ? Math.max(createTuiApprovalOptions(snapshot.pendingApproval).length + 4, Math.min(Math.floor(rows / 2), rows - inputLayout.promptHeight - statusHeight - 2)) : 0;
  /** 主会话普通审批与原地卡片使用同一详情滚动/固定决定组件。 */
  function handleApprovalKey(value: string, key: Key): boolean {
    if (key.pageUp || key.pageDown) { setApprovalOffset(function move(current) { return Math.max(0, Math.min(approvalMaximumRef.current, current + (key.pageDown ? 1 : -1) * Math.max(1, approvalCardHeight - 5))); }); return true; }
    if (value === "d") { setApprovalDetails(function toggle(current) { return !current; }); setApprovalOffset(0); return true; }
    if (key.escape || value === "\u001b") { setApprovalDetails(false); setApprovalOffset(0); return true; }
    return false;
  }
  derivedRef.current.handleApprovalKey = handleApprovalKey;
  const approvalHeight = isViewportMode && snapshot.pendingApproval ? createTuiApprovalOptions(snapshot.pendingApproval).length + 6 : 0;
  // Todo 展开态最多占 10 行；矮终端为输入框、状态栏和活动文案至少保留 6 行。
  const todoRowLimit = Math.max(2, Math.min(10, rows - 6));
  const activeTodoForm = getTuiTurnTodo(snapshot.liveEvents, snapshot.liveTurnId ?? "")?.todos.find(function active(todo) { return todo.status === "in_progress"; })?.activeForm;
  const fixedHeight = inputLayout.promptHeight + inputLayout.pickerHeight + approvalHeight + infoMessages.length + (infoMessages.length ? 1 : 0) + (approvalFeedback ? 1 : 0) + 1 + statusHeight;
  const fixedRef = useRef<DOMElement>(null);
  const inputAreaRef = useRef<DOMElement>(null);
  const approvalBoxRef = useRef<DOMElement>(null);
  const inlineBodyRef = useRef<DOMElement>(null);
  const [inlineHeight, setInlineHeight] = useState<number>();
  const [reservedInputRows, setReservedInputRows] = useState(0);
  /** 量出输入之外的固定行，避免活动行、状态栏折行和审批卡侵占命令窗口。 */
  useLayoutEffect(function measureSpaceAroundInput() {
    if (!fixedRef.current || !inputAreaRef.current) return;
    const approvalRows = approvalBoxRef.current ? measureElement(approvalBoxRef.current).height : 0;
    const reserved = measureElement(fixedRef.current).height - measureElement(inputAreaRef.current).height + approvalRows;
    setReservedInputRows(reserved);
  });
  // Ink 6 不支持 maxHeight；测量未收缩正文，给动态帧设置自然高度与窗口上限。
  useLayoutEffect(function measureInlineLayout() {
    if (isViewportMode || !inlineBodyRef.current || !fixedRef.current) return;
    const height = measureElement(inlineBodyRef.current).height + measureElement(fixedRef.current).height + approvalCardHeight;
    setInlineHeight(function update(previous) { return previous === height ? previous : height; });
  });
  const [measuredFixedHeight, setMeasuredFixedHeight] = useState<number>();
  useLayoutEffect(function measureFixedLayout() {
    if (!isViewportMode || !fixedRef.current) return;
    const height = measureElement(fixedRef.current).height + (approvalBoxRef.current ? measureElement(approvalBoxRef.current).height : 0);
    setMeasuredFixedHeight(function update(previous) { return previous === height ? previous : height; });
  });
  const viewportHeight = Math.max(1, rows - (measuredFixedHeight ?? fixedHeight));
  const viewportSourceCacheRef = useRef<ReturnType<typeof createTuiViewportSourceCache> | undefined>(undefined);
  if (!viewportSourceCacheRef.current) viewportSourceCacheRef.current = createTuiViewportSourceCache();
  const viewportLineCacheRef = useRef<ReturnType<typeof createTimelineVisualLineCache> | undefined>(undefined);
  if (!viewportLineCacheRef.current) viewportLineCacheRef.current = createTimelineVisualLineCache();
  const viewportContentWidth = Math.max(1, columns - 1);
  const viewportSources = useMemo(function getCachedViewportSources() {
    return isViewportMode
      ? viewportSourceCacheRef.current!.getSources(snapshot, statusView, pickers.approvalPickerIndex, viewportContentWidth, todoExpanded, props.useColor, todoRowLimit)
      : EMPTY_VIEWPORT_SOURCES;
  }, [isViewportMode, pickers.approvalPickerIndex, snapshot, statusView, viewportContentWidth, todoExpanded, props.useColor, todoRowLimit]);
  const viewportLines = useMemo(function getCachedViewportLines() {
    return isViewportMode
      ? viewportLineCacheRef.current!.getLines(viewportSources, viewportContentWidth)
      : EMPTY_VIEWPORT_LINES;
  }, [isViewportMode, viewportContentWidth, viewportSources]);

  const { viewportState, selection, handleTuiMouseEvent, handleTuiViewportKey } = useViewport({
    isViewportMode,
    columns,
    viewportLines,
    viewportHeight,
    stdout,
    onCopyText: props.onCopyText,
    onCopyError: function copyFailed() { props.store.addNotice("复制失败，请检查系统剪贴板后重试。"); },
  });

  derivedRef.current.handleTuiViewportKey = handleTuiViewportKey;

  const selectedText = isViewportMode ? getTuiSelectedText(viewportLines, selection) : "";
  const animationActive = (snapshot.compacting || snapshot.status === "running" && !snapshot.threadWait) && props.visible !== false && isRawModeSupported && stdout.isTTY !== false && terminalFocused;

  /** 把用户动作交给 Controller；结束后刷新状态栏并按投影结果打开对应 picker。 */
  async function dispatchAction(action: CliAction, prompt?: string, preserveSkillPickerQuery = false): Promise<void> {
    if (action.type === "exit") { props.onAppExit(0); return; }
    const answeringQuestion = action.type === "submit_prompt" && props.store.getSnapshot().status === "waiting_user_input";
    const allowWhileRunning = action.type === "cancel_turn" || (action.type === "submit_prompt" || action.type === "open_permissions" || action.type === "set_permission_mode" || action.type === "open_model_picker" || action.type === "set_model" || action.type === "open_effort_picker" || action.type === "set_effort" || action.type === "list_jobs" || action.type === "show_job" || action.type === "read_job_output" || action.type === "stop_job") && isActiveTuiStatus(props.store.getSnapshot().status);
    if (props.store.getSnapshot().compacting || busy.current && !allowWhileRunning) return;
    const isJobAction = action.type === "list_jobs" || action.type === "show_job" || action.type === "read_job_output" || action.type === "stop_job";
    const jobGeneration = isJobAction ? ++jobRequestGeneration.current : undefined;
    const inputPosition = prompt && allowWhileRunning ? props.store.captureInputPosition() : undefined;
    if (prompt && !answeringQuestion) {
      lastSubmittedPromptRef.current = prompt.trim();
      props.store.recordPrompt(prompt, !allowWhileRunning);
    }
    if (action.type === "approve") props.store.recordApprovalSubmission(action.decision);
    const hostApproval = action.type === "approve" && props.controller.hostApprovalFeedback;
    if (hostApproval) setApprovalFeedback("正在提交审批决定…");
    else setApprovalFeedback(undefined);
    if (!allowWhileRunning) busy.current = true;
    // D2/D5：仅交互 TUI 在发送前把 @ 引用的工作区文件内容以 <system-reminder> 附加块并入 action.content；
    // start/steer/queue/initial 四条 TUI 提交路径都经过此处，时间线与 Esc 恢复仍使用原文 prompt。
    let dispatchedAction = action;
    if (action.type === "submit_prompt" && !answeringQuestion && prompt && props.workspaceRoot && !props.controller.resolveFileMentionsInHost) {
      const resolved = await resolveFileMentionContext(action.content, props.workspaceRoot);
      for (const message of resolved.notices) props.store.addNotice(message);
      if (resolved.content !== action.content) dispatchedAction = { ...action, content: resolved.content };
    }
    let result: CliControllerResult;
    if (action.type === "compact") props.store.setCompacting(true);
    try {
      result = await props.controller.dispatch(dispatchedAction);
    } catch (error) {
      recordTuiRuntimeErrorDiagnostic(error);
      result = {
        kind: "error",
        exitCode: 1,
        lines: [],
        message: classifyCliError(error).code === "THREAD_RECOVERY_REQUIRED" ? CLI_THREAD_RECOVERY_HINT : classifyCliError(error).category === "node_state" ? `${classifyCliError(error).code}：会话保存未完成，请检查存储可用性后重试；原记录保留` : "CLI_RUNTIME_ERROR",
        projection: props.controller.getProjection(),
      };
    } finally {
      if (action.type === "compact") props.store.setCompacting(false);
      if (!allowWhileRunning) busy.current = false;
    }
    lastResult.current = result;
    props.onResult(result);
    if (hostApproval) setApprovalFeedback(result.kind === "ok" && props.controller.getHostApprovalStatus ? undefined : result.lines[0] ?? result.message ?? "审批提交未确认，请核查原决定。");
    const reportText = result.infoReport ?? result.lines.join("\n");
    const dedicatedView = hostApproval || result.jobView || result.contextView || result.skillOptions || result.permissionOptions || result.modelOptions || result.effortOptions || jobViewRef.current || contextView || pickers.isPickerActive || props.store.getSnapshot().pendingApproval;
    if (dedicatedView) setInfoReport(undefined);
    else if (result.infoReport || result.lines.length > 1 || reportText.includes("\n") || reportText.length > columns - 6) setInfoReport({ text: reportText, offset: 0 });
    if (result.jobView && jobGeneration === jobRequestGeneration.current) {
      jobViewRef.current = result.jobView;
      setJobView(result.jobView);
      if (result.jobView.mode === "list") {
        const nextList = result.jobView;
        setJobListCache(nextList);
        setJobSelectedIndex(function clampJobSelection(previous) { return Math.min(previous, Math.max(0, nextList.list.jobs.length - 1)); });
      } else {
        const updated = result.jobView.job;
        setJobListCache(function updateCachedSummary(previous) {
          if (!previous) return previous;
          return { ...previous, list: { ...previous.list, jobs: previous.list.jobs.map(function replaceJob(job) { return job.jobId === updated.jobId && (updated.revision ?? 0) >= (job.revision ?? 0) ? updated : job; }) } };
        });
      }
    }
    if (result.contextView) setContextView(result.contextView);
    if (result.hostRecordedPrompt && allowWhileRunning) props.store.recordPrompt(result.hostRecordedPrompt, "history");
    if (prompt && result.submittedInput) props.store.addPendingPrompt(prompt, result.submittedInput, inputPosition);
    await refreshStatusView();
    if (result.skillOptions) {
      pickers.setSkillPickerSkills(result.skillOptions);
      if (!preserveSkillPickerQuery) pickers.updateSkillPickerQuery("");
    }
    if (result.permissionOptions) {
      pickers.permissionPickerOptionsRef.current = result.permissionOptions;
      pickers.setPermissionPickerOptions(result.permissionOptions);
      pickers.updatePermissionPickerIndex(Math.max(0, result.permissionOptions.findIndex(function findSelected(option) { return option.selected; })));
    }
    if (result.modelOptions) {
      pickers.modelPickerOptionsRef.current = result.modelOptions;
      pickers.setModelPickerOptions(result.modelOptions);
      pickers.updateModelPickerIndex(Math.max(0, result.modelOptions.findIndex(function findSelected(option) { return option.selected; })));
    }
    if (result.effortOptions) {
      pickers.effortPickerOptionsRef.current = result.effortOptions;
      pickers.setEffortPickerOptions(result.effortOptions);
      pickers.updateEffortPickerIndex(Math.max(0, result.effortOptions.findIndex(function findSelected(option) { return option.selected; })));
    }
    if (result.kind === "exit") props.onAppExit(result.exitCode);
  }

  /** 统一接管终端 resize；inline 防抖，备用屏即时提交，布局提交后由 Ink 清理旧帧。 */
  useEffect(function subscribeTerminalResize() {
    const onResize = terminalSizeSource.on;
    const offResize = terminalSizeSource.off;
    if (props.availableColumns !== undefined || !onResize || !offResize) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function commitTerminalSize(): void {
      const nextSize = readTuiTerminalSize(terminalSizeSource);
      timer = undefined;
      setTerminalSize(nextSize);
    }
    function handleTerminalResize(): void {
      if (isViewportMode) {
        commitTerminalSize();
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(commitTerminalSize, 200);
    }
    onResize.call(terminalSizeSource, "resize", handleTerminalResize);
    return function cleanupTerminalResize(): void {
      if (timer) clearTimeout(timer);
      offResize.call(terminalSizeSource, "resize", handleTerminalResize);
    };
  }, [isViewportMode, terminalSizeSource]);

  useLayoutEffect(function syncTerminalSizeToInk() {
    if (props.availableColumns === undefined) props.onTerminalSizeChange?.(terminalSize);
  }, [terminalSize, props.onTerminalSizeChange]);

  useEffect(function bindTuiMouseInput() {
    if (!inputEnabled) return;
    /** 鼠标同样按实时交互门路由，隐藏或旧代次不能修改后台阅读位置。 */
    function routeSelectedMouse(event: Parameters<typeof handleTuiMouseEvent>[0], notches: number): void {
      if (props.canReceiveInput?.() !== false) handleTuiMouseEvent(event, notches);
    }
    props.mouseInput?.setHandler(routeSelectedMouse);
    return function unbindTuiMouseInput(): void {
      props.mouseInput?.setHandler(undefined);
    };
  }, [inputEnabled, props.mouseInput, isViewportMode, columns, viewportHeight, viewportLines.length]);

  useEffect(function resetApprovalSelection() {
    pickers.updateApprovalPickerIndex(0);
    setApprovalOffset(0); setApprovalDetails(false);
    if (snapshot.pendingApproval || hostStatus || snapshot.status !== "waiting_approval") setApprovalFeedback(undefined);
  }, [snapshot.pendingApproval?.approvalId, hostStatus, snapshot.status]);

  useEffect(function disposeTuiAnimationClock() {
    return function disposeAnimationClock(): void {
      animationClock.dispose();
    };
  }, [animationClock]);

  useEffect(function subscribeTuiStore() {
    return props.store.subscribe(function updateTuiSnapshot() {
      setSnapshot(props.store.getSnapshot());
    });
  }, [props.store]);

  // 同一提交的Turn/用量变化只触发一次刷新；在途变化由hook合并到下一次查询。
  useEffect(function refreshStatusOnTurnAndUsageChange() {
    void refreshStatusView();
  }, [refreshStatusView, snapshot.status, snapshot.liveTurnId, snapshot.contextUsage]);

  useEffect(function subscribeStdinEnd() {
    function handleStdinEnd(): void {
      props.onEof();
    }
    stdin.on("end", handleStdinEnd);
    return function unsubscribeStdinEnd(): void {
      stdin.removeListener("end", handleStdinEnd);
    };
  }, [stdin, props.onEof]);

  useEffect(function captureRawInputSequence() {
    /** 在 Ink 解析前缓存原始按键序列，用于区分 macOS Backspace 与前向 Delete。 */
    function capture(chunk: string | Buffer): void {
      rawInputSequenceRef.current = String(chunk);
    }
    stdin.prependListener("data", capture);
    return function unsubscribeRawInputSequence(): void {
      stdin.removeListener("data", capture);
    };
  }, [stdin]);

  useEffect(function captureTerminalFocus() {
    /** 读取终端 focus in/out 报告，让失焦时共享动画时钟停止。 */
    function captureFocus(chunk: string | Buffer): void {
      const value = String(chunk);
      if (value.includes("\u001b[O")) setTerminalFocused(false);
      if (value.includes("\u001b[I")) setTerminalFocused(true);
    }
    stdin.on("data", captureFocus);
    return function unsubscribeTerminalFocus(): void {
      stdin.removeListener("data", captureFocus);
    };
  }, [stdin]);

  useEffect(function runInitialOperation() {
    if (initialStarted.current || !props.initial) return;
    initialStarted.current = true;
    if (props.viewState) props.viewState.initialStarted = true;
    if (props.initial.type === "start") {
      void dispatchAction({ type: "submit_prompt", content: props.initial.content }, props.initial.content);
    } else {
      void (async function resumeInitialTurn(): Promise<void> {
        if (busy.current) return;
        busy.current = true;
        let result: CliControllerResult;
        try {
          result = await props.controller.resume();
        } catch (error) {
          recordTuiRuntimeErrorDiagnostic(error);
          result = {
            kind: "error",
            exitCode: 1,
            lines: [],
            message: classifyCliError(error).category === "node_state" ? `${classifyCliError(error).code}：会话保存未完成，请检查存储可用性后重试；原记录保留` : "CLI_RUNTIME_ERROR",
            projection: props.controller.getProjection(),
          };
        } finally {
          busy.current = false;
        }
        lastResult.current = result;
        props.onResult(result);
        await refreshStatusView();
      })();
    }
  }, [props.controller, props.initial]);

  useEffect(function closeCompletedOneShot() {
    if (!props.closeWhenIdle || !initialStarted.current || busy.current) return;
    if (keepOpenAfterCancel.current) return;
    if (snapshot.status !== "running" && snapshot.status !== "waiting_approval") {
      props.onAppExit(snapshot.requestedExitCode ?? lastResult.current?.exitCode ?? 0);
    }
  }, [props.closeWhenIdle, snapshot.status, snapshot.requestedExitCode]);

  /** 长报告独占按键，Esc 只关闭报告；输入组件保持挂载以保留草稿。 */
  useInput(function handleInfoReport(value: string, key: Key): void {
    if (props.canReceiveInput?.(value, key) === false) return;
    if (!infoReport) {
      if (key.ctrl && value === "g") setInfoReport({ text: snapshot.transcript.filter(function notice(item): item is Extract<CliTuiTranscriptItem, { kind: "notice" }> { return item.kind === "notice"; }).map(function message(item) { return item.message; }).join("\n\n") || "暂无提示", offset: 0 });
      return;
    }
    if (key.escape || value === "\u001b") { setInfoReport(undefined); return; }
    const delta = key.pageDown ? reportHeight : key.pageUp ? -reportHeight : key.downArrow ? 1 : key.upArrow ? -1 : 0;
    if (delta) setInfoReport({ ...infoReport, offset: Math.max(0, Math.min(reportMaximum, reportOffset + delta)) });
  }, { isActive: inputEnabled && isRawModeSupported && (infoReport !== undefined || !jobView && !contextView && !pickers.isPickerActive && !snapshot.pendingApproval) });

  /** 在 Job 视图内复用 Ink 输入路由；Esc 只返回视图，不取消 Turn 或退出进程。 */
  useInput(function handleJobInput(value: string, key: Key): void {
    if (props.canReceiveInput?.(value, key) === false) return;
    const current = jobViewRef.current;
    if (!current) return;
    if (key.escape || value === "\u001b") {
      jobRequestGeneration.current += 1;
      const next = current.mode === "detail" ? jobListCache : undefined;
      jobViewRef.current = next;
      setJobView(next);
      return;
    }
    if (current.mode === "list") {
      if (key.upArrow) { setJobSelectedIndex(function selectPrevious(index) { return Math.max(0, index - 1); }); return; }
      if (key.downArrow) { setJobSelectedIndex(function selectNext(index) { return Math.min(Math.max(0, current.list.jobs.length - 1), index + 1); }); return; }
      const selected = current.list.jobs[jobSelectedIndex];
      if (key.return && selected) void dispatchAction({ type: "show_job", jobId: selected.jobId });
      else if (value === "o" && selected) void dispatchAction({ type: "read_job_output", jobId: selected.jobId });
      else if (value === "s" && selected?.canStop) void dispatchAction({ type: "stop_job", jobId: selected.jobId });
      else if (value === "r") void dispatchAction({ type: "list_jobs" });
      return;
    }
    if (value === "o") void dispatchAction({ type: "read_job_output", jobId: current.job.jobId });
    else if (value === "s" && current.job.canStop) void dispatchAction({ type: "stop_job", jobId: current.job.jobId });
    else if (value === "r") void dispatchAction({ type: current.output ? "read_job_output" : "show_job", jobId: current.job.jobId });
  }, { isActive: inputEnabled && isRawModeSupported && jobView !== undefined && !infoReport });

  /** 在 Context 覆盖视图内复用 Ink 输入路由；Esc 只关闭视图回到聊天，不取消 Turn 或退出进程。 */
  useInput(function handleContextInput(value: string, key: Key): void {
    if (props.canReceiveInput?.(value, key) === false) return;
    if (contextView === undefined) return;
    if (key.escape || value === "\u001b") setContextView(undefined);
  }, { isActive: inputEnabled && isRawModeSupported && contextView !== undefined && !infoReport });

  // Ctrl+O 只切换 Todo 展开视图；picker 与审批等待打开时让位，避免按键语义冲突。
  useInput(function handleTodoExpandInput(input: string, key: Key): void {
    if (props.canReceiveInput?.(input, key) === false) return;
    if (key.ctrl && input === "o") setTodoExpanded(function toggleTodoExpanded(previous): boolean { return !previous; });
  }, { isActive: inputEnabled && isRawModeSupported && !pickers.isPickerActive && !snapshot.pendingApproval && !infoReport });

  const isLiveTurnTerminal = Boolean(snapshot.liveTurnId && isTerminalStatus(snapshot.status));
  const archiveActivePrompt = Boolean(snapshot.activePrompt?.turnId && snapshot.activePrompt.turnId === snapshot.liveTurnId && (snapshot.status === "completed" || snapshot.status === "failed"));
  const inlineHistoryItems: TuiInlineHistoryItem[] = isViewportMode ? [] : [
    TUI_BRAND_HISTORY_ITEM,
    ...snapshot.transcript.filter(function selectInlineHistoryItem(item): boolean {
      if (item.kind === "notice") return item.persistent === true;
      if (item.kind === "prompt" && item.key === snapshot.activePrompt?.key && !archiveActivePrompt) return false;
      if (item.kind === "turn") return item.turnId !== snapshot.liveTurnId || isLiveTurnTerminal;
      return true;
    }),
  ];
  const inlineOutput = inlineHistoryItems.map(function output(item) {
    if (item.kind === "turn") {
      const sequence = Math.max(0, ...item.events.filter(function runtime(event) { return event.seq < Number.MAX_SAFE_INTEGER; }).map(function seq(event) { return event.seq; }));
      return { key: `${props.inlineOutputKey ?? "session"}:turn:${item.turnId}`, sequence, render: function segment(after?: number) {
        const segment = after === undefined ? item : { ...item, presentation: undefined, events: item.events.filter(function newer(event) { return event.seq > after && event.seq < Number.MAX_SAFE_INTEGER; }) };
        return <MemoizedTuiTranscriptItem item={segment} columns={columns} useColor={props.useColor} screenReader={props.screenReader} />;
      } };
    }
    return { key: `${props.inlineOutputKey ?? "session"}:${item.key}`, node: item.kind === "brand"
      ? <TuiBrandHeader columns={columns} useColor={props.useColor} screenReader={props.screenReader} reducedMotion animationActive={false} />
      : <MemoizedTuiTranscriptItem item={item} columns={columns} useColor={props.useColor} screenReader={props.screenReader} /> };
  });

  return (
    <>
    {!isViewportMode ? <TuiInlineOutput items={inlineOutput} /> : null}
    <Box flexDirection="column" width={columns} height={isViewportMode ? rows : Math.max(1, Math.min(inlineHeight ?? maximumFrameRows, maximumFrameRows))} overflow="hidden" aria-role="list">
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" justifyContent={!isViewportMode && !jobView && !contextView && !infoReport ? "flex-end" : "flex-start"}>
      <Box ref={inlineBodyRef} position={isViewportMode ? "relative" : "absolute"} width={columns} flexDirection="column" flexShrink={0}>
      {infoReport ? <Box flexDirection="column" width={columns}>{reportLines.slice(reportOffset, reportOffset + reportHeight).map(function line(text, index) { return <Text key={index}>{text || " "}</Text>; })}<Text dimColor={props.useColor}>Esc 返回聊天 · ↑↓ / PgUp PgDn · {reportOffset + 1}/{reportLines.length}</Text></Box> : jobView ? <TuiJobs view={jobView} selectedIndex={jobSelectedIndex} useColor={props.useColor} screenReader={props.screenReader} /> : contextView ? <TuiContextReport usage={contextView.usage} expanded={contextView.expanded} columns={columns} useColor={props.useColor} screenReader={props.screenReader} /> : isViewportMode ? <>
        <TuiViewportTimeline lines={viewportLines} state={viewportState} columns={columns} useColor={props.useColor} selection={selection} />
        {snapshot.pendingApproval ? <Box ref={approvalBoxRef} flexDirection="column" flexShrink={0}><TuiApprovalPrompt height={approvalCardHeight} offset={approvalOffset} onMaximumOffset={function rememberMaximum(maximum) { approvalMaximumRef.current = maximum; }} details={approvalDetails} pendingApproval={snapshot.pendingApproval} selectedIndex={pickers.approvalPickerIndex} useColor={props.useColor} screenReader={props.screenReader} /></Box> : null}
      </> : <Box flexDirection="column" flexShrink={0}>
        {snapshot.activePrompt && !archiveActivePrompt ? <TuiPromptLine content={snapshot.activePrompt.content} keyValue={snapshot.activePrompt.key} columns={columns} useColor={props.useColor} /> : null}
        <TuiLiveTurn
          turnId={isLiveTurnTerminal ? undefined : snapshot.liveTurnId}
          events={snapshot.liveEvents}
          presentation={snapshot.livePresentation}
          pendingApproval={undefined}
          approvalSelectedIndex={pickers.approvalPickerIndex}
          status={snapshot.status}
          metrics={snapshot.liveMetrics}
          useColor={props.useColor}
          screenReader={props.screenReader}
          todoExpanded={todoExpanded}
          todoRowLimit={todoRowLimit}
          maximumWidth={Math.max(1, columns - 2)}
        />
        {snapshot.pendingInputs.map(function renderPendingInput(item): ReactNode {
          return item.delivery === "queue" ? <TuiPendingInputItem key={item.key} item={item} useColor={props.useColor} columns={columns} /> : null;
        })}
      </Box>}
      </Box>
      </Box>
      {!isViewportMode && snapshot.pendingApproval ? <Box ref={approvalBoxRef} flexDirection="column" flexShrink={0}><TuiApprovalPrompt height={approvalCardHeight} offset={approvalOffset} onMaximumOffset={function rememberMaximum(maximum) { approvalMaximumRef.current = maximum; }} details={approvalDetails} pendingApproval={snapshot.pendingApproval} selectedIndex={pickers.approvalPickerIndex} useColor={props.useColor} screenReader={props.screenReader} /></Box> : null}
      <Box ref={fixedRef} flexDirection="column" flexShrink={0}>
      <TuiActivityLine
        compacting={snapshot.compacting}
        threadWait={snapshot.threadWait}
        activity={snapshot.activity}
        status={snapshot.status}
        waitingForApproval={snapshot.pendingApproval !== undefined}
        useColor={props.useColor}
        screenReader={props.screenReader}
        reducedMotion={props.reducedMotion ?? false}
        animationActive={animationActive}
        clock={animationClock}
        runningSince={snapshot.liveMetrics?.runningSince}
        activeForm={activeTodoForm}
      />
      {approvalFeedback && <Text wrap="truncate">{approvalFeedback}</Text>}
      <Box height={!infoReport && infoMessages.length ? 2 : 0} overflow="hidden"><TuiInfoLines columns={columns} messages={infoMessages} useColor={props.useColor} /></Box>
      <Box ref={inputAreaRef} flexDirection="column" flexShrink={0}>
      <TuiInputArea
        parseInput={props.controller.parseInput}
        suggestSlashCommands={props.controller.suggestSlashCommands}
        draftRef={props.viewState?.draftRef}
        store={props.store}
        columns={columns}
        availableRows={maximumFrameRows - reservedInputRows}
        maximumPromptRows={Math.max(1, Math.min(4, rows - approvalCardHeight - statusHeight - 6))}
        busy={busy}
        keepOpenAfterCancel={keepOpenAfterCancel}
        lastSubmittedPromptRef={lastSubmittedPromptRef}
        rawInputSequenceRef={rawInputSequenceRef}
        dispatchAction={dispatchAction}
        onEof={props.onEof}
        onRequestInterrupt={props.onRequestInterrupt}
        onRequestCancel={props.onRequestCancel}
        isRawModeSupported={isRawModeSupported}
        isInputActive={inputEnabled && jobView === undefined && contextView === undefined && infoReport === undefined}
        canReceiveInput={props.canReceiveInput}
        bindInputHandler={props.bindInputHandler}
        onAttachmentsChange={props.onDraftAttachmentsChange}
        showInput={jobView === undefined && contextView === undefined && infoReport === undefined}
        useColor={props.useColor}
        screenReader={props.screenReader}
        pickers={pickers}
        derivedRef={derivedRef}
        fileMentionIndex={snapshot.status === "waiting_user_input" ? { entries: [], ready: false } : fileMentionIndex}
        onLayoutChange={handleInputLayoutChange}
      />
      </Box>
      <TuiStatusLine snapshot={snapshot} statusView={statusView} interactionLabel={hostStatus ?? props.interactionLabel} sessionTitle={props.sessionTitle} useColor={props.useColor} screenReader={props.screenReader} selectionCharacters={selectedText.length} escapeClosesPanel={props.escapeClosesPanel} />
      </Box>
    </Box>
    </>
  );
}
