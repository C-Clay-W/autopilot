/** Windows Desktop 缩网格前先提交可同时容纳于旧、新网格的动态帧；普通 CLI 不启用。 */
import { createServer, type Socket } from "node:net";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import type { TuiOutputStream, TuiTerminalSizeSource } from "./types.js";

/** 仅接受宿主创建的随机本机管道；布局预提交不更改真实 TTY 尺寸。 */
export function createDesktopResize(source: TuiOutputStream, env: NodeJS.ProcessEnv) {
  const pipe = env.AUTOPILOT_DESKTOP_RESIZE_PIPE;
  const enabled = process.platform === "win32" && env.TERM_PROGRAM === "autopilot-desktop" && /^\\\\\.\\pipe\\autopilot-desktop-[a-f0-9-]{36}$/.test(pipe ?? "");
  let target: { columns: number; rows: number } | undefined;
  let latestFrame = "";
  let pending: { socket: Socket; token: string; timer: ReturnType<typeof setTimeout> } | undefined;
  const listeners = new Set<(...args: unknown[]) => void>();
  const layoutSource: TuiTerminalSizeSource = {
    get columns() { return target ? Math.min(source.columns ?? 80, target.columns) : source.columns; },
    get rows() { return target ? Math.min(source.rows ?? 24, target.rows) : source.rows; },
    on(event, listener) { if (event === "resize") listeners.add(listener); },
    off(event, listener) { if (event === "resize") listeners.delete(listener); },
  };
  /** 发布布局目标，仍由现有 React/Ink 路径计算和输出帧。 */
  function notify() { for (const listener of listeners) listener(); }
  /** 仅目标网格确已应用才解除预排版；迟到的旧 resize 不能恢复旧宽帧。 */
  function resized() {
    if (!target || source.columns === target.columns && source.rows === target.rows) target = undefined;
    notify();
  }
  /** 已输出帧若本来就能容纳目标网格，放大时无需等待一次无变化的 Ink 写入。 */
  function confirmFrame() {
    if (!pending || !target || !latestFrame) return;
    const lines = stripVTControlCharacters(latestFrame).trimEnd().split("\n");
    if (lines.length > layoutSource.rows! || lines.some(function tooWide(line) { return stringWidth(line) > layoutSource.columns!; })) return;
    const request = pending;
    pending = undefined;
    clearTimeout(request.timer);
    const write = source.write as (chunk: string, callback: () => void) => unknown;
    write.call(source, `\x1b]777;autopilot-resize;${request.token}\x07`, function flushed() { request.socket.end(request.token); });
  }
  const server = enabled ? createServer(function connected(socket) {
    let input = "";
    socket.setTimeout(1500, function timedOut() { socket.destroy(); });
    socket.on("error", function ignored() {});
    socket.on("data", function received(data) {
      input += data.toString();
      if (input.length > 160 || pending) { socket.destroy(); return; }
      if (!input.endsWith("\n")) return;
      const match = /^(\d{1,4}) (\d{1,4}) ([a-f0-9-]{36})\n$/.exec(input);
      if (!match || +match[1] < 2 || +match[1] > 1000 || +match[2] < 1 || +match[2] > 1000) { socket.destroy(); return; }
      target = { columns: +match[1], rows: +match[2] };
      const timer = setTimeout(function abandoned() { pending = undefined; target = undefined; socket.destroy(); notify(); }, 1500);
      pending = { socket, token: match[3], timer };
      notify();
      confirmFrame();
    });
  }) : undefined;
  // 无可用管道时保留原 CLI 展示；不输出本机地址或原始错误。
  server?.on("error", function unavailable() {});
  server?.listen(pipe);
  if (enabled) source.on?.("resize", resized);
  return {
    source: enabled ? layoutSource : source,
    /** 只有真实输出已适合两阶段网格才确认；OSC 让 renderer 等到该帧解析完成。 */
    written(chunk: string) {
      if (!enabled) return;
      const text = stripVTControlCharacters(chunk);
      if (!text.includes("\n")) return;
      latestFrame = chunk;
      confirmFrame();
    },
    /** 退出只关闭本进程的管道与监听，不影响持久 shell。 */
    close() {
      if (pending) { clearTimeout(pending.timer); pending.socket.destroy(); }
      if (enabled) source.off?.("resize", resized);
      server?.close();
    },
  };
}
