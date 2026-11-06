/** r004独立跨层组合：真实Node合成存储分页经Manager进入内存Ink目录与历史视图。 */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import type { AgentEventEnvelope, AgentRuntime, Session } from "@autopilot-agent/core";
import { initializeNodeStateRoot } from "../../../../../packages/adapters/src/node/state-root";
import { createNodeSessionStore } from "../../../../../packages/adapters/src/node/stores/node-session-store";
import { createNodeTranscriptStore } from "../../../../../packages/adapters/src/node/stores/node-transcript-store";
import { createCliController } from "../../../src/controller.js";
import { createPlainRenderer } from "../../../src/renderer.js";
import { createCliSessionManager } from "../../../src/tui/session-manager.js";
import { CliSessionWorkspace } from "../../../src/tui/session-workspace.js";

/** 等待内存React帧，不访问真实TTY。 */
async function frame() { await new Promise<void>(function delay(resolve) { setTimeout(resolve, 40); }); }
/** 一次操作最多等待一秒，不重发按键。 */
async function until(check: () => boolean) { for (let i = 0; i < 25 && !check(); i++) await frame(); expect(check()).toBe(true); }

it("Node过滤空目录页可经PgDn继续，同名标题隐去UUID并精确选择后Ctrl+L分页到tail", async function nodeToCli() {
  const base = path.resolve(process.cwd(), "../../.agent-tests/work-test/manual-followup-01a19eed/fixtures/r004");
  fs.mkdirSync(base, { recursive: true }); const stateRoot = fs.mkdtempSync(path.join(base, "node-cli-"));
  initializeNodeStateRoot(stateRoot); fs.mkdirSync(path.join(stateRoot, "sessions"));
  const initial = { id: "ffffffff-0000-4000-8000-000000000001", title: "当前主任务", productMode: "work", projectId: "p", status: "idle", createdAt: 0, updatedAt: 0 } as Session;
  const first = "10000000-0000-4000-8000-000000000001"; const second = "20000000-0000-4000-8000-000000000002";
  for (let i = 0; i < 20; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    fs.writeFileSync(path.join(stateRoot, "sessions", id + ".json"), JSON.stringify({ ...initial, id, title: "其他Project", projectId: "other" }));
  }
  for (const id of [first, second]) fs.writeFileSync(path.join(stateRoot, "sessions", id + ".json"), JSON.stringify({ ...initial, id, title: "相同历史标题", presentation: { messages: [] } }));
  const sessions = createNodeSessionStore({ stateRoot }); const transcripts = createNodeTranscriptStore({ stateRoot });
  /** 事件正文只写合成任务目录，尾部追加用于真实cursor验证。 */
  function envelope(seq: number, value: unknown): AgentEventEnvelope { return { sessionId: second, turnId: "t", seq, timestamp: new Date(seq).toISOString(), event: value } as AgentEventEnvelope; }
  const events = [envelope(1, { type: "turn_started", turnId: "t", stepCount: 0 }), ...Array.from({ length: 205 }, function delta(_, i) { return envelope(i + 2, { type: "answer_delta", turnId: "t", stepId: "s", delta: "x" }); })];
  fs.mkdirSync(path.join(stateRoot, "transcripts")); fs.writeFileSync(path.join(stateRoot, "transcripts", second + ".jsonl"), events.map(function json(e) { return JSON.stringify(e); }).join("\n") + "\n");
  const get = vi.spyOn(sessions, "get"); const list = vi.spyOn(sessions, "list");
  const runtime = { sessions, turns: { start: vi.fn(), continue: vi.fn(), getContextUsage: async function usage() { return null; }, getFrozenRunConfig: async function frozen() { return undefined; } } } as unknown as AgentRuntime;
  const created: string[] = [];
  /** Controller内部路由使用UUID，不从标题反查。 */
  function controller(id: string) { created.push(id); return createCliController({ runtime, sessionId: id, renderer: createPlainRenderer("text") }); }
  const directory = vi.fn(async function directory(input: { cursor?: string; limit: number }) { return sessions.listDirectoryPage!({ ...input, projectId: "p" }); });
  const readPage = vi.fn(async function page(id: string, input: { cursor?: string; limit: number }) { return transcripts.readPage(id, input); });
  const manager = createCliSessionManager({ runtime, projectId: "p", initialSession: initial, initialController: controller(initial.id), createController: controller, readDirectoryPage: directory, readEventPage: readPage });
  const view = render(createElement(CliSessionWorkspace, { manager, terminalSizeSource: { columns: 110, rows: 28 }, closeWhenIdle: false, renderMode: "inline", useColor: false, screenReader: false, onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: function cancel() {}, onEof: function eof() {}, onAppExit: function exit() {} }));
  try {
    await frame(); expect(directory).not.toHaveBeenCalled(); expect(readPage).not.toHaveBeenCalled();
    view.stdin.write("\u0014"); await until(function emptyPage() { return directory.mock.calls.length === 1 && !manager.directoryState().loading; });
    expect(manager.directory()).toEqual([{ sessionId: initial.id, title: "当前主任务" }]); expect(manager.directoryState().more).toBe(true);
    expect(get.mock.calls.filter(function oldTarget(call) { return call[0] !== initial.id; })).toEqual([]); expect(list).not.toHaveBeenCalled(); expect(readPage).not.toHaveBeenCalled(); expect(created).toEqual([initial.id]);
    view.stdin.write("\u001b[6~"); await until(function nextPage() { return manager.directory().length === 3 && !manager.directoryState().loading; });
    expect(directory.mock.calls[1]![0].cursor).toBeTruthy(); expect(manager.directoryState().more).toBe(false);
    expect(view.lastFrame()).toContain("相同历史标题"); for (const id of [initial.id, first, second]) expect(view.lastFrame()).not.toContain(id);
    view.stdin.write("\u001b[B"); await frame(); view.stdin.write("\u001b[B"); await frame(); view.stdin.write("\r");
    await until(function selectedPage() { return manager.selected().sessionId === second && manager.selected().hydrated; });
    const oldTargetReads = get.mock.calls.filter(function oldTarget(call) { return call[0] !== initial.id; });
    expect(oldTargetReads.length).toBeGreaterThan(0); expect(oldTargetReads.every(function exactTarget(call) { return call[0] === second; })).toBe(true); expect(created).toEqual([initial.id, second]);
    expect(manager.selected().controller.getProjection().answer).toBe("x".repeat(99)); expect(manager.selected().historyMore).toBe(true);
    await manager.refresh(); expect(readPage).toHaveBeenCalledTimes(1);
    view.stdin.write("\u000c"); await until(function secondPage() { return manager.selected().controller.getProjection().answer.length === 199; });
    expect(manager.selected().historyMore).toBe(true); expect(readPage).toHaveBeenCalledTimes(2);
    view.stdin.write("\u000c"); await until(function finalPage() { return manager.selected().controller.getProjection().answer.length === 205; });
    expect(manager.selected().historyMore).toBe(false); expect(readPage).toHaveBeenCalledTimes(3);
    await transcripts.append(second, envelope(207, { type: "answer_delta", turnId: "t", stepId: "s", delta: "尾" })); await manager.refresh();
    expect(manager.selected().controller.getProjection().answer).toBe("x".repeat(205) + "尾"); expect(readPage).toHaveBeenCalledTimes(4);
    expect(runtime.turns.start).not.toHaveBeenCalled(); expect(runtime.turns.continue).not.toHaveBeenCalled();
    for (const id of [initial.id, first, second]) expect(view.lastFrame()).not.toContain(id);
  } finally { view.unmount(); await manager.stop(); }
});
