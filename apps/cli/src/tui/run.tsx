/** TUI 入口编排：启动 Ink，统一处理信号、退出码和动态渲染生命周期。 */

import { render } from "ink";
import { createTuiInputRouter, type TuiSgrMouseEvent } from "../tui-input-router.js";
import type { CliControllerResult } from "../controller.js";
import type { CliEventListener, CliExitCode } from "../types.js";
import { CliTuiApp } from "./app.js";
import { getTuiStatusLabel, isActiveTuiStatus, isTerminalStatus, readTuiTerminalSize } from "./format.js";
import { createRoutedTuiStdin, createTuiMouseInputSink, createTuiRenderStdout, createTuiTerminalLifecycle } from "./lifecycle.js";
import { getTuiRenderModeFallbackNotice, resolveNoColor, resolveReducedMotion, resolveScreenReader, resolveTuiRenderMode } from "./render-mode.js";
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
  const store = createCliTuiStore();
  const noColor = resolveNoColor(env);
  const screenReader = resolveScreenReader(env);
  const renderMode = resolveTuiRenderMode(env);
  const terminalSizeSource = options.streams.stdout;
  const renderStdout = createTuiRenderStdout(terminalSizeSource, readTuiTerminalSize(terminalSizeSource));
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
  let lastInterruptAt = 0;
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
    const snapshot = store.getSnapshot();
    const completedTurnCount = snapshot.transcript.filter(function countCompletedTurn(item): boolean {
      return item.kind === "turn" && item.status === "completed";
    }).length;
    try {
      options.streams.stdout.write(`\n${formatCliTuiRecap({
        sessionId: options.sessionId,
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
    void options.controller.dispatch({ type: "cancel_turn" }).then(handleResult).catch(function handleCancelFailure() {
      store.setCancellationRequested(false);
      store.addNotice("turn cancellation failed");
    });
  }

  /** 处理 TUI 内 Ctrl+C：首次取消当前 Turn，取消收口前第二次强制退出。 */
  function requestInterrupt(): void {
    const now = Date.now();
    const current = store.getSnapshot();
    if (isActiveTuiStatus(current.status)) {
      if (current.cancellationRequested) {
        if (now - lastInterruptAt < 100) return;
        options.streams.stderr.write("forced exit before cancellation completed; recovery status unknown\n");
        finish(130);
        terminalLifecycle.restore();
        options.forceExit?.(130);
        return;
      }
      lastInterruptAt = now;
      requestCancellation();
      return;
    }
    finish(130);
  }

  /** 处理 Esc：只取消活动 Turn，不把 Esc 解释为退出进程。 */
  function requestCancel(): void {
    requestCancellation();
  }

  /** 处理宿主 SIGINT/SIGTERM：取消后以相应进程退出码收口。 */
  function requestSignalStop(code: 130 | 143): void {
    requestedExitCode = requestedExitCode ?? code;
    store.requestExit(code);
    if (isActiveTuiStatus(store.getSnapshot().status)) {
      requestCancellation();
      return;
    }
    finish(code);
  }

  function handleEof(): void {
    requestedExitCode = requestedExitCode ?? 0;
    store.requestExit(0);
    const current = store.getSnapshot();
    if (current.status === "running" || current.status === "waiting_approval") {
      void options.controller.dispatch({ type: "cancel_turn" }).then(handleResult).catch(function ignoreEofCancelFailure() {
        finish(0);
      });
      return;
    }
    finish(0);
  }

  function handleSigint(): void { requestInterrupt(); }
  function handleSigterm(): void { requestSignalStop(143); }
  options.signalSource.on("SIGINT", handleSigint);
  options.signalSource.on("SIGTERM", handleSigterm);

  const listener: CliEventListener = function receiveEvent(event, projection): void {
    store.acceptEvent(event, projection);
    if (event.type === "status" && isTerminalStatus(event.status) && requestedExitCode !== undefined) finish(requestedExitCode);
  };
  options.controller.setEventListener?.(listener);
  options.controller.setQueuedInputListener?.(function receiveQueuedInputStarted(input): void {
    store.markQueuedInputStarted(input);
  });
  const node = (
    <CliTuiApp
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
      onResult={handleResult}
      onRequestInterrupt={requestInterrupt}
      onRequestCancel={requestCancel}
      onEof={handleEof}
      onAppExit={finish}
      terminalSizeSource={terminalSizeSource}
      onTerminalSizeChange={renderStdout.setSize}
    />
  );
  try {
    terminalLifecycle.enter();
    instance = render(node, {
      stdout: renderStdout.stdout as NodeJS.WriteStream,
      stderr: options.streams.stderr as NodeJS.WriteStream,
      stdin: routedStdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: true,
      // 输入框和动态时间线会改变行高；Windows Terminal 下增量渲染会残留旧帧，
      // 表现为逐字符重复或内容重叠。使用完整帧保证当前交互区域正确。
      incrementalRendering: false,
      isScreenReaderEnabled: screenReader,
      kittyKeyboard: { mode: kittyKeyboardMode },
    });
    // CC 在 AlternateScreen 挂载后再次声明鼠标模式；Ink 初始化完成后重申一次，避免真实终端只保留键盘模式。
    terminalLifecycle.reassert();
    await instance.waitUntilExit();
  } finally {
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
