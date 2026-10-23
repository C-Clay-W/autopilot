/**
 * Talk-Plan1022 CR R2 回归：Turn 冻结有效进程执行方式，旧沙箱 pending/checkpoint 不能静默
 * 变成宿主执行（Plan §1 第 4 条）。
 *
 * 覆盖：
 * - 升级前记录（无 processExecution 标记）的 awaiting_approval Turn 在宿主执行 Runtime 上
 *   Continue：抛 TURN_FROZEN_MISMATCH、模型零采样、旧批准零消费、提示新建任务；
 * - 新 Turn 由宿主 Port 冻结 processExecution="host"，重建 Runtime 后 Continue 正常执行；
 * - 反向：宿主冻结的 Turn 落到沙箱 Runtime 同样拒绝，不把宿主批准当成沙箱批准重放。
 *
 * 旧记录在沙箱 Runtime 上继续执行的原语义由 sandbox-freeze.contract.test.ts
 * 「旧 checkpoint 缺 sandbox 字段时 fail-safe 迁移」用例覆盖，本文件不重复。
 */
import { describe, expect, it, vi } from "vitest";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createAgentRuntime } from "../../src/runtime/public/create-agent-runtime";
import type { SandboxPort } from "../../src/runtime/ports";
import type { AgentLoopEvent } from "../../src/internal/agent-runtime";
import type { ModelSampler } from "../../src/internal/kernel/model-sampler";
import { createAgentTextMessage } from "../../src/internal/types/agent-message";
import type { FrozenRunConfig } from "../../src/runtime/domain";

/** 把事件流收集为数组，同时触发 Generator 内部的校验与异常。 */
async function collectEvents(generator: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

/** 构造声明宿主执行的 SandboxPort：只提供停用报告，不提供任何沙箱包装。 */
function createHostPort(): SandboxPort {
  const report = () => ({ platform: "windows" as const, backend: "host-execution", enforcement: "unavailable" as const, installed: false, provisioned: false });
  return {
    execution: "host",
    async status() { return report(); },
    async setup() { return report(); },
    async prepare() { throw new Error("宿主执行模式不提供沙箱包装"); },
    async release() {},
    async shutdown() {},
  };
}

/** 构造记录调用次数的确定性 mock 采样器；模型一旦被采样即说明恢复进入执行链。 */
function createRecordingSampler(content: string): { sampler: ModelSampler; calls: () => number } {
  let calls = 0;
  return {
    sampler: {
      async sample() {
        calls += 1;
        return { content, toolCalls: [], reasoningSummary: "mock", finishReason: "stop" };
      },
    },
    calls: () => calls,
  };
}

/** 写入一个等待审批的 Session/Turn/Checkpoint，冻结配置由调用方提供。 */
async function seedAwaitingApprovalTurn(
  ports: ReturnType<typeof createMemoryPorts>,
  input: { sessionId: string; turnId: string; frozenRunConfig: FrozenRunConfig },
): Promise<void> {
  const commandInput = { program: "node", args: ["--version"], cwd: "." };
  await ports.sessionStore.save({ id: input.sessionId, persistenceMode: "durable", status: "waiting_approval", createdAt: 1, updatedAt: 1, activeTurnId: input.turnId });
  await ports.turnStore.save({ id: input.turnId, sessionId: input.sessionId, status: "waiting_approval", frozenRunConfig: input.frozenRunConfig, startedAt: 1 });
  await ports.checkpointStore.save(input.sessionId, {
    messageSchemaVersion: 2,
    turnId: input.turnId,
    status: "awaiting_approval",
    stepCount: 1,
    // 未闭合的 tool-call 必须与 pendingCalls 配对，否则恢复边界按损坏记录拒绝。
    messages: [
      createAgentTextMessage("user", "请检查 Node 版本"),
      { role: "assistant", content: [{ type: "tool-call", id: "call-legacy", name: "run_command", input: commandInput }] },
    ],
    completedCallIds: [],
    pendingCalls: [{ id: "call-legacy", name: "run_command", input: commandInput }],
  });
}

/** 升级前的沙箱时代冻结配置：没有 processExecution 标记。 */
const LEGACY_SANDBOX_FROZEN: FrozenRunConfig = {
  permissionMode: "ask",
  workspaceRoot: "/ws",
  workspaceTrusted: true,
  workContextVersion: 1,
  capabilityCeiling: { productMode: "work" },
  safetyBudgetVersion: 2,
  sandboxMode: "workspace-write",
  sandboxPolicyVersion: 1,
};

describe("Talk-Plan1022 CR R2 执行方式冻结", function executionModeFreezeSuite() {
  it("旧沙箱 awaiting_approval Turn 在宿主 Runtime 上 Continue 被拒绝：零采样、旧批准零消费", async function legacySandboxTurnRefusedOnHost() {
    const ports = createMemoryPorts();
    ports.sandboxPort = createHostPort();
    const sessionId = "r2-legacy-host";
    const turnId = "turn-r2-legacy-host";
    await seedAwaitingApprovalTurn(ports, { sessionId, turnId, frozenRunConfig: { ...LEGACY_SANDBOX_FROZEN } });
    const consumeSpy = vi.spyOn(ports.approvalStore, "consumeExecutionApproval");
    const recording = createRecordingSampler("不应被采样");
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { permissionMode: "ask", workspaceRoot: "/ws", modelSampler: recording.sampler } });

    await expect(collectEvents(runtime.turns.continue({ sessionId, turnId, approval: { approvalId: "a-legacy", decision: "allow_once" } })))
      .rejects.toMatchObject({ code: "TURN_FROZEN_MISMATCH", message: expect.stringContaining("请新建任务重新审批") });
    expect(recording.calls()).toBe(0);
    expect(consumeSpy).not.toHaveBeenCalled();
    // 旧批准与 Turn 状态都保持原样，没有被消费成宿主批准。
    expect((await ports.turnStore.get(turnId))?.status).toBe("waiting_approval");
  });

  it("新 Turn 由宿主 Port 冻结 processExecution=host，重建 Runtime 后 Continue 正常执行", async function hostTurnContinuesOnHost() {
    const ports = createMemoryPorts();
    ports.sandboxPort = createHostPort();
    const sessionId = "r2-host-turn";
    const recording = createRecordingSampler("第一次完成");
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { permissionMode: "ask", workspaceRoot: "/ws", modelSampler: recording.sampler } });
    await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: 1, updatedAt: 1 });
    await collectEvents(runtime.turns.start({ sessionId, content: "第一次运行" }));

    const started = await ports.turnStore.getLatest(sessionId);
    expect(started?.frozenRunConfig.processExecution).toBe("host");
    const turnId = started!.id;
    await ports.checkpointStore.save(sessionId, {
      messageSchemaVersion: 2,
      turnId,
      status: "interrupted_recoverable",
      stepCount: 0,
      messages: [createAgentTextMessage("user", "请继续。")],
      completedCallIds: [],
    });
    await ports.turnStore.save({ ...started!, status: "interrupted", completedAt: undefined });

    // 重建 Runtime 模拟重启：同一宿主 Port 再次装配。
    const resumed = createRecordingSampler("已继续完成");
    const restarted = createAgentRuntime({ ports, defaultRunConfig: { permissionMode: "ask", workspaceRoot: "/ws", modelSampler: resumed.sampler } });
    await collectEvents(restarted.turns.continue({ sessionId, turnId }));
    expect(resumed.calls()).toBeGreaterThan(0);
    expect((await ports.turnStore.get(turnId))?.frozenRunConfig.processExecution).toBe("host");
  });

  it("反向：宿主冻结的 Turn 落到沙箱 Runtime 同样拒绝", async function hostTurnRefusedOnSandbox() {
    const ports = createMemoryPorts();
    const sessionId = "r2-host-sandbox";
    const turnId = "turn-r2-host-sandbox";
    await seedAwaitingApprovalTurn(ports, { sessionId, turnId, frozenRunConfig: { ...LEGACY_SANDBOX_FROZEN, processExecution: "host" } });
    const recording = createRecordingSampler("不应被采样");
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { permissionMode: "ask", workspaceRoot: "/ws", modelSampler: recording.sampler } });

    await expect(collectEvents(runtime.turns.continue({ sessionId, turnId, approval: { approvalId: "a-host", decision: "allow_once" } })))
      .rejects.toMatchObject({ code: "TURN_FROZEN_MISMATCH", message: expect.stringContaining("沙箱执行") });
    expect(recording.calls()).toBe(0);
  });
});
