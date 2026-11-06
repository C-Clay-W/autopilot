/** r004 feature：轻量历史目录/按UUID分页、inline草稿保留、关联审批及长文本性能。 */
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import { createCliController } from "../../../src/controller.js";
import { createPlainRenderer } from "../../../src/renderer.js";
import { createCliSessionManager } from "../../../src/tui/session-manager.js";
import { CliSessionWorkspace } from "../../../src/tui/session-workspace.js";
import { resolveTuiRenderMode } from "../../../src/tui/render-mode.js";
import { createTimelineVisualLines } from "../../../src/timeline-lines.js";
import type { AgentEventEnvelope, AgentRuntime, Session } from "@autopilot-agent/core";

/** 有界等待内存Ink帧，不接触真实终端。 */
async function frame() { await new Promise<void>(function tick(resolve) { setTimeout(resolve, 40); }); }
/** 最多等待1秒可观察事实，失败不重发按键。 */
async function until(check: () => boolean) { for (let i = 0; i < 25 && !check(); i++) await frame(); expect(check()).toBe(true); }
const rootId = "d4e708a1-bc31-4123-b2ee-7cf8e73646c6";
const firstId = "dc78c6d5-bd64-48fa-9553-32a114b2d826";
const secondId = "e7578a89-9e49-41b5-a671-b43358b8c716";

/** 用真实Controller和合成Runtime验证观察/执行边界。 */
function fixture() {
  const initial = { id: rootId, title: "当前标题", productMode: "work", projectId: "p", status: "idle", createdAt: 0, updatedAt: 0 } as Session;
  const sessions = new Map([initial, { ...initial, id: firstId, title: "同名标题" }, { ...initial, id: secondId, title: "同名标题" }].map(function entry(session) { return [session.id, session]; }));
  const events = new Map<string, AgentEventEnvelope[]>(); const calls: string[] = [];
  const get = vi.fn(async function get(id: string) { return sessions.get(id); }); const list = vi.fn(async function list() { throw new Error("全量目录禁止"); });
  const runtime = { sessions: { get, list }, approvals: { submit: async function approve(input: { sessionId: string }) { calls.push("approve:" + input.sessionId); } }, turns: { start: async function* start() { calls.push("start"); }, continue: async function* resume(input: { sessionId: string }) { calls.push("continue:" + input.sessionId); }, getFrozenRunConfig: async function frozen() { return undefined; }, getContextUsage: async function usage(input: { sessionId: string }) { calls.push("usage:" + input.sessionId); return null; }, getRecoverableState: async function recover() { calls.push("recover"); return null; } } } as unknown as AgentRuntime;
  const created: string[] = [];
  /** Controller始终绑定原UUID。 */
  function controller(id: string) { created.push(id); return createCliController({ runtime, sessionId: id, renderer: createPlainRenderer("text") }); }
  const relations: Array<{ threadId: string; parentThreadId: string; title: string; status: Session["status"]; activeTurnId?: string }> = [];
  const readPage = vi.fn(async function page(id: string, input: { cursor?: string; limit: number }) { const offset = input.cursor ? Number(input.cursor.split(":")[1]) : 0; const all = events.get(id) ?? []; const items = all.slice(offset, offset + input.limit); const cursor = id + ":" + (offset + items.length); return { items, cursor, ...(offset + items.length < all.length ? { nextCursor: cursor } : {}) }; });
  const directory = vi.fn(async function directory(input: { cursor?: string }) { return input.cursor === undefined ? { items: [{ id: firstId, title: "同名标题" }, { id: secondId, title: "同名标题" }] } : { items: [] }; });
  const manager = createCliSessionManager({ runtime, projectId: "p", initialSession: initial, initialController: controller(rootId), createController: controller, readDirectoryPage: directory, readEventPage: readPage, readSummary: async function summary(id) { return { title: sessions.get(id)?.title }; }, readRelations: async function related() { return relations; } });
  return { manager, get, list, created, events, calls, sessions, readPage, directory, relations, runtime };
}

/** 安全事件包用于真实Projector回放，无私有checkpoint。 */
function envelope(id: string, seq: number, event: unknown): AgentEventEnvelope { return { sessionId: id, turnId: "t", seq, timestamp: new Date(seq).toISOString(), event } as AgentEventEnvelope; }

/** 同一Session不同Turn的安全审批页，保留真实独立审批身份。 */
function approvalPage(turnId: string, approvalId: string) {
  return [
    { ...envelope(firstId, 1, { type: "turn_started", turnId, stepCount: 0 }), turnId },
    { ...envelope(firstId, 2, { type: "approval_required", turnId, stepId: "s", callId: "call", toolName: "edit_file", result: { status: "approval_required", approval: { approvalId, reason: "合成审批", allowedDecisions: ["allow_once", "deny"], display: { operation: "编辑合成文件", actionPreview: "合成审批", allowedDecisions: ["allow_once", "deny"] } } } }), turnId },
  ];
}

it("inline固定策略与84K长文本线性派生保留宽字/组合字符/ANSI源坐标", function linearText() {
  for (const platform of ["win32", "darwin", "linux"]) expect(resolveTuiRenderMode({ AUTOPILOT_TUI_FULLSCREEN: "1" }, platform)).toBe("inline");
  const text = "a".repeat(84337); const started = performance.now(); const lines = createTimelineVisualLines([{ itemId: "large", text }], 79);
  expect(performance.now() - started).toBeLessThan(2500); expect(lines.map(function text(line) { return line.text; }).join("")).toBe(text);
  const mixed = "中a👩🏽‍💻文e\u0301\u001b[31m彩色\u001b[39m\n尾行\n";
  const rendered = createTimelineVisualLines([{ itemId: "unicode", text: mixed, spans: [{ start: 0, end: 2, style: "bold" }] }], 4);
  expect(rendered.every(function source(line) { return line.text === mixed.slice(line.sourceStart, line.sourceEnd) && line.displayWidth <= 4; })).toBe(true);
  expect(rendered.some(function emoji(line) { return line.text.includes("👩🏽‍💻"); })).toBe(true); expect(rendered.some(function combining(line) { return line.text.includes("e\u0301"); })).toBe(true);
  expect(rendered.map(function text(line) { return line.text; }).join("")).toBe(mixed.replaceAll("\n", ""));
  expect(createTimelineVisualLines([{ itemId: "words", text: "hello world" }], 8).map(function text(line) { return line.text; })).toEqual(["hello ", "world"]);
});

it("目录不会预载正文或创建旧Controller，选中同名标题按UUID分页且不恢复执行", async function lazyHistory() {
  const f = fixture();
  try {
    expect(f.created).toEqual([rootId]); expect(f.readPage).not.toHaveBeenCalled();
    await f.manager.loadDirectory(); expect(f.get).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled(); expect(f.created).toEqual([rootId]); expect(f.manager.entries()).toHaveLength(1);
    f.events.set(secondId, [envelope(secondId, 1, { type: "turn_started", turnId: "t", stepCount: 0 }), ...Array.from({ length: 108 }, function answer(_, index) { return envelope(secondId, index + 2, { type: "answer_delta", turnId: "t", stepId: "step", delta: "x" }); })]);
    await f.manager.select(secondId); expect(f.get.mock.calls).toEqual([[secondId]]); expect(f.created).toEqual([rootId, secondId]); expect(f.manager.selected().controller.getProjection().answer).toHaveLength(99); expect(f.manager.selected().historyMore).toBe(true);
    await f.manager.refresh(); expect(f.readPage).toHaveBeenCalledTimes(1);
    await f.manager.loadHistory(); expect(f.manager.selected().controller.getProjection().answer).toHaveLength(108); expect(f.manager.selected().historyMore).toBe(false);
    f.events.get(secondId)!.push(envelope(secondId, 110, { type: "answer_delta", turnId: "t", stepId: "step", delta: "y" }));
    f.sessions.get(secondId)!.title = "回答后的自动标题";
    await f.manager.refresh(); expect(f.manager.selected().title).toBe("回答后的自动标题"); expect(f.get.mock.calls).toEqual([[secondId]]); expect(f.manager.selected().controller.getProjection().answer).toHaveLength(109); expect(f.readPage.mock.calls.at(-1)?.[1].cursor).toBe(secondId + ":109"); expect(f.calls).toEqual([]);
  } finally { await f.manager.stop(); }
});

it("迟到历史页只写原目标，单次在途门不会让切换目标被旧页覆盖", async function latePage() {
  const f = fixture(); await f.manager.loadDirectory();
  let complete!: (value: { items: AgentEventEnvelope[]; cursor: string }) => void;
  f.readPage.mockImplementationOnce(function delayed() { return new Promise(function wait(resolve) { complete = resolve; }); });
  try {
    const opening = f.manager.select(firstId); await Promise.resolve(); await Promise.resolve();
    await f.manager.select(secondId); expect(f.manager.selected().sessionId).toBe(secondId);
    complete({ items: [envelope(firstId, 1, { type: "answer_delta", turnId: "t", stepId: "s", delta: "原目标内容" })], cursor: firstId + ":1" }); await opening;
    expect(f.manager.selected().sessionId).toBe(secondId); expect(f.manager.selected().controller.getProjection().answer).toBe(""); expect(f.manager.entries().find(function original(entry) { return entry.sessionId === firstId; })?.controller.getProjection().answer).toBe("原目标内容");
  } finally { await f.manager.stop(); }
});

it("inline目录仅标题，切换保留草稿光标且隐藏会话不查询状态或派生正文", async function inlineDraft() {
  const f = fixture(); const terminal = Object.assign(new EventEmitter(), { columns: 130, rows: 28 });
  const view = render(createElement(CliSessionWorkspace, { manager: f.manager, terminalSizeSource: terminal, closeWhenIdle: false, renderMode: "inline", useColor: false, screenReader: false, reducedMotion: true, onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: function cancel() {}, onEof: function eof() {}, onAppExit: function exit() {} }));
  try {
    await frame(); view.stdin.write("主草稿"); await frame(); view.stdin.write("\u001b[D"); await frame();
    view.stdin.write("\u0014"); await until(function directory() { return view.lastFrame().includes("同名标题"); });
    for (const id of [rootId, firstId, secondId]) expect(view.lastFrame()).not.toContain(id);
    view.stdin.write("\u001b[B"); await frame(); view.stdin.write("\r"); await until(function selected() { return f.manager.selected().sessionId === firstId; }); await frame();
    f.calls.length = 0; f.manager.entries()[0]!.store.recordPrompt("隐藏的超长正文".repeat(500)); await frame(); expect(f.calls).toEqual([]);
    view.stdin.write("\u0014"); await frame(); view.stdin.write("\u001b[A"); await frame(); view.stdin.write("\r"); await until(function selected() { return f.manager.selected().sessionId === rootId; }); await frame();
    view.stdin.write("X"); await frame(); expect(f.manager.selected().viewState.draftRef.current?.inputRef.current).toBe("主草X稿"); expect(view.lastFrame()).toContain("主草X▏稿");
    for (const [columns, rows] of [[70, 20], [160, 32]]) { terminal.columns = columns; terminal.rows = rows; terminal.emit("resize"); await frame(); expect(f.manager.selected().viewState.draftRef.current?.inputRef.current).toBe("主草X稿"); expect(view.lastFrame()).toContain("主草X▏稿"); }
    expect(f.calls.every(function onlyCurrent(call) { return call === "usage:" + rootId; })).toBe(true);
  } finally { view.unmount(); await f.manager.stop(); }
});

it("关联轻量审批不保留正文，精确身份和顶层输入门在inline仍有效", async function relatedApproval() {
  const f = fixture(); f.relations.push({ threadId: firstId, parentThreadId: rootId, title: "关联标题", status: "waiting_approval", activeTurnId: "t" });
  f.events.set(firstId, [envelope(firstId, 1, { type: "turn_started", turnId: "t", stepCount: 0 }), envelope(firstId, 2, { type: "answer_delta", turnId: "t", stepId: "s", delta: "不应预载的正文" }), envelope(firstId, 3, { type: "approval_required", turnId: "t", stepId: "s", callId: "call", toolName: "edit_file", result: { status: "approval_required", approval: { approvalId: "approval", reason: "修改合成文件", allowedDecisions: ["allow_once", "deny"] } } })]);
  await f.manager.refresh(); expect(f.get).not.toHaveBeenCalled(); expect(f.manager.related()[0]!.store.getSnapshot().liveEvents.some(function answer(event) { return event.type === "answer_delta"; })).toBe(false);
  const cancel = vi.fn(); const view = render(createElement(CliSessionWorkspace, { manager: f.manager, terminalSizeSource: { columns: 90, rows: 25 }, closeWhenIdle: false, renderMode: "inline", useColor: false, screenReader: false, onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: cancel, onEof: function eof() {}, onAppExit: function exit() {} }));
  try {
    await frame(); view.stdin.write("保留草稿"); await frame(); view.stdin.write("\u0001"); await frame(); view.stdin.write("\r"); await until(function approval() { return view.lastFrame().includes("原地审批"); }); expect(view.lastFrame()).not.toContain("不应预载的正文");
    view.stdin.write("\r"); view.stdin.write("\r"); await until(function approved() { return f.calls.includes("approve:" + firstId); });
    expect(f.calls.filter(function approve(call) { return call.startsWith("approve:"); })).toEqual(["approve:" + firstId]); expect(f.calls).toContain("continue:" + firstId); expect(f.manager.selected().sessionId).toBe(rootId); expect(cancel).not.toHaveBeenCalled();
    await frame(); expect(view.lastFrame()).toContain("保留草稿");
    f.relations[0]!.status = "completed"; await f.manager.refresh(); expect(f.manager.related()[0]!.store.getSnapshot().pendingApproval).toBeUndefined(); expect(f.manager.related()[0]!.store.getSnapshot().status).toBe("completed");
  } finally { view.unmount(); await f.manager.stop(); }
});

it("权威新Turn在等待历史页前失效旧审批，同Turn保持且迟到旧页不能复活", async function invalidatesBeforePage() {
  const f = fixture(); const relation = { threadId: firstId, parentThreadId: rootId, title: "关联", status: "waiting_approval" as Session["status"], activeTurnId: "old" }; f.relations.push(relation); f.events.set(firstId, approvalPage("old", "old-approval"));
  try {
    await f.manager.refresh(); const child = f.manager.related()[0]!; expect(child.store.getSnapshot().pendingApproval?.approvalId).toBe("old-approval");
    await f.manager.refresh(); expect(child.store.getSnapshot().pendingApproval?.approvalId).toBe("old-approval");
    // 已打开正文作为真实观察保留；身份切换只关闭交互，不伪造完成事件。
    child.controller.observe?.([{ ...envelope(firstId, 3, { type: "answer_delta", turnId: "old", stepId: "s", delta: "已观察正文" }), turnId: "old" }]);
    let release!: (page: { items: AgentEventEnvelope[]; cursor: string; nextCursor: string }) => void;
    f.readPage.mockImplementationOnce(function pending() { return new Promise(function wait(resolve) { release = resolve; }); });
    relation.activeTurnId = "new"; const refreshing = f.manager.refresh(); await until(function reading() { return Boolean(release); });
    expect(child.store.getSnapshot().pendingApproval).toBeUndefined(); expect(child.controller.getProjection()).toMatchObject({ turnId: "new", status: "waiting_approval" }); expect(child.controller.getProjection().pendingApproval).toBeUndefined();
    expect(child.store.getSnapshot().transcript.some(function retained(item) { return item.kind === "turn" && item.turnId === "old" && item.events.some(function body(event) { return event.type === "answer_delta" && event.delta === "已观察正文"; }); })).toBe(true);
    expect((await child.controller.dispatch({ type: "approve", decision: "allow_once", expected: { sessionId: firstId, turnId: "old", approvalId: "old-approval" } })).kind).toBe("error");
    release({ items: approvalPage("old", "old-approval"), cursor: "old-tail", nextCursor: "old-tail" }); await refreshing; expect(child.store.getSnapshot().pendingApproval).toBeUndefined(); expect(f.calls).toEqual([]);
  } finally { await f.manager.stop(); }
});

it("关联未知身份和终态按fail closed清审批及问答等待，不能回退旧Turn", async function invalidatesUnknownAndTerminal() {
  for (const update of [{ activeTurnId: undefined, status: "waiting_approval" }, { activeTurnId: "old", status: "completed" }, { activeTurnId: "old", status: "waiting_user_input" }]) {
    const f = fixture(); const relation = { threadId: firstId, parentThreadId: rootId, title: "关联", status: "waiting_approval" as Session["status"], activeTurnId: "old" as string | undefined }; f.relations.push(relation); f.events.set(firstId, approvalPage("old", "old-approval"));
    try {
      await f.manager.refresh(); const child = f.manager.related()[0]!; expect(child.store.getSnapshot().pendingApproval).toBeTruthy();
      Object.assign(relation, update); await f.manager.refresh(); expect(child.store.getSnapshot().pendingApproval).toBeUndefined(); expect(child.controller.getProjection().turnId).toBe(update.activeTurnId);
      expect((await child.controller.dispatch({ type: "approve", decision: "allow_once" })).kind).toBe("error"); expect(f.calls).toEqual([]);
    } finally { await f.manager.stop(); }
  }
});

it("旧审批提交在途期间身份改变，迟到返回不继续旧Turn且当前新审批仍可处理", async function stopsLateApproval() {
  const f = fixture(); const relation = { threadId: firstId, parentThreadId: rootId, title: "关联", status: "waiting_approval" as Session["status"], activeTurnId: "old" }; f.relations.push(relation); f.events.set(firstId, approvalPage("old", "old-approval"));
  let release!: () => void;
  const submit = vi.spyOn(f.runtime.approvals, "submit").mockImplementationOnce(async function pending() { await new Promise<void>(function wait(resolve) { release = resolve; }); });
  try {
    await f.manager.refresh(); const child = f.manager.related()[0]!;
    const approving = child.controller.dispatch({ type: "approve", decision: "allow_once" }); await until(function submitted() { return Boolean(release); });
    relation.activeTurnId = "new"; await f.manager.refresh(); release(); const late = await approving; expect(late.kind).toBe("error"); f.manager.handleResult(child, late); expect(child.store.getSnapshot().pendingApproval).toBeUndefined(); expect(f.calls).not.toContain("continue:" + firstId);
    f.events.get(firstId)!.push(...approvalPage("new", "new-approval")); await f.manager.refresh(); expect(child.store.getSnapshot().pendingApproval?.approvalId).toBe("new-approval");
    await child.controller.dispatch({ type: "approve", decision: "deny", expected: { sessionId: firstId, turnId: "new", approvalId: "new-approval" } }); expect(submit).toHaveBeenCalledTimes(2); expect(f.calls).toContain("continue:" + firstId);
  } finally { submit.mockRestore(); await f.manager.stop(); }
});
