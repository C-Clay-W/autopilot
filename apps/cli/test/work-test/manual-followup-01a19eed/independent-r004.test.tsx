/** r004独立验证：关联状态分页追赶期间，已呈现旧Turn审批必须随当前身份改变立即失效。 */
import { createElement } from "react";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import type { AgentEventEnvelope, AgentRuntime, Session } from "@autopilot-agent/core";
import { createCliController } from "../../../src/controller.js";
import { createPlainRenderer } from "../../../src/renderer.js";
import { createCliSessionManager } from "../../../src/tui/session-manager.js";
import { CliSessionWorkspace } from "../../../src/tui/session-workspace.js";

/** 等待内存Ink提交，不驱动真实终端。 */
async function frame() { await new Promise<void>(function delay(resolve) { setTimeout(resolve, 40); }); }
/** 有界等待一次操作结果，不重发输入。 */
async function until(check: () => boolean) { for (let i = 0; i < 25 && !check(); i++) await frame(); expect(check()).toBe(true); }
/** 合成两个Turn的分页事件，不包含真实用户状态。 */
function event(seq: number, turnId: string, value: unknown): AgentEventEnvelope { return { sessionId: "child", turnId, seq, timestamp: new Date(seq).toISOString(), event: value } as AgentEventEnvelope; }

it("关联新Turn待审批而分页仍追赶旧Turn时，旧审批及已打开菜单立即失效", async function invalidatesOldTurn() {
  const initial = { id: "root", title: "当前任务", productMode: "work", projectId: "p", status: "idle", createdAt: 0, updatedAt: 0 } as Session;
  const submit = vi.fn(async function submit() {});
  const resume = vi.fn(async function* resume() {});
  const runtime = { sessions: { get: vi.fn(), list: vi.fn() }, approvals: { submit }, turns: { continue: resume, getContextUsage: async function usage() { return null; } } } as unknown as AgentRuntime;
  /** 每个真实Controller固定绑定原Session。 */
  function controller(id: string) { return createCliController({ runtime, sessionId: id, renderer: createPlainRenderer("text") }); }
  const relation = { threadId: "child", parentThreadId: "root", title: "关联任务", status: "waiting_approval" as Session["status"], activeTurnId: "old-turn" };
  const oldPage = [event(1, "old-turn", { type: "turn_started", turnId: "old-turn", stepCount: 0 }), event(2, "old-turn", { type: "approval_required", turnId: "old-turn", stepId: "s", callId: "call", toolName: "edit_file", result: { status: "approval_required", approval: { approvalId: "old-approval", reason: "旧Turn审批理由", allowedDecisions: ["allow_once", "deny"], display: { operation: "修改合成文件", actionPreview: "旧Turn审批理由", allowedDecisions: ["allow_once", "deny"] } } } })];
  const readPage = vi.fn(async function page(_id: string, input: { cursor?: string }) {
    return input.cursor === undefined ? { items: oldPage, cursor: "page-1", nextCursor: "page-1" } : { items: Array.from({ length: 100 }, function oldBody(_, i) { return event(i + 3, "old-turn", { type: "answer_delta", turnId: "old-turn", stepId: "s", delta: "旧正文" }); }), cursor: "page-2", nextCursor: "page-2" };
  });
  const manager = createCliSessionManager({ runtime, projectId: "p", initialSession: initial, initialController: controller("root"), createController: controller, readRelations: async function relations() { return [relation]; }, readEventPage: readPage });
  await manager.refresh();
  const view = render(createElement(CliSessionWorkspace, { manager, terminalSizeSource: { columns: 90, rows: 25 }, closeWhenIdle: false, renderMode: "inline", useColor: false, screenReader: false, onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: function cancel() {}, onEof: function eof() {}, onAppExit: function exit() {} }));
  try {
    await frame(); view.stdin.write("保留草稿"); await frame();
    view.stdin.write("\u0001"); await frame(); view.stdin.write("\r");
    await until(function oldApprovalShown() { return view.lastFrame().includes("原地审批") && view.lastFrame().includes("旧Turn审批理由"); });
    relation.activeTurnId = "new-turn";
    await manager.refresh(); await frame();
    expect(readPage.mock.calls.at(-1)?.[1].cursor).toBe("page-1");
    expect(manager.related()[0]!.store.getSnapshot().pendingApproval, "新Turn身份已确认，尚未追赶到新审批前不可保留旧Turn可执行审批").toBeUndefined();
    expect(view.lastFrame()).not.toContain("旧Turn审批理由");
    expect(view.lastFrame()).not.toContain("原地审批");
    expect(submit).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
    expect(manager.selected().viewState.draftRef.current?.inputRef.current).toBe("保留草稿");
  } finally { view.unmount(); await manager.stop(); }
});

