/** 瘦身后的 Ink 应用组件：编排 store 订阅、dispatchAction、动画时钟与渲染。 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, useInput, useStdin, useStdout, type Key } from "ink";
import { TuiActivityLine } from "../activity-animation.js";
import { createTuiAnimationClock, type TuiAnimationClock } from "../animation-clock.js";
import type { CliController, CliControllerResult } from "../controller.js";
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

const EMPTY_VIEWPORT_SOURCES: TimelineLineSource[] = [];
const EMPTY_VIEWPORT_LINES: TimelineVisualLine[] = [];

/** Ink 应用组件；useInput 只把用户动作交给 Controller Action。 */
export function CliTuiApp(props: {
  store: CliTuiStore;
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
  const rawInputSequenceRef = useRef("");
  const busy = useRef(false);
  const keepOpenAfterCancel = useRef(false);
  const lastSubmittedPromptRef = useRef<string | undefined>(undefined);
  const initialStarted = useRef(false);
  const lastResult = useRef<CliControllerResult | undefined>(undefined);
  const animationClockRef = useRef<TuiAnimationClock | undefined>(undefined);
  if (!animationClockRef.current) animationClockRef.current = createTuiAnimationClock();
  const animationClock = animationClockRef.current;
  /** 防抖后的终端尺寸；Ink 与应用布局共同使用同一份稳定快照。 */
  const [terminalSize, setTerminalSize] = useState(function createTerminalSize() {
    return readTuiTerminalSize(terminalSizeSource);
  });
  const isViewportMode = props.renderMode === "alternate-screen" && !props.screenReader;
  const columns = terminalSize.columns;
  const rows = terminalSize.rows;

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
    .filter(function isNotice(item): item is Extract<CliTuiTranscriptItem, { kind: "notice" }> { return item.kind === "notice"; })
    .slice(-4)
    .map(function getNoticeMessage(item): string { return item.message; });
  const approvalHeight = isViewportMode && snapshot.pendingApproval ? createTuiApprovalOptions(snapshot.pendingApproval).length + 6 : 0;
  // Todo 展开态最多占 10 行；矮终端为输入框、状态栏和活动文案至少保留 6 行。
  const todoRowLimit = Math.max(2, Math.min(10, rows - 6));
  const activeTodoForm = getTuiTurnTodo(snapshot.liveEvents, snapshot.liveTurnId ?? "")?.todos.find(function active(todo) { return todo.status === "in_progress"; })?.activeForm;
  const fixedHeight = inputLayout.promptHeight + inputLayout.pickerHeight + approvalHeight + infoMessages.length + 1 + (statusView ? 5 : 2);
  const viewportHeight = Math.max(1, rows - fixedHeight);
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
  });

  derivedRef.current.handleTuiViewportKey = handleTuiViewportKey;

  const selectedText = isViewportMode ? getTuiSelectedText(viewportLines, selection) : "";
  const animationActive = isRawModeSupported && stdout.isTTY !== false && terminalFocused;

  /** 把用户动作交给 Controller；结束后刷新状态栏并按投影结果打开对应 picker。 */
  async function dispatchAction(action: CliAction, prompt?: string, preserveSkillPickerQuery = false): Promise<void> {
    const allowWhileRunning = (action.type === "submit_prompt" || action.type === "open_permissions" || action.type === "set_permission_mode" || action.type === "open_model_picker" || action.type === "set_model" || action.type === "open_effort_picker" || action.type === "set_effort" || action.type === "list_jobs" || action.type === "show_job" || action.type === "read_job_output" || action.type === "stop_job") && isActiveTuiStatus(props.store.getSnapshot().status);
    if (busy.current && !allowWhileRunning) return;
    const isJobAction = action.type === "list_jobs" || action.type === "show_job" || action.type === "read_job_output" || action.type === "stop_job";
    const jobGeneration = isJobAction ? ++jobRequestGeneration.current : undefined;
    const inputPosition = prompt && allowWhileRunning ? props.store.captureInputPosition() : undefined;
    if (prompt) {
      lastSubmittedPromptRef.current = prompt.trim();
      props.store.recordPrompt(prompt, !allowWhileRunning);
    }
    if (action.type === "approve") props.store.recordApprovalSubmission(action.decision);
    if (!allowWhileRunning) busy.current = true;
    // D2/D5：仅交互 TUI 在发送前把 @ 引用的工作区文件内容以 <system-reminder> 附加块并入 action.content；
    // start/steer/queue/initial 四条 TUI 提交路径都经过此处，时间线与 Esc 恢复仍使用原文 prompt。
    let dispatchedAction = action;
    if (action.type === "submit_prompt" && prompt && props.workspaceRoot) {
      const resolved = await resolveFileMentionContext(action.content, props.workspaceRoot);
      for (const message of resolved.notices) props.store.addNotice(message);
      if (resolved.content !== action.content) dispatchedAction = { ...action, content: resolved.content };
    }
    let result: CliControllerResult;
    try {
      result = await props.controller.dispatch(dispatchedAction);
    } catch (error) {
      recordTuiRuntimeErrorDiagnostic(error);
      result = {
        kind: "error",
        exitCode: 1,
        lines: [],
        message: "CLI_RUNTIME_ERROR",
        projection: props.controller.getProjection(),
      };
    } finally {
      if (!allowWhileRunning) busy.current = false;
    }
    lastResult.current = result;
    props.onResult(result);
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
    if (!onResize || !offResize) return;
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
    props.onTerminalSizeChange?.(terminalSize);
  }, [terminalSize, props.onTerminalSizeChange]);

  useEffect(function bindTuiMouseInput() {
    props.mouseInput?.setHandler(handleTuiMouseEvent);
    return function unbindTuiMouseInput(): void {
      props.mouseInput?.setHandler(undefined);
    };
  }, [props.mouseInput, isViewportMode, columns, viewportHeight, viewportLines.length]);

  useEffect(function resetApprovalSelection() {
    pickers.updateApprovalPickerIndex(0);
  }, [snapshot.pendingApproval?.approvalId]);

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

  useEffect(function refreshStatusOnTurnChange() {
    void refreshStatusView();
  }, [props.controller, snapshot.status, snapshot.liveTurnId]);

  // 用量事件到达时重新查询状态栏，让 context 行在 Turn 运行中也能反映三态变化。
  useEffect(function refreshStatusOnContextUsage() {
    void refreshStatusView();
  }, [props.controller, snapshot.contextUsage]);

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
    if (props.initial.type === "start") {
      void dispatchAction({ type: "submit_prompt", content: props.initial.content }, props.initial.content);
    } else {
      void (async function resumeInitialTurn(): Promise<void> {
        if (busy.current) return;
        busy.current = true;
        let result: CliControllerResult;
        try {
          result = await props.controller.resume();
        } catch {
          result = {
            kind: "error",
            exitCode: 1,
            lines: [],
            message: "CLI_RUNTIME_ERROR",
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

  /** 在 Job 视图内复用 Ink 输入路由；Esc 只返回视图，不取消 Turn 或退出进程。 */
  useInput(function handleJobInput(value: string, key: Key): void {
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
  }, { isActive: isRawModeSupported && jobView !== undefined });

  /** 在 Context 覆盖视图内复用 Ink 输入路由；Esc 只关闭视图回到聊天，不取消 Turn 或退出进程。 */
  useInput(function handleContextInput(value: string, key: Key): void {
    if (contextView === undefined) return;
    if (key.escape || value === "\u001b") setContextView(undefined);
  }, { isActive: isRawModeSupported && contextView !== undefined });

  // Ctrl+O 只切换 Todo 展开视图；picker 与审批等待打开时让位，避免按键语义冲突。
  useInput(function handleTodoExpandInput(input: string, key: Key): void {
    if (key.ctrl && input === "o") setTodoExpanded(function toggleTodoExpanded(previous): boolean { return !previous; });
  }, { isActive: isRawModeSupported && !pickers.isPickerActive && !snapshot.pendingApproval });

  const isLiveTurnTerminal = Boolean(snapshot.liveTurnId && isTerminalStatus(snapshot.status));
  const inlineHistoryItems: TuiInlineHistoryItem[] = isViewportMode ? [] : [
    TUI_BRAND_HISTORY_ITEM,
    ...snapshot.transcript.filter(function selectInlineHistoryItem(item): boolean {
      if (item.kind === "notice") return false;
      if (item.kind === "turn") return item.turnId !== snapshot.liveTurnId || isLiveTurnTerminal;
      return item.key !== snapshot.activePrompt?.key || isLiveTurnTerminal;
    }),
  ];
  const activePrompt = snapshot.activePrompt && !isLiveTurnTerminal ? snapshot.activePrompt : undefined;

  return (
    <Box flexDirection="column" width={columns} aria-role="list">
      {jobView ? <TuiJobs view={jobView} selectedIndex={jobSelectedIndex} useColor={props.useColor} screenReader={props.screenReader} /> : contextView ? <TuiContextReport usage={contextView.usage} expanded={contextView.expanded} columns={columns} useColor={props.useColor} screenReader={props.screenReader} /> : isViewportMode ? <>
        <TuiViewportTimeline lines={viewportLines} state={viewportState} columns={columns} useColor={props.useColor} selection={selection} />
        {snapshot.pendingApproval ? <TuiApprovalPrompt pendingApproval={snapshot.pendingApproval} selectedIndex={pickers.approvalPickerIndex} useColor={props.useColor} screenReader={props.screenReader} /> : null}
      </> : <>
        {inlineHistoryItems.map(function renderInlineHistoryItem(item: TuiInlineHistoryItem): ReactNode {
          if (item.kind !== "brand") {
            return <MemoizedTuiTranscriptItem key={item.key} item={item} columns={columns} useColor={props.useColor} screenReader={props.screenReader} />;
          }
          return <TuiBrandHeader
            key={item.key}
            statusView={statusView}
            columns={columns}
            useColor={props.useColor}
            screenReader={props.screenReader}
            reducedMotion={props.reducedMotion ?? false}
            animationActive={false}
          />;
        })}
        {activePrompt ? <TuiPromptLine
          content={activePrompt.content}
          columns={columns}
          useColor={props.useColor}
          keyValue={activePrompt.key}
        /> : null}
        <TuiLiveTurn
          turnId={isLiveTurnTerminal ? undefined : snapshot.liveTurnId}
          events={snapshot.liveEvents}
          presentation={snapshot.livePresentation}
          pendingApproval={snapshot.pendingApproval}
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
          return item.delivery === "queue" ? <TuiPendingInputItem key={item.key} item={item} useColor={props.useColor} /> : null;
        })}
      </>}
      <TuiActivityLine
        activity={snapshot.activity}
        status={snapshot.status}
        waitingForApproval={snapshot.pendingApproval !== undefined}
        useColor={props.useColor}
        screenReader={props.screenReader}
        reducedMotion={props.reducedMotion ?? false}
        animationActive={animationActive}
        clock={animationClock}
        startedAt={snapshot.liveMetrics?.startedAt}
        activeForm={activeTodoForm}
      />
      <TuiInfoLines messages={infoMessages} useColor={props.useColor} />
      <TuiInputArea
        store={props.store}
        columns={columns}
        busy={busy}
        keepOpenAfterCancel={keepOpenAfterCancel}
        lastSubmittedPromptRef={lastSubmittedPromptRef}
        rawInputSequenceRef={rawInputSequenceRef}
        dispatchAction={dispatchAction}
        onEof={props.onEof}
        onRequestInterrupt={props.onRequestInterrupt}
        onRequestCancel={props.onRequestCancel}
        isRawModeSupported={isRawModeSupported}
        isInputActive={jobView === undefined && contextView === undefined}
        showInput={jobView === undefined && contextView === undefined}
        useColor={props.useColor}
        screenReader={props.screenReader}
        pickers={pickers}
        derivedRef={derivedRef}
        fileMentionIndex={fileMentionIndex}
        onLayoutChange={handleInputLayoutChange}
      />
      <TuiStatusLine snapshot={snapshot} statusView={statusView} useColor={props.useColor} screenReader={props.screenReader} selectionCharacters={selectedText.length} />
    </Box>
  );
}
