/**
 * Talk-Plan0809 Step 6 Provider 故障矩阵。
 *
 * 使用受控 fetch 与内存 Runtime 验证连接、超时、429、5xx、流损坏、空响应、
 * 输出截断、畸形工具调用、有限恢复、熔断、取消终态与安全错误投影。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createAgentRuntime } from "../../src/runtime/public/create-agent-runtime";
import { createAgentKernel } from "../../src/internal/kernel/agent-kernel";
import type { ModelSampler } from "../../src/internal/kernel/model-sampler";
import { AgentSampleError, type AgentSampleErrorCode } from "../../src/internal/lib/llm";
import type { AgentLoopEvent } from "../../src/internal/agent-runtime";
import { ToolRegistry } from "../../src/internal/tools/tool-registry";
import { createOpenAiChatCompletionsSampler } from "../../src/runtime/provider/openai-chat-completions-adapter";

const providerConnection = { baseUrl: "https://provider.invalid/v1", apiKey: "fake-test-key" };
const emptyTools = [];

/** 通过唯一 Chat Completions Adapter 构造受控 Provider，避免依赖已删除的旧 sampler 入口。 */
function createProviderSampler() {
  return createOpenAiChatCompletionsSampler({
    baseUrl: providerConnection.baseUrl,
    apiKey: providerConnection.apiKey,
    sampleOptions: { model: "deepseek-v4-flash" },
    protocolProfile: {
      apiProtocol: "openai-chat-completions",
      assistantToolCallContent: "empty-string",
      supportsReasoningContent: false,
      supportsUsageInStreaming: false,
    },
  });
}

/** 调用受控 Provider 采样，并确保测试输入使用 V2 canonical 内容块。 */
function sampleProvider() {
  return createProviderSampler().sample(
    [{ role: "user", content: [{ type: "text", text: "test" }] }],
    emptyTools,
    { maxTokens: 8_192 },
  );
}

/** 把 Runtime/Kernel 事件流完整收集为数组。 */
async function collectEvents(stream: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** 构造 OpenAI 兼容 SSE 响应。 */
function createSseResponse(payloads: unknown[], includeDone = true): Response {
  const body = payloads.map(function encodePayload(payload) {
    return `data: ${JSON.stringify(payload)}\n\n`;
  }).join("") + (includeDone ? "data: [DONE]\n\n" : "");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** 构造一次正常完成的最小采样结果。 */
function createSuccessfulSample() {
  return { content: "已恢复", toolCalls: [], reasoningSummary: "完成", finishReason: "stop" };
}

/** 创建最小 Kernel，避免测试依赖工作区工具。 */
function createKernel(turnId: string, sampler: ModelSampler) {
  return createAgentKernel({
    turnId,
    messages: [{ role: "user", content: [{ type: "text", text: "执行 Provider 故障测试" }] }],
    toolRegistry: new ToolRegistry(),
    permissionContext: { mode: "auto_approve" },
    modelSampler: sampler,
  });
}

/** 写入一个可由 Public Runtime 使用的内存 Session。 */
async function seedSession(ports: ReturnType<typeof createMemoryPorts>, sessionId: string): Promise<void> {
  await ports.sessionStore.save({
    id: sessionId,
    persistenceMode: "durable",
    status: "idle",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

afterEach(function restoreTestState() {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sampleAgentStream Provider 故障分类", function providerFailureClassificationSuite() {
  it("连接失败归一化且不暴露底层错误文本", async function normalizesConnectionFailure() {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("connect failed with fake-test-key")));

    const error = await sampleProvider().catch(function captureError(value: unknown) { return value; });

    expect(error).toBeInstanceOf(AgentSampleError);
    expect(error).toMatchObject({ code: "PROVIDER_CONNECTION" });
    expect(String(error)).not.toContain("fake-test-key");
  });

  it.each([429, 500, 503])("HTTP %s 使用稳定错误码且不暴露响应正文", async function normalizesHttpFailure(status) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      '{"error":{"message":"raw-provider-secret fake-test-key"}}',
      { status },
    )));

    const error = await sampleProvider().catch(function captureError(value: unknown) { return value; });

    expect(error).toBeInstanceOf(AgentSampleError);
    expect(error).toMatchObject({ code: status === 429 ? "PROVIDER_RATE_LIMIT" : "PROVIDER_SERVER_ERROR" });
    expect(String(error)).not.toContain("raw-provider-secret");
    expect(String(error)).not.toContain("fake-test-key");
  });

  it.each([400, 401, 403])("HTTP %s 安全失败且不伪装成连接故障", async function rejectsNonTransientClientFailure(status) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      '{"error":{"message":"raw-provider-secret fake-test-key"}}',
      { status },
    )));

    const error = await sampleProvider().catch(function captureError(value: unknown) { return value; });

    expect(error).toBeInstanceOf(AgentSampleError);
    expect(error).toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", message: `供应商拒绝请求（HTTP ${status}）` });
    expect(String(error)).not.toContain("raw-provider-secret");
    expect(String(error)).not.toContain("fake-test-key");
  });

  it("内部请求超时与用户取消使用不同错误语义", async function distinguishesTimeoutFromCancel() {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(function pendingFetch(_url: string, init?: RequestInit) {
      return new Promise<Response>(function waitForAbort(_resolve, reject) {
        init?.signal?.addEventListener("abort", function rejectOnAbort() {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }));

    const outcome = sampleProvider().catch(function captureError(value: unknown) { return value; });
    await vi.advanceTimersByTimeAsync(120_001);

    await expect(outcome).resolves.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  });

  it("损坏的 SSE JSON fail closed 为流不完整", async function rejectsMalformedSseJson() {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "data: {malformed-json}\n\ndata: [DONE]\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )));

    await expect(sampleProvider()).rejects.toMatchObject({ code: "STREAM_INCOMPLETE" });
  });

  it.each([
    ["提前断流", createSseResponse([{ choices: [{ delta: { content: "partial" }, finish_reason: null }] }], false), "STREAM_INCOMPLETE"],
    ["空响应", createSseResponse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]), "EMPTY_RESPONSE"],
    ["输出截断", createSseResponse([{ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }]), "MODEL_OUTPUT_LIMIT"],
    ["畸形工具调用", createSseResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: "{" } }] }, finish_reason: "tool_calls" }] }]), "TOOL_CALL_INVALID_JSON"],
  ])("%s 使用稳定结构化错误", async function keepsStructuredBoundaries(_label, response, code) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(sampleProvider()).rejects.toMatchObject({ code });
  });
});

describe("Kernel Provider 有限恢复与熔断", function providerRecoverySuite() {
  it.each([
    "PROVIDER_CONNECTION",
    "PROVIDER_TIMEOUT",
    "PROVIDER_RATE_LIMIT",
    "PROVIDER_SERVER_ERROR",
  ] as AgentSampleErrorCode[])("%s 只恢复一次并保持同一 Turn 上下文", async function retriesTransientFailureOnce(code) {
    const sampleMock = vi.fn()
      .mockRejectedValueOnce(new AgentSampleError("安全 Provider 错误", code))
      .mockResolvedValueOnce(createSuccessfulSample());
    const events = await collectEvents(createKernel(`retry-${code}`, { sample: sampleMock }).run());

    expect(sampleMock).toHaveBeenCalledTimes(2);
    expect(events.filter(function isRecovery(event) { return event.type === "model_recovery"; })).toHaveLength(1);
    expect(events.some(function isCompleted(event) { return event.type === "turn_completed"; })).toBe(true);
    expect(sampleMock.mock.calls[1]?.[0]).toEqual(sampleMock.mock.calls[0]?.[0]);
    expect(sampleMock.mock.calls[1]?.[2]).toEqual(sampleMock.mock.calls[0]?.[2]);
  });

  it("连续瞬时故障在一次恢复后熔断为安全失败", async function opensCircuitAfterOneRecovery() {
    const sampleMock = vi.fn(async function failWithPartialAnswer(_messages, _tools, _options, onDelta) {
      onDelta?.("partial");
      throw new AgentSampleError(
        "raw-provider-secret fake-test-key",
        "PROVIDER_RATE_LIMIT" as AgentSampleErrorCode,
      );
    });
    const events = await collectEvents(createKernel("provider-circuit", { sample: sampleMock }).run());
    const serialized = JSON.stringify(events);

    expect(sampleMock).toHaveBeenCalledTimes(2);
    expect(events.filter(function isRecovery(event) { return event.type === "model_recovery"; })).toHaveLength(1);
    expect(events.some(function resetsPartialAnswer(event) { return event.type === "answer_reset"; })).toBe(true);
    expect(events.some(function discardsFinalPartialAnswer(event) { return event.type === "answer_discard"; })).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "turn_failed", error: "供应商请求持续被限流，已停止自动恢复" });
    expect(serialized).not.toContain("raw-provider-secret");
    expect(serialized).not.toContain("fake-test-key");
  });

  it("非瞬时 Provider 4xx 不进入恢复并直接安全失败", async function failsClientRejectionWithoutRetry() {
    const sampleMock = vi.fn().mockRejectedValue(new Error("供应商拒绝请求 (401)"));
    const events = await collectEvents(createKernel("provider-client-rejection", { sample: sampleMock }).run());

    expect(sampleMock).toHaveBeenCalledTimes(1);
    expect(events.some(function isRecovery(event) { return event.type === "model_recovery"; })).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "turn_failed", error: "供应商拒绝请求 (401)" });
  });
});

describe("Runtime Provider 取消终态", function providerCancellationSuite() {
  it("cancel 中止进行中的 Provider 请求并落 interrupted 终态", async function abortsProviderRequest() {
    const ports = createMemoryPorts();
    const sessionId = "step6-provider-cancel";
    let notifySampleStarted: (() => void) | undefined;
    const sampleStarted = new Promise<void>(function waitForSample(resolve) { notifySampleStarted = resolve; });
    const sampler: ModelSampler = {
      sample(_messages, _tools, options) {
        notifySampleStarted?.();
        return new Promise(function waitForAbort(_resolve, reject) {
          options.signal?.addEventListener("abort", function rejectOnAbort() {
            const error = new Error("cancelled");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    };
    await seedSession(ports, sessionId);
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler: sampler } });
    const eventsPromise = collectEvents(runtime.turns.start({ sessionId, content: "等待取消" }));

    await sampleStarted;
    const turn = await ports.turnStore.getLatest(sessionId);
    if (!turn) throw new Error("测试未创建 Turn");
    await runtime.turns.cancel({ sessionId, turnId: turn.id });
    const events = await eventsPromise;

    expect(events.at(-1)?.type).toBe("turn_interrupted");
    expect((await ports.turnStore.get(turn.id))?.status).toBe("interrupted");
    expect((await ports.sessionStore.get(sessionId))?.status).toBe("interrupted");
  });
});
