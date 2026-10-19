/** CLI Controller contract test：无 React/Ink 时验证 Runtime 委托、事件输出和审批边界。 */

import type { AgentEvent, ApprovalDecision } from "@autopilot-agent/core";
import { describe, expect, it } from "vitest";
import { createCliController } from "../src/controller.js";
import { createPlainRenderer } from "../src/renderer.js";
import type { CliRuntime } from "../src/types.js";

/** 构造测试用 AgentEvent，避免让测试依赖 Kernel private 类型。 */
function asEvent(value: unknown): AgentEvent {
  return value as AgentEvent;
}

/** 将固定事件转换为异步事件流，模拟 Core Public API 的 AsyncIterable。 */
async function* eventStream(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const event of events) yield event;
}

/** 构造只实现 Controller 所需方法的最小 Runtime double。 */
function createRuntimeDouble(calls: { cancelled: boolean; continued: unknown[] }): CliRuntime {
  const runtime = {
    turns: {
      start: function start() {
        return eventStream([
          asEvent({ type: "turn_started", turnId: "turn-1", stepCount: 0 }),
          asEvent({ type: "answer_delta", turnId: "turn-1", stepId: "step-1", delta: "done" }),
          asEvent({ type: "turn_completed", turnId: "turn-1", checkpoint: { turnId: "turn-1", status: "completed", stepCount: 1, messages: [], completedCallIds: [] } }),
        ]);
      },
      continue: function continueTurn(input: unknown) {
        calls.continued.push(input);
        return eventStream([asEvent({ type: "turn_completed", turnId: "turn-1", checkpoint: { turnId: "turn-1", status: "completed", stepCount: 2, messages: [], completedCallIds: [] } })]);
      },
      cancel: async function cancel() {
        calls.cancelled = true;
      },
    },
  } as unknown as CliRuntime;
  return runtime;
}

describe("CLI Controller", function controllerSuite() {
  it("无 React 时委托 start 并输出安全 text 事件", async function delegatesStartWithoutReact() {
    const calls = { cancelled: false, continued: [] as unknown[] };
    const controller = createCliController({ runtime: createRuntimeDouble(calls), renderer: createPlainRenderer("text"), sessionId: "session-1" });
    const result = await controller.dispatch({ type: "submit_prompt", content: "hello" });
    expect(result.kind).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("answer: done");
    expect(result.projection.status).toBe("completed");
  });

  it.each(["继续", "继续执行", "继续任务"])("可恢复 Turn 的继续词 %s 复用原 turn，不创建新 turn", async function resumesSameTurn(content) {
    const started: unknown[] = [];
    const continued: unknown[] = [];
    const runtime = {
      turns: {
        start: function start(input: unknown) {
          started.push(input);
          return eventStream([]);
        },
        getRecoverableState: async function getRecoverableState() {
          return { sessionId: "session-1", turnId: "turn-paused", status: "interrupted_recoverable", recoverable: true, activeSkills: [], lastSeq: 7 };
        },
        continue: function continueTurn(input: unknown) {
          continued.push(input);
          return eventStream([asEvent({
            type: "turn_completed",
            turnId: "turn-paused",
            checkpoint: { turnId: "turn-paused", status: "completed", stepCount: 8, messages: [], completedCallIds: [] },
          })]);
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session-1" });

    await controller.consume(eventStream([asEvent({
      type: "turn_interrupted",
      turnId: "turn-paused",
      checkpoint: { turnId: "turn-paused", status: "interrupted_recoverable", stepCount: 7, messages: [], completedCallIds: [] },
    })]));

    const result = await controller.dispatch({ type: "submit_prompt", content });

    expect(result.projection.status).toBe("completed");
    expect(started).toHaveLength(0);
    expect(continued).toEqual([{ sessionId: "session-1", turnId: "turn-paused" }]);
  });

  it("无可恢复 Turn 时继续词仍按普通 prompt 启动新 turn", async function startsNewTurnWithoutRecovery() {
    const started: unknown[] = [];
    const runtime = {
      turns: {
        getRecoverableState: async function getRecoverableState() { return null; },
        start: function start(input: unknown) {
          started.push(input);
          return eventStream([asEvent({
            type: "turn_completed",
            turnId: "turn-new",
            checkpoint: { turnId: "turn-new", status: "completed", stepCount: 1, messages: [], completedCallIds: [] },
          })]);
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session-1" });

    const result = await controller.dispatch({ type: "submit_prompt", content: "继续" });

    expect(result.projection.status).toBe("completed");
    expect(started).toEqual([{ sessionId: "session-1", content: "继续", activeSkills: undefined }]);
  });

  it("运行中的普通输入默认 steer，/queue 显式写入同一 durable inbox", async function routesLiveInputToInbox() {
    const steers: unknown[] = [];
    const runtime = {
      turns: {
        start: function start() {
          return eventStream([asEvent({ type: "turn_started", turnId: "turn-1", stepCount: 0 })]);
        },
        steer: async function steer(input: unknown) {
          steers.push(input);
          const delivery = (input as { delivery: "steer" | "queue" }).delivery;
          return { inputId: `input-${delivery}`, delivery, status: "pending", sessionId: "session-1", content: "private", attachments: [], selectedSkills: [], createdAt: "2026-08-04T00:00:00.000Z" };
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session-1" });

    await controller.dispatch({ type: "submit_prompt", content: "开始" });
    const guided = await controller.dispatch({ type: "submit_prompt", content: "改为先检查" });
    const queued = await controller.dispatch({ type: "submit_prompt", content: "随后测试", delivery: "queue" });

    expect(steers).toEqual([
      { sessionId: "session-1", turnId: "turn-1", content: "改为先检查", delivery: "steer", selectedSkills: [] },
      { sessionId: "session-1", turnId: "turn-1", content: "随后测试", delivery: "queue", selectedSkills: [] },
    ]);
    expect(guided.submittedInput).toEqual({ inputId: "input-steer", delivery: "steer" });
    expect(queued.submittedInput).toEqual({ inputId: "input-queue", delivery: "queue" });
  });

  it("自动启动 queue Turn 前通知 TUI，保证消费 prompt 能插入新 Turn 的开头", async function notifiesQueuedTurnStart() {
    const started: unknown[] = [];
    let claimed = true;
    const runtime = {
      turns: {
        start: function start(input: { turnId?: string }) {
          const turnId = input.turnId ?? "turn-main";
          return eventStream([
            asEvent({ type: "turn_started", turnId, stepCount: 0 }),
            asEvent({ type: "turn_completed", turnId, checkpoint: { turnId, status: "completed", stepCount: 1, messages: [], completedCallIds: [] } }),
          ]);
        },
      },
      inbox: {
        claimNext: async function claimNext() {
          if (!claimed) return undefined;
          claimed = false;
          return { inputId: "queue-input-1", content: "排队任务", selectedSkills: [] };
        },
        consume: async function consume() { return true; },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({
      runtime,
      renderer: createPlainRenderer("text"),
      sessionId: "session-1",
      onQueuedInputStarted: function onQueuedInputStarted(input): void { started.push(input); },
    });

    const result = await controller.dispatch({ type: "submit_prompt", content: "主任务" });

    expect(result.projection.status).toBe("completed");
    expect(started).toMatchObject([{ inputId: "queue-input-1", content: "排队任务", delivery: "queue" }]);
    expect(started[0]).toMatchObject({ turnId: expect.any(String) });
  });

  it("主 Turn 失败时不自动消费 queue，保留排队输入等待用户处理", async function keepsQueueAfterFailedTurn() {
    const startedInputs: unknown[] = [];
    let claimCount = 0;
    const runtime = {
      turns: {
        start: function start(input: { turnId?: string }) {
          const turnId = input.turnId ?? "turn-main";
          startedInputs.push(input);
          return eventStream([
            asEvent({ type: "turn_started", turnId, stepCount: 0 }),
            asEvent({ type: "turn_failed", turnId, checkpoint: { turnId, status: "failed", stepCount: 1, messages: [], completedCallIds: [] }, error: "主任务失败" }),
          ]);
        },
      },
      inbox: {
        claimNext: async function claimNext() {
          claimCount += 1;
          return { inputId: "queue-input-failed", content: "失败后的排队任务", selectedSkills: [] };
        },
        consume: async function consume() { return true; },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({
      runtime,
      renderer: createPlainRenderer("text"),
      sessionId: "session-1",
    });

    const result = await controller.dispatch({ type: "submit_prompt", content: "主任务" });

    expect(result.projection.status).toBe("failed");
    expect(startedInputs).toHaveLength(1);
    expect(claimCount).toBe(0);
  });

  it("审批 Action 只向注入回调提交四个宿主字段，不生成冻结凭证", async function submitsOnlyApprovalBoundary() {
    const calls = { cancelled: false, continued: [] as unknown[] };
    const submitted: unknown[] = [];
    const controller = createCliController({
      runtime: createRuntimeDouble(calls),
      renderer: createPlainRenderer("jsonl"),
      sessionId: "session-1",
      approvalSubmit: async function approvalSubmit(input): Promise<ApprovalDecision> {
        submitted.push(input);
        return {
          approvalId: input.approvalId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          callId: "runtime-owned",
          toolName: "runtime-owned",
          normalizedInputHash: "runtime-owned",
          decision: input.decision,
          createdAt: "2026-08-04T00:00:00.000Z",
        };
      },
    });
    await controller.consume(eventStream([asEvent({
      type: "approval_required",
      turnId: "turn-1",
      stepId: "step-1",
      callId: "private-call",
      toolName: "edit_file",
      result: {
        status: "approval_required",
        callId: "private-call",
        toolName: "edit_file",
        approval: {
          approvalId: "approval-1",
          callId: "private-call",
          toolName: "edit_file",
          normalizedInputHash: "private-hash",
          reason: "write",
          risk: "write",
          preview: { path: "C:/workspace/private.txt" },
          expiresAt: "2026-08-04T00:00:00.000Z",
        },
      },
    })]));
    const result = await controller.dispatch({ type: "approve", decision: "allow_workspace" });
    expect(result.kind).toBe("ok");
    expect(submitted).toHaveLength(1);
    expect(Object.keys(submitted[0] as Record<string, unknown>).sort()).toEqual(["approvalId", "decision", "sessionId", "turnId"]);
    expect(calls.continued[0]).toEqual({ sessionId: "session-1", turnId: "turn-1", approval: { approvalId: "approval-1", decision: "allow" } });
  });

  it("compact 与 skill 在本步返回稳定 capability-unavailable，不伪造成功", async function rejectsDeferredCapabilities() {
    const controller = createCliController({ renderer: createPlainRenderer("text") });
    await expect(controller.dispatch({ type: "compact" })).resolves.toMatchObject({ kind: "unavailable", exitCode: 1 });
    await expect(controller.dispatch({ type: "select_skill", skill: "repo:demo" })).resolves.toMatchObject({ kind: "unavailable", exitCode: 1 });
  });

  it("compact submits only Runtime-owned policy and skill identity", async function submitsSafeCompactAndSkillInput() {
    const starts: unknown[] = [];
    const compacts: unknown[] = [];
    const runtime = {
      turns: {
        start: function start(input: unknown) {
          starts.push(input);
          return eventStream([asEvent({ type: "turn_started", turnId: "turn-1", stepCount: 0 })]);
        },
        compact: async function compact(input: unknown) {
          compacts.push(input);
          return { summary: "compacted", messages: [], preTokens: 100, postTokens: 50, preservedFromIndex: 1 };
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({
      runtime,
      renderer: createPlainRenderer("text"),
      sessionId: "session-1",
      resolveSkill: async function resolveSkill() {
        return { skillId: "repo:demo", contentHash: "hash-1" };
      },
    });

    await controller.dispatch({ type: "select_skill", skill: "repo:demo" });
    await controller.dispatch({ type: "submit_prompt", content: "hello" });
    const result = await controller.dispatch({ type: "compact" });

    expect(result.kind).toBe("ok");
    expect(starts).toEqual([{ sessionId: "session-1", content: "hello", activeSkills: [{ skillId: "repo:demo", contentHash: "hash-1" }] }]);
    expect(compacts).toEqual([{ sessionId: "session-1", turnId: "turn-1", trigger: "manual" }]);
    expect(JSON.stringify(compacts)).not.toContain("messages");
  });

  it("模型与 effort 只更新下一 Turn 的 Session 默认值，并按 CC settings 目录接受通用请求值", async function switchesSessionRunConfigFromCapabilities() {
    const saved: unknown[] = [];
    const session = {
      id: "session-1",
      defaultRunConfig: {
        modelRef: { provider: "firstParty", modelId: "provider-flash" },
        reasoningProfile: { effort: "high" },
      },
    };
    const runtime = {
      turns: {
        getFrozenRunConfig: async function getFrozenRunConfig() {
          return {
            sessionId: "session-1",
            turnId: "turn-1",
            modelRef: { provider: "openai", modelId: "gpt-5" },
            reasoningProfile: { effort: "high", maxTokens: 4096 },
          };
        },
      },
      sessions: {
        get: async function getSession() { return session; },
        setDefaultRunConfig: async function setDefaultRunConfig(_sessionId: string, runConfig: unknown) {
          session.defaultRunConfig = runConfig as typeof session.defaultRunConfig;
          saved.push(runConfig);
          return session;
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({
      runtime,
      renderer: createPlainRenderer("text"),
      sessionId: "session-1",
      getRuntimeStatusDefaults: function getRuntimeStatusDefaults() {
        return {
          modelCapabilities: [
            { provider: "firstParty", modelId: "provider-flash", requestableEfforts: ["none", "low", "medium", "high", "max"] },
            { provider: "firstParty", modelId: "provider-pro", requestableEfforts: ["none", "low", "medium", "high", "max"] },
          ],
        };
      },
    });
    await controller.consume(eventStream([asEvent({ type: "turn_started", turnId: "turn-1", stepCount: 0 })]));

    await expect(controller.dispatch({ type: "open_model_picker" })).resolves.toMatchObject({
      kind: "ok",
      modelOptions: [{ modelId: "provider-flash", selected: true }, { modelId: "provider-pro", selected: false }],
    });
    await expect(controller.dispatch({ type: "set_model", modelId: "provider-pro" })).resolves.toMatchObject({ kind: "ok", statusView: { nextModel: "firstParty/provider-pro" } });
    await expect(controller.dispatch({ type: "open_effort_picker" })).resolves.toMatchObject({
      kind: "ok",
      effortOptions: [{ effort: "none" }, { effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "max" }],
    });
    await expect(controller.dispatch({ type: "set_effort", effort: "low" })).resolves.toMatchObject({ kind: "ok", statusView: { nextEffort: "low" } });
    await expect(controller.dispatch({ type: "set_effort", effort: "max" })).resolves.toMatchObject({ kind: "ok", statusView: { nextEffort: "max" } });
    expect(saved).toEqual([
      { modelRef: { provider: "firstParty", modelId: "provider-pro" }, reasoningProfile: { effort: "high" } },
      { modelRef: { provider: "firstParty", modelId: "provider-pro" }, reasoningProfile: { effort: "low" } },
      { modelRef: { provider: "firstParty", modelId: "provider-pro" }, reasoningProfile: { effort: "max" } },
    ]);
  });

  it("provider/model 精确切换同名 route 模型，并保留 provider 身份", async function selectsProviderQualifiedModel() {
    const saved: unknown[] = [];
    const session = { id: "session-route", defaultRunConfig: {} };
    const runtime = {
      sessions: {
        get: async function getSession() { return session; },
        setDefaultRunConfig: async function setDefaultRunConfig(_sessionId: string, runConfig: unknown) {
          session.defaultRunConfig = runConfig as typeof session.defaultRunConfig;
          saved.push(runConfig);
          return session;
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({
      runtime,
      renderer: createPlainRenderer("text"),
      sessionId: "session-route",
      getRuntimeStatusDefaults: function getRuntimeStatusDefaults() {
        return {
          modelCapabilities: [
            { provider: "gateway-a", modelId: "shared-model", requestableEfforts: ["none"] },
            { provider: "gateway-b", modelId: "shared-model", requestableEfforts: ["none"] },
          ],
        };
      },
    });

    await expect(controller.dispatch({ type: "set_model", provider: "gateway-b", modelId: "shared-model" })).resolves.toMatchObject({ kind: "ok" });
    expect(saved).toEqual([{ modelRef: { provider: "gateway-b", modelId: "shared-model" } }]);
  });

  it("活动 /exit 先由 Core 取消并恢复安全终态，再返回退出结果", async function exitsAfterControlledCancellation() {
    let cancelled = false;
    const runtime = {
      turns: {
        cancel: async function cancel() { cancelled = true; },
        getRecoverableState: async function getRecoverableState() {
          return { sessionId: "session-1", turnId: "turn-1", status: "interrupted_recoverable", recoverable: true, activeSkills: [] };
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session-1" });
    await controller.consume(eventStream([asEvent({ type: "turn_started", turnId: "turn-1", stepCount: 0 })]));

    const result = await controller.dispatch({ type: "exit" });

    expect(cancelled).toBe(true);
    expect(result.kind).toBe("exit");
    expect(result.projection.status).toBe("interrupted_recoverable");
  });

  it("/skill 无参数展示安全 catalog 摘要，不要求用户预先记住名称", async function listsAvailableSkills() {
    const controller = createCliController({
      renderer: createPlainRenderer("text"),
      listSkills: async function listSkills() {
        return [
          { qualifiedName: "repo:review", displayName: "代码审查", description: "检查当前变更" },
          { qualifiedName: "user:release", displayName: "发布", description: "准备发布说明" },
        ];
      },
    });

    const result = await controller.dispatch({ type: "list_skills" });

    expect(result.kind).toBe("ok");
    expect(result.lines).toEqual([
      "available skills:",
      "1. 代码审查 (repo:review) — 检查当前变更",
      "2. 发布 (user:release) — 准备发布说明",
      "use /skill <canonical name> to select one",
    ]);
  });

  it("picker 的 toggle_skill 只保存 Runtime 校验后的身份，并返回最新 on/off 安全摘要", async function togglesSelectedSkill() {
    const controller = createCliController({
      renderer: createPlainRenderer("text"),
      listSkills: async function listSkills() {
        return [{ qualifiedName: "repo:review", displayName: "代码审查", description: "检查当前变更" }];
      },
      resolveSkill: async function resolveSkill() {
        return { skillId: "repo:review", contentHash: "hash-1" };
      },
    });

    await expect(controller.dispatch({ type: "toggle_skill", skill: "repo:review" })).resolves.toMatchObject({
      kind: "ok",
      lines: ["skill enabled: repo:review"],
      skillOptions: [{ qualifiedName: "repo:review", selected: true }],
    });
    await expect(controller.dispatch({ type: "toggle_skill", skill: "repo:review" })).resolves.toMatchObject({
      kind: "ok",
      lines: ["skill disabled: repo:review"],
      skillOptions: [{ qualifiedName: "repo:review", selected: false }],
    });
  });

  it("真实 Runtime 审批闭环只提交四字段并复用同一 turn 继续", async function completesApprovalFlow() {
    const submitted: unknown[] = [];
    const runtime = {
      turns: {
        start: function start() {
          return eventStream([
            asEvent({ type: "turn_started", turnId: "turn-1", stepCount: 0 }),
            asEvent({ type: "tool_started", turnId: "turn-1", stepId: "step-1", callId: "private-call", toolName: "run_command", summary: "执行命令" }),
            asEvent({
              type: "approval_required",
              turnId: "turn-1",
              stepId: "step-1",
              callId: "private-call",
              toolName: "run_command",
              result: {
                status: "approval_required",
                callId: "private-call",
                toolName: "run_command",
                approval: {
                  approvalId: "approval-1",
                  callId: "private-call",
                  toolName: "run_command",
                  normalizedInputHash: "private-hash",
                  reason: "命令需要确认",
                  risk: "command",
                  preview: { cwd: "C:/private" },
                  expiresAt: "2026-08-04T00:00:00.000Z",
                  display: { operation: "command", effect: "external", destructive: false, risk: "command", allowedDecisions: ["allow_once", "deny"] },
                },
              },
            }),
          ]);
        },
        continue: function continueTurn() {
          return eventStream([
            asEvent({ type: "tool_result", turnId: "turn-1", stepId: "step-1", callId: "private-call", toolName: "run_command", retryCount: 0, summary: "命令完成", result: { status: "success", callId: "private-call", toolName: "run_command", output: "private", meta: { durationMs: 1, inputHash: "private-hash" } } }),
            asEvent({ type: "turn_completed", turnId: "turn-1", checkpoint: { turnId: "turn-1", status: "completed", stepCount: 2, messages: [], completedCallIds: ["private-call"] } }),
          ]);
        },
      },
      approvals: {
        submit: async function submit(input: unknown) {
          submitted.push(input);
          return { approvalId: "approval-1", sessionId: "session-1", turnId: "turn-1", callId: "runtime-owned", toolName: "run_command", normalizedInputHash: "runtime-owned", decision: "allow_once", createdAt: "2026-08-04T00:00:00.000Z" };
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session-1" });
    const initial = await controller.dispatch({ type: "submit_prompt", content: "执行命令" });
    expect(initial.projection.status).toBe("waiting_approval");
    const completed = await controller.dispatch({ type: "approve", decision: "allow_once" });
    expect(completed.projection.status).toBe("completed");
    expect(Object.keys(submitted[0] as Record<string, unknown>).sort()).toEqual(["approvalId", "decision", "sessionId", "turnId"]);
    expect(completed.lines.join("\n")).toContain("tool run_command [success]");
  });

  it("auto_approve 命令审批遵循 Core 冻结范围并允许此工作区继续", async function completesWorkspaceCommandApproval() {
    const submitted: unknown[] = [];
    const continued: unknown[] = [];
    const runtime = {
      turns: {
        start: function start() {
          return eventStream([
            asEvent({ type: "turn_started", turnId: "turn-auto-approve", stepCount: 0 }),
            asEvent({ type: "tool_started", turnId: "turn-auto-approve", stepId: "step-1", callId: "auto-command", toolName: "run_command", summary: "执行命令" }),
            asEvent({
              type: "approval_required",
              turnId: "turn-auto-approve",
              stepId: "step-1",
              callId: "auto-command",
              toolName: "run_command",
              result: {
                status: "approval_required",
                callId: "auto-command",
                toolName: "run_command",
                approval: {
                  approvalId: "approval-auto",
                  callId: "auto-command",
                  toolName: "run_command",
                  normalizedInputHash: "auto-hash",
                  reason: "命令需要确认",
                  risk: "external_side_effect",
                  preview: { cwd: "C:/private" },
                  expiresAt: "2026-08-04T00:00:00.000Z",
                  display: { operation: "command", effect: "external", destructive: false, risk: "external_side_effect", allowedDecisions: ["allow_once", "allow_session", "allow_workspace", "deny"] },
                },
              },
            }),
          ]);
        },
        continue: function continueTurn(input: unknown) {
          continued.push(input);
          return eventStream([asEvent({ type: "turn_completed", turnId: "turn-auto-approve", checkpoint: { turnId: "turn-auto-approve", status: "completed", stepCount: 2, messages: [], completedCallIds: ["auto-command"] } })]);
        },
      },
      approvals: {
        submit: async function submit(input: unknown) {
          submitted.push(input);
          return { approvalId: "approval-auto", sessionId: "session-1", turnId: "turn-auto-approve", callId: "auto-command", toolName: "run_command", normalizedInputHash: "auto-hash", decision: "allow_workspace", createdAt: "2026-08-04T00:00:00.000Z" };
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session-1" });

    const initial = await controller.dispatch({ type: "submit_prompt", content: "执行命令" });
    expect(initial.projection.status).toBe("waiting_approval");
    const completed = await controller.dispatch({ type: "approve", decision: "allow_workspace" });

    expect(completed.projection.status).toBe("completed");
    expect(submitted).toEqual([{ approvalId: "approval-auto", decision: "allow_workspace", sessionId: "session-1", turnId: "turn-auto-approve" }]);
    expect(continued).toEqual([{ sessionId: "session-1", turnId: "turn-auto-approve", approval: { approvalId: "approval-auto", decision: "allow" } }]);
  });

  it("resume 只消费脱敏恢复视图并继续原 turn", async function resumesRecoverableView() {
    const continued: unknown[] = [];
    const runtime = {
      turns: {
        getRecoverableState: async function getRecoverableState() {
          return { sessionId: "session-1", turnId: "turn-1", status: "interrupted_recoverable", recoverable: true, activeSkills: [{ skillId: "repo:demo", contentHash: "hash-1" }], lastSeq: 7 };
        },
        continue: function continueTurn(input: unknown) {
          continued.push(input);
          return eventStream([asEvent({ type: "turn_completed", turnId: "turn-1", checkpoint: { turnId: "turn-1", status: "completed", stepCount: 3, messages: [{ role: "user", content: "private" }], completedCallIds: [], lease: { leaseId: "private", ownerId: "private", heartbeatAt: 1, safeBoundarySeq: 8 } } })]);
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("jsonl"), sessionId: "session-1" });
    const result = await controller.resume();
    expect(result.projection.status).toBe("completed");
    expect(continued).toEqual([{ sessionId: "session-1", turnId: "turn-1" }]);
    expect(JSON.stringify(result.projection.events)).not.toContain("private");
  });

  it("已完成 Turn 的 resume 返回不可恢复错误而不是伪造成功", async function rejectsCompletedResume() {
    const runtime = {
      turns: {
        getRecoverableState: async function getRecoverableState() {
          return { sessionId: "session-1", turnId: "turn-1", status: "completed", recoverable: false, activeSkills: [], lastSeq: 9 };
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session-1" });

    await expect(controller.resume()).resolves.toMatchObject({ kind: "error", exitCode: 1, message: "CLI_TURN_NOT_RESUMABLE: completed" });
  });

  it("Core 判定预算终态不可恢复时拒绝 resume", async function rejectsNonRecoverableBudgetResume() {
    let continued = false;
    const runtime = {
      turns: {
        getRecoverableState: async function getRecoverableState() {
          return {
            sessionId: "session-1",
            turnId: "turn-1",
            status: "failed",
            recoverable: false,
            termination: { reason: "token_budget", recoverable: false, budget: { used: 12, limit: 10, unit: "tokens" } },
            activeSkills: [],
            lastSeq: 9,
          };
        },
        continue: function continueTurn() {
          continued = true;
          return eventStream([]);
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session-1" });

    await expect(controller.resume()).resolves.toMatchObject({ kind: "error", exitCode: 1, message: "CLI_TURN_NOT_RESUMABLE: failed" });
    expect(continued).toBe(false);
  });

  it("Web 的等待结构化回答 Turn 只显示安全摘要，不伪造答案或继续执行", async function reportsWebOnlyQuestionResume() {
    let continued = false;
    const runtime = {
      turns: {
        getRecoverableState: async function getRecoverableState() {
          return { sessionId: "session-1", turnId: "turn-web-question", status: "awaiting_user_input", recoverable: true, activeSkills: [], lastSeq: 12 };
        },
        continue: function continueTurn() {
          continued = true;
          return eventStream([]);
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session-1" });

    const result = await controller.resume();

    expect(result).toMatchObject({ kind: "ok", exitCode: 0, lines: ["请在支持结构化回答的 Web 中处理"] });
    expect(result.projection.status).toBe("waiting_user_input");
    expect(continued).toBe(false);
  });

  it("状态栏通过 Controller 安全投影 canonical workspaceRoot", async function projectsWorkspaceToStatusView() {
    const runtime = {
      sessions: { get: async function getSession() { return null; } },
    } as unknown as CliRuntime;
    const controller = createCliController({
      runtime,
      renderer: createPlainRenderer("text"),
      sessionId: "session-1",
      workspaceRoot: "C:/canonical/workspace",
    });

    const view = await controller.getStatusView?.();
    expect(view?.workspaceRoot).toBe("C:/canonical/workspace");
    expect(view?.source).toBe("runtime_default");
  });

  it("持久授权查看/撤销只消费共享 approvals facade 的脱敏事实", async function listsAndRevokesPermissionGrants() {
    const calls: unknown[] = [];
    const grants = [
      { scope: "allow_session", sessionId: "session-1", toolName: "write_file", constraint: "ext-file:D:/out/a.txt", projection: "synced", createdAt: "2026-10-14T00:00:00.000Z" },
      { scope: "allow_workspace", workspaceRoot: "C:/w", toolName: "edit_file", constraint: "ext-file:D:/out/b.txt", projection: "synced", createdAt: "2026-10-14T00:00:00.000Z" },
      { scope: "allow_session", sessionId: "session-2", toolName: "write_file", constraint: "path:inside.txt", createdAt: "2026-10-14T00:00:00.000Z" },
    ];
    const runtime = {
      approvals: {
        listPersistentGrants: async function listPersistentGrants(input: { workspaceRoot?: string; sessionId?: string }) {
          calls.push(input);
          return grants.filter(function matchesScope(grant) {
            if (input.sessionId !== undefined) return grant.sessionId === input.sessionId;
            if (input.workspaceRoot !== undefined) return grant.workspaceRoot === input.workspaceRoot;
            return false;
          });
        },
        revokePersistentGrant: async function revokePersistentGrant(input: unknown) {
          calls.push(input);
          return { deleted: true, ruleRemoved: true };
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session-1", workspaceRoot: "C:/w" });

    const list = await controller.dispatch({ type: "list_permission_grants" });
    expect(list.kind).toBe("ok");
    // 只展示本 Session 与本工作区可见授权；其他 Session 的 grant 不出现。
    expect(list.lines.join("\n")).not.toContain("session-2");
    expect(list.lines.filter(function isExternalLine(line) { return line.includes("ext-file:"); })).toHaveLength(2);

    const revoke = await controller.dispatch({ type: "revoke_permission_grant", constraint: "ext-file:D:/out/a.txt" });
    expect(revoke.kind).toBe("ok");
    expect(revoke.lines.join("\n")).toContain("已撤销");
    expect(calls.at(-1)).toMatchObject({ workspaceRoot: "C:/w", sessionId: "session-1", toolName: "write_file", constraint: "ext-file:D:/out/a.txt" });

    const unknownRevoke = await controller.dispatch({ type: "revoke_permission_grant", constraint: "ext-file:D:/missing.txt" });
    expect(unknownRevoke.kind).toBe("error");
    expect(unknownRevoke.message).toBe("CLI_PERMISSION_GRANT_NOT_FOUND");
  });
});
