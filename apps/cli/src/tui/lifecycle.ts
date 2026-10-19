/** TUI 终端生命周期：鼠标事件入口、Ink stdin 包装与幂等的控制序列生命周期。 */

import { PassThrough } from "node:stream";
import type { TuiSgrMouseEvent } from "../tui-input-router.js";
import {
  TUI_ALTERNATE_SCREEN_DISABLE,
  TUI_ALTERNATE_SCREEN_ENABLE,
  TUI_BRACKETED_PASTE_DISABLE,
  TUI_BRACKETED_PASTE_ENABLE,
  TUI_INLINE_RESIZE_CLEAR,
  TUI_MOUSE_TRACKING_DISABLE,
  TUI_MOUSE_TRACKING_ENABLE,
  TUI_TERMINAL_FOCUS_DISABLE,
  TUI_TERMINAL_FOCUS_ENABLE,
} from "./constants.js";
import type { TuiMouseInputSink, TuiRenderMode, TuiTerminalLifecycle } from "./types.js";
import type { TuiOutputStream } from "./types.js";

/** Ink 使用的稳定尺寸输出代理；它转发写入并在新布局提交后通知 resize。 */
class StableTuiOutputStream {
  private size: { columns: number; rows: number };
  private readonly resizeListeners = new Set<(...args: unknown[]) => void>();

  public constructor(private readonly source: TuiOutputStream, initialSize: { columns: number; rows: number }) {
    this.size = initialSize;
  }

  public get columns(): number { return this.size.columns; }

  public get rows(): number { return this.size.rows; }

  public get isTTY(): boolean | undefined { return this.source.isTTY; }

  /** 将 Ink 的所有输出原样写入真实终端。 */
  public write(chunk: string, ...args: unknown[]): boolean {
    const write = this.source.write as unknown as (...writeArgs: unknown[]) => unknown;
    const result = write.call(this.source, chunk, ...args);
    return result !== false;
  }

  /** 保存 Ink 的 resize 监听，等待应用布局提交后再触发。 */
  public on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === "resize") this.resizeListeners.add(listener);
    return this;
  }

  /** 移除 Ink 的 resize 监听，满足 Ink 卸载时的监听清理。 */
  public off(event: string, listener: (...args: unknown[]) => void): this {
    if (event === "resize") this.resizeListeners.delete(listener);
    return this;
  }

  /** 更新 Ink 后续布局使用的稳定尺寸，并在缩窄时清空旧物理回流行及 scrollback。 */
  public setSize(size: { columns: number; rows: number }): void {
    const changed = size.columns !== this.size.columns || size.rows !== this.size.rows;
    const widthDecreased = size.columns < this.size.columns;
    this.size = size;
    if (!changed) return;
    if (widthDecreased) this.source.write(TUI_INLINE_RESIZE_CLEAR);
    for (const listener of this.resizeListeners) listener();
  }
}

/** 创建跨 DPI resize 时使用的 Ink 输出代理与尺寸提交函数。 */
export function createTuiRenderStdout(source: TuiOutputStream, initialSize: { columns: number; rows: number }): { stdout: TuiOutputStream; setSize(size: { columns: number; rows: number }): void } {
  const stable = new StableTuiOutputStream(source, initialSize);
  return {
    stdout: stable,
    setSize(size): void { stable.setSize(size); },
  };
}

/** 创建可在 Ink 挂载前后安全使用的鼠标事件入口。 */
export function createTuiMouseInputSink(): TuiMouseInputSink {
  let handler: ((event: TuiSgrMouseEvent, wheelNotches: number) => void) | undefined;
  return {
    setHandler(nextHandler): void {
      handler = nextHandler;
    },
    dispatch(event, wheelNotches = 1): void {
      handler?.(event, wheelNotches);
    },
  };
}

/** 把原始 TTY 包装为 Ink 专用输入流，并转发 raw-mode 与 ref 生命周期以保持 Ink 挂载语义。 */
export function createRoutedTuiStdin(input: NodeJS.ReadStream): PassThrough {
  const routed = new PassThrough();
  const lifecycleInput = input as NodeJS.ReadStream & { ref?(): void; unref?(): void };
  Object.defineProperty(routed, "isTTY", { value: input.isTTY === true });
  if (typeof input.setRawMode === "function") {
    Object.defineProperty(routed, "setRawMode", { value: input.setRawMode.bind(input) });
  }
  if (typeof lifecycleInput.ref === "function") {
    Object.defineProperty(routed, "ref", { value: lifecycleInput.ref.bind(input) });
  }
  if (typeof lifecycleInput.unref === "function") {
    Object.defineProperty(routed, "unref", { value: lifecycleInput.unref.bind(input) });
  }
  return routed;
}

/** 创建幂等的终端控制序列生命周期，保证所有退出路径只恢复一次。 */
export function createTuiTerminalLifecycle(stdout: { write(chunk: string): void }, mode: TuiRenderMode): TuiTerminalLifecycle {
  let entered = false;
  let restored = false;

  /** 按渲染模式进入终端能力；内联路径保留既有 paste/focus 输入语义。 */
  function enter(): void {
    if (entered) return;
    entered = true;
    if (mode === "alternate-screen") stdout.write(TUI_ALTERNATE_SCREEN_ENABLE + TUI_MOUSE_TRACKING_ENABLE + TUI_BRACKETED_PASTE_ENABLE + TUI_TERMINAL_FOCUS_ENABLE);
    else stdout.write(TUI_BRACKETED_PASTE_ENABLE + TUI_TERMINAL_FOCUS_ENABLE);
  }

  /** 在 Ink 完成输入初始化或终端重新聚焦后幂等重申鼠标模式，避免初始化顺序清掉备用屏捕获。 */
  function reassert(): void {
    if (!entered || restored || mode !== "alternate-screen") return;
    stdout.write(TUI_MOUSE_TRACKING_ENABLE);
  }

  /** 逆序恢复终端能力；备用屏路径同步关闭鼠标并返回主屏。 */
  function restore(): void {
    if (restored) return;
    restored = true;
    if (mode === "alternate-screen") stdout.write(TUI_MOUSE_TRACKING_DISABLE + TUI_BRACKETED_PASTE_DISABLE + TUI_TERMINAL_FOCUS_DISABLE + TUI_ALTERNATE_SCREEN_DISABLE);
    else stdout.write(TUI_BRACKETED_PASTE_DISABLE + TUI_TERMINAL_FOCUS_DISABLE);
  }

  return { enter, reassert, restore };
}
