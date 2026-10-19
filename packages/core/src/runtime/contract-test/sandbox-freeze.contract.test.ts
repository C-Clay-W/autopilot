/**
 * runtime/contract-test/sandbox-freeze.contract.test.ts — 沙箱冻结与恢复契约测试（D 组，Talk-Plan0917 Stage 1）
 *
 * 验证：
 * - sandboxMode/sandboxTempRoot 只信任宿主 runtimeDefault，Project/Session/Turn（含 Chat
 *   请求体来源）覆盖一律不生效，未知值 fail-closed 拒绝；
 * - 新 Turn 冻结 sandboxMode、受控 tempRoot、安全摘要与版本；
 * - Continue 强制沿用冻结值，不读取新 runtimeDefault；
 * - 旧 checkpoint 缺 sandbox 字段时按 safetyBudgetVersion 幂等范式 fail-safe 迁移为 read-only。
 */
import { describe, expect, it, vi } from "vitest";
import { createMemoryPorts } from "../adapters/memory";
import { createAgentRuntime } from "../public/create-agent-runtime";
import { resolveRunConfig } from "../protocol/run-config";
import type { SessionRunConfig } from "../domain/session-run-config";
import { computeSandboxPolicyDigest, SANDBOX_POLICY_VERSION } from "../domain/sandbox-policy";
import type { AgentLoopEvent } from "../../internal/agent-runtime";
import type { ModelSampler } from "../../internal/kernel/model-sampler";
import { createAgentTextMessage, createAgentToolResultMessage } from "../../internal/types/agent-message";
import { createTurnRuntimeConfigResolver } from "../application/turn/turn-runtime-config-resolver";
import type { FrozenRunConfig } from "../domain";

/** 把事件流收集为数组。 */
async function collectEvents(generator: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

/** 构造一个确定性 mock 采样器。 */
function createMockSampler(content: string): ModelSampler {
  return {
    sample: async () => ({ content, toolCalls: [], reasoningSummary: "mock", finishReason: "stop" }),
  };
}

/** 创建并保存一个测试 Session。 */
async function seedSession(ports: ReturnType<typeof createMemoryPorts>, sessionId: string) {
  await ports.sessionStore.save({
    id: sessionId,
    persistenceMode: "durable",
    status: "idle",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

describe("sandbox resolveRunConfig contract", () => {
  it("缺省冻结为 workspace-write 并写入版本与安全摘要", () => {
    const frozen = resolveRunConfig({});
    expect(frozen.sandboxMode).toBe("workspace-write");
    expect(frozen.sandboxPolicyVersion).toBe(SANDBOX_POLICY_VERSION);
    expect(frozen.sandboxPolicyDigest).toBe(computeSandboxPolicyDigest({ mode: "workspace-write" }));
    expect(frozen.sandboxTempRoot).toBeUndefined();
  });

  it("宿主 runtimeDefault 显式冻结 read-only 与受控 tempRoot，摘要随内容变化", () => {
    const frozen = resolveRunConfig({ runtimeDefault: { sandboxMode: "read-only", sandboxTempRoot: "/ws/.autopilot/tmp" } });
    expect(frozen.sandboxMode).toBe("read-only");
    expect(frozen.sandboxTempRoot).toBe("/ws/.autopilot/tmp");
    expect(frozen.sandboxPolicyDigest).toBe(computeSandboxPolicyDigest({ mode: "read-only", tempRoot: "/ws/.autopilot/tmp" }));
  });

  it("宿主可显式冻结 danger-full-access；该来源之外不可达", () => {
    expect(resolveRunConfig({ runtimeDefault: { sandboxMode: "danger-full-access" } }).sandboxMode).toBe("danger-full-access");
  });

  it("turnOverride / sessionDefault / projectDefault 均不能设置沙箱字段（Chat 请求体伪造同源拒绝）", () => {
    const override = { sandboxMode: "danger-full-access", sandboxTempRoot: "/ambient/tmp" } as const;
    const frozen = resolveRunConfig({
      turnOverride: { ...override },
      // 类型断言仅用于模拟伪造来源的字段注入；运行时 resolveRunConfig 忽略这些来源。
      sessionDefault: { ...override } as unknown as SessionRunConfig,
      projectDefault: { ...override } as unknown as SessionRunConfig,
    });
    expect(frozen.sandboxMode).toBe("workspace-write");
    expect(frozen.sandboxTempRoot).toBeUndefined();
  });

  it("未知 sandboxMode 在解析边界 fail-closed 抛错，不静默回退", () => {
    expect(() => resolveRunConfig({ runtimeDefault: { sandboxMode: "yolo" as never } })).toThrow(/SANDBOX_MODE_INVALID/);
  });

  it("Runtime shutdown 先终止 Job 再最后 shutdown 沙箱端口（Talk-Plan0917 Stage 2）", async () => {
    const ports = createMemoryPorts();
    const order: string[] = [];
    const originalSandboxShutdown = ports.sandboxPort.shutdown.bind(ports.sandboxPort);
    ports.sandboxPort.shutdown = async () => {
      order.push("sandbox");
      await originalSandboxShutdown();
    };
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: { permissionMode: "ask", workspaceRoot: "/ws", sandboxMode: "read-only" },
    });
    const originalJobsShutdown = runtime.jobs.shutdown.bind(runtime.jobs);
    runtime.jobs.shutdown = async () => {
      order.push("jobs");
      await originalJobsShutdown();
    };
    await runtime.shutdown?.();
    expect(order).toEqual(["jobs", "sandbox"]);
  });
});

describe("sandbox agent options binding contract (Talk-Plan0917 Stage 3)", () => {
  /** 构造最小 resolver 依赖与冻结配置，避免完整 Turn 生命周期。 */
  function buildOptions(frozenOverrides: Partial<FrozenRunConfig>, productMode?: "work" | "chat") {
    const ports = createMemoryPorts();
    const resolver = createTurnRuntimeConfigResolver({ ports, defaultRunConfig: {} });
    const frozen: FrozenRunConfig = {
      permissionMode: "auto_approve",
      workspaceRoot: "/ws",
      workspaceTrusted: true,
      capabilityCeiling: { productMode: productMode ?? "work" },
      ...frozenOverrides,
    };
    return { ports, options: resolver.buildAgentOptions(frozen, {}, "s-1", "t-1") };
  }

  it("Work Turn 注入冻结沙箱绑定：Port 来自 RuntimePorts，mode/tempRoot 来自 FrozenRunConfig", () => {
    const { ports, options } = buildOptions({ sandboxMode: "workspace-write", sandboxTempRoot: "/ws/.autopilot/tmp" });
    expect(options.sandbox).toMatchObject({ mode: "workspace-write", tempRoot: "/ws/.autopilot/tmp" });
    expect(options.sandbox?.port).toBe(ports.sandboxPort);
  });

  it("Chat Turn 不注入沙箱绑定（run_command 在 Chat 本就不可用）", () => {
    const { options } = buildOptions({ sandboxMode: "workspace-write", sandboxTempRoot: "/ws/.autopilot/tmp" }, "chat");
    expect(options.sandbox).toBeUndefined();
  });

  it("旧记录缺省 sandboxMode 时按 fail-safe 范式取 read-only", () => {
    const { options } = buildOptions({});
    expect(options.sandbox).toMatchObject({ mode: "read-only" });
  });
});

describe("sandbox freeze & recovery contract", () => {
  it("新 Turn 冻结沙箱字段且 Continue 不读取新 runtimeDefault", async () => {
    const ports = createMemoryPorts();
    const sessionId = "sandbox-freeze-001";
    const turnId = "turn-sandbox-freeze-001";
    await seedSession(ports, sessionId);
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: { permissionMode: "ask", workspaceRoot: "/ws", sandboxMode: "read-only", modelSampler: createMockSampler("完成") },
    });
    await collectEvents(runtime.turns.start({ sessionId, content: "第一次运行" }));
    const started = await ports.turnStore.getLatest(sessionId);
    expect(started?.frozenRunConfig.sandboxMode).toBe("read-only");
    expect(started?.frozenRunConfig.sandboxPolicyVersion).toBe(SANDBOX_POLICY_VERSION);

    await ports.checkpointStore.save(sessionId, {
      messageSchemaVersion: 2,
      turnId,
      status: "interrupted_recoverable",
      stepCount: 0,
      messages: [createAgentTextMessage("user", "请继续。")],
      completedCallIds: [],
    });
    await ports.turnStore.save({
      id: turnId,
      sessionId,
      status: "interrupted",
      frozenRunConfig: { ...started!.frozenRunConfig },
      startedAt: Date.now(),
    });

    // Continue 时宿主把 defaultRunConfig 改为 danger-full-access：冻结值必须原样沿用。
    const runtimeAfterHostChange = createAgentRuntime({
      ports,
      defaultRunConfig: { permissionMode: "ask", workspaceRoot: "/ws", sandboxMode: "danger-full-access", modelSampler: createMockSampler("已继续完成。") },
    });
    await collectEvents(runtimeAfterHostChange.turns.continue({ sessionId, turnId }));
    const continued = await ports.turnStore.get(turnId);
    expect(continued?.frozenRunConfig.sandboxMode).toBe("read-only");
    expect(continued?.frozenRunConfig.sandboxPolicyVersion).toBe(SANDBOX_POLICY_VERSION);
  });

  it("旧 checkpoint 缺 sandbox 字段时 fail-safe 迁移为 read-only 且幂等", async () => {
    const ports = createMemoryPorts();
    const sessionId = "sandbox-freeze-legacy";
    const turnId = "turn-sandbox-freeze-legacy";
    await seedSession(ports, sessionId);
    await ports.turnStore.save({
      id: turnId,
      sessionId,
      status: "interrupted",
      frozenRunConfig: {
        permissionMode: "auto_approve",
        maxDurationMs: 30 * 60 * 1_000,
        workspaceRoot: "/ws",
        workspaceTrusted: true,
        workContextVersion: 1,
        capabilityCeiling: { productMode: "work" },
        safetyBudgetVersion: 2,
      },
      startedAt: Date.now(),
    });
    const completedCallId = "call-legacy-1";
    await ports.checkpointStore.save(sessionId, {
      messageSchemaVersion: 2,
      turnId,
      status: "interrupted_recoverable",
      interruptionReason: "runtime_budget",
      stepCount: 1,
      messages: [
        createAgentTextMessage("user", "继续完成任务。"),
        { role: "assistant", content: [{ type: "tool-call", id: completedCallId, name: "read_file", input: { path: "README.md" } }] },
        createAgentToolResultMessage({ toolCallId: completedCallId, text: "旧读取已完成", isError: false }),
      ],
      completedCallIds: [completedCallId],
      runtimeBudget: { startedAt: Date.now() - 60_000, totalTokens: 250 },
    });
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: { permissionMode: "auto_approve", workspaceRoot: "/ws", modelSampler: createMockSampler("迁移后继续完成。") },
    });
    const saveSpy = vi.spyOn(ports.turnStore, "save");

    const recoveryView = await runtime.turns.getRecoverableState({ sessionId, turnId });
    expect(recoveryView).toMatchObject({ status: "interrupted_recoverable", recoverable: true });
    await collectEvents(runtime.turns.continue({ sessionId, turnId }));

    const migratedTurn = await ports.turnStore.get(turnId);
    expect(migratedTurn?.frozenRunConfig.sandboxMode).toBe("read-only");
    expect(migratedTurn?.frozenRunConfig.sandboxPolicyVersion).toBe(SANDBOX_POLICY_VERSION);
    expect(migratedTurn?.frozenRunConfig.maxTotalTokens).toBeUndefined();
    const saveCountAfterMigration = saveSpy.mock.calls.length;
    expect(saveCountAfterMigration).toBeGreaterThan(0);

    // 幂等：迁移完成后再次读取恢复视图不得重写 durable。
    await runtime.turns.getRecoverableState({ sessionId, turnId });
    expect(saveSpy.mock.calls.length).toBe(saveCountAfterMigration);
    expect((await ports.turnStore.get(turnId))?.frozenRunConfig.sandboxMode).toBe("read-only");
  });
});
