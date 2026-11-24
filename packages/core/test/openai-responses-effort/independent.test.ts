/** Responses 独立离线验证，覆盖传输边界、受信能力和真实 Kernel 恢复。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { createNodeCheckpointStore } from "../../../adapters/src/node/stores/node-checkpoint-store";
import { createOpenAiResponsesSampler, createOpenAiResponsesRequest } from "../../src/runtime/provider/openai-responses-adapter";
import { resolveAutopilotSettings } from "../../src/runtime/config/autopilot-settings";
import { resolveRouteModelCapability, resolveRouteProtocolProfile } from "../../src/runtime/provider/model-capability-catalog";
import { resolveRouteModelSample } from "../../src/runtime/provider/model-sample-resolver";
import { createAgentKernel } from "../../src/internal/kernel/agent-kernel";
import { ToolRegistry } from "../../src/internal/tools/tool-registry";
import type { AgentMessage } from "../../src/internal/types/agent-message";
import type { ProviderRouteProfile } from "../../src/runtime/provider/api-protocol";
import type { AgentCheckpoint } from "../../src/internal/agent-runtime";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createAgentRuntime } from "../../src/runtime/public/create-agent-runtime";
import { compactMessages, projectMessagesForSummary } from "../../src/internal/kernel/compact";
import { createTurnRuntimeConfigResolver } from "../../src/runtime/application/turn/turn-runtime-config-resolver";
import type { RuntimePorts } from "../../src/runtime/ports";

vi.mock("@autopilot-agent/core", async function sourceCore() { return import("../../src/index"); });

const input = { routeId: "fixture", baseUrl: "https://fixture.invalid/v1", apiKey: "offline", sampleOptions: { model: "gpt-6-luna", reasoningEffort: "high" as const }, protocolProfile: { apiProtocol: "openai-responses" as const, reasoningReplay: "encrypted" as const } };
const user: AgentMessage = { role: "user", content: [{ type: "text", text: "确认" }] };
/** 构造完整文本项。 */
function textItem(text = "完成") { return { type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text }] }; }
/** 构造完成事件。 */
function end(output: unknown[]) { return { type: "response.completed", response: { status: "completed", output } }; }
/** 构造离线流，可控制分块大小。 */
function stream(events: unknown[], size = 7) {
  const bytes = new TextEncoder().encode(events.map(function encode(event) { return `data: ${JSON.stringify(event)}\r\n\r\n`; }).join(""));
  return new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += size) controller.enqueue(bytes.slice(index, index + size)); controller.close(); } }));
}
/** 构造带预设或旧配置的最小 route。 */
function route(preset?: "openai" | "deepseek", model = "custom"): ProviderRouteProfile { return { id: "fixture", apiProtocol: preset ? "openai-responses" : "openai-chat-completions", compatibilityPreset: preset, baseUrl: input.baseUrl, credentialRef: { provider: "fixture", key: "offline" }, models: [{ id: model }] }; }

describe("Responses independent", function suite() {
  afterEach(function cleanup() { vi.unstubAllGlobals(); });
  it.each([1, 2, 7, 4096])("UTF8 CRLF chunk %s", async function chunks(size) {
    vi.stubGlobal("fetch", vi.fn(async function offline() { return stream([end([textItem("完成🙂")])], size); }));
    expect((await createOpenAiResponsesSampler(input).sample([user], [], {})).content).toBe("完成🙂");
  });
  it.each([400, 401, 403, 429, 500])("HTTP %s 归一且不泄露错误正文", async function http(status) {
    vi.stubGlobal("fetch", vi.fn(async function offline() { return new Response('{"error":{"code":"invalid_api_key","message":"private-marker"}}', { status }); }));
    const error = await createOpenAiResponsesSampler(input).sample([user], [], {}).catch(function caught(value) { return value; });
    expect(error.providerHttpStatus).toBe(status);
    expect(JSON.stringify(error)).not.toContain("private-marker");
  });
  it("网络错误与读取断流分别分类", async function connection() {
    vi.stubGlobal("fetch", vi.fn(async function offline() { throw new TypeError("network"); }));
    await expect(createOpenAiResponsesSampler(input).sample([user], [], {})).rejects.toMatchObject({ code: "PROVIDER_CONNECTION" });
    vi.stubGlobal("fetch", vi.fn(async function offline() { return new Response(new ReadableStream({ start(controller) { controller.error(new Error("reset")); } })); }));
    await expect(createOpenAiResponsesSampler(input).sample([user], [], {})).rejects.toMatchObject({ code: "STREAM_INCOMPLETE" });
  });
  it("timeout 与 caller cancel 保留分类", async function cancellation() {
    vi.stubGlobal("fetch", vi.fn(function offline(_url, options) { return new Promise(function pending(_resolve, reject) { options.signal.addEventListener("abort", function abort() { reject(new DOMException("aborted", "AbortError")); }); }); }));
    await expect(createOpenAiResponsesSampler({ ...input, timeoutMs: 10 }).sample([user], [], {})).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    const controller = new AbortController();
    const pending = createOpenAiResponsesSampler(input).sample([user], [], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  it("done 的加密负载覆盖终态摘要", async function authoritativeDone() {
    const reasoning = { type: "reasoning", id: "r", encrypted_content: "private-marker" };
    vi.stubGlobal("fetch", vi.fn(async function offline() { return stream([{ type: "response.output_item.done", output_index: 0, item: reasoning }, end([{ type: "reasoning", id: "r" }, textItem()])]); }));
    const result = await createOpenAiResponsesSampler(input).sample([user], [], {});
    expect(JSON.stringify(result.adapterReplayState)).toContain("private-marker");
    expect(result.content).toBe("完成");
  });
  it("损坏 replay 和 canonical 错配均拒绝", function corruption() {
    const binding = { apiProtocol: "openai-responses", routeId: input.routeId, baseUrl: input.baseUrl, modelId: input.sampleOptions.model };
    for (const items of ["invalid", [textItem("错配")]]) {
      const message: AgentMessage = { role: "assistant", content: [{ type: "text", text: "完成" }], adapterReplayState: { apiProtocol: "openai-responses", value: { binding, items } } };
      expect(function request() { createOpenAiResponsesRequest({ ...input, messages: [user, message], tools: [] }); }).toThrow();
    }
  });
  it("工具结果图片使用 call_id 和受信图像数据", function toolImage() {
    const image = { type: "image-ref" as const, id: "12345678-1234-1234-1234-123456789012", sha256: "a".repeat(64), width: 10, height: 10 };
    const messages: AgentMessage[] = [user, { role: "assistant", content: [{ type: "tool-call", id: "call", name: "fixture", input: {} }] }, { role: "user", content: [{ type: "tool-result", toolCallId: "call", content: [{ type: "text", text: "图片" }], isError: false, images: [image] }] }];
    const body = createOpenAiResponsesRequest({ ...input, messages, tools: [], imageData: { [image.id]: { mimeType: "image/png", data: "fixture-bytes" } } });
    expect((body.input as any[]).at(-1)).toMatchObject({ type: "function_call_output", call_id: "call", output: [{ type: "input_text", text: "图片" }, { type: "input_image", image_url: "data:image/png;base64,fixture-bytes" }] });
    expect(function missing() { createOpenAiResponsesRequest({ ...input, messages, tools: [] }); }).toThrow();
  });
  it.each(["encrypted", "content"] as const)("Runtime store %s 私有 checkpoint 与公开事件隔离", async function runtimePersistence(strategy) {
    const reasoning = strategy === "encrypted" ? { type: "reasoning", id: "r", encrypted_content: "private-marker" } : { type: "reasoning", id: "r", content: [{ type: "reasoning_text", text: "private-marker" }] };
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async function offline(_url, options) { requests.push(JSON.parse(options.body as string)); return stream([end([reasoning, textItem()])]); }));
    const ports = createMemoryPorts();
    const defaults = { permissionMode: "auto_approve" as const, maxSteps: 4, modelSampler: createOpenAiResponsesSampler({ ...input, protocolProfile: { apiProtocol: "openai-responses" as const, reasoningReplay: strategy } }) };
    const runtime = createAgentRuntime({ ports, defaultRunConfig: defaults });
    const session = await runtime.sessions.create({ id: "offline-runtime", title: "fixture" });
    const events: unknown[] = [];
    for await (const event of runtime.turns.start({ sessionId: session.id, content: "确认" })) events.push(event);
    expect(JSON.stringify(events)).not.toContain("private-marker");
    expect(JSON.stringify(await ports.transcriptStore.getEvents(session.id))).not.toContain("private-marker");
    expect(JSON.stringify(await ports.checkpointStore.getLatest(session.id))).toContain("private-marker");
    const reopened = createAgentRuntime({ ports, defaultRunConfig: defaults });
    for await (const event of reopened.turns.start({ sessionId: session.id, content: "下一轮" })) events.push(event);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain("private-marker");
    expect(JSON.stringify(events)).not.toContain("private-marker");
  });
  it("compact 去除旧完整工具组且私有 payload 不进摘要", async function compactPrivate() {
    const old: AgentMessage[] = [user, { role: "assistant", content: [{ type: "tool-call", id: "old-call", name: "fixture", input: {} }], adapterReplayState: { apiProtocol: "openai-responses", value: { private: "private-marker".repeat(3000) } } }, { role: "user", content: [{ type: "tool-result", toolCallId: "old-call", content: [{ type: "text", text: "ok" }], isError: false }] }];
    const messages = [...old, user, { role: "assistant" as const, content: [{ type: "text" as const, text: "最近" }] }];
    expect(projectMessagesForSummary(messages)).not.toContain("private-marker");
    const compacted = await compactMessages({ messages, targetTokens: 2500, preserveRecentTurns: 1, trigger: "manual", sampler: { async sample(history) { expect(JSON.stringify(history)).toContain("private-marker"); return { content: "摘要", reasoningSummary: "完成", toolCalls: [] }; } } });
    expect(JSON.stringify(compacted.messages)).not.toContain("old-call");
    expect(JSON.stringify(compacted.messages)).not.toContain("private-marker");
  });
  it("混合 delta 与完整文本项在 Kernel 都展示且不重复", async function mixedText() {
    const first = textItem("甲");
    const second = { ...textItem("乙"), id: "m2" };
    vi.stubGlobal("fetch", vi.fn(async function offline() { return stream([{ type: "response.output_text.delta", output_index: 0, delta: "甲" }, end([first, second])]); }));
    const deltas: string[] = [];
    const kernel = createAgentKernel({ turnId: "mixed", messages: [user], toolRegistry: new ToolRegistry(), permissionContext: { mode: "auto_approve" }, modelSampler: createOpenAiResponsesSampler(input), maxSteps: 4 });
    for await (const event of kernel.run()) { if (event.type === "answer_delta") deltas.push(event.delta); }
    expect(deltas.join("")).toBe("甲乙");
  });
  it("旧无预设 Chat 的显式 high 仍可使用", function legacyChat() {
    const legacy = route();
    expect(resolveRouteModelSample(legacy, { provider: "fixture", modelId: "custom" }, { effort: "high" }).sampleOptions.reasoningEffort).toBe("high");
  });
  it("DeepSeek Pro 不能覆盖声明为图片模型", function proImage() {
    const pro = route("deepseek", "deepseek-v4-pro");
    pro.models[0].capabilities = { inputModalities: ["text", "image"] };
    expect(function resolve() { resolveRouteModelCapability(pro, "deepseek-v4-pro"); }).toThrow();
  });
  it("OpenAI 声明不能突破硬输出上限", function hardOutput() {
    const openai = route("openai", "gpt-6-luna");
    openai.models[0].capabilities = { maxOutputTokens: 999999 };
    expect(function resolve() { resolveRouteModelCapability(openai, "gpt-6-luna"); }).toThrow();
  });
  it("旧无预设 Chat settings high 无新增诊断", function legacySettings() {
    const config = resolveAutopilotSettings([{ scope: "user", value: { model: "fixture/custom", effortLevel: "high", providerRoutes: { fixture: route() } } }]);
    expect(config.diagnostics).toEqual([]);
  });
  it.each([
    { supportedReasoningEfforts: ["ultra"] },
    { supportedReasoningEfforts: ["high", "high"] },
    { supportedReasoningEfforts: ["low"], defaultReasoningEffort: "high" },
    { inputModalities: ["image"] },
    { maxOutputTokens: -1 },
    { unknownCapability: true },
  ])("严格配置拒绝非法能力 %j", function strictConfig(capabilities) {
    const config = route();
    const resolved = resolveAutopilotSettings([{ scope: "user", value: { providerRoutes: { fixture: { ...config, models: [{ id: "custom", capabilities }] } } } }]);
    expect(resolved.diagnostics).toContainEqual(expect.objectContaining({ code: "SETTINGS_PROVIDER_ROUTE_INVALID" }));
  });
  it("generic 模型声明和完整 profile 覆盖不跨 route", function priority() {
    const config: ProviderRouteProfile = { ...route(), apiProtocol: "openai-responses", compatibilityPreset: "generic", protocolProfile: { apiProtocol: "openai-responses", reasoningReplay: "none" }, models: [{ id: "custom", capabilities: { supportedReasoningEfforts: ["low", "xhigh"], defaultReasoningEffort: "xhigh" }, protocolProfile: { apiProtocol: "openai-responses", reasoningReplay: "content" } }] };
    expect(resolveRouteProtocolProfile(config, "custom")).toEqual({ apiProtocol: "openai-responses", reasoningReplay: "content" });
    expect(resolveRouteModelSample(config, { provider: "fixture", modelId: "custom" }).sampleOptions.reasoningEffort).toBe("xhigh");
    expect(resolveRouteModelCapability({ ...config, id: "other", models: [{ id: "custom" }] }, "custom").supportedReasoningEfforts).toBeUndefined();
  });
  it("Anthropic 原有关闭 thinking 和 max 冻结保持一致", function firstPartyFrozen() {
    const resolver = createTurnRuntimeConfigResolver({ ports: {} as RuntimePorts, defaultRunConfig: {} });
    const frozen = resolver.freezeProviderConfig({ modelRef: { provider: "firstParty", modelId: "fixture" }, reasoningProfile: { effort: "max" } }, { providerSettings: { primary: { apiProtocol: "anthropic-messages", thinkingEnabled: false, timeoutMs: 12345 } } });
    expect(frozen).toMatchObject({ apiProtocol: "anthropic-messages", sampleOptions: { model: "fixture", reasoningEffort: "max" }, timeoutMs: 12345, effectiveReasoning: { effort: "max", source: "requested" } });
    expect(frozen?.sampleOptions).not.toHaveProperty("thinking");
  });
  it.each(["encrypted", "content"] as const)("真实 Kernel %s 多工具安全 checkpoint 恢复及下一 Turn", async function kernel(strategy) {
    const configured = { ...input, protocolProfile: { apiProtocol: "openai-responses" as const, reasoningReplay: strategy } };
    const reasoning = strategy === "encrypted" ? { type: "reasoning", id: "r", encrypted_content: "private-marker" } : { type: "reasoning", id: "r", content: [{ type: "reasoning_text", text: "private-marker" }] };
    const calls = ["a", "b"].map(function call(id) { return { type: "function_call", id: `item-${id}`, call_id: id, name: "fixture_echo", arguments: JSON.stringify({ value: id }) }; });
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async function offline(_url, options) { requests.push(JSON.parse(options.body as string)); return stream([end(requests.length === 1 ? [reasoning, ...calls] : [textItem()])]); }));
    const registry = new ToolRegistry();
    const executed: string[] = [];
    registry.register({ name: "fixture_echo", description: "离线工具", inputSchema: z.object({ value: z.string() }), metadata: { effect: "none", destructive: false, concurrency: { max: 2 }, retry: { safe: false } },
      /** 生成只读动作事实。 */
      createActionFacts() { return { toolName: "fixture_echo", effect: "none", destructive: false, operation: "read", risk: "read_only" }; },
      /** 返回离线工具结果。 */
      async execute(value) { executed.push(value.value); return { content: value.value }; },
    });
    let checkpoint: AgentCheckpoint | undefined;
    const stateRoot = fileURLToPath(new URL(`../../../../.agent-tests/openai-responses-effort/runs/r001-independent/fixtures/kernel-${strategy}/`, import.meta.url));
    const checkpointStore = createNodeCheckpointStore({ stateRoot });
    const kernel = createAgentKernel({ turnId: "offline", messages: [user], toolRegistry: registry, permissionContext: { mode: "auto_approve" }, modelSampler: createOpenAiResponsesSampler(configured), maxSteps: 4,
      /** 固化完整批次后模拟进程中断。 */
      async onSafeToolBatch(value) { await checkpointStore.save("offline-session", value); checkpoint = value; throw new Error("offline crash boundary"); },
    });
    try { for await (const _event of kernel.run()) { /* 消费至安全批次。 */ } } catch { /* 保留真实 checkpoint 供恢复。 */ }
    expect(executed.sort()).toEqual(["a", "b"]);
    expect(checkpoint).toBeDefined();
    checkpoint = (await createNodeCheckpointStore({ stateRoot }).getLatest("offline-session"))!;
    const recovered = createAgentKernel({ turnId: "offline", messages: checkpoint!.messages, checkpoint, toolRegistry: registry, permissionContext: { mode: "auto_approve" }, modelSampler: createOpenAiResponsesSampler(configured), maxSteps: 4 });
    let final: AgentCheckpoint | undefined;
    for await (const event of recovered.run()) { if (event.type === "turn_completed") final = event.checkpoint; }
    expect(final).toBeDefined();
    expect(executed).toHaveLength(2);
    expect(requests[1].input.filter(function outputs(item) { return item.type === "function_call_output"; }).map(function id(item) { return item.call_id; }).sort()).toEqual(["a", "b"]);
    expect(JSON.stringify(requests[1])).toContain("private-marker");
    const next = createAgentKernel({ turnId: "next", messages: [...final!.messages, user], toolRegistry: registry, permissionContext: { mode: "auto_approve" }, modelSampler: createOpenAiResponsesSampler(configured), maxSteps: 4 });
    for await (const _event of next.run()) { /* 消费下一 Turn。 */ }
    expect(JSON.stringify(requests[2])).toContain("private-marker");
  });
});
