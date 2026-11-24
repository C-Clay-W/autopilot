/** 启动临时品牌画面，与本地初始化并行，退出时只擦除本次 Ink 动态帧。 */
import { useEffect, useState, type ReactNode } from "react";
import { stripVTControlCharacters } from "node:util";
import { Box, Text, render } from "ink";
import { createTuiAnimationClock } from "../../animation-clock.js";
import { CLI_TUI_COLORS } from "../../design-tokens.js";
import { createDesktopResize } from "../desktop-resize.js";
import { readTuiTerminalSize } from "../format.js";
import { createTuiRenderStdout } from "../lifecycle.js";
import { getWindowsTuiResizeHost, resolveNoColor, resolveReducedMotion, resolveScreenReader } from "../render-mode.js";
import type { TuiOutputStream } from "../types.js";
import { createAgentLogoRows } from "./logo.js";
import { renderAutopilotColoredRows } from "./pixel.js";

/** 居中显示等比例点阵，小网格和读屏使用稳定文字，灰白扫光只提供装饰。 */
export function TuiStartupLogo(props: { columns: number; rows: number; elapsed: number; useColor: boolean; screenReader: boolean }): ReactNode {
  const height = Math.max(1, Math.min(20, props.rows - 1));
  const logoHeight = Math.min(16, height - 2, Math.floor(props.columns / 2));
  const logoWidth = logoHeight * 2;
  const compact = props.screenReader || logoHeight < 5;
  const rows = compact ? [] : createAgentLogoRows(logoWidth, logoHeight);
  /** 按时间与列位置选择现有灰阶，保持字符和占行完全稳定。 */
  function colorCell(char: string, column: number): string | undefined {
    if (!props.useColor || char === " ") return undefined;
    const light = (Math.sin(props.elapsed / 650 - column / 5) + 1) / 2;
    return light > 0.7 ? CLI_TUI_COLORS.copilotInk : light > 0.25 ? CLI_TUI_COLORS.copilotMuted : CLI_TUI_COLORS.copilotOutline;
  }
  return <Box width={props.columns} height={compact ? 1 : height} flexDirection="column" alignItems="center" justifyContent="center">
    {compact ? <Text wrap="truncate-end">Autopilot loading…</Text> : <>
      {renderAutopilotColoredRows(rows, colorCell, logoWidth)}
      <Text>Loading…</Text>
    </>}
  </Box>;
}

/** 挂载临时画面，首帧真正写入后计时；调用方仅在本地就绪后等待门槛。 */
export function startCliStartupLogo(output: TuiOutputStream, input: NodeJS.ReadStream, env: NodeJS.ProcessEnv = process.env) {
  // Ink 在 CI 中不输出动态帧，沿用其进程环境判定，避免等待永远不可见的首帧。
  if ([process.env.CI, process.env.CONTINUOUS_INTEGRATION].some(function enabled(value) { return value !== undefined && value !== "0" && value !== "false"; })) {
    return {
      /** CI 没有临时帧需要清理。 */
      dispose: function dispose(): void {},
      /** 沿用 Ink 的 CI 静态输出，不施加不可见动画门槛。 */
      finish: async function finish(): Promise<void> {},
    };
  }
  const desktop = createDesktopResize(output, env);
  const proxy = createTuiRenderStdout(output, readTuiTerminalSize(desktop.source), getWindowsTuiResizeHost(output.isTTY, env) !== undefined, written);
  const screenReader = resolveScreenReader(env);
  const animate = !screenReader && !resolveReducedMotion(env) && !resolveNoColor(env);
  const clock = createTuiAnimationClock({ frameMs: 120 });
  let instance: ReturnType<typeof render> | undefined;
  let firstFrame: number | undefined;
  let markVisible!: () => void;
  const visible = new Promise<void>(function waitVisible(resolve) { markVisible = resolve; });
  let pendingSize: { columns: number; rows: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  let disposed = false;

  /** 在输出代理真正写入可见文字后开始计时，排除 Ink 布局与节流等待。 */
  function written(chunk: string): void {
    desktop.written(chunk);
    if (disposed || firstFrame !== undefined || !stripVTControlCharacters(chunk).trim()) return;
    firstFrame = Date.now();
    markVisible();
  }

  /** 清理动画、尺寸监听和临时画面，既有 scrollback 不参与清理。 */
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    markVisible();
    if (timer) clearTimeout(timer);
    release?.();
    clock.dispose();
    instance?.rerender(<></>);
    instance?.clear();
    instance?.unmount();
    desktop.close();
  }

  /** 尺寸先通过组件提交短帧，再提交给 Ink，沿用 Desktop 两阶段缩窗机制。 */
  function StartupApp(): ReactNode {
    const [size, setSize] = useState(readTuiTerminalSize(desktop.source));
    const [elapsed, setElapsed] = useState(0);
    /** 同一时钟只刷新装饰亮度，无色和辅助模式没有动画订阅。 */
    function subscribeAnimation(): (() => void) | undefined {
      if (!animate) return;
      return clock.subscribe(function tick(time) { setElapsed(time - (firstFrame ?? time)); });
    }
    /** 将 resize 同步到布局目标，真正的 Ink 尺寸在该帧写入后提交。 */
    function subscribeResize(): () => void {
      function resized(): void {
        const next = readTuiTerminalSize(desktop.source);
        pendingSize = next;
        setSize(next);
      }
      desktop.source.on?.("resize", resized);
      return function detach(): void { desktop.source.off?.("resize", resized); };
    }
    useEffect(subscribeAnimation, []);
    useEffect(subscribeResize, []);
    return <TuiStartupLogo {...size} elapsed={elapsed} useColor={!resolveNoColor(env) && !screenReader} screenReader={screenReader} />;
  }

  try {
    instance = render(<StartupApp />, {
      stdout: proxy.stdout as NodeJS.WriteStream, stdin: input, exitOnCtrlC: false,
      patchConsole: false, incrementalRendering: false, isScreenReaderEnabled: screenReader,
      /** Ink 在实际输出前回调，微任务在同步写入完成后提交真实尺寸。 */
      onRender: function rendered(): void {
        queueMicrotask(function committed(): void {
          if (disposed) return;
          const next = pendingSize;
          pendingSize = undefined;
          if (next) proxy.setSize(next);
        });
      },
    });
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    dispose,
    /** 本地就绪后补足首帧两秒，初始化失败直接走 dispose，无额外延迟。 */
    async finish(): Promise<void> {
      await visible;
      if (disposed) return;
      await new Promise<void>(function waitMinimum(resolve) {
        release = resolve;
        timer = setTimeout(resolve, Math.max(0, 2000 - (Date.now() - (firstFrame ?? Date.now()))));
      });
      dispose();
    },
  };
}
