/** r004：通过生产会话壳验证自然高度、流式终态衔接和长正文上限，不启动Provider。 */
import { writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { runCliTui } from "../../../src/tui/run.js";
import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { expect, it } from "vitest";
import type { AgentRuntime, Session } from "@autopilot-agent/core";
import { createCliController } from "../../../src/controller.js";
import { createPlainRenderer } from "../../../src/renderer.js";
import { createCliSessionManager } from "../../../src/tui/session-manager.js";
import { CliSessionWorkspace } from "../../../src/tui/session-workspace.js";

/** 等待Ink提交布局与Static追加。 */
async function frame() { await new Promise(function tick(resolve) { setTimeout(resolve, 80); }); }
/** 使用无持久化会话及可变终端尺寸挂载生产壳。 */
function fixture(rows: number) {
  const parent = { id: "parent", title: "NEW_SESSION", productMode: "work", projectId: "p", status: "idle", createdAt: 1, updatedAt: 1 } as Session;
  const runtime = { sessions: { get: async function get() { return parent; } }, turns: { getFrozenRunConfig: async function frozen() { return null; }, getUsageSnapshot: async function usage() { return { contextUsage: null, turnUsage: null }; } } } as unknown as AgentRuntime;
  /** 复用生产Controller但不发起执行。 */
  function controller(id: string) { return createCliController({ runtime, sessionId: id, renderer: createPlainRenderer("text") }); }
  const manager = createCliSessionManager({ runtime, projectId: "p", initialSession: parent, initialController: controller(parent.id), createController: controller, readDirectoryPage: async function directory() { return { items: [parent] }; }, readRelations: async function relations() { return []; }, readEventPage: async function events() { return { items: [] }; } });
  const size = Object.assign(new EventEmitter(), { columns: 80, rows });
  const view = render(<CliSessionWorkspace manager={manager} terminalSizeSource={size} renderMode="inline" closeWhenIdle={false} useColor={false} screenReader={false} reducedMotion onResult={function noop() {}} onRequestInterrupt={function noop() {}} onRequestCancel={function noop() {}} onEof={function noop() {}} onAppExit={function noop() {}} />);
  const entry = manager.selected();
  /** 按正式Store路径提交流式和终态事实。 */
  function event(value: any, status = "running") { entry.store.acceptEvent({ ...value, turnId: "turn" }, { ...entry.controller.getProjection(), turnId: "turn", status } as any); }
  return { view, size, entry, manager, event };
}
/** 测量帧内最长连续空白，捕获窗口高度造成的填充。 */
function blankRun(value: string) { return Math.max(0, ...Array.from(value.matchAll(/(?:^\s*$\n?)+/gm), function length(match) { return match[0].split("\n").length - 1; })); }

it.each([24, 60, 120])("r004 %i行启动与短回复终态没有整屏填充", async function compactLifecycle(rows) {
  const f = fixture(rows);
  try {
    await frame();
    expect(blankRun(f.view.lastFrame() ?? "")).toBeLessThanOrEqual(3);
    expect((f.view.lastFrame() ?? "").split("当前：").at(-1)!.split("\n").length).toBeLessThan(20);
    f.event({ type: "turn_started", seq: 1, stepCount: 0 });
    f.event({ type: "answer_delta", seq: 2, delta: "SHORT_REPLY" }); await frame();
    const live = f.view.lastFrame() ?? "";
    writeFileSync(`E:/autopilot-agent/.agent-tests/work-test/refix-live-01a1ab13/runs/r004/live-${rows}.txt`, live);
    expect(live).toContain("SHORT_REPLY"); expect(blankRun(live)).toBeLessThanOrEqual(3);
    f.event({ type: "status", seq: 3, status: "completed" }, "completed"); await frame();
    const done = f.view.lastFrame() ?? "";
    expect(done.split("SHORT_REPLY")).toHaveLength(2); expect(blankRun(done)).toBeLessThanOrEqual(3);
    expect(Math.abs(done.split("\n").findIndex(function answer(line) { return line.includes("SHORT_REPLY"); }) - live.split("\n").findIndex(function answer(line) { return line.includes("SHORT_REPLY"); }))).toBeLessThanOrEqual(3);
  } finally { f.view.unmount(); await f.manager.stop(); }
});

it("r004 长回复保持有界尾部，缩窗与目录返回保留输入", async function longTail() {
  const f = fixture(60);
  try {
    f.event({ type: "turn_started", seq: 1, stepCount: 0 });
    f.event({ type: "answer_delta", seq: 2, delta: "old line\n".repeat(150) + "LATEST_TAIL" }); await frame();
    f.size.rows = 24; f.size.emit("resize"); await frame(); await frame();
    expect(f.view.lastFrame()).toContain("LATEST_TAIL");
    expect((f.view.lastFrame() ?? "").split("当前：").at(-1)!.split("\n").length).toBeLessThanOrEqual(24);
    f.view.stdin.write("DRAFT"); await frame(); f.view.stdin.write("\u0014"); await frame();
    expect(f.view.lastFrame()).toContain("NEW_SESSION");
    f.view.stdin.write("\u001b"); await frame();
    expect(f.entry.viewState.draftRef.current?.inputRef.current).toBe("DRAFT");
    expect(f.view.lastFrame()).toContain("LATEST_TAIL");
  } finally { f.view.unmount(); await f.manager.stop(); }
});


it("r004 内存TTY长回复与审批不清屏且详情可达", async function realInkOutput() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: function noop() {}, ref: function noop() {}, unref: function noop() {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 60 });
  const stderr = new PassThrough(); stderr.on("data", function ignore() {});
  let output = ""; stdout.on("data", function capture(chunk) { output += String(chunk); });
  const signal = new EventEmitter();
  const controller = createCliController({ sessionId: "memory", renderer: createPlainRenderer("text") });
  const work = runCliTui({ controller, streams: { stdin, stdout, stderr }, signalSource: signal, closeWhenIdle: false, env: { NO_COLOR: "1" } });
  // 使用Controller事件监听入口，不连接Runtime或实际会话。
  try {
    await frame();
    const event = { type: "answer_delta", turnId: "turn", seq: 2, delta: "MEMSHORT" };
    controller.observe?.([{ sessionId: "memory", turnId: "turn", seq: 1, timestamp: new Date().toISOString(), event: { type: "turn_started", turnId: "turn", stepCount: 0 } }, { sessionId: "memory", turnId: "turn", seq: 2, timestamp: new Date().toISOString(), event }] as any);
    await frame();
    expect(output).toContain("MEMSHORT");
    controller.observe?.([{ sessionId: "memory", turnId: "turn", seq: 3, timestamp: new Date().toISOString(), event: { type: "answer_delta", turnId: "turn", delta: "old line\n\n".repeat(100) + "MEMTAIL" } }] as any);
    await frame(); stdout.rows = 24; stdout.emit("resize"); await frame(); await frame();
    expect(output).toContain("MEMTAIL");
    controller.observe?.([{ sessionId: "memory", turnId: "turn", seq: 4, timestamp: new Date().toISOString(), event: { type: "approval_required", turnId: "turn", stepId: "s", callId: "c", toolName: "run_command", result: { status: "approval_required", approval: { approvalId: "a", callId: "c", toolName: "run_command", reason: "DETAIL_HEAD\n" + "details\n".repeat(35) + "DETAIL_END", allowedDecisions: ["allow_once", "deny"], display: { operation: "运行命令", actionPreview: "DETAIL_HEAD\n" + "details\n".repeat(35) + "DETAIL_END", allowedDecisions: ["allow_once", "deny"] } } } } }] as any);
    await frame(); expect(output).toContain("允许本次"); expect(output).toContain("拒绝");
    stdin.write("d"); await frame();
    for (let i = 0; i < 15; i++) { stdin.write("\u001b[6~"); await frame(); }
    expect(output).toContain("DETAIL_END");
    expect(output).not.toMatch(/\u001b\[(?:2J|3J|\?1049h)/);
    writeFileSync("E:/autopilot-agent/.agent-tests/work-test/refix-live-01a1ab13/runs/r004/memory-tty.json", JSON.stringify({ bytes: Buffer.byteLength(output), clearScreen: 0, clearScrollback: 0, alternateScreen: 0, latestTail: true, approvalDecisions: true, approvalDetails: true }));
  } finally { writeFileSync("E:/autopilot-agent/.agent-tests/work-test/refix-live-01a1ab13/runs/r004/memory-output.txt", output); signal.emit("SIGINT"); await work; }
});
