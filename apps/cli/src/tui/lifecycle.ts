/** TUI 终端生命周期：鼠标事件入口、Ink stdin 包装与幂等的控制序列生命周期。 */

import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import wrapAnsi from "wrap-ansi";
import type { TuiSgrMouseEvent } from "../tui-input-router.js";
import {
  TUI_ALTERNATE_SCREEN_DISABLE,
  TUI_ALTERNATE_SCREEN_ENABLE,
  TUI_BRACKETED_PASTE_DISABLE,
  TUI_BRACKETED_PASTE_ENABLE,
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
  private frame = "";
  private replayInkOutput = false;
  private observedColumns: number;
  private replayPending = false;
  private replayTimer?: ReturnType<typeof setTimeout>;
  private readonly observeWidth = this.observeTerminalWidth.bind(this);
  private readonly resizeListeners = new Set<(...args: unknown[]) => void>();

  public constructor(private readonly source: TuiOutputStream, initialSize: { columns: number; rows: number }, private readonly reflow = false, private readonly onWritten?: (chunk: string) => void, private readonly replayOnWidthChange = false) {
    this.size = initialSize;
    this.observedColumns = initialSize.columns;
  }

  /** 按真实列宽记录整次拖动；即使最后回到原宽，也要清掉中间宽度留下的历史边线。 */
  private observeTerminalWidth(): void {
    const columns = this.source.columns;
    if (columns === undefined || columns === this.observedColumns) return;
    this.observedColumns = columns;
    this.replayPending = true;
    clearTimeout(this.replayTimer);
    this.replayTimer = setTimeout(function replayWhenSettled(stream: StableTuiOutputStream) {
      stream.replayTimer = undefined;
      stream.setSize(stream.size);
    }, 200, this);
  }

  public get columns(): number { return this.size.columns; }

  // Ink 在上一帧达到输出高度时会清屏并重放 Static。只在同步 resize 回调中触发一次。
  public get rows(): number { return this.replayInkOutput ? 0 : this.size.rows; }

  public get isTTY(): boolean | undefined { return this.source.isTTY; }

  /** 转发 Ink 输出，并在适用的 ConPTY 宿主按旧帧实际占行修正动态擦除。 */
  public write(chunk: string, ...args: unknown[]): boolean {
    // ConPTY 会重排旧动态帧，Ink 仍按旧逻辑行数擦除，须按实际新宽度计物理行。
    let columns = this.source.columns ?? this.size.columns;
    if (this.reflow) {
      // Node20 的 columns 缓存直到 resize 事件才更新，ConPTY 可在该事件前完成重排。
      const handle = (this.source as TuiOutputStream & { _handle?: { getWindowSize(size: number[]): number } })._handle;
      const actual = [0, 0];
      if (handle?.getWindowSize(actual) === 0 && actual[0] > 0) columns = actual[0];
    }
    const erase = /\x1b\[2K(?:\x1b\[1A\x1b\[2K)*\x1b\[G/;
    const eraseMatch = chunk.match(erase);
    if (this.reflow && this.frame && eraseMatch) {
      // Ink 的整屏回放含 Static 历史；仅当逻辑行数与本次动态擦除一致时使用捕获帧。
      const logicalRows = eraseMatch[0].match(/\x1b\[2K/g)!.length;
      if (logicalRows === this.frame.split("\n").length) {
        const rows = wrapAnsi(this.frame, Math.max(1, columns), { hard: true, wordWrap: false, trim: false }).split("\n").length;
        chunk = chunk.replace(erase, "\x1b[2K" + "\x1b[1A\x1b[2K".repeat(rows - 1) + "\x1b[G");
      }
    }
    if (this.reflow) {
      const text = stripVTControlCharacters(chunk);
      if (text.includes("\n") || erase.test(chunk)) this.frame = text;
    }
    const write = this.source.write as unknown as (...writeArgs: unknown[]) => unknown;
    const result = write.call(this.source, chunk, ...args);
    this.onWritten?.(chunk);
    return result !== false;
  }

  /** 保存 Ink 的 resize 监听，等待应用布局提交后再触发。 */
  public on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === "resize") {
      if (this.replayOnWidthChange && !this.resizeListeners.size) this.source.on?.("resize", this.observeWidth);
      this.resizeListeners.add(listener);
    }
    return this;
  }

  /** 移除 Ink 的 resize 监听，满足 Ink 卸载时的监听清理。 */
  public off(event: string, listener: (...args: unknown[]) => void): this {
    if (event === "resize" && this.resizeListeners.delete(listener) && !this.resizeListeners.size && this.replayOnWidthChange) {
      this.source.off?.("resize", this.observeWidth);
      clearTimeout(this.replayTimer);
      this.replayTimer = undefined;
      this.replayPending = false;
    }
    return this;
  }

  /** 更新 Ink 后续布局使用的稳定尺寸，并交由 Ink 自身失效旧输出缓存后重绘。 */
  public setSize(size: { columns: number; rows: number }): void {
    const changed = size.columns !== this.size.columns || size.rows !== this.size.rows;
    // 拖动停稳且布局已提交最终列宽后，只重放一次静态历史和当前帧。
    const replay = this.replayPending && this.replayTimer === undefined && size.columns === this.observedColumns;
    this.size = size;
    if (!changed && !replay) return;
    if (replay) this.replayPending = false;
    this.replayInkOutput = replay;
    try {
      for (const listener of this.resizeListeners) listener();
    } finally {
      this.replayInkOutput = false;
    }
  }
}

/** 创建跨 DPI resize 时使用的 Ink 输出代理与尺寸提交函数。 */
export function createTuiRenderStdout(source: TuiOutputStream, initialSize: { columns: number; rows: number }, reflow = false, onWritten?: (chunk: string) => void, replayOnWidthChange = false): { stdout: TuiOutputStream; setSize(size: { columns: number; rows: number }): void } {
  const stable = new StableTuiOutputStream(source, initialSize, reflow, onWritten, replayOnWidthChange);
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
