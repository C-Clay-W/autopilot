/** 两阶段 Logo 定向验证，真实 Ink 输出流与受控终端尺寸，不连接 Provider。 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";
import stringWidth from "string-width";
import { describe, expect, it, vi } from "vitest";
import { startCliStartupLogo, TuiStartupLogo } from "../src/tui/brand/startup.js";
import { createAgentLogoRows } from "../src/tui/brand/logo.js";

/** 让 React、Ink 帧和 Node 计时器完成调度。 */
function delay(ms: number): Promise<void> { return new Promise(function wait(resolve) { setTimeout(resolve, ms); }); }

/** 使用有 resize 事件的输出 double，捕获真实 Ink 控制序列。 */
function createTerminal() {
  const output = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 80, rows: 24,
    write: function write(chunk: string): boolean { writes.push(String(chunk)); return true; },
  });
  const writes: string[] = [];
  const input = new PassThrough();
  return { output, writes, input: input as unknown as NodeJS.ReadStream };
}

describe("two-stage startup logo", function startupSuite() {
  it("CI 不挂载不可见的动态帧，也不等待首帧", async function ciFallback() {
    const terminal = createTerminal();
    vi.stubEnv("CI", "1");
    try {
      const startup = startCliStartupLogo(terminal.output, terminal.input);
      await startup.finish();
      startup.dispose();
      expect(terminal.writes).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  });
  it("快初始化等待首个可见帧满两秒，期间不会自行退出", async function minimumDuration() {
    const terminal = createTerminal();
    const startup = startCliStartupLogo(terminal.output, terminal.input, { NO_COLOR: "1" });
    try {
      await delay(60);
      expect(terminal.writes.join("")).toContain("Loading");
      const start = Date.now();
      let finished = false;
      const result = startup.finish().then(function done() { finished = true; });
      await delay(150);
      expect(finished).toBe(false);
      await result;
      expect(Date.now() - start).toBeGreaterThanOrEqual(1850);
      expect(terminal.output.listenerCount("resize")).toBe(0);
      const output = terminal.writes.join("");
      expect(output).not.toMatch(/\x1b\[(?:2J|3J|\?1049h|[\d;]*m)/u);
    } finally { startup.dispose(); }
  });

  it("慢初始化超过两秒仍显示，ready 后立即清理，resize 只重排本帧", async function slowInitialization() {
    const terminal = createTerminal();
    const startup = startCliStartupLogo(terminal.output, terminal.input, { REDUCED_MOTION: "1" });
    try {
      await delay(60);
      terminal.output.columns = 24;
      terminal.output.rows = 10;
      terminal.output.emit("resize");
      await delay(2200);
      expect(terminal.output.listenerCount("resize")).toBe(1);
      const start = Date.now();
      await startup.finish();
      expect(Date.now() - start).toBeLessThan(150);
      expect(terminal.output.listenerCount("resize")).toBe(0);
      expect(terminal.writes.join("")).not.toMatch(/\x1b\[(?:2J|3J|\?1049h)/u);
    } finally { startup.dispose(); }
  });

  it("错误清理立即释放等待，重复清理安全，读屏没有点阵", async function errorCleanup() {
    const terminal = createTerminal();
    const startup = startCliStartupLogo(terminal.output, terminal.input, { SCREEN_READER: "1" });
    await delay(50);
    const pending = startup.finish();
    const start = Date.now();
    startup.dispose();
    startup.dispose();
    await pending;
    expect(Date.now() - start).toBeLessThan(100);
    const text = stripVTControlCharacters(terminal.writes.join(""));
    expect(text).toContain("Autopilot loading");
    expect(text).not.toMatch(/[\u2800-\u28ff]/u);
    expect(terminal.output.listenerCount("resize")).toBe(0);
  });

  it("点阵大小固定，宽窄和极小网格均不溢出布局", function boundedLayout() {
    for (const [columns, rows] of [[80, 24], [30, 12], [12, 6], [2, 2], [1, 1]]) {
      const frame = renderToString(<TuiStartupLogo columns={columns!} rows={rows!} elapsed={300} useColor={false} screenReader={false} />, { columns });
      expect(frame.split("\n").every(function fits(line) { return stringWidth(line) <= columns!; })).toBe(true);
      expect(frame.split("\n").length).toBeLessThanOrEqual(Math.max(1, rows! - 1));
    }
    const small = createAgentLogoRows(14, 7);
    expect(small).toHaveLength(7);
    expect(small.every(function fixedWidth(row) { return stringWidth(row) === 14; })).toBe(true);
    expect(small.join("")).toMatch(/[\u2801-\u28ff]/u);
  });
});
