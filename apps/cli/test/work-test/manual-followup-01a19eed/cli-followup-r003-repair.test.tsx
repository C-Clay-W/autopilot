/** r003独立组合验证：显式关联、阅读保活及长详情终态隔离；只使用内存Ink与fake Runtime。 */
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import { createCliController } from "../../../src/controller.js";
import { createPlainRenderer } from "../../../src/renderer.js";
import { createCliSessionManager } from "../../../src/tui/session-manager.js";
import { CliSessionWorkspace } from "../../../src/tui/session-workspace.js";

/** 每个输入后等待一帧，确保Ink订阅提交；不重复发送输入。 */
async function frame() { await new Promise<void>(function tick(resolve) { setTimeout(resolve, 40); }); }
/** 固定安全事件驱动真实Controller，禁止访问用户运行态。 */
async function* events(items: unknown[]) { for (const item of items) yield item as never; }
/** 生成带长安全展示的冻结审批事实。 */
function approval(turnId: string, approvalId: string) {
  return [
    { type: "turn_started", turnId, stepCount: 0 },
    { type: "approval_required", turnId, stepId: "step", callId: "call", toolName: "edit_file", result: { status: "approval_required", approval: { approvalId, reason: "独立fixture", allowedDecisions: ["allow_once", "deny"], display: { allowedDecisions: ["allow_once", "deny"], operation: "编辑fixture", effect: "workspace", actionPreview: Array.from({ length: 45 }, function line(_, index) { return `安全详情第${String(index).padStart(2, "0")}行`; }).join("\n") } } } },
    { type: "turn_paused", turnId, checkpoint: { turnId, status: "awaiting_approval", messages: [], completedCallIds: [] } },
  ];
}
/** 建立含显式关联、创建来源、孙级与无关目录的独立fixture。 */
async function fixture() {
  const root = { id: "root", title: "主会话", productMode: "work", projectId: "p", status: "idle", createdAt: 1, updatedAt: 1 };
  const linked = { ...root, id: "linked", title: "显式关联审批目标" };
  const unrelated = { ...root, id: "unrelated", title: "独立普通审批目标" };
  const child = { ...root, id: "child", title: "创建来源子会话", creationSource: { actor: { kind: "thread", threadId: root.id, turnId: "source-turn" }, requestId: "create-child" } };
  const grandchild = { ...child, id: "grandchild", title: "孙级会话", creationSource: { actor: { kind: "thread", threadId: child.id, turnId: "child-source" }, requestId: "create-grandchild" } };
  const sessions = [root, linked, unrelated, child, grandchild];
  const calls: any[] = [];
  const runtime = {
    sessions: { list: async function list() { return sessions; }, get: async function get(id: string) { return sessions.find(function match(item) { return item.id === id; }); } },
    approvals: { submit: async function submit(input: unknown) { calls.push({ type: "approve", ...input as object }); } },
    turns: {
      start: async function* start() { calls.push({ type: "start" }); },
      continue: function resume(input: any) { calls.push({ type: "continue", ...input }); return events([{ type: "turn_completed", turnId: input.turnId, checkpoint: { turnId: input.turnId, status: "completed", messages: [], completedCallIds: [] } }]); },
      cancel: async function cancel(input: unknown) { calls.push({ type: "cancel", ...input as object }); },
      getFrozenRunConfig: async function frozen() { return undefined; }, getRecoverableState: async function recover() { return null; },
    },
  } as never;
  /** 每个身份固定真实Controller，关联只来自只读关系回调。 */
  function controller(sessionId: string) { return createCliController({ runtime, sessionId, renderer: createPlainRenderer("text") }); }
  const manager = createCliSessionManager({ runtime, projectId: "p", initialSession: root as never, initialController: controller(root.id), createController: controller, readRelations: async function relations() { return [{ threadId: linked.id, parentThreadId: root.id }]; }, readEvents: async function history() { return []; } });
  await manager.refresh();
  const terminal = Object.assign(new EventEmitter(), { columns: 160, rows: 30 });
  const cancel = vi.fn();
  const view = render(createElement(CliSessionWorkspace, { manager, terminalSizeSource: terminal, closeWhenIdle: false, useColor: false, screenReader: false, renderMode: "alternate-screen", onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: cancel, onEof: function eof() {}, onAppExit: function exit() {} }));
  /** 同步物理终端与内存输出尺寸，仅发resize，不注入业务事件。 */
  async function resize(columns: number, rows: number) { terminal.columns = columns; terminal.rows = rows; Object.defineProperty(view.stdout, "columns", { configurable: true, value: columns }); Object.defineProperty(view.stdout, "rows", { configurable: true, value: rows }); terminal.emit("resize"); view.stdout.emit("resize"); await frame(); await frame(); }
  /** 一次按键作为一个独立输入事件，等待订阅完成。 */
  async function key(value: string) { view.stdin.write(value); await frame(); }
  return { manager, view, terminal, calls, cancel, resize, key };
}


it("关闭侧栏后首次PgUp即可阅读且宽窄往返保留草稿与位置", async function readingAfterClose() {
 const f = await fixture();
 try { await f.resize(160,30); f.manager.selected().store.recordPrompt(Array.from({length:80},function line(_,i){return `正文阅读标记${String(i).padStart(2,"0")}`;}).join("\n")); await frame(); await f.key("保留主草稿"); await f.key("\u001b"); await f.key("\u001b[5~");
 const markers = f.view.lastFrame().match(/正文阅读标记\d+/gu) ?? []; expect(markers.length).toBeGreaterThan(0); expect(markers).not.toContain("正文阅读标记79");
 await f.resize(74,30); await f.resize(180,30); await f.resize(160,30); expect(f.view.lastFrame().match(/正文阅读标记\d+/gu)).toEqual(markers); expect(f.view.lastFrame()).toContain("保留主草稿"); expect(f.calls).toEqual([]); expect(f.cancel).not.toHaveBeenCalled();
 } finally { f.view.unmount(); await f.manager.stop(); }
});

it("快速管理切入长审批仍固定显示决定，Pg和Esc不穿透，独立Enter只批准目标", async function ordinaryApproval() {
 const f = await fixture(); const target = f.manager.entries().find(function match(entry){return entry.sessionId === "unrelated";})!;
 try { await target.controller.consume(events(approval("ordinary-turn","ordinary-approval"))); await f.resize(74,24); await f.key("主草稿保留");
 f.view.stdin.write("\u0014"); f.view.stdin.write("\u001b[B"); f.view.stdin.write("\u001b[B"); f.view.stdin.write("\r"); await frame(); await frame();
 expect(f.manager.selected().sessionId).toBe("unrelated"); expect(f.calls).toEqual([]); expect(f.view.lastFrame()).toContain("允许本次"); expect(f.view.lastFrame()).toContain("拒绝"); expect(f.view.lastFrame()).toContain("安全详情第00行");
 await f.key("\u001b[6~"); expect(f.view.lastFrame()).not.toContain("安全详情第00行"); expect(f.view.lastFrame()).toMatch(/安全详情第\d+行/u); expect(f.view.lastFrame()).toContain("允许本次"); expect(f.view.lastFrame()).toContain("拒绝");
 await f.key("\u001b"); expect(f.cancel).not.toHaveBeenCalled(); expect(f.calls).toEqual([]); expect(f.view.lastFrame()).toContain("允许本次");
 await f.key("\r"); expect(f.calls).toEqual([{type:"approve",sessionId:"unrelated",turnId:"ordinary-turn",approvalId:"ordinary-approval",decision:"allow_once"},{type:"continue",sessionId:"unrelated",turnId:"ordinary-turn",approval:{approvalId:"ordinary-approval",decision:"allow"}}]);
 } finally { f.view.unmount(); await f.manager.stop(); }
});
