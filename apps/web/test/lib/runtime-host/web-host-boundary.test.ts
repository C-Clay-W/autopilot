/** Web Host Stage 17 边界回归：Route 只做协议，受信能力由 Composition Root 装配。 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSafeBootstrapConfig, type AgentRuntime, type ContextBudgetSnapshot, type ModelSamplerFactory } from "@autopilot-agent/core";
import { createRuntimeAgentStream } from "@/lib/runtime-host/web-agent-stream";
import { assertWebContextWithinBudget, createWebCompositionRoot } from "@/lib/composition-root";

/** 读取 messages route 源码，锁定 Stage 17 禁止回流的宿主依赖。 */
function readMessagesRouteSource(): string {
  return readFileSync(path.resolve(__dirname, "../../../app/api/sessions/[id]/messages/route.ts"), "utf8");
}

/** 读取 stream 的 JSON SSE payload，供 Context 投影断言使用。 */
async function readSseEvents(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let content = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    content += decoder.decode(value, { stream: true });
  }
  return content.split("\n\n")
    .flatMap((chunk) => chunk.startsWith("data: {") ? [JSON.parse(chunk.slice(6)) as Record<string, unknown>] : []);
}

/** 消费确定性 Turn，确保测试仅验证装配，不触发真实 Provider。 */
async function collectTurnEvents(events: AsyncIterable<unknown>): Promise<void> {
  for await (const event of events) {
    void event;
    // 只驱动完整生命周期；断言由假采样器记录的工具目录完成。
  }
}

describe("Web Host Stage 17 boundary", function webHostBoundarySuite() {
  it("messages route 不直接读取 Context、Memory、Skill catalog 或构建 RAG", function keepsRouteProtocolOnly() {
    const source = readMessagesRouteSource();

    expect(source).toContain("getDefaultWebCompositionRoot");
    expect(source).not.toContain("agent-context/instruction-store");
    expect(source).not.toContain("agent-memory/memory-retriever");
    expect(source).not.toContain("agent-skills/skill-discovery");
    expect(source).not.toContain("createRAGAgent");
    expect(source).not.toContain("context_compact_started\", trigger: \"auto");
    expect(source).toContain("prepareTurnContext(content)");
  });

  it("未 bootstrap 的 Composition Root 拒绝读取受信 Skill capability", async function requiresTrustBeforeCapabilityResolution() {
    const root = createWebCompositionRoot({ config: createSafeBootstrapConfig({ host: "web", workspaceRoot: "/fixture-explicit-workspace" }) });

    await expect(root.resolveSelectedSkills([], [])).rejects.toThrow("Runtime bootstrap 建立 Trust 后使用");
  });

  it("仅由受控附件引用生成视觉上下文", function createsAttachmentInstructionFromResolvedReferences() {
    const root = createWebCompositionRoot({ config: createSafeBootstrapConfig({ host: "web", workspaceRoot: "/fixture-explicit-workspace" }) });
    const instruction = root.createAttachmentInstruction([
      { id: "image-1", name: "diagram.png", mimeType: "image/png", relativePath: ".autopilot/sessions/s1/diagram.png" },
    ]);

    expect(instruction).toEqual(expect.objectContaining({
      role: "system",
      content: [expect.objectContaining({ type: "text", text: expect.stringContaining(".autopilot/sessions/s1/diagram.png") })],
    }));
  });

  it("通义环境凭据和 LLM_MODEL 存在时将 vision_analyze 与受信主模型一起冻结进 Web 新 Turn", async function registersVisionToolFromDashScopeFallback() {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "autopilot-web-vision-workspace-"));
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), "autopilot-web-vision-state-"));
    const previousTongyiApiKey = process.env.TONGYI_API_KEY;
    const previousLlmModel = process.env.LLM_MODEL;
    // 此夹具只验证宿主装配，不能读取开发者真实 Home 的模型配置或凭据。
    const home = vi.spyOn(os, "homedir").mockReturnValue(workspaceRoot);
    process.env.TONGYI_API_KEY = "fixture-tongyi-key";
    process.env.LLM_MODEL = "qwen3-vl-flash";
    const sampledToolNames: string[] = [];
    let frozenPrimaryModelId: string | undefined;
    let frozenVisionModelId: string | undefined;
    const modelSamplerFactory: ModelSamplerFactory = {
      create(input) {
        frozenPrimaryModelId = input?.ref?.modelId;
        frozenVisionModelId = input?.providerConfig?.vision?.ref.modelId;
        return {
          async sample(_messages, tools) {
            sampledToolNames.push(...tools.map(function getToolName(tool) { return tool.function.name; }));
            return { content: "视觉目录已冻结", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" };
          },
        };
      },
      getSupportedProviders() {
        return ["fixture"];
      },
    };

    try {
      const root = createWebCompositionRoot({
        config: createSafeBootstrapConfig({ host: "web", workspaceRoot, skipTrustCheck: true }),
        stateRoot,
        defaultRunConfig: {
          modelRef: { provider: "firstParty", modelId: "fixture-primary-model" },
          providerSettings: { primary: { apiProtocol: "anthropic-messages" } },
        },
        capabilityLoader: {
          loadProvider() {
            return modelSamplerFactory;
          },
        },
      });
      const runtime = await root.bootstrap();
      const session = await runtime.sessions.create({ id: "web-vision-fallback", title: "视觉回归" });

      await collectTurnEvents(runtime.turns.start({
        sessionId: session.id,
        content: "请描述上传图片",
        messages: [root.createAttachmentInstruction([
          { id: "image-1", name: "diagram.png", mimeType: "image/png", relativePath: ".autopilot/sessions/web-vision-fallback/diagram.png" },
        ])!],
      }));

      expect(sampledToolNames).toContain("vision_analyze");
      // 主模型由受信宿主 RunConfig 冻结；本用例只验证 Web 视觉环境不会覆盖该选择。
      expect(frozenPrimaryModelId).toBe("fixture-primary-model");
      expect(frozenVisionModelId).toBe("qwen3-vl-flash");
    } finally {
      home.mockRestore();
      if (previousTongyiApiKey === undefined) delete process.env.TONGYI_API_KEY;
      else process.env.TONGYI_API_KEY = previousTongyiApiKey;
      if (previousLlmModel === undefined) delete process.env.LLM_MODEL;
      else process.env.LLM_MODEL = previousLlmModel;
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("项目指令超过硬上限时拒绝启动", function rejectsOversizedProjectInstructions() {
    expect(() => assertWebContextWithinBudget({
      instructions: [],
      memories: [],
      budget: {
        estimatedTokens: 200_000,
        sections: { instructions: 800_001 },
        diagnostics: ["AGENTS.md 指令超过单轮预算，已拒绝注入而非静默截断"],
        compactNeeded: true,
      },
    })).toThrow("AGENTS.md 指令超过单轮预算");
  });

  it("SSE 只投影合并诊断，不携带 Node 项目预算", async function projectsDiagnosticsWithoutNodeBudgetToSse() {
    const budget: ContextBudgetSnapshot = {
      estimatedTokens: 1_024,
      sections: { instructions: 400, memories: 100 },
      diagnostics: ["上下文达到 compact 触发阈值"],
      compactNeeded: true,
    };
    const runtime = {
      turns: {
        async *start() {
          yield { type: "turn_started", turnId: "turn-budget", stepCount: 0 };
        },
      },
    } as unknown as AgentRuntime;

    const stream = createRuntimeAgentStream({
      sessionId: "session-budget",
      turnId: "turn-budget",
      runtime,
      mode: "start",
      content: "测试 Context 预算",
      requestSignal: new AbortController().signal,
      contextBudget: budget,
      initialDiagnostics: ["Pinned Skill 已更新"],
    });

    const [diagnostic] = await readSseEvents(stream);
    expect(diagnostic).toMatchObject({
      type: "context_diagnostic",
      diagnostics: ["上下文达到 compact 触发阈值", "Pinned Skill 已更新"],
    });
    expect(diagnostic).not.toHaveProperty("budget");
  });

  it("SSE 透传 Core context_usage_updated 安全快照", async function forwardsContextUsageUpdatedEvent() {
    const usage = {
      modelRef: "deepseek-chat",
      contextWindowTokens: 128_000,
      estimatedAddedTokens: 0,
      currentContextTokens: 16_000,
      outputReserveTokens: 8_192,
      compactTriggerTokens: 102_400,
      projectedTokens: 24_192,
      usageRatio: 0.189,
      compactNeeded: false,
      measurement: "measured",
      breakdown: { categories: [], freeTokens: 78_208, freeRatio: 0.611, compactBufferTokens: 25_600, compactBufferRatio: 0.2, overLimitTokens: 0, overLimitRatio: 0, measurement: "estimated" },
    };
    const runtime = {
      turns: {
        async *start() {
          yield { type: "context_usage_updated", turnId: "turn-budget", usage };
          yield { type: "turn_started", turnId: "turn-budget", stepCount: 0 };
        },
      },
    } as unknown as AgentRuntime;

    const stream = createRuntimeAgentStream({
      sessionId: "session-budget",
      turnId: "turn-budget",
      runtime,
      mode: "start",
      content: "测试 Context 用量事件",
      requestSignal: new AbortController().signal,
    });

    const events = await readSseEvents(stream);
    expect(events[0]).toMatchObject({ type: "context_usage_updated", usage });
  });

  it("Core 终态 Session 保存不会覆盖已完成回答", async function persistsAssistantAnswerAfterTerminalSessionSave() {
    let storedSession = {
      id: "session-answer",
      title: "现有对话",
      createdAt: 1,
      updatedAt: 1,
      status: "running",
      persistenceMode: "durable" as const,
      presentation: { messages: [] as Array<Record<string, unknown>> },
    };
    const staleSession = structuredClone(storedSession);
    const runtime = {
      sessions: {
        async get() {
          return structuredClone(storedSession);
        },
        async save(session: typeof storedSession) {
          storedSession = structuredClone(session);
        },
      },
      turns: {
        async *start() {
          yield { type: "answer_delta", turnId: "turn-answer", stepId: "answer-1", delta: "回答不能丢失" };
          yield { type: "turn_completed", turnId: "turn-answer", checkpoint: { status: "completed", messages: [{ role: "system", content: [{ type: "text", text: "internal-checkpoint-context" }] }] } };
          // 模拟 Core 在终态事件消费后，用运行前取得的 Session 快照写入最终状态。
          storedSession = staleSession;
        },
      },
    } as unknown as AgentRuntime;

    const stream = createRuntimeAgentStream({
      sessionId: "session-answer",
      turnId: "turn-answer",
      runtime,
      mode: "start",
      content: "测试回答持久化",
      requestSignal: new AbortController().signal,
    });

    const events = await readSseEvents(stream);
    const completed = events.find(function findCompletedEvent(event) { return event.type === "turn_completed"; });
    expect(completed).toMatchObject({ type: "turn_completed", turnId: "turn-answer" });
    expect(completed).not.toHaveProperty("checkpoint");
    expect(JSON.stringify(events)).not.toContain("internal-checkpoint-context");
    expect(storedSession.presentation.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      turnId: "turn-answer",
      content: "回答不能丢失",
    }));
  });
});
