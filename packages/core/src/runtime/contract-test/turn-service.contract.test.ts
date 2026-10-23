/**
 * runtime/contract-test/turn-service.contract.test.ts — TurnService 契约测试
 *
 * 使用内存适配器验证 Public Runtime 的 turn 生命周期：
 * - start 能执行完整 turn 并持久化事件/checkpoint。
 * - continue 能从已有 checkpoint 恢复并继续执行。
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryPorts } from "../adapters/memory";
import { createAgentRuntime } from "../public/create-agent-runtime";
import type { AgentCheckpoint, AgentLoopEvent } from "../../internal/agent-runtime";
import type { ModelSampler } from "../../internal/kernel/model-sampler";
import { AgentSampleError } from "../../internal/lib/llm";
import { createAgentTextMessage, createAgentToolResultMessage, getAgentMessageText, type AgentMessage } from "../../internal/types/agent-message";
import type { SandboxPort } from "../ports";

/** 透传式 fake 沙箱 Port：prepare 原样返回 argv，供需要真实执行 run_command 的用例替换 unavailable stub。 */
function createPassthroughSandboxPort(): SandboxPort {
  return {
    async status() {
      return { platform: "macos", backend: "fake", enforcement: "full" };
    },
    async setup() {
      throw new Error("fake sandbox setup 不可用");
    },
    async prepare(request) {
      return { executionId: request.commandId, executable: request.program, args: [...request.args], env: {}, enforcement: "full" as const };
    },
    async release() {},
    async shutdown() {},
  };
}

/** 把事件流收集为数组。 */
async function collectEvents(generator: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

/** 构造一个确定性 mock 采样器。 */
function createMockSampler(content: string, toolCalls: unknown[] = []): ModelSampler {
  return {
    sample: async (_messages, _tools, _options, onDelta) => {
      if (onDelta) {
        for (const char of content) onDelta(char);
      }
      return {
        content,
        toolCalls: toolCalls as any,
        reasoningSummary: "mock",
        finishReason: "stop",
      };
    },
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

describe("TurnService contract test", function turnServiceContractSuite() {
  it("显式视觉 route 冻结协议，宿主未提供 visionRef 时不猜测", async function freezesVisionRoutesSafely() {
    const ports = createMemoryPorts();
    const sessionId = "turn-vision-route";
    await seedSession(ports, sessionId);
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelRef: { provider: "firstParty", modelId: "fixture-model" },
        modelSampler: createMockSampler("完成"),
        providerSettings: {
          primary: { apiProtocol: "anthropic-messages" },
          vision: { baseUrl: "https://stub.example/v1", credentialRef: { provider: "ali", key: "USER_SETTINGS_API_KEY" } },
          visionModelRef: { provider: "ali", modelId: "qwen3-vl-flash" },
        },
      },
    });
    await collectEvents(runtime.turns.start({ sessionId, content: "检查图片" }));
    const withVision = await ports.turnStore.getLatest(sessionId);
    expect(withVision?.frozenProviderConfig?.vision).toEqual({
      ref: { provider: "ali", modelId: "qwen3-vl-flash" },
      apiProtocol: "openai-chat-completions",
      baseUrl: "https://stub.example/v1",
      credentialRef: { provider: "ali", key: "USER_SETTINGS_API_KEY" },
    });

    const plainPorts = createMemoryPorts();
    await seedSession(plainPorts, "turn-no-vision-route");
    const plainRuntime = createAgentRuntime({ ports: plainPorts, defaultRunConfig: { modelRef: { provider: "firstParty", modelId: "fixture-model" }, modelSampler: createMockSampler("完成"), providerSettings: { primary: { apiProtocol: "anthropic-messages" } } } });
    await collectEvents(plainRuntime.turns.start({ sessionId: "turn-no-vision-route", content: "纯文本" }));
    expect((await plainPorts.turnStore.getLatest("turn-no-vision-route"))?.frozenProviderConfig?.vision).toBeUndefined();
  });

  it("仅在消息与冻结模型配置一致时跨 Turn 继承 usage anchor", async function validatesInheritedUsageAnchor() {
    const ports = createMemoryPorts();
    const sessionId = "turn-usage-anchor-signature";
    let sampleCount = 0;
    await seedSession(ports, sessionId);
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelRef: { provider: "firstParty", modelId: "fixture-model" },
        providerSettings: { primary: { apiProtocol: "anthropic-messages" } },
        modelSampler: {
          async sample() {
            sampleCount += 1;
            return sampleCount === 1
              ? { content: "首轮完成", toolCalls: [], reasoningSummary: "mock", usage: { inputTokens: 20, outputTokens: 5, contextTokens: 25 } }
              : { content: "续轮完成", toolCalls: [], reasoningSummary: "mock" };
          },
        },
      },
    });

    await collectEvents(runtime.turns.start({ sessionId, content: "首轮" }));
    const firstAnchor = (await ports.checkpointStore.getLatest(sessionId))?.usageAnchor;
    expect(firstAnchor?.requestSignature).toMatch(/^[a-f0-9]{64}$/);

    await collectEvents(runtime.turns.start({ sessionId, content: "同模型续轮" }));
    expect((await ports.checkpointStore.getLatest(sessionId))?.usageAnchor?.requestSignature).toBe(firstAnchor?.requestSignature);

    await collectEvents(runtime.turns.start({ sessionId, content: "切换模型", runConfig: { modelRef: { provider: "firstParty", modelId: "fixture-model-pro" } } }));
    expect((await ports.checkpointStore.getLatest(sessionId))?.usageAnchor).toBeUndefined();
  });

  it("新 Turn 复用上一安全完成 Turn 的 canonical conversation 且剥离 raw reasoning", async function carriesCanonicalConversation() {
    const ports = createMemoryPorts();
    const sessionId = "turn-canonical-conversation";
    let sampleCount = 0;
    let secondMessages: AgentMessage[] = [];
    await seedSession(ports, sessionId);
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelSampler: {
          async sample(messages) {
            sampleCount += 1;
            // 冻结采样时刻的数组快照：kernel 会在同一数组上原地追加本 Turn 的 assistant 回复（含 reasoning），
            // 保存引用会让断言看到采样后才写入的内容。
            if (sampleCount === 2) secondMessages = [...messages];
            return { content: sampleCount === 1 ? "A 已完成" : "B 已完成", toolCalls: [], reasoningSummary: "mock", reasoningContent: "private-reasoning", finishReason: "stop" };
          },
        },
      },
    });
    await collectEvents(runtime.turns.start({ sessionId, content: "A 的问题" }));
    const firstTurn = await ports.turnStore.getLatest(sessionId);
    const firstPrivateCheckpoint = firstTurn ? await ports.checkpointStore.getByTurn(sessionId, firstTurn.id) : null;
    await collectEvents(runtime.turns.start({ sessionId, content: "B 继续提问" }));
    const firstTranscript = (await ports.transcriptStore.getEvents(sessionId)).filter((envelope) => envelope.turnId === firstTurn?.id);
    const firstTerminal = firstTranscript.find((envelope) => envelope.event.type === "turn_completed");

    expect(secondMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: [{ type: "text", text: "A 的问题" }] }),
      expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "A 已完成" }] }),
      expect.objectContaining({ role: "user", content: [{ type: "text", text: "B 继续提问" }] }),
    ]));
    expect(firstPrivateCheckpoint?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: expect.arrayContaining([{ type: "text", text: "A 的问题" }]) }),
      expect.objectContaining({ role: "assistant", content: expect.arrayContaining([{ type: "text", text: "A 已完成" }]) }),
    ]));
    expect(firstTerminal?.event.type === "turn_completed" ? firstTerminal.event.checkpoint : undefined).toMatchObject({ status: "completed", messages: [], completedCallIds: [] });
    expect(JSON.stringify(firstTerminal)).not.toContain("A 的问题");
    expect(JSON.stringify(secondMessages)).not.toContain("private-reasoning");
  });

  it("切到更小 context window 时在首采样前执行 proactive compact", async function proactivelyCompactsBeforeFirstSample() {
    const ports = createMemoryPorts();
    const sessionId = "turn-proactive-compact-001";
    const sampledMessages: AgentMessage[][] = [];
    await seedSession(ports, sessionId);
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "auto_approve",
        compactPolicy: { preserveRecentTurns: 1, targetTokens: 4_000 },
        modelSampler: {
          async sample(messages) {
            sampledMessages.push(messages);
            const summaryRequest = messages.length === 2
              && messages[0] && getAgentMessageText(messages[0]).includes("上下文压缩器")
              && messages[1] && getAgentMessageText(messages[1]).includes("Flash 的已完成任务");
            return { content: summaryRequest ? "固定压缩摘要：保留任务事实。" : "完成", toolCalls: [], reasoningSummary: "mock", finishReason: "stop" };
          },
        },
      },
    });
    await collectEvents(runtime.turns.start({ sessionId, content: "Flash 的已完成任务", runConfig: { modelRef: { provider: "firstParty", modelId: "fixture-model" }, providerSettings: { primary: { apiProtocol: "anthropic-messages", compactThresholdTokens: 1_000_000 } } } }));
    const previous = await ports.turnStore.getLatest(sessionId);
    expect(previous?.frozenProviderConfig?.compactThresholdTokens).toBe(1_000_000);
    if (!previous?.frozenProviderConfig) throw new Error("missing frozen provider config");
    await ports.turnStore.save({
      ...previous,
      frozenProviderConfig: { ...previous.frozenProviderConfig, compactThresholdTokens: 1_000_001 },
    });

    const events = await collectEvents(runtime.turns.start({ sessionId, content: "Pro 继续处理", runConfig: { modelRef: { provider: "firstParty", modelId: "fixture-model" }, providerSettings: { primary: { apiProtocol: "anthropic-messages", compactThresholdTokens: 1_000_000 } } } }));
    const signatures = events.map(function getType(event) { return event.type; });
    const compactStartedIndex = signatures.indexOf("context_compact_started");
    const turnStartedIndex = signatures.indexOf("turn_started");
    expect(events[compactStartedIndex]).toMatchObject({ type: "context_compact_started", trigger: "proactive" });
    expect(events.find(function findCompacted(event) { return event.type === "context_compacted" })).toMatchObject({ trigger: "proactive" });
    expect(compactStartedIndex).toBeGreaterThanOrEqual(0);
    expect(compactStartedIndex).toBeLessThan(turnStartedIndex);
    expect(sampledMessages.at(-1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "system", content: [{ type: "text", text: expect.stringContaining("已压缩历史摘要（proactive）") }] }),
      expect.objectContaining({ role: "user", content: [{ type: "text", text: "Pro 继续处理" }] }),
    ]));
  });

  it("宿主事件流和 getState checkpoint 均不暴露内部 reasoningContent", async function sanitizesPublicReasoning() {
    const ports = createMemoryPorts();
    const sessionId = "turn-reasoning-sanitized";
    let callCount = 0;
    await seedSession(ports, sessionId);
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelSampler: {
          async sample() {
            callCount += 1;
            if (callCount > 1) return { content: "读取完成", toolCalls: [], reasoningSummary: "模型已完成" };
            return {
              content: "",
              toolCalls: [{ id: "call-reasoning", name: "read_file", input: { path: "README.md" } }],
              reasoningSummary: "模型请求调用 read_file",
              reasoningContent: "internal-reasoning-must-not-leak",
            };
          },
        },
      },
    });

    const events = await collectEvents(runtime.turns.start({ sessionId, content: "读取 README" }));
    expect(JSON.stringify(events)).not.toContain("internal-reasoning-must-not-leak");
    expect(JSON.stringify(await ports.checkpointStore.getLatest(sessionId))).toContain("internal-reasoning-must-not-leak");
    expect(JSON.stringify(await runtime.turns.getState({ sessionId }))).not.toContain("internal-reasoning-must-not-leak");
  });

  it("start 执行完整 turn 并持久化 checkpoint / transcript", async function startTurn() {
    const ports = createMemoryPorts();
    const sessionId = "contract-start-001";
    await seedSession(ports, sessionId);

    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "auto_approve",
        modelSampler: createMockSampler("已完成。"),
        maxSteps: 8,
      },
    });

    const events = await collectEvents(
      runtime.turns.start({ sessionId, content: "请确认。" }),
    );

    const signatures = events.map((event) => event.type);
    expect(signatures).toContain("turn_started");
    expect(signatures).toContain("answer_delta");
    expect(signatures).toContain("turn_completed");

    const transcript = await ports.transcriptStore.getEvents(sessionId);
    expect(transcript.length).toBe(events.length);
    expect(transcript[0].sessionId).toBe(sessionId);

    const checkpoint = await ports.checkpointStore.getLatest(sessionId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.status).toBe("completed");

    const session = await ports.sessionStore.get(sessionId);
    expect(session?.status).toBe("completed");
    expect(session?.activeTurnId).toBeUndefined();
  });

  it("省略 turnId 时重放整个 Session 的安全 transcript，指定时只返回目标 Turn", async function restoresWholeSessionTranscript() {
    const ports = createMemoryPorts();
    const sessionId = "contract-history-001";
    await seedSession(ports, sessionId);
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler: createMockSampler("完成") } });

    await collectEvents(runtime.turns.start({ sessionId, turnId: "turn-history-one", content: "第一轮" }));
    await collectEvents(runtime.turns.start({ sessionId, turnId: "turn-history-two", content: "第二轮" }));

    const sessionState = await runtime.turns.getState({ sessionId });
    const firstTurnState = await runtime.turns.getState({ sessionId, turnId: "turn-history-one" });

    expect(new Set(sessionState.events.map((event) => event.turnId))).toEqual(new Set(["turn-history-one", "turn-history-two"]));
    expect(firstTurnState.events).toHaveLength((await ports.transcriptStore.getEvents(sessionId)).filter((event) => event.turnId === "turn-history-one").length);
    expect(firstTurnState.events.every((event) => event.turnId === "turn-history-one")).toBe(true);
  });

  it("continue 从 checkpoint 恢复并继续执行", async function continueTurn() {
    const ports = createMemoryPorts();
    const sessionId = "contract-continue-001";
    const turnId = "turn-continue-001";
    await seedSession(ports, sessionId);

    // 预置一个 interrupted 状态的 checkpoint，模拟可安全继续的 turn。
    await ports.checkpointStore.save(sessionId, {
      messageSchemaVersion: 2,
      turnId,
      status: "interrupted_recoverable",
      stepCount: 0,
      messages: [createAgentTextMessage("user", "请继续。")],
      completedCallIds: [],
    } as any);

    // Phase 3：预置一个 Turn 到 TurnStore，模拟 start 时冻结的配置。
    // CR 边界后：直接落盘的 Work Turn 夹具需带 Core 签发的 workContextVersion 与 Work ceiling，否则 continue 按"旧来源"拒绝。
    await ports.turnStore.save({
      id: turnId,
      sessionId,
      status: "running",
      frozenRunConfig: {
        permissionMode: "auto_approve",
        maxSteps: 8,
        workContextVersion: 1,
        capabilityCeiling: { productMode: "work" },
      },
      startedAt: Date.now(),
      schemaVersion: 1,
    });

    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "auto_approve",
        modelSampler: createMockSampler("已继续完成。"),
        maxSteps: 8,
      },
    });

    const events = await collectEvents(
      runtime.turns.continue({ sessionId, turnId }),
    );

    const signatures = events.map((event) => event.type);
    expect(signatures).toContain("turn_completed");

    const checkpoint = await ports.checkpointStore.getLatest(sessionId);
    expect(checkpoint?.status).toBe("completed");
    expect(checkpoint?.turnId).toBe(turnId);
  });

  it("continue 拒绝新鲜 lease 下的重复运行", async function rejectsFreshLease() {
    const ports = createMemoryPorts();
    const sessionId = "contract-active-lease-001";
    const turnId = "turn-active-lease-001";
    const now = Date.now();
    await seedSession(ports, sessionId);
    await ports.turnStore.save({
      id: turnId,
      sessionId,
      status: "running",
      frozenRunConfig: { permissionMode: "auto_approve", maxSteps: 8, workContextVersion: 1, capabilityCeiling: { productMode: "work" } },
      startedAt: now,
      schemaVersion: 1,
    });
    await ports.checkpointStore.save(sessionId, {
      messageSchemaVersion: 2,
      turnId,
      status: "running",
      stepCount: 0,
      messages: [createAgentTextMessage("user", "已有宿主正在运行")],
      completedCallIds: [],
      lease: { leaseId: "lease-active", ownerId: "owner-active", heartbeatAt: now, safeBoundarySeq: 1 },
    });

    const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler: createMockSampler("不应执行") } });

    await expect(collectEvents(runtime.turns.continue({ sessionId, turnId }))).rejects.toMatchObject({
      code: "TURN_ALREADY_RUNNING",
    });
  });

  it("start 拒绝 Session 中已有新鲜 lease 的活动 turn", async function rejectsActiveStart() {
    const ports = createMemoryPorts();
    const sessionId = "contract-active-start-001";
    const turnId = "turn-active-start-001";
    const now = Date.now();
    await ports.sessionStore.save({
      id: sessionId,
      persistenceMode: "durable",
      status: "running",
      activeTurnId: turnId,
      createdAt: now,
      updatedAt: now,
    });
    await ports.turnStore.save({
      id: turnId,
      sessionId,
      status: "running",
      frozenRunConfig: { permissionMode: "auto_approve", maxSteps: 8, workContextVersion: 1, capabilityCeiling: { productMode: "work" } },
      startedAt: now,
      schemaVersion: 1,
    });
    await ports.checkpointStore.save(sessionId, {
      messageSchemaVersion: 2,
      turnId,
      status: "running",
      stepCount: 1,
      messages: [createAgentTextMessage("user", "已有宿主正在运行")],
      completedCallIds: [],
      lease: { leaseId: "lease-active-start", ownerId: "owner-active-start", heartbeatAt: now, safeBoundarySeq: 1 },
    });

    const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler: createMockSampler("不应执行") } });

    await expect(collectEvents(runtime.turns.start({ sessionId, content: "不应创建第二个 turn" }))).rejects.toMatchObject({
      code: "TURN_ALREADY_RUNNING",
    });
    expect((await ports.turnStore.list(sessionId)).map((turn) => turn.id)).toEqual([turnId]);
  });

  it("continue 接受 ask 下的 allow_once 并执行冻结命令", async function resumesSingleUseCommandApproval() {
    const ports = createMemoryPorts();
    // 本用例需要 run_command 真实执行；内存宿主默认 unavailable stub，替换为透传 fake（Talk-Plan0917 Stage 3）。
    ports.sandboxPort = createPassthroughSandboxPort();
    let now = 100_000;
    ports.clock = {
      now: function getCurrentTime() { return now; },
      timestamp: function getCurrentTimestamp() { return new Date(now).toISOString(); },
    };
    const sessionId = "contract-approval-001";
    const turnId = "turn-approval-001";
    await seedSession(ports, sessionId);

    let sampleCount = 0;
    const sampler: ModelSampler = {
      sample: async (_messages, _tools, _options, onDelta) => {
        sampleCount++;
        if (sampleCount === 1) {
          return {
            content: "",
            toolCalls: [{ id: "command-1", name: "run_command", input: { program: "node", args: ["-e", "process.stdout.write('approval-ok')"], cwd: ".", timeoutMs: 5_000 } }],
            reasoningSummary: "执行命令",
            finishReason: "tool_calls",
          };
        }
        onDelta?.("命令已执行。");
        return { content: "命令已执行。", toolCalls: [], reasoningSummary: "完成", finishReason: "stop" };
      },
    };
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: { permissionMode: "ask", modelSampler: sampler, maxSteps: 8, maxDurationMs: 1_000, workspaceRoot: process.cwd() },
    });

    const initialEvents = await collectEvents(runtime.turns.start({ sessionId, turnId, content: "请执行一次命令。" }));
    const approvalEvent = initialEvents.find((event) => event.type === "approval_required");
    expect(approvalEvent?.type).toBe("approval_required");
    if (approvalEvent?.type !== "approval_required") throw new Error("approval checkpoint missing");

    const approval = approvalEvent.result.approval;
    await runtime.approvals.submit({ sessionId, turnId, approvalId: approval.approvalId, decision: "allow_once" });
    now += 10_000;

    const resumedEvents = await collectEvents(runtime.turns.continue({ sessionId, turnId, approval: { approvalId: approval.approvalId, decision: "allow" } }));
    expect(resumedEvents.some((event) => event.type === "tool_result" && event.toolName === "run_command" && event.result.status === "success")).toBe(true);
    expect(resumedEvents.some((event) => event.type === "turn_completed")).toBe(true);
    expect(sampleCount).toBe(2);
    expect((await ports.checkpointStore.getLatest(sessionId))?.runtimeBudget?.startedAt).toBe(now);
    const turnSequence = (await ports.transcriptStore.getEvents(sessionId))
      .filter((envelope) => envelope.turnId === turnId)
      .map((envelope) => envelope.seq);
    expect(turnSequence).toEqual([...turnSequence].sort((left, right) => left - right));
    expect(new Set(turnSequence).size).toBe(turnSequence.length);
  });

  /** 用可控时钟验证每次 Continue 都开启新时长段且 token 与副作用事实跨段保留。 */
  it("runtime_budget Continue 重开执行段但保留 token 额度与已完成调用", async function reopensRuntimeBudgetSegmentOnContinue() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "turn-runtime-segment-"));
    const ports = createMemoryPorts(workspaceRoot);
    let now = 200_000;
    ports.clock = {
      now: function getCurrentTime() { return now; },
      timestamp: function getCurrentTimestamp() { return new Date(now).toISOString(); },
    };
    const sessionId = "contract-runtime-segment-001";
    const turnId = "turn-runtime-segment-001";
    await seedSession(ports, sessionId);
    let sampleCount = 0;
    const sampler: ModelSampler = {
      async sample() {
        sampleCount += 1;
        if (sampleCount < 3) now += 1_001;
        if (sampleCount === 1) {
          return { content: "", toolCalls: [{ id: "segment-write", name: "write_file", input: { path: "created.txt", content: "written once\n" } }], reasoningSummary: "创建文件", finishReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 0, contextTokens: 10 } };
        }
        if (sampleCount === 2) {
          return { content: "", toolCalls: [{ id: "segment-read", name: "read_file", input: { path: "created.txt", limit: 100 } }], reasoningSummary: "验证写入", finishReason: "tool_calls", usage: { inputTokens: 20, outputTokens: 0, contextTokens: 20 } };
        }
        return { content: "已完成并验证。", toolCalls: [], reasoningSummary: "完成", finishReason: "stop", usage: { inputTokens: 30, outputTokens: 0, contextTokens: 30 } };
      },
    };
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: { permissionMode: "auto_approve", modelSampler: sampler, maxSteps: 8, maxDurationMs: 1_000, maxTotalTokens: 100, workspaceRoot, workspaceTrusted: true },
    });

    try {
      const firstEvents = await collectEvents(runtime.turns.start({ sessionId, turnId, content: "创建并验证 created.txt" }));
      const firstCheckpoint = await ports.checkpointStore.getLatest(sessionId);
      expect(firstEvents.some((event) => event.type === "turn_interrupted")).toBe(true);
      const firstPause = firstEvents.find((event) => event.type === "turn_interrupted");
      expect(firstPause?.type === "turn_interrupted" ? firstPause.termination : undefined).toEqual({
        recoverable: true,
        reason: "runtime_budget",
        budget: { used: 1_001, limit: 1_000, unit: "ms" },
      });
      const firstRecoverableView = await runtime.turns.getRecoverableState({ sessionId, turnId });
      expect(firstRecoverableView).toMatchObject({
        recoverable: true,
        status: "interrupted_recoverable",
        termination: { reason: "runtime_budget", recoverable: true, budget: { used: 1_001, limit: 1_000, unit: "ms" } },
      });
      expect(firstCheckpoint).toMatchObject({ turnId, status: "interrupted_recoverable", interruptionReason: "runtime_budget", completedCallIds: ["segment-write"] });
      expect(firstCheckpoint?.runtimeBudget).toMatchObject({ startedAt: 200_000, totalTokens: 10, executionSegmentVersion: 1 });

      now += 10_000;
      const secondSegmentStartedAt = now;
      const secondEvents = await collectEvents(runtime.turns.continue({ sessionId, turnId }));
      const secondCheckpoint = await ports.checkpointStore.getLatest(sessionId);
      expect(secondEvents.some((event) => event.type === "turn_interrupted")).toBe(true);
      expect(secondCheckpoint).toMatchObject({ turnId, status: "interrupted_recoverable", interruptionReason: "runtime_budget", completedCallIds: ["segment-write", "segment-read"] });
      expect(secondCheckpoint?.runtimeBudget).toMatchObject({ startedAt: secondSegmentStartedAt, totalTokens: 30, executionSegmentVersion: 1 });
      expect(sampleCount).toBe(2);

      now += 10_000;
      const thirdSegmentStartedAt = now;
      const thirdEvents = await collectEvents(runtime.turns.continue({ sessionId, turnId }));
      const finalCheckpoint = await ports.checkpointStore.getLatest(sessionId);
      const allEvents = [...firstEvents, ...secondEvents, ...thirdEvents];
      expect(thirdEvents.some((event) => event.type === "turn_completed" && event.turnId === turnId)).toBe(true);
      expect(sampleCount).toBe(3);
      expect(finalCheckpoint).toMatchObject({ turnId, status: "completed", completedCallIds: ["segment-write", "segment-read"] });
      expect(finalCheckpoint?.runtimeBudget).toMatchObject({ startedAt: thirdSegmentStartedAt, totalTokens: 60, executionSegmentVersion: 1 });
      expect(allEvents.filter((event) => event.type === "tool_started" && event.toolName === "write_file")).toHaveLength(1);
      expect(allEvents.filter((event) => event.type === "tool_started" && event.toolName === "read_file")).toHaveLength(1);
      expect(await readFile(path.join(workspaceRoot, "created.txt"), "utf8")).toBe("written once\n");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  /** 验证耗尽的显式 token 额度以不可恢复失败投影，并由 Core 拒绝 Continue。 */
  it("token_budget 终态投影白名单用量并拒绝 Continue", async function projectsNonRecoverableTokenBudget() {
    const ports = createMemoryPorts();
    const sessionId = "contract-token-budget-terminal-view";
    const turnId = "turn-token-budget-terminal-view";
    await seedSession(ports, sessionId);
    let sampleCount = 0;
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "auto_approve",
        workspaceRoot: process.cwd(),
        workspaceTrusted: true,
        maxTotalTokens: 10,
        modelSampler: {
          /** 执行一次安全读取并返回超额 usage，让预算在下一个安全边界终止 Turn。 */
          async sample() {
            sampleCount += 1;
            return { content: "", toolCalls: [{ id: "budget-read", name: "read_file", input: { path: "package.json", limit: 20 } }], reasoningSummary: "读取预算 fixture", usage: { inputTokens: 12, outputTokens: 0, contextTokens: 12 } };
          },
        },
      },
    });

    const events = await collectEvents(runtime.turns.start({ sessionId, turnId, content: "检查预算" }));
    const failure = events.find((event) => event.type === "turn_failed");
    const recoverable = await runtime.turns.getRecoverableState({ sessionId, turnId });

    expect(sampleCount).toBe(1);
    expect(events.filter((event) => event.type === "tool_result" && event.toolName === "read_file")).toHaveLength(1);
    expect(failure?.type === "turn_failed" ? failure.termination : undefined).toEqual({
      recoverable: false,
      reason: "token_budget",
      budget: { used: 12, limit: 10, unit: "tokens" },
    });
    expect(failure?.type === "turn_failed" ? failure.checkpoint : undefined).toMatchObject({ status: "failed", messages: [], completedCallIds: [] });
    expect(JSON.stringify(failure)).not.toContain("检查预算");
    expect(JSON.stringify(failure)).not.toContain("package.json");
    expect(JSON.stringify(failure)).not.toContain("budget-read");
    expect(recoverable).toMatchObject({
      status: "failed",
      recoverable: false,
      termination: { reason: "token_budget", recoverable: false, budget: { used: 12, limit: 10, unit: "tokens" } },
    });
    expect(JSON.stringify(failure)).not.toContain("runtimeBudget");
    expect(JSON.stringify(failure)).not.toContain("usageAnchor");
    await expect(collectEvents(runtime.turns.continue({ sessionId, turnId }))).rejects.toMatchObject({ code: "TURN_NOT_RESUMABLE" });
  });

  it("continue 收到权限拒绝后终止 Turn 且不采样替代工具", async function stopsAfterDeniedApproval() {
    const ports = createMemoryPorts();
    // 本用例验证审批拒绝流；run_command 需要可沙箱执行才进入审批（Stage 3 组合矩阵），替换透传 fake。
    ports.sandboxPort = createPassthroughSandboxPort();
    const sessionId = "contract-approval-deny-001";
    const turnId = "turn-approval-deny-001";
    await seedSession(ports, sessionId);

    let sampleCount = 0;
    const sampler: ModelSampler = {
      sample: async () => {
        sampleCount++;
        if (sampleCount === 1) {
          return {
            content: "",
            toolCalls: [{ id: "command-deny-1", name: "run_command", input: { program: "node", args: ["--version"], cwd: ".", timeoutMs: 5_000 } }],
            reasoningSummary: "执行命令",
            finishReason: "tool_calls",
          };
        }
        return {
          content: "",
          toolCalls: [{ id: "fallback-search-1", name: "grep_files", input: { pattern: "node", path: "." } }],
          reasoningSummary: "尝试替代工具",
          finishReason: "tool_calls",
        };
      },
    };
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: { permissionMode: "ask", modelSampler: sampler, maxSteps: 8, workspaceRoot: process.cwd() },
    });

    const initialEvents = await collectEvents(runtime.turns.start({ sessionId, turnId, content: "请执行 node --version。" }));
    const approvalEvent = initialEvents.find((event) => event.type === "approval_required");
    if (approvalEvent?.type !== "approval_required") throw new Error("approval checkpoint missing");
    const approval = approvalEvent.result.approval;
    await runtime.approvals.submit({ sessionId, turnId, approvalId: approval.approvalId, decision: "deny" });

    const resumedEvents = await collectEvents(runtime.turns.continue({ sessionId, turnId, approval: { approvalId: approval.approvalId, decision: "deny" } }));

    expect(sampleCount).toBe(1);
    expect(resumedEvents.some((event) => event.type === "tool_result" && event.toolName === "run_command" && event.result.status === "denied")).toBe(true);
    expect(resumedEvents.some((event) => event.type === "tool_started" && event.toolName === "grep_files")).toBe(false);
    expect(resumedEvents.some((event) => event.type === "answer_delta" && event.delta.includes("不会尝试其他命令"))).toBe(true);
    // 2.5：拒绝是未完成的终止，终态必须是 turn_failed（受阻不能显示为成功完成）。
    expect(resumedEvents.some((event) => event.type === "turn_failed")).toBe(true);
  });

  it("审批拒绝会为尚未开始的同批 sibling 写入确定性错误结果", async function closesSiblingsAfterDeniedApproval() {
    const ports = createMemoryPorts();
    // 本用例验证审批拒绝流；run_command 需要可沙箱执行才进入审批（Stage 3 组合矩阵），替换透传 fake。
    ports.sandboxPort = createPassthroughSandboxPort();
    const sessionId = "contract-approval-deny-siblings-001";
    const turnId = "turn-approval-deny-siblings-001";
    await seedSession(ports, sessionId);
    const sampler: ModelSampler = {
      sample: async () => ({
        content: "",
        toolCalls: [
          { id: "command-deny-1", name: "run_command", input: { program: "node", args: ["--version"], cwd: ".", timeoutMs: 5_000 } },
          { id: "grep-after-deny-1", name: "grep_files", input: { pattern: "node", path: "." } },
        ],
        reasoningSummary: "执行命令后再搜索",
        finishReason: "tool_calls",
      }),
    };
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { permissionMode: "ask", modelSampler: sampler, maxSteps: 8, workspaceRoot: process.cwd() } });

    const initialEvents = await collectEvents(runtime.turns.start({ sessionId, turnId, content: "请执行 node --version 后搜索 node。" }));
    const approvalEvent = initialEvents.find((event) => event.type === "approval_required");
    if (approvalEvent?.type !== "approval_required") throw new Error("approval checkpoint missing");
    await runtime.approvals.submit({ sessionId, turnId, approvalId: approvalEvent.result.approval.approvalId, decision: "deny" });

    const resumedEvents = await collectEvents(runtime.turns.continue({ sessionId, turnId, approval: { approvalId: approvalEvent.result.approval.approvalId, decision: "deny" } }));
    expect(resumedEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_result", callId: "command-deny-1", result: expect.objectContaining({ status: "denied" }) }),
      expect.objectContaining({ type: "tool_result", callId: "grep-after-deny-1", result: expect.objectContaining({ status: "error", error: expect.objectContaining({ code: "TOOL_NOT_EXECUTED_AFTER_DENIAL" }) }) }),
    ]));
    expect((await ports.checkpointStore.getLatest(sessionId))?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: [expect.objectContaining({ type: "tool-result", toolCallId: "grep-after-deny-1", isError: true })] }),
    ]));
  });

  it("continue 拒绝 completed checkpoint，避免内部路径绕过新 Turn 边界", async function rejectsCompletedCheckpointContinuation() {
    const ports = createMemoryPorts();
    const sessionId = "contract-completed-not-resumable-001";
    const turnId = "turn-completed-not-resumable-001";
    await seedSession(ports, sessionId);
    await ports.turnStore.save({ id: turnId, sessionId, status: "completed", frozenRunConfig: { permissionMode: "auto_approve", maxSteps: 8, workContextVersion: 1, capabilityCeiling: { productMode: "work" } }, startedAt: Date.now() });
    await ports.checkpointStore.save(sessionId, {
      messageSchemaVersion: 2,
      turnId,
      status: "completed",
      stepCount: 1,
      messages: [createAgentTextMessage("user", "已经完成")],
      completedCallIds: [],
    });
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler: createMockSampler("不应采样") } });

    await expect(collectEvents(runtime.turns.continue({ sessionId, turnId }))).rejects.toMatchObject({ code: "TURN_NOT_RESUMABLE" });
  });

  it("迁移旧默认 2,000,000 token checkpoint 后允许同一 Turn 继续", async function migratesLegacyDefaultTokenBudget() {
    const ports = createMemoryPorts();
    const sessionId = "contract-legacy-default-token-budget";
    const turnId = "turn-legacy-default-token-budget";
    const completedCallId = "legacy-completed-read";
    await seedSession(ports, sessionId);
    await ports.turnStore.save({
      id: turnId,
      sessionId,
      status: "interrupted",
      frozenRunConfig: {
        permissionMode: "auto_approve",
        maxDurationMs: 30 * 60 * 1_000,
        maxTotalTokens: 2_000_000,
        workspaceRoot: process.cwd(),
        workspaceTrusted: true,
        workContextVersion: 1,
        capabilityCeiling: { productMode: "work" },
      },
      startedAt: Date.now(),
    });
    await ports.checkpointStore.save(sessionId, {
      messageSchemaVersion: 2,
      turnId,
      status: "interrupted_recoverable",
      interruptionReason: "token_budget",
      stepCount: 1,
      messages: [
        createAgentTextMessage("user", "继续完成任务。"),
        { role: "assistant", content: [{ type: "tool-call", id: completedCallId, name: "read_file", input: { path: "README.md" } }] },
        createAgentToolResultMessage({ toolCallId: completedCallId, text: "旧读取已完成", isError: false }),
      ],
      completedCallIds: [completedCallId],
      runtimeBudget: { startedAt: Date.now() - 60_000, totalTokens: 2_100_000 },
    });
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: { permissionMode: "auto_approve", workspaceRoot: process.cwd(), workspaceTrusted: true, modelSampler: createMockSampler("迁移后继续完成。") },
    });

    const recoveryView = await runtime.turns.getRecoverableState({ sessionId, turnId });
    const events = await collectEvents(runtime.turns.continue({ sessionId, turnId }));
    const migratedTurn = await ports.turnStore.get(turnId);
    const migratedCheckpoint = await ports.checkpointStore.getLatest(sessionId);
    const publicState = await runtime.turns.getState({ sessionId, turnId });

    expect(recoveryView).toMatchObject({ status: "interrupted_recoverable", recoverable: true });
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
    expect(events.some((event) => event.type === "tool_started" && event.callId === completedCallId)).toBe(false);
    expect(migratedTurn?.frozenRunConfig.safetyBudgetVersion).toBe(2);
    expect(migratedTurn?.frozenRunConfig.maxTotalTokens).toBeUndefined();
    expect(migratedCheckpoint?.safetyBudgetVersion).toBe(2);
    expect(migratedCheckpoint?.status).toBe("completed");
    expect(migratedCheckpoint?.completedCallIds).toContain(completedCallId);
    expect(migratedCheckpoint?.runtimeBudget?.totalTokens).toBe(2_100_000);
    expect(JSON.stringify(events)).not.toContain("safetyBudgetVersion");
    expect(JSON.stringify(publicState)).not.toContain("safetyBudgetVersion");
  });

  it("迁移未耗尽的旧显式额度时保留冻结上限并允许 Continue", async function preservesLegacyExplicitTokenBudget() {
    const ports = createMemoryPorts();
    const sessionId = "contract-legacy-explicit-token-budget-remaining";
    const turnId = "turn-legacy-explicit-token-budget-remaining";
    await seedSession(ports, sessionId);
    await ports.turnStore.save({
      id: turnId,
      sessionId,
      status: "interrupted",
      frozenRunConfig: {
        permissionMode: "auto_approve",
        maxDurationMs: 30 * 60 * 1_000,
        maxTotalTokens: 500,
        workspaceRoot: process.cwd(),
        workspaceTrusted: true,
        workContextVersion: 1,
        capabilityCeiling: { productMode: "work" },
      },
      startedAt: Date.now(),
    });
    await ports.checkpointStore.save(sessionId, {
      messageSchemaVersion: 2,
      turnId,
      status: "interrupted_recoverable",
      interruptionReason: "runtime_budget",
      stepCount: 1,
      messages: [createAgentTextMessage("user", "在运行段暂停后继续。")],
      completedCallIds: [],
      runtimeBudget: { startedAt: Date.now() - 60_000, totalTokens: 250 },
    });
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: { permissionMode: "auto_approve", workspaceRoot: process.cwd(), workspaceTrusted: true, modelSampler: createMockSampler("显式额度仍有余量，继续完成。") },
    });

    const recoveryView = await runtime.turns.getRecoverableState({ sessionId, turnId });
    const events = await collectEvents(runtime.turns.continue({ sessionId, turnId }));
    const migratedTurn = await ports.turnStore.get(turnId);
    const migratedCheckpoint = await ports.checkpointStore.getLatest(sessionId);

    expect(recoveryView).toMatchObject({ status: "interrupted_recoverable", recoverable: true });
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
    expect(migratedTurn?.frozenRunConfig.safetyBudgetVersion).toBe(2);
    expect(migratedTurn?.frozenRunConfig.maxTotalTokens).toBe(500);
    expect(migratedCheckpoint?.safetyBudgetVersion).toBe(2);
    expect(migratedCheckpoint?.runtimeBudget?.totalTokens).toBe(250);
  });

  it("迁移已耗尽的旧显式 token 额度为不可继续终态且重复读取幂等", async function terminalizesLegacyExhaustedExplicitTokenBudget() {
    const ports = createMemoryPorts();
    const sessionId = "contract-legacy-explicit-token-budget";
    const turnId = "turn-legacy-explicit-token-budget";
    let sampleCount = 0;
    await seedSession(ports, sessionId);
    await ports.turnStore.save({
      id: turnId,
      sessionId,
      status: "interrupted",
      frozenRunConfig: {
        permissionMode: "auto_approve",
        maxDurationMs: 30 * 60 * 1_000,
        maxTotalTokens: 10,
        workspaceRoot: process.cwd(),
        workspaceTrusted: true,
        workContextVersion: 1,
        capabilityCeiling: { productMode: "work" },
      },
      startedAt: Date.now(),
    });
    await ports.checkpointStore.save(sessionId, {
      messageSchemaVersion: 2,
      turnId,
      status: "interrupted_recoverable",
      interruptionReason: "token_budget",
      stepCount: 1,
      messages: [createAgentTextMessage("user", "继续任务。")],
      completedCallIds: [],
      runtimeBudget: { startedAt: Date.now() - 60_000, totalTokens: 10 },
    });
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "auto_approve",
        workspaceRoot: process.cwd(),
        workspaceTrusted: true,
        modelSampler: {
          async sample() {
            sampleCount += 1;
            return { content: "不应采样", toolCalls: [], reasoningSummary: "mock", finishReason: "stop" };
          },
        },
      },
    });
    const saveTurn = vi.spyOn(ports.turnStore, "save");
    const saveCheckpoint = vi.spyOn(ports.checkpointStore, "save");

    const recoveryView = await runtime.turns.getRecoverableState({ sessionId, turnId });
    expect(recoveryView).toMatchObject({
      status: "failed",
      recoverable: false,
      termination: { reason: "token_budget", recoverable: false, budget: { used: 10, limit: 10, unit: "tokens" } },
    });
    expect(JSON.stringify(recoveryView)).not.toContain("runtimeBudget");
    expect(JSON.stringify(recoveryView)).not.toContain("继续任务");
    expect((await ports.turnStore.get(turnId))?.status).toBe("interrupted");
    expect((await ports.turnStore.get(turnId))?.frozenRunConfig.safetyBudgetVersion).toBeUndefined();
    expect((await ports.checkpointStore.getLatest(sessionId))?.status).toBe("interrupted_recoverable");
    expect((await ports.checkpointStore.getLatest(sessionId))?.safetyBudgetVersion).toBeUndefined();
    expect(saveTurn).not.toHaveBeenCalled();
    expect(saveCheckpoint).not.toHaveBeenCalled();

    await expect(collectEvents(runtime.turns.continue({ sessionId, turnId }))).rejects.toMatchObject({ code: "TURN_NOT_RESUMABLE" });
    const migratedTurn = await ports.turnStore.get(turnId);
    const migratedCheckpoint = await ports.checkpointStore.getLatest(sessionId);
    expect(sampleCount).toBe(0);
    expect(migratedTurn?.status).toBe("failed");
    expect(migratedTurn?.frozenRunConfig.safetyBudgetVersion).toBe(2);
    expect(migratedTurn?.frozenRunConfig.maxTotalTokens).toBe(10);
    expect(migratedCheckpoint?.status).toBe("failed");
    expect(migratedCheckpoint?.safetyBudgetVersion).toBe(2);

    await expect(collectEvents(runtime.turns.continue({ sessionId, turnId }))).rejects.toMatchObject({ code: "TURN_NOT_RESUMABLE" });
    expect(saveTurn).toHaveBeenCalledTimes(1);
    expect(saveCheckpoint).toHaveBeenCalledTimes(1);
    expect(sampleCount).toBe(0);
  });

  it("continue 拒绝与最新 Turn 身份不一致的 checkpoint", async function rejectsCheckpointFromDifferentTurn() {
    const ports = createMemoryPorts();
    const sessionId = "contract-checkpoint-turn-mismatch-001";
    const latestTurnId = "turn-latest-001";
    await seedSession(ports, sessionId);
    await ports.turnStore.save({ id: latestTurnId, sessionId, status: "interrupted", frozenRunConfig: { permissionMode: "auto_approve", maxSteps: 8, workContextVersion: 1, capabilityCeiling: { productMode: "work" } }, startedAt: Date.now() });
    // 旧 checkpoint 的来源 Turn 也要在 Turn 历史中，否则 CR 边界按"孤立 checkpoint"拒绝，测不到目标错误码。
    await ports.turnStore.save({ id: "turn-stale-001", sessionId, status: "interrupted", frozenRunConfig: { permissionMode: "auto_approve", maxSteps: 8, workContextVersion: 1, capabilityCeiling: { productMode: "work" } }, startedAt: Date.now() });
    await ports.checkpointStore.save(sessionId, {
      messageSchemaVersion: 2,
      turnId: "turn-stale-001",
      status: "interrupted_recoverable",
      stepCount: 1,
      messages: [createAgentTextMessage("user", "旧 Turn")],
      completedCallIds: [],
    });
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler: createMockSampler("不应采样") } });

    await expect(collectEvents(runtime.turns.continue({ sessionId, turnId: latestTurnId }))).rejects.toMatchObject({ code: "TURN_FROZEN_MISMATCH" });
  });

  it("中断恢复先以 TOOL_OUTCOME_UNKNOWN 闭合未持久化工具结果，再采样", async function closesUnknownToolOutcomeBeforeResume() {
    const ports = createMemoryPorts();
    const sessionId = "contract-interrupted-close-001";
    const turnId = "turn-interrupted-close-001";
    await seedSession(ports, sessionId);
    await ports.turnStore.save({ id: turnId, sessionId, status: "interrupted", frozenRunConfig: { permissionMode: "auto_approve", maxSteps: 8, workContextVersion: 1, capabilityCeiling: { productMode: "work" } }, startedAt: Date.now() });
    await ports.checkpointStore.save(sessionId, {
      messageSchemaVersion: 2,
      turnId,
      status: "interrupted_recoverable",
      stepCount: 1,
      messages: [
        createAgentTextMessage("user", "继续处理"),
        { role: "assistant", content: [{ type: "tool-call", id: "unknown-call-1", name: "read_file", input: { path: "README.md" } }] },
      ],
      pendingCalls: [{ id: "unknown-call-1", name: "read_file", input: { path: "README.md" } }],
      completedCallIds: [],
    });
    const sampledMessages: AgentMessage[][] = [];
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelSampler: {
          async sample(messages) {
            sampledMessages.push(messages);
            return { content: "已从安全边界恢复。", toolCalls: [], reasoningSummary: "mock", finishReason: "stop" };
          },
        },
      },
    });

    const events = await collectEvents(runtime.turns.continue({ sessionId, turnId }));
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
    expect(sampledMessages[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: [expect.objectContaining({ type: "tool-result", toolCallId: "unknown-call-1", isError: true })] }),
    ]));
    expect(JSON.stringify(sampledMessages[0])).toContain("TOOL_OUTCOME_UNKNOWN");
  });

  it("start 将宿主解析的 activeSkills 持久化到完成 checkpoint", async function persistsActiveSkills() {
    const ports = createMemoryPorts();
    const sessionId = "contract-active-skills-001";
    const activeSkills = [{ skillId: "frontend-design", contentHash: "hash-0730" }];
    await seedSession(ports, sessionId);

    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "auto_approve",
        modelSampler: createMockSampler("已完成。"),
        maxSteps: 8,
      },
    });

    const events = await collectEvents(runtime.turns.start({ sessionId, content: "请确认。", activeSkills }));
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
    expect((await ports.checkpointStore.getLatest(sessionId))?.activeSkills).toEqual(activeSkills);
  });

  it("start 在不存在的 Session 上抛出 SESSION_NOT_FOUND", async function sessionNotFound() {
    const ports = createMemoryPorts();
    const runtime = createAgentRuntime({ ports });

    await expect(
      (async () => {
        for await (const _event of runtime.turns.start({ sessionId: "missing", content: "hi" })) {
          // noop
        }
      })(),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  it("读取状态时将过期 running lease 转为 interrupted_recoverable", async function recoversStaleLease() {
    const ports = createMemoryPorts();
    let now = 100_000;
    ports.clock = {
      now: () => now,
      timestamp: () => new Date(now).toISOString(),
    };
    const sessionId = "contract-stale-lease-001";
    const turnId = "turn-stale-lease-001";
    await seedSession(ports, sessionId);
    await ports.turnStore.save({
      id: turnId,
      sessionId,
      status: "running",
      frozenRunConfig: { permissionMode: "auto_approve", maxSteps: 8, workContextVersion: 1, capabilityCeiling: { productMode: "work" } },
      startedAt: now - 60_000,
      schemaVersion: 1,
    });
    await ports.checkpointStore.save(sessionId, {
      messageSchemaVersion: 2,
      turnId,
      status: "running",
      stepCount: 1,
      messages: [createAgentTextMessage("user", "等待恢复")],
      completedCallIds: [],
      lease: { leaseId: "lease-1", ownerId: "owner-1", heartbeatAt: now - 46_000, safeBoundarySeq: 2 },
    });

    const runtime = createAgentRuntime({ ports });
    const state = await runtime.turns.getState({ sessionId, turnId });

    expect(state.checkpoint).toMatchObject({ status: "interrupted_recoverable", messages: [], completedCallIds: [] });
    expect(JSON.stringify(state.checkpoint)).not.toContain("等待恢复");
    expect(JSON.stringify(state.checkpoint)).not.toContain("leaseId");
    expect((await ports.checkpointStore.getLatest(sessionId))?.status).toBe("interrupted_recoverable");
    const recoverable = await runtime.turns.getRecoverableState({ sessionId, turnId });
    expect(recoverable).toMatchObject({ sessionId, turnId, status: "interrupted_recoverable", recoverable: true, activeSkills: [] });
    expect(JSON.stringify(recoverable)).not.toContain("等待恢复");
    expect(JSON.stringify(recoverable)).not.toContain("leaseId");
    now += 1;
  });

  it("只读工具批次完成后先持久化 running checkpoint，重启恢复不重复读取", async function refreshesReadonlyCheckpointBeforeNextSample() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "turn-safe-readonly-"));
    const fixturePath = path.join(workspaceRoot, "fixture.txt");
    await writeFile(fixturePath, "safe checkpoint\n", "utf8");
    const ports = createMemoryPorts(workspaceRoot);
    const sessionId = "contract-safe-readonly-001";
    const turnId = "turn-safe-readonly-001";
    await seedSession(ports, sessionId);

    const savedCheckpoints: AgentCheckpoint[] = [];
    const originalSave = ports.checkpointStore.save.bind(ports.checkpointStore);
    const saveSpy = vi.spyOn(ports.checkpointStore, "save").mockImplementation(async function captureCheckpoint(session, checkpoint) {
      savedCheckpoints.push(structuredClone(checkpoint));
      await originalSave(session, checkpoint);
    });
    let sampleCount = 0;
    const sampler: ModelSampler = {
      async sample() {
        sampleCount += 1;
        return sampleCount === 1
          ? { content: "", toolCalls: [{ id: "safe-read-1", name: "read_file", input: { path: "fixture.txt", limit: 100 } }], reasoningSummary: "读取文件", finishReason: "tool_calls" }
          : { content: "已完成读取。", toolCalls: [], reasoningSummary: "完成", finishReason: "stop" };
      },
    };

    try {
      const runtime = createAgentRuntime({ ports, defaultRunConfig: { permissionMode: "auto_approve", workspaceRoot, workspaceTrusted: true, modelSampler: sampler } });
      const firstEvents = await collectEvents(runtime.turns.start({ sessionId, turnId, content: "读取 fixture.txt 并完成。" }));
      const safeCheckpoint = savedCheckpoints.find(function findCompletedRead(checkpoint) {
        return checkpoint.status === "running" && checkpoint.completedCallIds.includes("safe-read-1");
      });

      expect(safeCheckpoint).toMatchObject({ status: "running", completedCallIds: ["safe-read-1"] });
      if (!safeCheckpoint) throw new Error("只读工具安全 checkpoint 未写入");
      expect(safeCheckpoint.pendingCalls).toBeUndefined();
      expect(safeCheckpoint.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ content: [expect.objectContaining({ type: "tool-result", toolCallId: "safe-read-1" })] }),
      ]));

      const restartCheckpoint: AgentCheckpoint = {
        ...safeCheckpoint,
        status: "interrupted_recoverable",
        interruptionReason: "stale_lease",
        lease: safeCheckpoint.lease ? { ...safeCheckpoint.lease, heartbeatAt: 0 } : undefined,
      };
      await originalSave(sessionId, restartCheckpoint);
      const resumedRuntime = createAgentRuntime({ ports, defaultRunConfig: { permissionMode: "auto_approve", workspaceRoot, workspaceTrusted: true, modelSampler: { async sample() { return { content: "重启后完成。", toolCalls: [], reasoningSummary: "完成", finishReason: "stop" }; } } } });
      const resumedEvents = await collectEvents(resumedRuntime.turns.continue({ sessionId, turnId }));

      expect(firstEvents.filter(function countReadStarts(event) { return event.type === "tool_started" && event.toolName === "read_file"; })).toHaveLength(1);
      expect(resumedEvents.some(function repeatsRead(event) { return event.type === "tool_started" && event.toolName === "read_file"; })).toBe(false);
      const completedCheckpoint = await ports.checkpointStore.getByTurn(sessionId, turnId);
      expect(completedCheckpoint?.completedCallIds).toContain("safe-read-1");
    } finally {
      saveSpy.mockRestore();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("mutation 工具成功后从最新安全 checkpoint 重启，已完成写入不重放", async function doesNotReplayMutationAfterSafeCheckpointRestart() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "turn-safe-mutation-"));
    const ports = createMemoryPorts(workspaceRoot);
    const sessionId = "contract-safe-mutation-001";
    const turnId = "turn-safe-mutation-001";
    await seedSession(ports, sessionId);

    const savedCheckpoints: AgentCheckpoint[] = [];
    const originalSave = ports.checkpointStore.save.bind(ports.checkpointStore);
    const saveSpy = vi.spyOn(ports.checkpointStore, "save").mockImplementation(async function captureCheckpoint(session, checkpoint) {
      savedCheckpoints.push(structuredClone(checkpoint));
      await originalSave(session, checkpoint);
    });
    let sampleCount = 0;
    const firstSampler: ModelSampler = {
      async sample() {
        sampleCount += 1;
        if (sampleCount === 1) return { content: "", toolCalls: [{ id: "safe-write-1", name: "write_file", input: { path: "created.txt", content: "written once\n" } }], reasoningSummary: "创建文件", finishReason: "tool_calls" };
        if (sampleCount === 2) return { content: "", toolCalls: [{ id: "safe-verify-1", name: "read_file", input: { path: "created.txt", limit: 100 } }], reasoningSummary: "验证写入", finishReason: "tool_calls" };
        return { content: "已写入并验证。", toolCalls: [], reasoningSummary: "完成", finishReason: "stop" };
      },
    };
    const runtimeOptions = { permissionMode: "auto_approve" as const, workspaceRoot, workspaceTrusted: true };

    try {
      const runtime = createAgentRuntime({ ports, defaultRunConfig: { ...runtimeOptions, modelSampler: firstSampler } });
      const firstEvents = await collectEvents(runtime.turns.start({ sessionId, turnId, content: "创建 created.txt 并验证写入。" }));
      const safeCheckpoint = savedCheckpoints.find(function findWriteCheckpoint(checkpoint) {
        return checkpoint.status === "running"
          && checkpoint.completedCallIds.includes("safe-write-1")
          && !checkpoint.completedCallIds.includes("safe-verify-1");
      });

      expect(safeCheckpoint).toMatchObject({ status: "running", completedCallIds: ["safe-write-1"] });
      if (!safeCheckpoint) throw new Error("mutation 工具安全 checkpoint 未写入");
      expect(safeCheckpoint.pendingCalls).toBeUndefined();
      const runningSequences = savedCheckpoints
        .filter(function selectRunning(checkpoint) { return checkpoint.status === "running"; })
        .map(function getCompletedIds(checkpoint) { return checkpoint.completedCallIds; });
      expect(runningSequences.some(function preservesWrite(ids) { return ids.includes("safe-write-1"); })).toBe(true);
      for (let index = 1; index < runningSequences.length; index += 1) {
        expect(runningSequences[index]).toEqual(expect.arrayContaining(runningSequences[index - 1]));
      }

      const restartCheckpoint: AgentCheckpoint = {
        ...safeCheckpoint,
        status: "interrupted_recoverable",
        interruptionReason: "stale_lease",
        lease: safeCheckpoint.lease ? { ...safeCheckpoint.lease, heartbeatAt: 0 } : undefined,
      };
      await originalSave(sessionId, restartCheckpoint);
      let resumedSampleCount = 0;
      const resumedRuntime = createAgentRuntime({ ports, defaultRunConfig: { ...runtimeOptions, modelSampler: { async sample() {
        resumedSampleCount += 1;
        return resumedSampleCount === 1
          ? { content: "", toolCalls: [{ id: "safe-verify-after-restart", name: "read_file", input: { path: "created.txt", limit: 100 } }], reasoningSummary: "验证写入", finishReason: "tool_calls" }
          : { content: "重启后已验证。", toolCalls: [], reasoningSummary: "完成", finishReason: "stop" };
      } } } });
      const resumedEvents = await collectEvents(resumedRuntime.turns.continue({ sessionId, turnId }));

      expect(firstEvents.filter(function countWrites(event) { return event.type === "tool_started" && event.toolName === "write_file"; })).toHaveLength(1);
      expect(resumedEvents.some(function repeatsWrite(event) { return event.type === "tool_started" && event.toolName === "write_file"; })).toBe(false);
      expect(await readFile(path.join(workspaceRoot, "created.txt"), "utf8")).toBe("written once\n");
      const completedCheckpoint = await ports.checkpointStore.getByTurn(sessionId, turnId);
      expect(completedCheckpoint?.completedCallIds).toEqual(expect.arrayContaining(["safe-write-1", "safe-verify-after-restart"]));
    } finally {
      saveSpy.mockRestore();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("context overflow 由 Runtime 执行一次 reactive compact 后重试", async function recoversContextOverflow() {
    const ports = createMemoryPorts();
    const sessionId = "contract-reactive-compact-001";
    let sampleCount = 0;
    await seedSession(ports, sessionId);
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "auto_approve",
        maxSteps: 8,
        compactPolicy: { preserveRecentTurns: 1, targetTokens: 4_000 },
        modelSampler: {
          async sample(messages) {
            sampleCount += 1;
            if (messages[0] && getAgentMessageText(messages[0]).includes("上下文压缩器")) return { content: "压缩摘要：保留已完成工具事实。", toolCalls: [], reasoningSummary: "compact", finishReason: "stop" };
            if (sampleCount === 1) return { content: "", toolCalls: [{ id: "reactive-todo", name: "todo_write", input: { todos: [{ content: "保留 reactive 进度", activeForm: "正在保留 reactive 进度", status: "in_progress" }] } }], reasoningSummary: "mock", finishReason: "tool_use" };
            if (sampleCount === 2) throw new AgentSampleError("context overflow", "CONTEXT_OVERFLOW");
            return { content: "压缩后完成。", toolCalls: [], reasoningSummary: "mock", finishReason: "stop" };
          },
        },
      },
    });

    const events = await collectEvents(runtime.turns.start({ sessionId, content: "请完成任务。" }));
    const signatures = events.map((event) => event.type);
    expect(signatures).toContain("context_compact_started");
    expect(signatures).toContain("context_compacted");
    expect(signatures).toContain("turn_completed");
    expect(signatures).not.toContain("context_overflow");
    expect(events.filter(function countTodoStarts(event) { return event.type === "tool_started" && event.toolName === "todo_write"; })).toHaveLength(1);
    const compacted = events.find(function findCompacted(event) { return event.type === "context_compacted" && event.trigger === "reactive"; });
    expect(compacted?.type === "context_compacted" && compacted.checkpoint?.turnId).toBe((await ports.turnStore.getLatest(sessionId))?.id);
    expect(compacted?.type === "context_compacted" && compacted.checkpoint?.status).toBe("running");
    // 公开事件 checkpoint 是脱敏投影（completedCallIds 恒为空数组）；已闭合调用身份从 Core 私有 checkpoint 断言。
    const retryCheckpoint = await ports.checkpointStore.getByTurn(sessionId, (await ports.turnStore.getLatest(sessionId))!.id);
    expect(retryCheckpoint?.completedCallIds).toContain("reactive-todo");
    expect(sampleCount).toBe(3);
  });
});

/** H1：会话延续基线要保留失败轮的原始请求，而不是回退到更早的 completed 历史。 */
describe("会话延续基线（H1）", function conversationBaselineSuite() {
  /** 构造一次 run_command 采样结果；内存宿主沙箱不可用会把它压成 SANDBOX_UNAVAILABLE 拒绝。 */
  function sandboxCommandSample(callId: string) {
    return {
      content: "",
      toolCalls: [{ id: callId, name: "run_command", input: { program: "node", args: ["-e", "process.stdout.write('h1')"], cwd: "." } }],
      reasoningSummary: "mock",
    };
  }

  it("首次任务因沙箱不可用失败后，继续执行仍能看到原请求与失败事实", async function keepsFirstFailedTask() {
    const ports = createMemoryPorts();
    const sessionId = "turn-baseline-first-failed";
    await seedSession(ports, sessionId);
    const samples: AgentMessage[][] = [];
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelRef: { provider: "firstParty", modelId: "fixture-model" },
        providerSettings: { primary: { apiProtocol: "anthropic-messages" } },
        modelSampler: {
          async sample(messages) {
            samples.push(messages);
            return samples.length === 1 ? sandboxCommandSample("h1-call-1") : { content: "继续处理", toolCalls: [], reasoningSummary: "mock" };
          },
        },
      },
    });

    const firstEvents = await collectEvents(runtime.turns.start({ sessionId, content: "把计算器做成 index.html" }));
    const failed = firstEvents.at(-1);
    expect(failed?.type).toBe("turn_failed");
    // 终态带出结构化沙箱类别，Web 不再把它当模型配置问题。
    expect(failed?.type === "turn_failed" ? failed.errorCode : undefined).toBe("SANDBOX_UNAVAILABLE");
    expect(samples).toHaveLength(1);

    const secondEvents = await collectEvents(runtime.turns.start({ sessionId, content: "继续执行" }));
    expect(secondEvents.some(function completed(event) { return event.type === "turn_completed"; })).toBe(true);
    const secondInput = JSON.stringify(samples[1]);
    expect(secondInput).toContain("把计算器做成 index.html");
    expect(secondInput).toContain("沙箱不可用");
    expect(secondInput).toContain("继续执行");
    // 失败轮的未知副作用不能被自动重放。
    expect(secondEvents.filter(function reranCommand(event) { return event.type === "tool_started" && event.toolName === "run_command"; })).toHaveLength(0);
  });

  it("已有成功历史时，最新失败轮仍是下一轮基线", async function prefersLatestFailedTurn() {
    const ports = createMemoryPorts();
    const sessionId = "turn-baseline-after-completed";
    await seedSession(ports, sessionId);
    const samples: AgentMessage[][] = [];
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelRef: { provider: "firstParty", modelId: "fixture-model" },
        providerSettings: { primary: { apiProtocol: "anthropic-messages" } },
        modelSampler: {
          async sample(messages) {
            samples.push(messages);
            if (samples.length === 1) return { content: "第一轮完成", toolCalls: [], reasoningSummary: "mock" };
            if (samples.length === 2) return sandboxCommandSample("h1-call-2");
            return { content: "继续处理", toolCalls: [], reasoningSummary: "mock" };
          },
        },
      },
    });

    await collectEvents(runtime.turns.start({ sessionId, content: "第一轮任务" }));
    const failedEvents = await collectEvents(runtime.turns.start({ sessionId, content: "第二轮任务" }));
    expect(failedEvents.at(-1)?.type).toBe("turn_failed");
    expect(samples).toHaveLength(2);

    const thirdEvents = await collectEvents(runtime.turns.start({ sessionId, content: "继续执行" }));
    expect(thirdEvents.some(function completed(event) { return event.type === "turn_completed"; })).toBe(true);
    const thirdInput = JSON.stringify(samples[2]);
    expect(thirdInput).toContain("第一轮任务");
    expect(thirdInput).toContain("第二轮任务");
    expect(thirdInput).toContain("沙箱不可用");
  });
});
