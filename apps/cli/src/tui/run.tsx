/** TUI 入口编排：启动 Ink，统一处理信号、退出码和动态渲染生命周期。 */

import { render } from "ink";
import { createDesktopResize } from "./desktop-resize.js";
import { createTuiInputRouter, type TuiSgrMouseEvent } from "../tui-input-router.js";
import type { CliControllerResult } from "../controller.js";
import type { CliEventListener, CliExitCode } from "../types.js";
import { CliSessionWorkspace } from "./session-workspace.js";
import { CliTuiApp } from "./app.js";
import { getTuiStatusLabel, isActiveTuiStatus, isTerminalStatus, readTuiTerminalSize } from "./format.js";
import { createRoutedTuiStdin, createTuiMouseInputSink, createTuiRenderStdout, createTuiTerminalLifecycle } from "./lifecycle.js";
import { getTuiRenderModeFallbackNotice, getWindowsTuiResizeHost, resolveNoColor, resolveReducedMotion, resolveScreenReader, resolveTuiRenderMode, TuiManagedTerminalStyles } from "./render-mode.js";
import { createCliTuiStore } from "./store.js";
import type { CliTuiRecap, RunCliTuiOptions, RunCliTuiResult } from "./types.js";

/** 将已知的安全会话字段格式化为主屏 recap；输出保持纯文本，兼容 NO_COLOR。 */
export function formatCliTuiRecap(recap: CliTuiRecap): string {
  const canResume = recap.recoverable
    && (recap.finalStatus === "waiting_approval" || recap.finalStatus === "interrupted_recoverable" || recap.finalStatus === "limit_reached");
  const resumeHint = canResume ? ` · Resume: ap resume --session ${recap.sessionId}` : "";
  return `Autopilot recap · Session: ${recap.sessionId} · Completed turns: ${recap.completedTurnCount} · Final status: ${getTuiStatusLabel(recap.finalStatus)}${resumeHint}\n`;
}

/** 启动 Ink，统一处理信号、退出码和动态渲染生命周期。 */
export async function runCliTui(options: RunCliTuiOptions): Promise<RunCliTuiResult> {
  const env = options.env ?? process.env;
  const store = options.sessionManager?.selected().store ?? options.store ?? createCliTuiStore();
  const noColor = resolveNoColor(env);
  const screenReader = resolveScreenReader(env);
  const renderMode = resolveTuiRenderMode(env);
  const desktopResize = createDesktopResize(options.streams.stdout, env);
  const terminalSizeSource = desktopResize.source;
  const resizeHost = getWindowsTuiResizeHost(options.streams.stdout.isTTY, env);
  const replayOnWidthChange = resizeHost === "external" && renderMode === "inline" && !screenReader;
  const renderStdout = createTuiRenderStdout(options.streams.stdout, readTuiTerminalSize(terminalSizeSource), resizeHost !== undefined, desktopResize.written, replayOnWidthChange);
  const fallbackNotice = getTuiRenderModeFallbackNotice({ env, platform: process.platform });
  if (fallbackNotice) options.streams.stderr.write(fallbackNotice);
  const terminalLifecycle = createTuiTerminalLifecycle(options.streams.stdout, renderMode);
  const mouseInput = createTuiMouseInputSink();
  const routedStdin = createRoutedTuiStdin(options.streams.stdin);
  const inputRouter = createTuiInputRouter();
  const reducedMotion = resolveReducedMotion(env);
  // Ink 的 auto 预检没有覆盖 Windows Terminal；WT 1.24 支持 Kitty keyboard protocol，必须主动启用才能区分 Shift+Enter。
  const kittyKeyboardMode = env.WT_SESSION ? "enabled" : "auto";
  let requestedExitCode: CliExitCode | undefined;
  let lastResult: CliControllerResult | undefined;
  let instance: ReturnType<typeof render> | undefined;
  let pendingRenderSize: { columns: number; rows: number } | undefined;
  /** 先让Ink用旧尺寸完成新短帧，再提交真实新尺寸，避免旧帧高度触发Static全量重放。 */
  function requestRenderSize(size: { columns: number; rows: number }): void { pendingRenderSize = size; }
  /** onRender回调发生在同步输出之前，微任务确保高度记账已更新；尺寸不伪造。 */
  function commitRenderedSize(): void {
    queueMicrotask(function commit() {
      const size = pendingRenderSize;
      pendingRenderSize = undefined;
      if (size) renderStdout.setSize(size);
    });
  }

  let pendingWheelNotches = 0;
  let pendingWheelEvent: TuiSgrMouseEvent | undefined;
  let mouseFlushTimer: ReturnType<typeof setTimeout> | undefined;

  /** 把同一 16ms 窗口内的滚轮 notch 合并为一次视口状态更新。 */
  function flushMouseWheel(): void {
    mouseFlushTimer = undefined;
    const event = pendingWheelEvent;
    const wheelNotches = Math.abs(pendingWheelNotches);
    pendingWheelEvent = undefined;
    pendingWheelNotches = 0;
    if (event && wheelNotches > 0) mouseInput.dispatch(event, wheelNotches);
  }

  /** 记录无法解析的 SGR 鼠标输入，而不把控制字节泄漏给 Ink prompt。 */
  function recordMouseDiagnostics(diagnostics: Array<"invalid_sgr_mouse" | "sgr_mouse_overflow">): void {
    for (const diagnostic of diagnostics) store.addNotice(`terminal mouse input ignored (${diagnostic})`);
  }

  /** 单点消费真实 stdin：鼠标交给视口，其余字节按原顺序交给 Ink。 */
  function routeRawTuiInput(chunk: string | Buffer): void {
    const routed = inputRouter.push(String(chunk));
    recordMouseDiagnostics(routed.diagnostics);
    if (routed.passthrough.includes("\u001b[I")) terminalLifecycle.reassert();
    if (routed.passthrough) routedStdin.write(routed.passthrough);
    for (const event of routed.mouseEvents) {
      if (event.kind !== "wheel_up" && event.kind !== "wheel_down") {
        mouseInput.dispatch(event);
        continue;
      }
      const delta = event.kind === "wheel_up" ? 1 : -1;
      if (pendingWheelNotches !== 0 && Math.sign(pendingWheelNotches) !== delta) flushMouseWheel();
      pendingWheelNotches += delta;
      pendingWheelEvent = event;
      if (!mouseFlushTimer) mouseFlushTimer = setTimeout(flushMouseWheel, 16);
    }
  }

  /** 输入结束时丢弃残缺 SGR 前缀并关闭 Ink 专用输入流。 */
  function finishRawTuiInput(): void {
    recordMouseDiagnostics(inputRouter.finish().diagnostics);
    flushMouseWheel();
    routedStdin.end();
  }

  options.streams.stdin.on("data", routeRawTuiInput);
  options.streams.stdin.once("end", finishRawTuiInput);

  function finish(code: CliExitCode): void {
    requestedExitCode = requestedExitCode ?? code;
    instance?.unmount();
  }

  /** 在 TUI 终端恢复后尽力输出统一安全摘要；输出失败不能掩盖原本的退出或异常。 */
  function writeTuiRecap(): void {
    if (!options.sessionId) return;
    const snapshot = (options.sessionManager?.selected().store ?? store).getSnapshot();
    const completedTurnCount = snapshot.transcript.filter(function countCompletedTurn(item): boolean {
      return item.kind === "turn" && item.status === "completed";
    }).length;
    try {
      options.streams.stdout.write(`\n${formatCliTuiRecap({
        sessionId: options.sessionManager?.selected().sessionId ?? options.sessionId,
        completedTurnCount,
        finalStatus: snapshot.status,
        recoverable: snapshot.recoverable,
      })}`);
    } catch {
      // 终端已断开时只保证先完成 restore，recap 为尽力输出。
    }
  }

  function handleResult(result: CliControllerResult): void {
    lastResult = result;
    store.syncProjection(result.projection);
    // 专用视图结果由 app 层打开覆盖视图；禁止复用 notice 路径把报告行截成零散 info。
    if (result.skillOptions || result.permissionOptions || result.modelOptions || result.effortOptions || result.jobView || result.contextView) return;
    const lines = result.lines.filter(function keepNotice(line) {
      const trimmed = line.trim();
      // queue 的投递/启动由 pending prompt 和新 Turn 时间线表达，不再重复显示为两行 info。
      return trimmed.length > 0 && !trimmed.startsWith("input queued:") && !trimmed.startsWith("queued input started:");
    });
    for (const line of lines) store.addNotice(line);
    if (lines.length === 0 && result.message) store.addNotice(result.message);
  }

  /** 向 Runtime 请求当前活动 Turn 取消，但保留 Ink TUI 等待终态并回到 prompt。 */
  function requestCancellation(): void {
    const current = store.getSnapshot();
    if (!isActiveTuiStatus(current.status) || current.cancellationRequested) return;
    store.setCancellationRequested(true);
    void options.controller.dispatch({ type: "cancel_turn" }).then(function finished(result) {
      if (result.kind === "error" && store.getSnapshot().liveTurnId === current.liveTurnId) store.setCancellationRequested(false);
      handleResult(result);
    }).catch(function handleCancelFailure() {
      if (store.getSnapshot().liveTurnId === current.liveTurnId) store.setCancellationRequested(false);
      store.addNotice("turn cancellation failed");
    });
  }

  /** Ctrl+C退出整个宿主；具体owner收尾交Main，不沿创建来源取消。 */
  function requestInterrupt(): void { finish(130); }

  /** Esc只取消提交时选中目标，列表/picker优先消费；不退出宿主。 */
  function requestCancel(): void {
    if (!options.sessionManager) { requestCancellation(); return; }
    const entry = options.sessionManager.selected();
    const current = entry.store.getSnapshot();
    if (!isActiveTuiStatus(current.status) || current.cancellationRequested) return;
    entry.store.setCancellationRequested(true);
    void entry.controller.dispatch({ type: "cancel_turn" }).then(function completed(result) { options.sessionManager!.handleResult(entry, result); }).catch(function failed() { entry.store.setCancellationRequested(false); entry.store.addNotice("turn cancellation failed"); });
  }

  /** SIGTERM与EOF都退出整个宿主，不把等待审批伪装为完成。 */
  function requestSignalStop(code: 130 | 143): void { finish(code); }
  function handleEof(): void { finish(0); }

  function handleSigint(): void { requestInterrupt(); }
  function handleSigterm(): void { requestSignalStop(143); }
  options.signalSource.on("SIGINT", handleSigint);
  options.signalSource.on("SIGTERM", handleSigterm);

  const listener: CliEventListener = function receiveEvent(event, projection): void {
    store.acceptEvent(event, projection);
    if (event.type === "status" && isTerminalStatus(event.status) && requestedExitCode !== undefined) finish(requestedExitCode);
  };
  if (!options.sessionManager) options.controller.setEventListener?.(listener);
  if (!options.sessionManager) options.controller.setQueuedInputListener?.(function receiveQueuedInputStarted(input): void {
    store.markQueuedInputStarted(input);
  });
  const App = options.sessionManager ? CliSessionWorkspace : CliTuiApp;
  const node = (
    <App
      manager={options.sessionManager!}
      store={store}
      controller={options.controller}
      initial={options.initial}
      closeWhenIdle={options.closeWhenIdle}
      workspaceRoot={options.workspaceRoot}
      useColor={!noColor && !screenReader}
      screenReader={screenReader}
      renderMode={renderMode}
      reducedMotion={reducedMotion}
      mouseInput={mouseInput}
      onResult={options.sessionManager ? function rememberResult(result) { lastResult = result; } : handleResult}
      onRequestInterrupt={requestInterrupt}
      onRequestCancel={requestCancel}
      onEof={handleEof}
      onAppExit={finish}
      terminalSizeSource={terminalSizeSource}
      onTerminalSizeChange={requestRenderSize}
    />
  );
  try {
    terminalLifecycle.enter();
    instance = render(<TuiManagedTerminalStyles.Provider value={options.managedPromptBackground === true && !screenReader}>{node}</TuiManagedTerminalStyles.Provider>, {
      stdout: renderStdout.stdout as NodeJS.WriteStream,
      stderr: options.streams.stderr as NodeJS.WriteStream,
      stdin: routedStdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: true,
      // 输入框和动态时间线会改变行高；Windows Terminal 下增量渲染会残留旧帧，
      // 表现为逐字符重复或内容重叠。使用完整帧保证当前交互区域正确。
      incrementalRendering: false,
      onRender: commitRenderedSize,
      isScreenReaderEnabled: screenReader,
      kittyKeyboard: { mode: kittyKeyboardMode },
    });
    // CC 在 AlternateScreen 挂载后再次声明鼠标模式；Ink 初始化完成后重申一次，避免真实终端只保留键盘模式。
    terminalLifecycle.reassert();
    await instance.waitUntilExit();
  } finally {
    desktopResize.close();
    if (mouseFlushTimer) clearTimeout(mouseFlushTimer);
    options.streams.stdin.removeListener("data", routeRawTuiInput);
    options.streams.stdin.removeListener("end", finishRawTuiInput);
    mouseInput.setHandler(undefined);
    routedStdin.end();
    terminalLifecycle.restore();
    writeTuiRecap();
    options.signalSource.removeListener("SIGINT", handleSigint);
    options.signalSource.removeListener("SIGTERM", handleSigterm);
  }
  const projection = options.controller.getProjection();
  const result = lastResult ?? {
    kind: "exit",
    exitCode: requestedExitCode ?? 0,
    lines: [],
    projection,
  };
  return { result, exitCode: requestedExitCode ?? result.exitCode };
}
