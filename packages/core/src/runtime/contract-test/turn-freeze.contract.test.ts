/**
 * runtime/contract-test/turn-freeze.contract.test.ts — Turn 冻结契约测试
 *
 * 验证 TurnService 的冻结语义：
 * - start 时写入 TurnStore
 * - continue 强制读取 TurnStore 中的 frozenRunConfig
 * - continue 忽略 input.runConfig 覆盖
 * - TurnStore.getLatest 返回最新 Turn
 */

import { describe, it, expect } from "vitest";
import { createMemoryPorts } from "../adapters/memory";
import { createAgentRuntime } from "../public/create-agent-runtime";
import type { AgentLoopEvent } from "../../internal/agent-runtime";
import type { ModelSampler } from "../../internal/kernel/model-sampler";

/** 把事件流收集为数组。 */
async function collectEvents(generator: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

/** 构造一个确定性 mock 采样器。 */
function createMockSampler(content: string): ModelSampler {
  return {
    sample: async (_messages, _tools, _options, onDelta) => {
      if (onDelta) {
        for (const char of content) onDelta(char);
      }
      return { content, toolCalls: [], reasoningSummary: "mock", finishReason: "stop" };
    },
  };
}

describe("Turn freeze contract test", function turnFreezeContractSuite() {
  it("start 时写入 TurnStore，continue 能读取", async function startWritesTurn() {
    const ports = createMemoryPorts();
    const sessionId = "freeze-001";
    await ports.sessionStore.save({
      id: sessionId,
      persistenceMode: "durable",
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "auto_approve",
        modelSampler: createMockSampler("已完成。"),
        maxSteps: 8,
        databaseSearchPolicy: { enabled: false },
      },
    });

    const events = await collectEvents(
      runtime.turns.start({ sessionId, content: "请确认。" }),
    );
    expect(events.some((e) => e.type === "turn_completed")).toBe(true);

    // TurnStore 应有记录
    const turn = await ports.turnStore.getLatest(sessionId);
    expect(turn).toBeDefined();
    expect(turn!.status).toBe("completed");
    expect(turn!.frozenRunConfig.permissionMode).toBe("auto_approve");
    expect(turn!.frozenRunConfig.maxSteps).toBe(8);
    expect(turn!.frozenRunConfig.databaseSearchPolicy).toEqual({ enabled: false });
  });

  it("continue 强制使用 frozenRunConfig，忽略 input.runConfig 覆盖", async function continueUsesFrozen() {
    const ports = createMemoryPorts();
    const sessionId = "freeze-002";
    const turnId = "turn-freeze-002";
    await ports.sessionStore.save({
      id: sessionId,
      persistenceMode: "durable",
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 预置 checkpoint
    await ports.checkpointStore.save(sessionId, {
      messageSchemaVersion: 2,
      turnId,
      status: "interrupted_recoverable",
      stepCount: 0,
      messages: [{ role: "user", content: [{ type: "text", text: "请继续。" }] }],
      completedCallIds: [],
    } as any);

    // 预置 Turn，frozenRunConfig.maxSteps = 8；CR 边界后需带新边界签发的 workContextVersion 与 Work ceiling。
    await ports.turnStore.save({
      id: turnId,
      sessionId,
      status: "interrupted",
      frozenRunConfig: { permissionMode: "auto_approve", maxSteps: 8, databaseSearchPolicy: { enabled: true }, workContextVersion: 1, capabilityCeiling: { productMode: "work" } },
      startedAt: Date.now(),
      schemaVersion: 1,
    });

    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "auto_approve",
        modelSampler: createMockSampler("已继续完成。"),
        maxSteps: 99, // 默认值，应被 frozen 覆盖
      },
    });

    // continue 传入 runConfig.maxSteps = 50，应被忽略
    const events = await collectEvents(
      runtime.turns.continue({ sessionId, turnId, runConfig: { maxSteps: 50, databaseSearchPolicy: { enabled: false } } } as any),
    );
    expect(events.some((e) => e.type === "turn_completed")).toBe(true);

    // Turn 状态应更新为 completed
    const turn = await ports.turnStore.get(turnId);
    expect(turn!.status).toBe("completed");
    // frozenRunConfig 不应变
    expect(turn!.frozenRunConfig.maxSteps).toBe(8);
    expect(turn!.frozenRunConfig.databaseSearchPolicy).toEqual({ enabled: true });
  });

  it("只读冻结配置视图不泄露凭据、路径或其他运行策略", async function exposesSanitizedFrozenRunConfig() {
    const ports = createMemoryPorts();
    const sessionId = "freeze-003";
    const turnId = "turn-freeze-003";
    await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    await ports.turnStore.save({
      id: turnId,
      sessionId,
      status: "completed",
      frozenRunConfig: {
        modelRef: { provider: "openai", modelId: "gpt-5" },
        reasoningProfile: { effort: "high", maxTokens: 4096 },
        credentialRef: { provider: "openai", key: "secret-credential" },
        rerankPolicy: { enabled: true, baseUrl: "https://private-rerank.invalid", textModel: "text", visionModel: "vision" },
        workspaceRoot: "/private/workspace",
        permissionMode: "auto_approve",
      },
      startedAt: Date.now(),
    });

    const view = await createAgentRuntime({ ports }).turns.getFrozenRunConfig({ sessionId, turnId });
    expect(view).toEqual({
      sessionId,
      turnId,
      modelRef: { provider: "openai", modelId: "gpt-5" },
      reasoningProfile: { effort: "high", maxTokens: 4096 },
      permissionMode: "auto_approve",
    });
    expect(JSON.stringify(view)).not.toContain("private");
    expect(JSON.stringify(view)).not.toContain("credential");
    expect(JSON.stringify(view)).not.toContain("private-rerank");
  });

  it("firstParty 将 effective effort、compact 阈值和 timeout 一次冻结到私有 Turn", async function freezesFirstPartyRuntimeParameters() {
    const ports = createMemoryPorts();
    const sessionId = "freeze-first-party-004";
    await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelSampler: createMockSampler("已完成。"),
        getRuntimeDefaults() {
          return {
            modelRef: { provider: "firstParty", modelId: "fixture-model[1m]" },
            reasoningProfile: { effort: "max" },
            providerSettings: {
              primary: {
                apiProtocol: "anthropic-messages",
                compactThresholdTokens: 786_432,
                timeoutMs: 120_000,
                subagentModelId: "fixture-subagent",
                thinkingEnabled: false,
              },
            },
          };
        },
      },
    });

    await collectEvents(runtime.turns.start({ sessionId, content: "请冻结配置。" }));
    const turn = await ports.turnStore.getLatest(sessionId);
    expect(turn?.frozenProviderConfig).toMatchObject({
      sampleOptions: { model: "fixture-model[1m]", reasoningEffort: "max" },
      compactThresholdTokens: 786_432,
      timeoutMs: 120_000,
      subagentModelId: "fixture-subagent",
      effectiveReasoning: { effort: "max", source: "requested" },
    });
    const view = await runtime.turns.getFrozenRunConfig({ sessionId, turnId: turn?.id });
    expect(view?.effectiveReasoning).toEqual({ effort: "max", source: "requested" });
  });

  it("已命名 credentialRef 缺失时本地失败，不回落到其他 sampler 或凭据", async function rejectsMissingRouteCredential() {
    const ports = createMemoryPorts();
    const sessionId = "freeze-missing-credential";
    await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    let factoryCalled = false;
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelRef: { provider: "route-a", modelId: "fixture-model" },
        modelSamplerFactory: {
          create() {
            factoryCalled = true;
            return createMockSampler("不应采样");
          },
          getSupportedProviders() {
            return ["route-a"];
          },
        },
        providerSettings: {
          routes: {
            "route-a": {
              id: "route-a",
              apiProtocol: "openai-chat-completions",
              baseUrl: "https://provider.example/v1",
              credentialRef: { provider: "route-a", key: "MISSING_ROUTE_A_KEY" },
              models: [{ id: "fixture-model" }],
            },
          },
        },
      },
    });

    await expect(collectEvents(runtime.turns.start({ sessionId, content: "请开始" }))).rejects.toMatchObject({ code: "MISSING_CREDENTIAL" });
    expect(factoryCalled).toBe(false);
    expect((await runtime.turns.getState({ sessionId })).turn?.status).toBe("failed");
    expect((await ports.sessionStore.get(sessionId))?.status).toBe("failed");
    expect(await ports.checkpointStore.getLatest(sessionId)).toBeNull();
    expect(await ports.transcriptStore.getEvents(sessionId)).toEqual([]);
    /** 模拟用户保存 Key 后，既有 Store 在下一次请求立即读取到新凭据。 */
    ports.credentialStore.resolve = async function resolveRestoredCredential() { return { apiKey: "fixture-restored-key" }; };
    const retried = await collectEvents(runtime.turns.start({ sessionId, content: "凭据修复后重发" }));
    expect(retried.some(function completed(event) { return event.type === "turn_completed"; })).toBe(true);
    expect(factoryCalled).toBe(true);
  });

  it("continue 在 TurnStore 无记录时抛出 TURN_NOT_FOUND", async function continueNoTurn() {
    const ports = createMemoryPorts();
    const sessionId = "freeze-003";
    await ports.sessionStore.save({
      id: sessionId,
      persistenceMode: "durable",
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const runtime = createAgentRuntime({ ports });

    await expect(
      (async () => {
        for await (const _event of runtime.turns.continue({ sessionId, turnId: "missing" })) {
          // noop
        }
      })(),
    ).rejects.toMatchObject({ code: "TURN_NOT_FOUND" });
  });

  it("目录外的第三方 route 模型以声明窗口冻结", async function freezesRouteDeclaredContextWindow() {
    const ports = createMemoryPorts();
    /** 种子 route 凭据，避免执行期 MISSING_CREDENTIAL。 */
    ports.credentialStore.resolve = async function resolveSeededCredential() { return { apiKey: "fixture-gateway-key" }; };
    const sessionId = "freeze-route-window";
    await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelRef: { provider: "gateway-route", modelId: "gateway-chat" },
        providerSettings: {
          routes: {
            "gateway-route": {
              id: "gateway-route",
              apiProtocol: "openai-chat-completions",
              baseUrl: "https://provider.example/v1",
              credentialRef: { provider: "gateway-route", key: "USER_SETTINGS_GATEWAY_KEY" },
              models: [{ id: "gateway-chat", contextWindowTokens: 262_144 }],
            },
          },
        },
        modelSampler: createMockSampler("已完成。"),
      },
    });

    await collectEvents(runtime.turns.start({ sessionId, content: "请冻结配置。" }));
    const turn = await ports.turnStore.getLatest(sessionId);

    expect(turn?.frozenProviderConfig?.contextWindowTokens).toBe(262_144);
  });

  it("内置目录模型仍以目录窗口为权威，route 声明不覆盖", async function catalogWindowOverridesRouteDeclaration() {
    const ports = createMemoryPorts();
    /** 种子 route 凭据，避免执行期 MISSING_CREDENTIAL。 */
    ports.credentialStore.resolve = async function resolveSeededCredential() { return { apiKey: "fixture-deepseek-key" }; };
    const sessionId = "freeze-catalog-window-priority";
    await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelRef: { provider: "deepseek", modelId: "deepseek-v4-flash" },
        providerSettings: {
          routes: {
            deepseek: {
              id: "deepseek",
              apiProtocol: "openai-chat-completions",
              baseUrl: "https://provider.example/v1",
              credentialRef: { provider: "deepseek", key: "USER_SETTINGS_DEEPSEEK_KEY" },
              models: [{ id: "deepseek-v4-flash", contextWindowTokens: 262_144 }],
            },
          },
        },
        modelSampler: createMockSampler("已完成。"),
      },
    });

    await collectEvents(runtime.turns.start({ sessionId, content: "请冻结配置。" }));
    const turn = await ports.turnStore.getLatest(sessionId);

    expect(turn?.frozenProviderConfig?.contextWindowTokens).toBe(1_000_000);
  });

  it("route 声明窗口后生产装配的 /context 投影从 unknown 恢复为合法快照", async function projectsUsageFromRouteDeclaredWindow() {
    /** 构造仅窗口声明不同的两个 Runtime，对齐同一生产装配链。 */
    function createRouteRuntime(withWindow: boolean) {
      const ports = createMemoryPorts();
      /** 种子 route 凭据，避免执行期 MISSING_CREDENTIAL。 */
      ports.credentialStore.resolve = async function resolveSeededCredential() { return { apiKey: "fixture-gateway-key" }; };
      const sessionId = withWindow ? "context-usage-route-window" : "context-usage-route-no-window";
      return { ports, sessionId, runtime: createAgentRuntime({
        ports,
        defaultRunConfig: {
          modelRef: { provider: "gateway-route", modelId: "gateway-chat" },
          providerSettings: {
            routes: {
              "gateway-route": {
                id: "gateway-route",
                apiProtocol: "openai-chat-completions",
                baseUrl: "https://provider.example/v1",
                credentialRef: { provider: "gateway-route", key: "USER_SETTINGS_GATEWAY_KEY" },
                models: [{ id: "gateway-chat", ...(withWindow ? { contextWindowTokens: 262_144 } : {}) }],
              },
            },
          },
          modelSampler: createMockSampler("已完成。"),
        },
      }) };
    }

    const withoutWindow = createRouteRuntime(false);
    await withoutWindow.ports.sessionStore.save({ id: withoutWindow.sessionId, persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    await collectEvents(withoutWindow.runtime.turns.start({ sessionId: withoutWindow.sessionId, content: "未知窗口" }));
    const silentTurn = await withoutWindow.ports.turnStore.getLatest(withoutWindow.sessionId);
    expect(silentTurn?.frozenProviderConfig?.contextWindowTokens).toBeUndefined();
    expect(await withoutWindow.runtime.turns.getContextUsage({ sessionId: withoutWindow.sessionId })).toBeNull();

    const withWindow = createRouteRuntime(true);
    await withWindow.ports.sessionStore.save({ id: withWindow.sessionId, persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    await collectEvents(withWindow.runtime.turns.start({ sessionId: withWindow.sessionId, content: "声明窗口" }));
    const events = await withWindow.runtime.turns.getContextUsage({ sessionId: withWindow.sessionId });
    const turn = await withWindow.ports.turnStore.getLatest(withWindow.sessionId);

    expect(turn?.frozenProviderConfig?.contextWindowTokens).toBe(262_144);
    expect(events).toMatchObject({ modelRef: "gateway-route/gateway-chat", contextWindowTokens: 262_144 });
  });
});
