/** 首次自然语言任务后内联正文不能挤掉输入框和状态栏。 */
import { render } from "ink-testing-library";
import { it, expect, vi } from "vitest";
import { CliTuiApp } from "../src/tui/app.js";
import { createCliTuiStore } from "../src/tui/store.js";
import { createManagedCliController } from "../src/managed-controller.js";
import { render as renderInk } from "ink";
import { Terminal } from "@xterm/xterm";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createTuiRenderStdout } from "../src/tui/lifecycle.js";
import { getWindowsTuiResizeHost } from "../src/tui/render-mode.js";

/** 等待真实 Ink 布局完成。 */
async function frame() { await new Promise(function wait(resolve) { setTimeout(resolve, 60); }); }

it("Windows 缩放识别无标记的外部 TTY、WT 标签页和 Desktop", function selectsResizeHost() {
  expect(getWindowsTuiResizeHost(true, {}, "win32")).toBe("external");
  expect(getWindowsTuiResizeHost(true, { WT_SESSION: "fixture" }, "win32")).toBe("external");
  expect(getWindowsTuiResizeHost(true, { WT_SESSION: "fixture", TERM_PROGRAM: "autopilot-desktop" }, "win32")).toBe("desktop");
  expect(getWindowsTuiResizeHost(true, { TERM_PROGRAM: "vscode" }, "win32")).toBeUndefined();
  expect(getWindowsTuiResizeHost(false, {}, "win32")).toBeUndefined();
  expect(getWindowsTuiResizeHost(true, { WT_SESSION: "fixture" }, "linux")).toBeUndefined();
});

it("外部 Windows Terminal 拖动停稳后按最终宽度重放一次历史", function replaysSettledHistory() {
  const source = Object.assign(new EventEmitter(), { columns: 100, write: function write() {} });
  const output = createTuiRenderStdout(source, { columns: 100, rows: 30 }, true, undefined, true);
  const inkHeights: Array<number | undefined> = [];
  function observeLayout() { inkHeights.push(output.stdout.rows); }
  vi.useFakeTimers();
  try {
    output.stdout.on?.("resize", observeLayout);
    source.columns = 70;
    source.emit("resize");
    source.columns = 100;
    source.emit("resize");
    vi.advanceTimersByTime(200);
    expect(inkHeights).toEqual([0]);

    source.columns = 120;
    source.emit("resize");
    vi.advanceTimersByTime(200);
    expect(inkHeights).toEqual([0]);
    output.setSize({ columns: 120, rows: 40 });
    expect(inkHeights).toEqual([0, 0]);
    expect(output.stdout.rows).toBe(40);
  } finally {
    output.stdout.off?.("resize", observeLayout);
    vi.useRealTimers();
  }
});

it("内联长任务首次提交后保留输入框底边及状态栏", async function firstPrompt() {
  const store = createCliTuiStore();
  const controller = createManagedCliController(async function request(operation) {
    if (operation === "cli") return { model: "fixture-model", effort: "medium", permissionMode: "ask", workspaceRoot: "fixture" };
    return "补充已记录并交给同一主控。";
  }, function notice(text) { store.addNotice(text); });
  const view = render(<CliTuiApp availableColumns={100} availableRows={14} store={store} controller={controller} closeWhenIdle={false} useColor={false} screenReader={false} renderMode="inline" onResult={function result(value) { for (const line of value.lines) store.addNotice(line); }} onRequestInterrupt={function interrupt() {}} onRequestCancel={function cancel() {}} onEof={function eof() {}} onAppExit={function exit() {}} />);
  try {
    await frame();
    store.recordPrompt("请帮我做一个简洁好看的中文待办清单网页，电脑和手机上都方便使用。可以添加事项、勾选完成、删除事项，并按全部、未完成、已完成筛选，刷新页面后清单还在。".repeat(4));
    await frame();
    expect(view.lastFrame()).toContain("workspace: fixture");
    store.addNotice("补充已记录并交给同一主控。");
    await frame();
    expect(view.lastFrame()).toContain("workspace: fixture");
  } finally { view.unmount(); }
});

it("真实Ink光标输出在xterm上保留底栏", async function cursorOutput() {
  const store = createCliTuiStore();
  const controller = createManagedCliController(async function request(operation) {
    if (operation === "cli") return { model: "fixture-model", effort: "medium", permissionMode: "ask", workspaceRoot: "fixture" };
    return "补充已记录并交给同一主控。";
  }, function notice(text) { store.addNotice(text); });
  const terminal = new Terminal({ cols: 100, rows: 14, windowsMode: true, windowsPty: { backend: "conpty" } });
  const chunks: string[] = [];
  const source = Object.assign(new EventEmitter(), { columns: 100, rows: 14, isTTY: true, write: function write(chunk: string, callback?: () => void) { chunks.push(chunk); terminal.write(chunk.replace(/\n/g, "\r\n"), callback); return true; } });
  const output = createTuiRenderStdout(source, { columns: 100, rows: 14 }, true);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: function raw() {}, ref: function ref() {}, unref: function unref() {} });
  const instance = renderInk(<CliTuiApp terminalSizeSource={source} onTerminalSizeChange={output.setSize} store={store} controller={controller} closeWhenIdle={false} useColor={false} screenReader={false} renderMode="inline" reducedMotion onResult={function result(value) { for (const line of value.lines) store.addNotice(line); }} onRequestInterrupt={function interrupt() {}} onRequestCancel={function cancel() {}} onEof={function eof() {}} onAppExit={function exit() {}} />, { stdout: output.stdout as never, stdin: stdin as never, stderr: new PassThrough() as never, patchConsole: false, exitOnCtrlC: false, incrementalRendering: false });
  /** 读取终端物理屏幕，包含真实 ANSI 光标动作的影响。 */
  function screen() { return Array.from({ length: terminal.rows }, function line(_, index) { return terminal.buffer.active.getLine(terminal.buffer.active.viewportY + index)?.translateToString(true); }).join("\n"); }
  try {
    await frame(); await frame();
    store.recordPrompt("请帮我做一个简洁好看的中文待办清单网页，电脑和手机上都方便使用。可以添加事项、勾选完成、删除事项，并按全部、未完成、已完成筛选，刷新页面后清单还在。".repeat(4));
    await frame(); await frame();
    expect(screen()).toContain("workspace: fixture");
    store.addNotice("补充已记录并交给同一主控。");
    await frame(); await frame();
    expect(screen()).toContain("workspace: fixture");
  } finally { instance.unmount(); stdin.end(); terminal.dispose(); }
});
