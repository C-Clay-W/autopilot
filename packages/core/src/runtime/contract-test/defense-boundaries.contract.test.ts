/** 防御审计回归：验证宿主能力来源、失败事件字段投影与 Memory Session 副本边界。 */
import { describe, expect, it, vi } from "vitest";
import { createMemoryPorts } from "../adapters/memory";
import { createSessionService } from "../application/session-service";
import { createAgentRuntime } from "../public/create-agent-runtime";
import { resolveTurnCapabilities } from "../application/turn/turn-capability-ceiling";
import { createTurnRuntimeConfigResolver } from "../application/turn/turn-runtime-config-resolver";
import { resolveRunConfig, type RunConfig } from "../protocol/run-config";
import { sanitizeEventForExternal } from "../protocol/sanitize-checkpoint";
import type { AgentLoopEvent } from "../../internal/agent-runtime";
import * as compactModule from "../../internal/kernel/compact";

describe("Defense Audit 边界", function suite() {
  /** 直接验证 start/continue 能力解析的来源，同时核对冻结参数的下游消费。 */
  it("Work start/continue 只使用宿主能力，合法参数经冻结配置消费", async function hostOnlyCapabilities() {
    const ports = createMemoryPorts();
    const session = await createSessionService(ports).create({});
    const malicious = vi.fn(function injected() { throw new Error("INJECTED_CANARY"); });
    const webLoader = vi.fn(async function trustedWeb() { return {}; });
    const contextLoader = vi.fn(function trustedContext() { return { instructions: [], memories: [], budget: { estimatedTokens: 0, sections: {}, diagnostics: [], compactNeeded: false } }; });
    const runtimeDefault: RunConfig = { webLoader, contextLoader, modelSampler: { sample: malicious } };
    const override: RunConfig = {
      webLoader: malicious, contextLoader: malicious, web: { search: { search: malicious } },
      databaseSearch: { search: malicious }, skills: { catalog: [], discoverSkills: malicious, loadSkill: malicious, readResource: malicious, prepareScript: malicious }, mcp: { servers: [] },
      modelSampler: { sample: malicious }, modelSamplerFactory: { create: malicious, getSupportedProviders: malicious },
      providerSettings: { primary: { baseUrl: "https://injected.invalid" } },
      modelRef: { provider: "firstParty", modelId: "fixture" }, reasoningProfile: { effort: "low" },
      permissionMode: "full_access", maxSteps: 9, maxToolRetries: 1, maxDurationMs: 3000, maxTotalTokens: 10000,
      compactPolicy: { preserveRecentTurns: 2, targetTokens: 1000 }, databaseSearchPolicy: { enabled: true },
    };
    const frozen = resolveRunConfig({ runtimeDefault, turnOverride: override });
    const resolver = createTurnRuntimeConfigResolver({ ports, defaultRunConfig: runtimeDefault });
    for (const continuing of [false, true]) {
      const result = await resolveTurnCapabilities({ session, turnId: "t", runtimeDefault, override, frozen, continuing, now: 1 });
      for (const field of ["contextLoader", "databaseSearch", "skills", "mcp", "modelSampler", "modelSamplerFactory", "providerSettings"] as const) {
        expect(result.capabilities[field]).toBe(runtimeDefault[field]);
      }
      expect(result.capabilities.web).toEqual({});
      const options = resolver.buildAgentOptions(result.frozen, result.capabilities, session.id, "t");
      expect(options).toMatchObject({ permissionMode: "full_access", modelSampler: runtimeDefault.modelSampler });
      expect(result.frozen).toMatchObject({ modelRef: override.modelRef, reasoningProfile: override.reasoningProfile, compactPolicy: override.compactPolicy, databaseSearchPolicy: { enabled: true }, maxSteps: 9, maxToolRetries: 1, maxDurationMs: 3000, maxTotalTokens: 10000 });
    }
    expect(webLoader).toHaveBeenCalledTimes(2);
    expect(malicious).not.toHaveBeenCalled();
  });

  /** 用未知字段 canary 验证默认排除，并保留合法诊断和恢复事实。 */
  it("turn_failed 排除未知与历史字段，保留安全诊断与恢复事实", function safeFailureProjection() {
    const event = {
      type: "turn_failed", turnId: "t", error: "PRIVATE_CANARY", errorCode: "PROVIDER_REQUEST_REJECTED",
      failureStage: "provider_sampling", feedbackId: "12345678-1234-1234-1234-123456789abc",
      providerHttpStatus: 401, providerFailureReason: "authentication_failed", providerFailureDetail: "code:invalid_request",
      providerFailureProfile: "deepseek_official", unknownCanary: "PRIVATE_CANARY",
      checkpoint: { turnId: "t", status: "interrupted_recoverable", stepCount: 2, messages: [], completedCallIds: [], privateCanary: "PRIVATE_CANARY" },
      termination: { reason: "runtime_budget", budget: { used: 20, limit: 10, unit: "ms" }, privateCanary: "PRIVATE_CANARY" },
    } as unknown as AgentLoopEvent;
    const safe = sanitizeEventForExternal(event);
    expect(safe).toMatchObject({ type: "turn_failed", turnId: "t", error: "Agent Loop 执行失败", errorCode: "PROVIDER_REQUEST_REJECTED", failureStage: "provider_sampling", feedbackId: "12345678-1234-1234-1234-123456789abc", providerHttpStatus: 401, providerFailureReason: "authentication_failed", providerFailureDetail: "code:invalid_request", checkpoint: { status: "interrupted_recoverable", stepCount: 2 }, termination: { reason: "runtime_budget", recoverable: true, budget: { used: 20, limit: 10, unit: "ms" } } });
    expect(safe).not.toHaveProperty("unknownCanary");
    expect(safe).not.toHaveProperty("providerFailureProfile");
    expect(JSON.stringify(safe)).not.toContain("PRIVATE_CANARY");
  });

  /** 从真实 Runtime 入口验证受信上下文与数据库开关，恢复后沿用同一冻结快照。 */
  it("真实 start 刷新受信上下文并按 Turn 开关注册宿主数据库工具", async function trustedStart() {
    const ports = createMemoryPorts();
    const malicious = vi.fn(function injected() { throw new Error("INJECTED_CANARY"); });
    const contextLoader = vi.fn(function trustedContext() {
      return { instructions: [{ path: "AGENTS.md", content: "TRUSTED_CONTEXT", contentHash: "hash" }], memories: [], budget: { estimatedTokens: 0, sections: {}, diagnostics: [], compactNeeded: false } };
    });
    const sample = vi.fn(async function trustedSample() { return { content: "完成", toolCalls: [], reasoningSummary: "fixture" }; });
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { contextLoader, modelSampler: { sample }, databaseSearch: { search: malicious } } });
    const session = await runtime.sessions.create({});
    for (const enabled of [false, true]) {
      const events = [];
      for await (const event of runtime.turns.start({ sessionId: session.id, content: "检查工具", runConfig: { contextLoader: malicious, modelSampler: { sample: malicious }, databaseSearch: { search: malicious }, databaseSearchPolicy: { enabled } } })) events.push(event);
      expect(events.some(function completed(event) { return event.type === "turn_completed"; })).toBe(true);
      const call = sample.mock.calls.at(-1)! as unknown as [unknown, { function: { name: string } }[]];
      expect(JSON.stringify(call[0])).toContain("TRUSTED_CONTEXT");
      expect(call[1].some(function databaseTool(tool) { return tool.function.name === "database_search"; })).toBe(enabled);
    }
    expect(contextLoader).toHaveBeenCalledTimes(2);
    expect(sample).toHaveBeenCalledTimes(2);
    expect(malicious).not.toHaveBeenCalled();
    const turn = (await ports.turnStore.getLatest(session.id))!;
    const savedCheckpoint = (await ports.checkpointStore.getLatest(session.id))!;
    await ports.turnStore.save({ ...turn, status: "interrupted" });
    await ports.checkpointStore.save(session.id, { ...savedCheckpoint, status: "interrupted_recoverable" });
    const continued = [];
    for await (const event of runtime.turns.continue({ sessionId: session.id, turnId: turn.id, runConfig: { modelSampler: { sample: malicious }, contextLoader: malicious, databaseSearchPolicy: { enabled: false }, maxSteps: 999 } })) continued.push(event);
    expect(continued.some(function completed(event) { return event.type === "turn_completed"; })).toBe(true);
    expect((await ports.turnStore.get(turn.id))?.frozenRunConfig).toEqual(turn.frozenRunConfig);
    expect(malicious).not.toHaveBeenCalled();
  });

  /** 只替换底层压缩器，验证公开 compact 入口向其传入原冻结策略。 */
  it("合法 Session 的 compact 仍读取 Turn 冻结策略", async function frozenCompact() {
    const ports = createMemoryPorts();
    const runtime = createAgentRuntime({ ports });
    const session = await runtime.sessions.create({});
    const compactPolicy = { preserveRecentTurns: 2, targetTokens: 7000 };
    await ports.turnStore.save({ id: "t", sessionId: session.id, status: "completed", frozenRunConfig: { compactPolicy, workContextVersion: 1, capabilityCeiling: { productMode: "work" } }, startedAt: 1 });
    const compactSpy = vi.spyOn(compactModule, "compactMessages").mockResolvedValue({ outcome: "skipped", summary: "", messages: [], preTokens: 0, postTokens: 0, preservedFromIndex: 0 });
    try {
      await runtime.turns.compact({ sessionId: session.id, turnId: "t", messages: [], trigger: "manual" });
      expect(compactSpy).toHaveBeenCalledWith(expect.objectContaining(compactPolicy));
    } finally {
      compactSpy.mockRestore();
    }
  });

  /** 从输入与返回对象两侧修改嵌套值，验证存储隔离和 Service 身份保存规则。 */
  it("Memory get/list/save/createIfAbsent 隔离嵌套引用，身份修改仍须校验", async function sessionCopies() {
    const ports = createMemoryPorts();
    const sessions = createSessionService(ports);
    const session = await sessions.create({});
    session.defaultRunConfig = { modelRef: { provider: "firstParty", modelId: "original" } };
    await ports.sessionStore.save(session);
    session.defaultRunConfig.modelRef!.modelId = "save-input";
    expect((await ports.sessionStore.get(session.id))?.defaultRunConfig?.modelRef?.modelId).toBe("original");
    const read = (await ports.sessionStore.get(session.id))!;
    read.defaultRunConfig!.modelRef!.modelId = "get-output";
    read.projectId = "forged";
    await expect(sessions.save(read)).rejects.toMatchObject({ code: "SESSION_MODE_MISMATCH" });
    const listed = await ports.sessionStore.list();
    listed[0].defaultRunConfig!.modelRef!.modelId = "list-output";
    expect((await ports.sessionStore.get(session.id))?.defaultRunConfig?.modelRef?.modelId).toBe("original");
    const created = { ...session, id: "created", defaultRunConfig: { modelRef: { provider: "firstParty", modelId: "created-original" } } };
    expect(await ports.sessionStore.createIfAbsent(created)).toBe(true);
    created.defaultRunConfig.modelRef.modelId = "create-input";
    expect(await ports.sessionStore.createIfAbsent(created)).toBe(false);
    expect((await ports.sessionStore.get("created"))?.defaultRunConfig?.modelRef?.modelId).toBe("created-original");
    const valid = (await sessions.get(session.id))!;
    valid.title = "合法保存";
    await sessions.save(valid);
    expect((await ports.sessionStore.get(session.id))?.title).toBe("合法保存");
    expect(await ports.sessionStore.get("absent")).toBeNull();
  });
});
