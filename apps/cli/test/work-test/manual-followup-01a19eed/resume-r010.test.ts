/** r010回归：恢复准备期间的目录/旧历史读取不能使当前恢复请求失效。 */
import { expect, it } from "vitest";
import { createCliController } from "../../../src/controller.js";
import { createPlainRenderer } from "../../../src/renderer.js";
import { createCliSessionManager } from "../../../src/tui/session-manager.js";
import type { AgentRuntime, Session } from "@autopilot-agent/core";

it("启动恢复与迟到旧历史/元数据重叠时保持精确恢复身份", async function resumeHydrationRace() {
  const session = { id: "s", title: "恢复测试", productMode: "work", projectId: "p", status: "interrupted", createdAt: 0, updatedAt: 0 } as Session;
  let releaseState!: (state: unknown) => void;
  let releasePage!: (page: unknown) => void;
  const runtime = { sessions: { get: async function get() { return session; } }, turns: { getRecoverableState: function recover() { return new Promise(function delayed(resolve) { releaseState = resolve; }); } } } as unknown as AgentRuntime;
  const controller = createCliController({ sessionId: "s", runtime, renderer: createPlainRenderer("text") });
  const manager = createCliSessionManager({ runtime, projectId: "p", initialSession: session, initialController: controller, createController: function create() { return controller; }, readSummary: async function summary() { return session; }, readEventPage: function page() { return new Promise(function delayed(resolve) { releasePage = resolve; }); } });
  const hydration = manager.loadHistory();
  const resume = controller.resume();
  await manager.refresh();
  releasePage({ items: [{ sessionId: "s", turnId: "old", seq: 1, timestamp: new Date(0).toISOString(), event: { type: "turn_started", turnId: "old", stepCount: 0 } }], cursor: "tail" });
  await hydration;
  releaseState({ sessionId: "s", turnId: "current", status: "awaiting_approval", recoverable: true, activeSkills: [], approval: { approvalId: "approval", toolName: "run_command", allowedDecisions: ["allow_once", "deny"] } });
  const result = await resume;
  expect(result.kind).toBe("ok");
  expect(controller.getProjection().turnId).toBe("current");
  expect(controller.getProjection().pendingApproval?.approvalId).toBe("approval");
  expect(manager.selected().hydrated).toBe(false);
});

it("决定已落盘但旧宿主未continue时通过resume续接且不重复提交", async function resumesSavedDecision() {
  let continued: unknown;
  let submitted = false;
  const runtime = { approvals: { getDecision: async function decision(input: unknown) { expect(input).toEqual({ sessionId: "s", turnId: "t", approvalId: "a" }); return { decision: "allow_once" }; }, submit: async function submit() { submitted = true; } }, turns: { getRecoverableState: async function state() { return { sessionId: "s", turnId: "t", status: "awaiting_approval", recoverable: true, activeSkills: [], approval: { approvalId: "a", toolName: "run_command" } }; }, async *continue(input: unknown) { continued = input; } } } as unknown as AgentRuntime;
  const controller = createCliController({ sessionId: "s", runtime, renderer: createPlainRenderer("text") });
  expect((await controller.resume()).kind).toBe("ok");
  expect(continued).toEqual({ sessionId: "s", turnId: "t", approval: { approvalId: "a", decision: "allow" } });
  expect(submitted).toBe(false);
});

it("审批提交跨过后台刷新时不清除当前身份且只continue一次", async function approvalRefreshRace() {
  const session = { id: "s", title: "审批测试", productMode: "work", projectId: "p", status: "waiting_approval", createdAt: 0, updatedAt: 0 } as Session;
  let release!: () => void;
  let continued = 0;
  const pending = { approvalId: "a", callId: "c", toolName: "run_command", reason: "合成命令", constraint: "command:v1", display: { operation: "合成命令", actionPreview: "合成命令", allowedDecisions: ["allow_once", "deny"] } };
  const envelope = { sessionId: "s", turnId: "t", seq: 1, timestamp: new Date().toISOString(), event: { type: "approval_required", turnId: "t", stepId: "step", callId: "c", toolName: "run_command", result: { status: "approval_required", approval: pending } } } as never;
  const runtime = { sessions: { get: async function get() { return session; } }, approvals: { submit: function submit() { return new Promise<void>(function wait(resolve) { release = resolve; }); } }, turns: { async *continue() { continued++; }, getRecoverableState: async function state() { return null; } } } as unknown as AgentRuntime;
  const controller = createCliController({ sessionId: "s", runtime, renderer: createPlainRenderer("text") });
  const manager = createCliSessionManager({ runtime, projectId: "p", initialSession: session, initialController: controller, createController: function create() { return controller; }, readSummary: async function summary() { return { ...session, currentTurnId: "t" }; }, readEventPage: async function page() { return { items: [envelope], cursor: "tail" }; } });
  await manager.refresh();
  const approving = controller.dispatch({ type: "approve", decision: "allow_once", expected: { sessionId: "s", turnId: "t", approvalId: "a" } });
  await manager.refresh();
  release();
  const result = await approving;
  expect(result.kind).toBe("ok");
  expect(continued).toBe(1);
});
