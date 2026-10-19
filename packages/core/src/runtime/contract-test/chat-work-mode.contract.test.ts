/** Chat/Work Stage 1 契约：只用内存 Store 和 fake Provider 验证身份、工具上限、引用与证据门。 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryPorts } from "../adapters/memory";
import { createAgentRuntime } from "../public/create-agent-runtime";
import type { ChatCapability, ChatRagEvidenceBatch } from "../protocol/chat-capability";
import type { ChatRetrievalMode, Session } from "../domain";
import type { RunConfig } from "../protocol";
import type { AgentLoopEvent } from "../../internal/agent-runtime";
import type { AgentSampleResult } from "../../internal/lib/llm";
import type { ModelSampler } from "../../internal/kernel/model-sampler";
import { ToolExecutor } from "../../internal/tools/tool-executor";
import { ToolRegistry } from "../../internal/tools/tool-registry";
import { CHAT_RAG_INSUFFICIENT_MESSAGE, CHAT_RAG_ANSWER_FAILED_MESSAGE } from "../../internal/tools/chat-tool-runtime";
import { createAgentTextMessage } from "../../internal/types/agent-message";

const sessionId = "chat-session";
const turnId = "chat-turn";
const documentRef = "attachment_document_001";
const imageRef = "attachment_image_001";
const evidenceRef = "visual_evidence_001";
const evidenceId = "local_evidence_001";
const now = 2_000_000;
const canary = "PRIVATE_CANARY_STAGE1";

/** 收集真实 Runtime 事件，用于同时核验 Live、transcript 与 checkpoint。 */
async function collect(events: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const result: AgentLoopEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

/** RAG JSON fixture 通过答案提交工具返回；其他正文保留 delta 以检测提前泄漏。 */
function answer(content = "完成"): AgentSampleResult {
  if (content.startsWith("{")) return { content: "", toolCalls: [{ id: "answer-submit", name: "chat_submit_answer", input: JSON.parse(content) }], reasoningSummary: "fixture", finishReason: "tool_calls" };
  return { content, toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" };
}

/** 构造一次模型提出的工具调用，允许模拟目录外的恶意工具。 */
function call(name: string, input: Record<string, unknown>, id = "call-1"): AgentSampleResult {
  return { ...answer(""), toolCalls: [{ id, name, input }] };
}

/** fake sampler 捕获目录与上下文，所有请求都留在进程内。 */
function samplerFor(steps: AgentSampleResult[], catalogs: string[][] = [], contexts: string[] = []): ModelSampler {
  let index = 0;
  return {
    /** 每步返回预设结果，顺便模拟真实 Provider 的增量正文。 */
    async sample(messages, tools, _options, onDelta) {
      /** 采集模型实际获得的工具名并排序，供精确矩阵断言。 */
      catalogs.push(tools.map(function name(tool) { return tool.function.name; }).sort());
      contexts.push(JSON.stringify(messages));
      const result = steps[index++] ?? answer();
      onDelta?.(result.content);
      return result;
    },
  };
}

/** 提供当前 Session 的文档、图片与本地证据端口；spy 检查非法引用在读取前失败。 */
function chatCapability(): ChatCapability {
  return {
    attachments: [
      { ref: documentRef, kind: "document", sessionId, expiresAt: now + 100_000 },
      { ref: imageRef, kind: "image", sessionId, expiresAt: now + 100_000 },
    ],
    /** 默认授权当前测试引用，负向用例可替换此端口。 */
    authorizeRef: vi.fn(async function authorize() { return true; }),
    /** 返回私有标记文本，用于检测越域或提前泄漏。 */
    readAttachment: vi.fn(async function read() { return { text: canary }; }),
    /** 返回具有 PNG 签名的最小字节，避免真实图片文件依赖。 */
    readImage: vi.fn(async function read() { return { bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]), mimeType: "image/png" }; }),
    /** 返回固定本地视觉观察，便于逐字引用核验。 */
    visionAnalyzer: { analyze: vi.fn(async function analyze() { return "图片文字：本地证据"; }) },
    knowledge: {
      knowledgeSpaceId: "chat-knowledge-space",
      /** 根据调用身份生成当前会话的充分证据批次。 */
      prepareSearch: vi.fn(async function search(binding): Promise<ChatRagEvidenceBatch> {
        return { sessionId: binding.sessionId, turnId: binding.turnId, knowledgeSpaceId: "chat-knowledge-space", batchId: "knowledge_batch_001", evidence: [{ id: evidenceId, text: canary, sufficient: true, visualEvidenceRef: evidenceRef }] };
      }),
      /** 默认认可当前批次，撤销用例会改为拒绝。 */
      validateEvidence: vi.fn(async function validate() { return true; }),
    },
  };
}

/** 创建带完整 Work 干扰能力的 Runtime，验证 Chat 不会继承 Workspace、RAG 或 Web 加载器。 */
async function fixture(mode: ChatRetrievalMode, steps: AgentSampleResult[], capability: ChatCapability | undefined = chatCapability(), extra: Partial<RunConfig> = {}) {
  const ports = createMemoryPorts("/private/WORKSPACE_CANARY");
  /** 固定宿主时钟，使过期边界可重复。 */
  ports.clock.now = function fixedNow() { return now; };
  const workspaceSpy = vi.spyOn(ports.workspaceAdapter, "resolveWorkspaceRoot");
  const catalogs: string[][] = [];
  const contexts: string[] = [];
  const web = {
    /** 用内存公开结果替代真实搜索，spy 统计调用。 */
    search: { search: vi.fn(async function search() { return { answer: "public", sources: [], truncated: false }; }) },
    /** 用内存公开正文替代真实网页读取，不产生网络请求。 */
    fetch: { fetch: vi.fn(async function fetch() { return { url: "https://example.com/", finalUrl: "https://example.com/", content: "public", contentType: "text/plain", truncated: false }; }) },
  };
  /** 若误加载工作区上下文则立即失败。 */
  const contextLoader = vi.fn(async function context() { throw new Error("WORKSPACE_CONTEXT_MUST_NOT_LOAD"); });
  /** 仅返回测试 Web 端口，检测是否错误装配到 RAG。 */
  const webLoader = vi.fn(async function loadWeb() { return web; });
  /** 仅返回当前测试的 Chat 授权目录。 */
  const chatLoader = vi.fn(async function loadChat() { return capability; });
  const defaultRunConfig: RunConfig = {
    workspaceRoot: "/private/WORKSPACE_CANARY",
    workspaceTrusted: true,
    permissionMode: "full_access",
    modelSampler: samplerFor(steps, catalogs, contexts),
    contextLoader,
    webLoader,
    chatLoader,
    maxSteps: 8,
    ...extra,
  };
  const runtime = createAgentRuntime({ ports, defaultRunConfig, enableUserQuestions: true });
  const session = await runtime.sessions.create({ id: sessionId, productMode: "chat", chatRetrievalMode: mode });
  return { ports, runtime, session, catalogs, contexts, web, webLoader, contextLoader, chatLoader, workspaceSpy, defaultRunConfig };
}

/** 断言伪造请求没有执行展示、工具开始或审批，稳定错误仍可由宿主消费。 */
function expectRejected(events: AgentLoopEvent[], code: string): void {
  /** 检查被拒绝调用没有工具开始、审批或用户问题事件。 */
  expect(events.some(function forbiddenEvent(event) { return event.type === "tool_started" || event.type === "approval_required" || event.type === "question_required"; })).toBe(false);
  /** 检查拒绝仍产生可消费的稳定错误码。 */
  expect(events.some(function failure(event) { return event.type === "tool_result" && event.result.status === "error" && event.result.error.code === code; })).toBe(true);
  expect(events.at(-1)?.type).toBe("turn_failed");
}

/** 集中验证 Session 产品身份、旧记录兼容与创建归属。 */
describe("Chat/Work Session identity", function identitySuite() {
  it.each([
    { productMode: "chat", chatRetrievalMode: "none", projectId: "workspace" },
    { productMode: "chat" },
    { productMode: "chat", chatRetrievalMode: "both" },
    { productMode: "work", chatRetrievalMode: "web", projectId: "workspace" },
    { productMode: "work" },
    { productMode: "invalid", projectId: "workspace" },
  /** 验证拒绝非法模式/归属组合 %j。 */
  ])("拒绝非法模式/归属组合 %j", async function invalidCombination(input) {
    const ports = createMemoryPorts();
    const runtime = createAgentRuntime({ ports });
    await expect(runtime.sessions.create(input as Parameters<typeof runtime.sessions.create>[0])).rejects.toMatchObject({ code: "SESSION_MODE_MISMATCH" });
    expect(await ports.sessionStore.list()).toEqual([]);
  });

  /** 验证创建、get、list 和 save 均不能通过对象别名修改产品身份。 */
  it("创建、get、list 和 save 均不能通过对象别名修改产品身份", async function immutableIdentity() {
    const { runtime, session } = await fixture("rag", []);
    await expect(runtime.sessions.save({ ...session, productMode: "work", chatRetrievalMode: undefined, projectId: "workspace" })).rejects.toMatchObject({ code: "SESSION_MODE_MISMATCH" });
    const fromGet = (await runtime.sessions.get(sessionId))!;
    Object.assign(fromGet, { chatRetrievalMode: "web" });
    await expect(runtime.sessions.save(fromGet)).rejects.toMatchObject({ code: "CHAT_RETRIEVAL_MODE_LOCKED" });
    const fromList = (await runtime.sessions.list())[0];
    Object.assign(fromList, { productMode: "work" });
    expect((await runtime.sessions.get(sessionId))?.productMode).toBe("chat");
    await expect(runtime.sessions.create({ id: sessionId, productMode: "chat", chatRetrievalMode: "none" })).rejects.toMatchObject({ code: "SESSION_MODE_MISMATCH" });
  });

  /** 验证旧无模式记录只按 Work 读取，不落盘迁移，也不能保存为 Chat。 */
  it("旧无模式记录只按 Work 读取，不落盘迁移，也不能保存为 Chat", async function legacyWork() {
    const ports = createMemoryPorts();
    const legacy: Session = { id: "legacy", status: "idle", persistenceMode: "durable", createdAt: now, updatedAt: now };
    await ports.sessionStore.save(legacy);
    const catalogs: string[][] = [];
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler: samplerFor([answer()], catalogs) } });
    await collect(runtime.turns.start({ sessionId: legacy.id, content: "你好" }));
    expect(catalogs[0]).toEqual(["edit_file", "glob_files", "grep_files", "read_file", "run_command", "todo_write", "write_file"]);
    expect((await ports.sessionStore.get(legacy.id))?.productMode).toBeUndefined();
    await expect(runtime.sessions.save({ ...legacy, productMode: "chat", chatRetrievalMode: "none" })).rejects.toMatchObject({ code: "SESSION_MODE_MISMATCH" });
  });

  /** 验证旧创建调用写入 Work 并复用 Host 工作区 Project，显式 Work 必须带归属。 */
  it("旧创建调用写入 Work 并复用 Host 工作区 Project，显式 Work 必须带归属", async function compatibleCreation() {
    const ports = createMemoryPorts();
    const runtime = createAgentRuntime({ ports });
    const one = await runtime.sessions.create({});
    const two = await runtime.sessions.create({});
    expect(one.productMode).toBe("work");
    expect(two.projectId).toBe(one.projectId);
    expect((await ports.projectStore.get(one.projectId!))?.workspaceRoot).toBe("/tmp/test-workspace");
  });
});

/** 集中验证精确工具目录及注册和执行两层拒绝。 */
describe("Chat 工具目录与双层拒绝", function ceilingSuite() {
  it.each([
    ["none", ["chat_attachment_read", "chat_vision_analyze"]],
    ["web", ["chat_attachment_read", "chat_vision_analyze", "web_fetch", "web_search"]],
    ["rag", ["chat_vision_analyze", "rag_search"]],
  /** 验证%s 只暴露精确矩阵且不读取工作区。 */
  ] as const)("%s 只暴露精确矩阵且不读取工作区", async function exactCatalog(mode, expected) {
    const f = await fixture(mode, [answer()]);
    await collect(f.runtime.turns.start({ sessionId, turnId, content: "请创建一段短文" }));
    expect(f.catalogs).toEqual([[...expected]]);
    expect(f.workspaceSpy).not.toHaveBeenCalled();
    expect(f.contextLoader).not.toHaveBeenCalled();
    expect(f.contexts.join()).not.toContain("WORKSPACE_CANARY");
    expect(f.contexts.join()).not.toContain("todo_write");
    expect(f.webLoader).toHaveBeenCalledTimes(mode === "web" ? 1 : 0);
    const view = await f.runtime.turns.getFrozenRunConfig({ sessionId, turnId });
    expect(view?.capabilityCeiling?.productMode).toBe("chat");
    expect(JSON.stringify(view)).not.toContain(documentRef);
    expect(JSON.stringify(view)).not.toContain("knowledgeSpaceId");
  });

  /** 验证无附件 none 精确为空，缺能力 web/rag 不添加替代工具。 */
  it("无附件 none 精确为空，缺能力 web/rag 不添加替代工具", async function absentCapabilities() {
    for (const mode of ["none", "web", "rag"] as const) {
      /** 模拟没有装配 Web 能力的宿主，禁止工具降级。 */
      const f = await fixture(mode, [answer()], {}, { webLoader: async function unavailable() { return undefined; } });
      await collect(f.runtime.turns.start({ sessionId, content: "你好" }));
      expect(f.catalogs).toEqual([[]]);
    }
  });

  /** 验证full_access 和伪造 body 不能放开 %s。 */
  it.each(["run_command", "read_file", "write_file", "edit_file", "glob_files", "grep_files", "vision_analyze", "database_search", "skill", "discover_skills", "mcp__fake", "start_background_job", "list_background_jobs", "read_background_job", "stop_background_job", "todo_write", "ask_user_question", "unknown_tool"])("full_access 和伪造 body 不能放开 %s", async function forgedCall(name) {
    const f = await fixture("none", [call(name, {})]);
    const events = await collect(f.runtime.turns.start({ sessionId, content: "执行", runConfig: { permissionMode: "full_access", toolAllowlist: [name], workspaceRoot: "/", workspaceTrusted: true, productMode: "work", web: f.web } as RunConfig }));
    expectRejected(events, "CHAT_TOOL_FORBIDDEN");
    expect(f.catalogs).toEqual([[]]);
  });

  /** 验证%s 越域调用 %s 默认拒绝。 */
  it.each([["rag", "web_search"], ["rag", "web_fetch"], ["web", "rag_search"], ["rag", "chat_attachment_read"]] as const)("%s 越域调用 %s 默认拒绝", async function crossRetrieval(mode, name) {
    const f = await fixture(mode, [call(name, { query: canary, attachmentRef: documentRef })]);
    const events = await collect(f.runtime.turns.start({ sessionId, content: "查询" }));
    expectRejected(events, "CHAT_TOOL_FORBIDDEN");
    expect(f.web.search.search).not.toHaveBeenCalled();
    expect(f.web.fetch.fetch).not.toHaveBeenCalled();
  });

  /** 验证绕过 Registry 条件注册后 Executor 仍在审批、handler 和审计开始前拒绝。 */
  it("绕过 Registry 条件注册后 Executor 仍在审批、handler 和审计开始前拒绝", async function executorDefense() {
    const registry = new ToolRegistry();
    /** 记录 handler 是否被越权调用触发。 */
    const execute = vi.fn(async function execute() { return {}; });
    /** 构造无副作用声明，证明伪造声明不能绕过产品上限。 */
    const facts = vi.fn(function facts() { return { toolName: "run_command", effect: "none" as const, destructive: false, operation: "test" }; });
    registry.register({ name: "run_command", description: "fixture", inputSchema: z.object({}), metadata: { effect: "none", destructive: false, concurrency: { max: 1 }, retry: { safe: false } }, createActionFacts: facts, execute, serializeOutput: Object });
    const onToolEvent = vi.fn();
    /** 提供空检索端口并保留审计 spy，验证 Executor 独立防线。 */
    const executor = new ToolExecutor(registry, { permissionMode: "full_access", capabilityCeiling: { productMode: "chat", chatRetrievalMode: "none", allowedTools: ["run_command"] }, agentFlow: { search: async function search() { return []; } }, onToolEvent });
    expect(await executor.execute({ callId: "forged", toolName: "run_command", input: {} })).toMatchObject({ status: "error", error: { code: "CHAT_TOOL_FORBIDDEN" } });
    expect(execute).not.toHaveBeenCalled();
    expect(facts).not.toHaveBeenCalled();
    /** 验证执行层拒绝发生在底层工具开始事件之前。 */
    expect(onToolEvent.mock.calls.some(function started([event]) { return event.type === "tool_start"; })).toBe(false);
  });

  /** 验证Work 不可见且不可执行 %s。 */
  it.each(["chat_attachment_read", "chat_vision_analyze"])("Work 不可见且不可执行 %s", async function workCannotUseChat(name) {
    const ports = createMemoryPorts();
    const catalogs: string[][] = [];
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler: samplerFor([call(name, { attachmentRef: imageRef, prompt: "看图" })], catalogs), permissionMode: "full_access" } });
    const session = await runtime.sessions.create({});
    const events = await collect(runtime.turns.start({ sessionId: session.id, content: "查询" }));
    expect(catalogs[0]).not.toContain(name);
    expectRejected(events, "CHAT_TOOL_FORBIDDEN");
  });

  /** 验证Chat 的 Search/Fetch 可执行且没有审批。 */
  it("Chat 的 Search/Fetch 可执行且没有审批", async function webReadOnly() {
    const f = await fixture("web", [call("web_search", { query: "public" }), call("web_fetch", { url: "https://example.com/" }, "call-2"), answer()]);
    const events = await collect(f.runtime.turns.start({ sessionId, content: "联网" }));
    expect(events.at(-1)?.type).toBe("turn_completed");
    /** 验证 Chat 的成功 Web 读取也不进入审批。 */
    expect(events.some(function approval(event) { return event.type === "approval_required"; })).toBe(false);
    expect(f.web.search.search).toHaveBeenCalledTimes(1);
    expect(f.web.fetch.fetch).toHaveBeenCalledTimes(1);
  });
});

/** 集中验证不透明引用的身份、有效期及字节边界。 */
describe("Chat opaque 引用", function refSuite() {
  /** 首次采样必须收到有效附件目录，不能要求用户提供内部引用或暴露宿主路径。 */
  it.each(["none", "web"] as const)("%s 首次采样提供当前附件目录，不注入跨会话或过期附件", async function attachmentCatalog(mode) {
    const capability = chatCapability();
    Object.assign(capability, { attachments: [
      { ...capability.attachments![0], displayName: "C:\\private\\note.txt", storagePath: "HOST_PATH_CANARY" },
      capability.attachments![1],
      { ref: "expired_attachment_001", kind: "document", sessionId, expiresAt: now },
      { ref: "foreign_attachment_001", kind: "image", sessionId: "foreign", expiresAt: now + 100_000 },
    ] });
    const f = await fixture(mode, [answer()], capability);
    await collect(f.runtime.turns.start({ sessionId, turnId, content: "看附件" }));
    expect(f.contexts[0]).toContain(documentRef);
    expect(f.contexts[0]).toContain(imageRef);
    expect(f.contexts[0]).toContain("note.txt");
    for (const forbidden of ["C:\\private", "HOST_PATH_CANARY", "expired_attachment_001", "foreign_attachment_001"]) expect(f.contexts[0]).not.toContain(forbidden);
    expect(capability.readAttachment).not.toHaveBeenCalled();
  });

  /** 验证合法附件与视觉按绑定身份调用，没有审批、路径、data URL 或向量写入端口。 */
  it("合法附件与视觉按绑定身份调用，没有审批、路径、data URL 或向量写入端口", async function validRefs() {
    const capability = chatCapability();
    const f = await fixture("none", [call("chat_attachment_read", { attachmentRef: documentRef }), call("chat_vision_analyze", { attachmentRef: imageRef, prompt: "看图" }, "call-2"), answer()], capability);
    const events = await collect(f.runtime.turns.start({ sessionId, turnId, content: "看附件" }));
    expect(events.at(-1)?.type).toBe("turn_completed");
    /** 核对文档读取与图片分析均成功完成。 */
    expect(events.filter(function success(event) { return event.type === "tool_result" && event.result.status === "success"; })).toHaveLength(2);
    expect(capability.readAttachment).toHaveBeenCalledWith(expect.objectContaining({ sessionId, turnId, retrievalMode: "none", attachmentRef: documentRef }));
    expect(capability.knowledge?.prepareSearch).not.toHaveBeenCalled();
    /** 核对合法引用读取无需审批。 */
    expect(events.some(function approval(event) { return event.type === "approval_required"; })).toBe(false);
    expect(JSON.stringify(events)).not.toContain("data:image");
    expect(JSON.stringify(events)).not.toContain("WORKSPACE_CANARY");
  });

  it.each([
    { path: "/tmp/private.png", prompt: "看图" },
    { attachmentRef: "https://example.com/image.png", prompt: "看图" },
    { attachmentRef: "data:image/png;base64,eA==", prompt: "看图" },
    { attachmentRef: imageRef, visualEvidenceRef: evidenceRef, prompt: "看图" },
    { attachmentRef: imageRef, path: "../private", prompt: "看图" },
  /** 验证Schema 在任何执行事件前拒绝 %j。 */
  ])("Schema 在任何执行事件前拒绝 %j", async function invalidSchema(input) {
    const capability = chatCapability();
    const f = await fixture("none", [call("chat_vision_analyze", input)], capability);
    expectRejected(await collect(f.runtime.turns.start({ sessionId, content: "看图" })), "INVALID_INPUT");
    expect(capability.readImage).not.toHaveBeenCalled();
  });

  /** 验证非当前附件 ref %s 不会访问 Host 字节。 */
  it.each(["forged_reference_001", evidenceRef])("非当前附件 ref %s 不会访问 Host 字节", async function forgedRef(ref) {
    const capability = chatCapability();
    const f = await fixture("none", [call("chat_vision_analyze", { attachmentRef: ref, prompt: "看图" })], capability);
    expectRejected(await collect(f.runtime.turns.start({ sessionId, content: "看图" })), "CHAT_ATTACHMENT_UNAVAILABLE");
    expect(capability.authorizeRef).not.toHaveBeenCalled();
    expect(capability.readImage).not.toHaveBeenCalled();
  });

  /** 验证跨 Session、刚过期及宿主已撤销授权均不读取字节。 */
  it("跨 Session、刚过期及宿主已撤销授权均不读取字节", async function staleGrants() {
    for (const reason of ["cross-session", "expired", "revoked"]) {
      const capability = chatCapability();
      if (reason === "cross-session") capability.attachments![1].sessionId = "another-session";
      if (reason === "expired") capability.attachments![1].expiresAt = now;
      /** 模拟宿主撤销当前引用，禁止访问图片字节。 */
      if (reason === "revoked") capability.authorizeRef = vi.fn(async function revoked() { return false; });
      const f = await fixture("none", [call("chat_vision_analyze", { attachmentRef: imageRef, prompt: "看图" })], capability);
      expectRejected(await collect(f.runtime.turns.start({ sessionId, content: "看图" })), "CHAT_ATTACHMENT_UNAVAILABLE");
      expect(capability.readImage).not.toHaveBeenCalled();
    }
  });

  /** 验证仅文档时视觉不可见，读取产生合法页图 ref 后才出现。 */
  it("仅文档时视觉不可见，读取产生合法页图 ref 后才出现", async function renderedPageVisibility() {
    const capability = chatCapability();
    Object.assign(capability, { attachments: [capability.attachments![0]] });
    /** 文档读取后签发不延长父附件有效期的当前页图。 */
    capability.readAttachment = vi.fn(async function read() { return { text: "扫描页", pageImages: [{ ref: imageRef, kind: "image" as const, sessionId, expiresAt: now + 50_000 }] }; });
    const f = await fixture("none", [call("chat_attachment_read", { attachmentRef: documentRef }), call("chat_vision_analyze", { attachmentRef: imageRef, prompt: "看图" }, "call-2"), answer()], capability);
    const events = await collect(f.runtime.turns.start({ sessionId, content: "看文件" }));
    expect(f.catalogs[0]).toEqual(["chat_attachment_read"]);
    expect(f.catalogs[1]).toEqual(["chat_attachment_read", "chat_vision_analyze"]);
    expect(events.at(-1)?.type).toBe("turn_completed");
  });

  /** 验证伪 MIME、超限图片及 Provider 私有错误不外泄。 */
  it("伪 MIME、超限图片及 Provider 私有错误不外泄", async function unsafeImages() {
    for (const reason of ["mime", "size", "provider"]) {
      const capability = chatCapability();
      /** 伪造 PNG 类型但返回不匹配字节，验证签名检查。 */
      if (reason === "mime") capability.readImage = vi.fn(async function read() { return { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }; });
      /** 返回超过单图上限的字节，验证硬预算。 */
      if (reason === "size") capability.readImage = vi.fn(async function read() { return { bytes: new Uint8Array(5 * 1024 * 1024 + 1), mimeType: "image/png" }; });
      /** 模拟携带私有信息的 Provider 异常，验证安全错误投影。 */
      if (reason === "provider") capability.visionAnalyzer!.analyze = vi.fn(async function fail() { throw new Error("PRIVATE_PROVIDER_KEY_PATH"); });
      const f = await fixture("none", [call("chat_vision_analyze", { attachmentRef: imageRef, prompt: "看图" }), answer()], capability);
      const events = await collect(f.runtime.turns.start({ sessionId, content: "看图" }));
      /** 核对所有图片失败只返回稳定不可用错误。 */
      expect(events.some(function failed(event) { return event.type === "tool_result" && event.result.status === "error" && event.result.error.code === "CHAT_ATTACHMENT_UNAVAILABLE"; })).toBe(true);
      expect(JSON.stringify(events)).not.toContain("PRIVATE_PROVIDER_KEY_PATH");
      if (reason !== "provider") expect(capability.visionAnalyzer!.analyze).not.toHaveBeenCalled();
    }
  });
});

/** 集中验证 RAG 证据门、恢复快照与宿主能力边界。 */
describe("Chat RAG 事实与恢复边界", function ragAndRecoverySuite() {
  /** 验证%s 证据不足时零事实 delta、零 Web 调用。 */
  it.each(["no-search", "empty", "low", "wrong-session", "stale", "provider"])("%s 证据不足时零事实 delta、零 Web 调用", async function insufficientEvidence(reason) {
    const capability = chatCapability();
    const originalSearch = capability.knowledge!.prepareSearch;
    /** 按用例构造空、低质量、错归属或异常检索结果。 */
    capability.knowledge!.prepareSearch = vi.fn(async function search(binding) {
      if (reason === "provider") throw new Error("PRIVATE_PROVIDER_CANARY");
      const batch = await originalSearch(binding);
      if (reason === "empty") batch.evidence = [];
      /** 保持证据文本但撤销充分性标记，禁止模型自行认定证据。 */
      if (reason === "low") batch.evidence = batch.evidence.map(function low(item) { return { ...item, sufficient: false }; });
      if (reason === "wrong-session") batch.sessionId = "another-session";
      return batch;
    });
    /** 模拟资源已经失效，令批次复查拒绝。 */
    if (reason === "stale") capability.knowledge!.validateEvidence = vi.fn(async function stale() { return false; });
    const invented = "模型预训练常识：UNSUPPORTED_FACT_999";
    const steps = [...(reason === "no-search" ? [] : [call("rag_search", { query: canary })]), { ...answer(invented), reasoningSummary: invented, reasoningContent: invented }];
    const f = await fixture("rag", steps, capability);
    const events = await collect(f.runtime.turns.start({ sessionId, turnId, content: "知识问题" }));
    /** 合并实际正文事件，检查不足回答前没有事实泄漏。 */
    const deltas = events.flatMap(function delta(event) { return event.type === "answer_delta" ? [event.delta] : []; }).join("");
    expect(deltas).toBe(CHAT_RAG_INSUFFICIENT_MESSAGE);
    expect(JSON.stringify(events)).not.toContain("UNSUPPORTED_FACT_999");
    expect(JSON.stringify(await f.ports.checkpointStore.getLatest(sessionId))).not.toContain("UNSUPPORTED_FACT_999");
    expect(JSON.stringify(await f.ports.transcriptStore.getEvents(sessionId))).not.toContain("PRIVATE_PROVIDER_CANARY");
    expect(f.webLoader).not.toHaveBeenCalled();
  });

  /** 引用校验失败只允许一次格式/摘录纠正，不展示或持久化被拒绝的事实。 */
  it("RAG 引用不匹配可纠正一次，只有正确的连续原文进入结果", async function correctQuoteOnce() {
    const invalid = JSON.stringify({ quotes: [{ evidenceId, quote: "编造事实 999" }] });
    const valid = JSON.stringify({ quotes: [{ evidenceId, quote: canary }] });
    const f = await fixture("rag", [call("rag_search", { query: canary }), answer(invalid), answer(valid)]);
    const events = await collect(f.runtime.turns.start({ sessionId, turnId, content: "知识问题" }));
    expect(f.contexts).toHaveLength(3);
    expect(f.contexts[2]).toContain("RAG 引用纠正");
    const deltas = events.flatMap(function delta(event) { return event.type === "answer_delta" ? [event.delta] : []; }).join("");
    expect(deltas).toContain(canary);
    expect(JSON.stringify(events)).not.toContain("编造事实 999");
    expect(JSON.stringify(await f.ports.checkpointStore.getLatest(sessionId))).not.toContain("编造事实 999");
  });

  /** 普通回答没有机器协议保证，必须进入仅允许答案提交的收尾阶段。 */
  it("结构化收尾：普通文字转强制提交且不泄漏，成功不重复检索", async function finalizePlainText() {
    const f = await fixture("rag", [call("rag_search", { query: canary }), answer("UNVALIDATED_PROSE"), answer(JSON.stringify({ quotes: [{ evidenceId, quote: canary }] }))]);
    const sample = vi.spyOn(f.defaultRunConfig.modelSampler!, "sample");
    const events = await collect(f.runtime.turns.start({ sessionId, turnId, content: "知识问题" }));
    expect(sample).toHaveBeenCalledTimes(3);
    expect(sample.mock.calls[2][1].map(function name(tool) { return tool.function.name; })).toEqual(["chat_submit_answer"]);
    expect(sample.mock.calls[2][2].toolChoice).toEqual({ name: "chat_submit_answer" });
    expect(f.chatLoader.mock.results).toHaveLength(1);
    expect(events.filter(function started(event) { return event.type === "tool_started"; })).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("UNVALIDATED_PROSE");
    expect(JSON.stringify(await f.ports.checkpointStore.getLatest(sessionId))).not.toContain("UNVALIDATED_PROSE");
    expect(events.filter(function delta(event) { return event.type === "answer_delta"; })).toMatchObject([{ delta: `${canary} [1]\n\n来源：\n\n[1] 私有资料` }]);
  });

  /** 每轮拥有自己的纠正预算，历史纠正指令不会污染本轮采样。 */
  it("结构化收尾：上一轮已纠正，下一轮仍可纠正一次", async function correctAcrossTurns() {
    const invalid = answer(JSON.stringify({ quotes: [{ evidenceId, quote: "WRONG_QUOTE" }] }));
    const valid = answer(JSON.stringify({ quotes: [{ evidenceId, quote: canary }] }));
    const f = await fixture("rag", [call("rag_search", { query: canary }), invalid, valid, call("rag_search", { query: canary }, "search-2"), invalid, valid]);
    await collect(f.runtime.turns.start({ sessionId, turnId, content: "第一问" }));
    const events = await collect(f.runtime.turns.start({ sessionId, turnId: "chat-turn-2", content: "第二问" }));
    expect(f.contexts).toHaveLength(6);
    expect(f.contexts[3]).not.toContain(`【RAG 本轮纠正 ${turnId}】`);
    expect(f.contexts[5]).toContain("【RAG 本轮纠正 chat-turn-2】");
    expect(events.filter(function delta(event) { return event.type === "answer_delta"; })).toMatchObject([{ delta: `${canary} [1]\n\n来源：\n\n[1] 私有资料` }]);
  });

  /** 重建 Runtime 时证据必须重新检索，但本轮已用的纠正预算仍保留。 */
  it("结构化收尾：恢复同一轮不重新获得已消耗的纠正预算", async function preserveCorrectionOnResume() {
    const invalid = answer(JSON.stringify({ quotes: [{ evidenceId, quote: "WRONG_QUOTE" }] }));
    const f = await fixture("rag", [call("rag_search", { query: canary }), invalid], chatCapability(), { maxSteps: 2 });
    await collect(f.runtime.turns.start({ sessionId, turnId, content: "知识问题" }));
    const contexts: string[] = [];
    const resumed = createAgentRuntime({ ports: f.ports, defaultRunConfig: { ...f.defaultRunConfig, modelSampler: samplerFor([call("rag_search", { query: canary }, "search-after-resume"), invalid], [], contexts) } });
    const events = await collect(resumed.turns.continue({ sessionId, turnId }));
    expect(contexts).toHaveLength(2);
    expect(events.filter(function delta(event) { return event.type === "answer_delta"; })).toMatchObject([{ delta: CHAT_RAG_ANSWER_FAILED_MESSAGE }]);
  });

  /** 提交与其他调用混合时整批不执行；重试耗尽准确区分于缺证据。 */
  it("结构化收尾：混合调用被拦截，连续非法提交返回整理失败", async function rejectMixedSubmission() {
    const capability = chatCapability();
    const mixed = { ...answer(""), toolCalls: [...call("chat_submit_answer", { quotes: [{ evidenceId, quote: canary }] }).toolCalls, ...call("rag_search", { query: "MUST_NOT_EXECUTE" }, "forbidden-second-search").toolCalls] };
    const f = await fixture("rag", [call("rag_search", { query: canary }), mixed, call("chat_submit_answer", { quotes: [], extra: "PRIVATE_BAD_PAYLOAD" })], capability);
    const events = await collect(f.runtime.turns.start({ sessionId, turnId, content: "知识问题" }));
    expect(capability.knowledge!.prepareSearch).toHaveBeenCalledTimes(1);
    expect(f.contexts).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_BAD_PAYLOAD");
    expect(events.filter(function delta(event) { return event.type === "answer_delta"; })).toMatchObject([{ delta: CHAT_RAG_ANSWER_FAILED_MESSAGE }]);
  });

  /** 模型可明确提交证据不足，不能同时夹带答案。 */
  it("结构化收尾：Provider 忽略强制选择时有界失败且不展示自由正文", async function rejectNoncompliantProvider() {
    const f = await fixture("rag", [call("rag_search", { query: canary }), answer("UNVERIFIED_A"), answer("UNVERIFIED_B"), answer("UNVERIFIED_C")]);
    const events = await collect(f.runtime.turns.start({ sessionId, turnId, content: "知识问题" }));
    expect(f.contexts).toHaveLength(4);
    expect(JSON.stringify(events)).not.toContain("UNVERIFIED_");
    expect(events.filter(function delta(event) { return event.type === "answer_delta"; })).toMatchObject([{ delta: CHAT_RAG_ANSWER_FAILED_MESSAGE }]);
  });

  /** 模型可明确提交证据不足，不能同时夹带答案。 */
  it("结构化收尾：明确不足与非法结构的终态不同", async function explicitInsufficiency() {
    const f = await fixture("rag", [call("rag_search", { query: canary }), call("chat_submit_answer", { insufficient: true })]);
    const events = await collect(f.runtime.turns.start({ sessionId, turnId, content: "资料没有涵盖的细节" }));
    expect(f.contexts).toHaveLength(2);
    expect(events.filter(function delta(event) { return event.type === "answer_delta"; })).toMatchObject([{ delta: CHAT_RAG_INSUFFICIENT_MESSAGE }]);
  });

  /** 验证有引用也必须验证摘录内容：valid=%s。 */
  it.each([true, false])("有引用也必须验证摘录内容：valid=%s", async function groundedQuotes(valid) {
    const final = JSON.stringify({ quotes: [{ evidenceId, quote: valid ? canary : "编造事实 999" }] });
    const f = await fixture("rag", [call("rag_search", { query: canary }), answer(final)]);
    const events = await collect(f.runtime.turns.start({ sessionId, turnId, content: "知识问题" }));
    /** 合并实际正文事件，核对摘录或稳定拒答。 */
    const deltas = events.flatMap(function delta(event) { return event.type === "answer_delta" ? [event.delta] : []; }).join("");
    expect(deltas).toBe(valid ? `${canary} [1]\n\n来源：\n\n[1] 私有资料` : CHAT_RAG_ANSWER_FAILED_MESSAGE);
    expect(JSON.stringify(events)).not.toContain('"quotes"');
  });

  /** 验证来源由宿主提供，编号复用且内部标识不进入最终正文。 */
  it("RAG 使用可读来源编号并转义文件名，不展示内部证据 ID", async function readableSources() {
    const capability = chatCapability();
    const prepareSearch = capability.knowledge!.prepareSearch;
    capability.knowledge!.prepareSearch = async function search(binding) {
      const batch = await prepareSearch(binding);
      return { ...batch, evidence: batch.evidence.map(function source(item) { return { ...item, sourceLabel: "测试[资料].pdf · 第 2 页" }; }) };
    };
    const final = JSON.stringify({ quotes: [{ evidenceId, quote: canary }, { evidenceId, quote: canary }] });
    const f = await fixture("rag", [call("rag_search", { query: canary }), answer(final)], capability);
    const events = await collect(f.runtime.turns.start({ sessionId, turnId, content: "知识问题" }));
    const deltas = events.flatMap(function delta(event) { return event.type === "answer_delta" ? [event.delta] : []; }).join("");
    expect(deltas).toBe(`${canary} [1]\n\n${canary} [1]\n\n来源：\n\n[1] 测试\\[资料\\].pdf · 第 2 页`);
    expect(deltas).not.toContain(evidenceId);
    expect(deltas).not.toContain("knowledge_batch_001");
  });

  /** 媒体来源只由受信批次投影，公网地址不能成为图片来源。 */
  it("连续检索仅向下一次采样提供最新证据，旧引用仍不可使用", async function latestEvidenceOnly() {
    for (const useLatest of [true, false]) {
      const capability = chatCapability();
      let index = 0;
      let current: ChatRagEvidenceBatch;
      capability.knowledge!.prepareSearch = async function search(binding) {
        index++;
        current = { sessionId: binding.sessionId, turnId: binding.turnId, knowledgeSpaceId: "chat-knowledge-space", batchId: `knowledge_batch_00${index}`, evidence: [{ id: `latest_evidence_00${index}`, text: canary, sufficient: true, visualEvidenceRef: `latest_visual_ref_00${index}` }] };
        return structuredClone(current);
      };
      capability.knowledge!.validateEvidence = async function validate(input) { return JSON.stringify(input.batch) === JSON.stringify(current); };
      const searches = { ...answer(""), toolCalls: [call("rag_search", { query: "first" }, "first-search").toolCalls[0], call("rag_search", { query: "second" }, "second-search").toolCalls[0]] };
      const f = await fixture("rag", [searches, answer(JSON.stringify({ quotes: [{ evidenceId: `latest_evidence_00${useLatest ? 2 : 1}`, quote: canary }] }))], capability);
      const events = await collect(f.runtime.turns.start({ sessionId, turnId, content: "自然问题" }));
      expect(f.contexts[1]).toContain("CHAT_EVIDENCE_SUPERSEDED");
      expect(f.contexts[1]).not.toContain("latest_evidence_001"); expect(f.contexts[1]).not.toContain("latest_visual_ref_001");
      expect(f.contexts[1]).toContain("latest_evidence_002");
      const text = events.flatMap(function delta(event) { return event.type === "answer_delta" ? [event.delta] : []; }).join("");
      expect(text).toContain(useLatest ? canary : CHAT_RAG_ANSWER_FAILED_MESSAGE);
    }
  });

  /** 视觉回答由当前观察与图片来源共同支撑，不要求主模型重新逐字复制。 */
  it.each(["valid", "unread", "stale", "no-image", "invented"])("视觉概括使用当前观察和来源图：%s", async function groundedVisualAnswer(reason) {
    const capability = chatCapability();
    const prepare = capability.knowledge!.prepareSearch;
    capability.knowledge!.prepareSearch = async function search(binding) {
      const batch = await prepare(binding);
      return { ...batch, evidence: batch.evidence.map(function source(item) { return { ...item, ...(reason === "no-image" ? {} : { sourceImageUrl: "/api/chat/knowledge/resource_0123456789abcdef0123456789abcdef/preview" }) }; }) };
    };
    const visual = { evidenceId, ...(reason === "invented" ? { answer: "UNSUPPORTED_VISUAL_FACT" } : {}) };
    const steps = [call("rag_search", { query: canary }), ...(reason === "unread" ? [] : [call("chat_vision_analyze", { visualEvidenceRef: evidenceRef, prompt: "简要回答图片中的内容" }, "vision")]), ...(reason === "stale" ? [call("rag_search", { query: "new" }, "new-search")] : []), answer(JSON.stringify({ visualAnswers: [visual] }))];
    const f = await fixture("rag", steps, capability);
    const events = await collect(f.runtime.turns.start({ sessionId, turnId, content: "图片大概是什么" }));
    const text = events.flatMap(function delta(event) { return event.type === "answer_delta" ? [event.delta] : []; }).join("");
    if (reason === "valid") {
      expect(text).toContain("图片文字：本地证据 [1]");
      expect(text).toContain("/preview)");
    } else expect(text).toBe(CHAT_RAG_ANSWER_FAILED_MESSAGE);
    expect(text).not.toContain("UNSUPPORTED_VISUAL_FACT");
    expect(f.webLoader).not.toHaveBeenCalled();
  });

  /** 同一引用重新分析后，采样视图与引用校验都只认最新观察。 */
  it("同一图片重复分析后隐藏旧观察，最新摘录可通过引用校验", async function latestVisualObservation() {
    const capability = chatCapability();
    let count = 0;
    capability.visionAnalyzer!.analyze = vi.fn(async function observe() { return ++count === 1 ? "旧图注 OLD_VISUAL_CANARY" : "最新图注 NEW_VISUAL_CANARY"; });
    const f = await fixture("rag", [call("rag_search", { query: canary }), call("chat_vision_analyze", { visualEvidenceRef: evidenceRef, prompt: "看图" }, "vision-1"), call("chat_vision_analyze", { visualEvidenceRef: evidenceRef, prompt: "核对" }, "vision-2"), answer(JSON.stringify({ quotes: [{ evidenceId, quote: "最新图注 NEW_VISUAL_CANARY" }] }))], capability);
    const events = await collect(f.runtime.turns.start({ sessionId, turnId, content: "图注是什么" }));
    expect(f.contexts[3]).toContain("CHAT_EVIDENCE_SUPERSEDED");
    expect(f.contexts[3]).not.toContain("OLD_VISUAL_CANARY");
    expect(f.contexts[3]).toContain("NEW_VISUAL_CANARY");
    expect(events.some(function grounded(event) { return event.type === "answer_delta" && event.delta.includes("最新图注 NEW_VISUAL_CANARY [1]"); })).toBe(true);
    expect(JSON.stringify(await f.ports.checkpointStore.getLatest(sessionId))).toContain("OLD_VISUAL_CANARY");
  });

  /** 媒体来源只由受信批次投影，公网地址不能成为图片来源。 */
  it("RAG 来源图片由受信批次提供，保持实际引用页并拒绝远程地址", async function sourceImages() {
    for (const sourceImageUrl of ["/api/chat/knowledge/resource_0123456789abcdef0123456789abcdef/preview/pages/2", "https://example.com/tracker.png"]) {
      const capability = chatCapability();
      const prepareSearch = capability.knowledge!.prepareSearch;
      capability.knowledge!.prepareSearch = async function search(binding) {
        const batch = await prepareSearch(binding);
        return { ...batch, evidence: batch.evidence.map(function source(item) { return { ...item, sourceLabel: "扫描件.pdf · 第 2 页", sourceImageUrl }; }) };
      };
      const f = await fixture("rag", [call("rag_search", { query: canary }), answer(JSON.stringify({ quotes: [{ evidenceId, quote: canary }] }))], capability);
      const events = await collect(f.runtime.turns.start({ sessionId, turnId, content: "知识图片" }));
      const text = events.flatMap(function delta(event) { return event.type === "answer_delta" ? [event.delta] : []; }).join("");
      if (sourceImageUrl.startsWith("/")) expect(text).toContain(`![扫描件.pdf · 第 2 页](${sourceImageUrl})`);
      else expect(text).not.toContain("![");
      expect(text).not.toContain(evidenceId);
    }
  });

  /** 验证 RAG 视觉 ref 必须由本轮检索产生，无审批分析后才可引用观察。 */
  it("RAG 视觉 ref 必须由本轮检索产生，无审批分析后才可引用观察", async function ragVisualEvidence() {
    const capability = chatCapability();
    const f = await fixture("rag", [call("rag_search", { query: canary }), call("chat_vision_analyze", { visualEvidenceRef: evidenceRef, prompt: "看图" }, "call-2"), answer(JSON.stringify({ quotes: [{ evidenceId, quote: "图片文字：本地证据" }] }))], capability);
    const events = await collect(f.runtime.turns.start({ sessionId, turnId, content: "知识图片" }));
    /** 验证 RAG 视觉分析无需审批。 */
    expect(events.some(function approval(event) { return event.type === "approval_required"; })).toBe(false);
    expect(capability.readImage).toHaveBeenCalledWith(expect.objectContaining({ sessionId, turnId, batchId: "knowledge_batch_001" }));
    /** 核对最终正文只包含取得的视觉观察与当前引用。 */
    expect(events.some(function grounded(event) { return event.type === "answer_delta" && event.delta === "图片文字：本地证据 [1]\n\n来源：\n\n[1] 私有资料"; })).toBe(true);
    const forged = await fixture("rag", [call("chat_vision_analyze", { visualEvidenceRef: evidenceRef, prompt: "看图" })], chatCapability());
    expectRejected(await collect(forged.runtime.turns.start({ sessionId, content: "伪造证据" })), "CHAT_ATTACHMENT_UNAVAILABLE");
  });

  /** 验证continue 重建 Runtime 不采用更宽能力或未冻结工具。 */
  it("continue 重建 Runtime 不采用更宽能力或未冻结工具", async function continuationCeiling() {
    const f = await fixture("web", [call("web_search", { query: "public" })], {}, { maxSteps: 1, toolAllowlist: ["web_search"] });
    await collect(f.runtime.turns.start({ sessionId, turnId, content: "查询" }));
    const original = structuredClone((await f.ports.turnStore.get(turnId))!.frozenRunConfig);
    const catalogs: string[][] = [];
    const resumed = createAgentRuntime({ ports: f.ports, defaultRunConfig: { ...f.defaultRunConfig, toolAllowlist: undefined, modelSampler: samplerFor([call("web_fetch", { url: "https://example.com/" }, "resume-fetch")], catalogs) } });
    const events = await collect(resumed.turns.continue({ sessionId, turnId, runConfig: { permissionMode: "full_access", toolAllowlist: ["web_search", "web_fetch", "run_command"] } }));
    expect(catalogs).toEqual([["web_search"]]);
    expectRejected(events, "CHAT_TOOL_FORBIDDEN");
    expect((await f.ports.turnStore.get(turnId))?.frozenRunConfig).toEqual(original);
    expect(f.web.fetch.fetch).not.toHaveBeenCalled();
  });

  /** 验证恢复 pending call 先校验产品权限，批准也不能执行命令。 */
  it("恢复 pending call 先校验产品权限，批准也不能执行命令", async function forgedPendingCall() {
    const f = await fixture("none", [call("chat_attachment_read", { attachmentRef: documentRef })], chatCapability(), { maxSteps: 1 });
    await collect(f.runtime.turns.start({ sessionId, turnId, content: "看附件" }));
    const checkpoint = (await f.ports.checkpointStore.getLatest(sessionId))!;
    checkpoint.status = "awaiting_approval";
    checkpoint.pendingCalls = [{ id: "forged-pending", name: "run_command", input: { command: "echo forbidden" } }];
    checkpoint.messages.push({ role: "assistant", content: [{ type: "tool-call", id: "forged-pending", name: "run_command", input: { command: "echo forbidden" } }] });
    await f.ports.checkpointStore.save(sessionId, checkpoint);
    const events = await collect(f.runtime.turns.continue({ sessionId, turnId, approval: { approvalId: "forged", decision: "allow" }, runConfig: { permissionMode: "full_access" } }));
    expectRejected(events, "CHAT_TOOL_FORBIDDEN");
  });

  /** 验证恢复时不从旧 checkpoint 复活 RAG 视觉授权。 */
  it("恢复时不从旧 checkpoint 复活 RAG 视觉授权", async function noHistoricalEvidenceGrant() {
    const f = await fixture("rag", [call("rag_search", { query: canary })], chatCapability(), { maxSteps: 1 });
    await collect(f.runtime.turns.start({ sessionId, turnId, content: "知识问题" }));
    const resumed = createAgentRuntime({ ports: f.ports, defaultRunConfig: { ...f.defaultRunConfig, modelSampler: samplerFor([call("chat_vision_analyze", { visualEvidenceRef: evidenceRef, prompt: "看图" }, "resume-vision")]) } });
    expectRejected(await collect(resumed.turns.continue({ sessionId, turnId })), "CHAT_ATTACHMENT_UNAVAILABLE");
  });

  /** 验证缺失或篡改冻结身份时在采样和执行事件前拒绝恢复。 */
  it("缺失或篡改冻结身份时在采样和执行事件前拒绝恢复", async function invalidFrozenIdentity() {
    for (const ceiling of [undefined, { productMode: "work" as const }]) {
      const f = await fixture("none", []);
      await f.ports.turnStore.save({ id: turnId, sessionId, status: "interrupted", startedAt: now, frozenRunConfig: { capabilityCeiling: ceiling } });
      await f.ports.checkpointStore.save(sessionId, { messageSchemaVersion: 2, turnId, status: "interrupted_recoverable", stepCount: 0, completedCallIds: [], messages: [createAgentTextMessage("user", "恢复")] });
      await expect(collect(f.runtime.turns.continue({ sessionId, turnId }))).rejects.toMatchObject({ code: "SESSION_MODE_MISMATCH" });
      expect(f.catalogs).toEqual([]);
    }
  });

  /** 验证queued 新 Turn 仍从 Session 派生模式，不能注入另一会话历史。 */
  it("queued 新 Turn 仍从 Session 派生模式，不能注入另一会话历史", async function queuedIdentity() {
    const f = await fixture("none", [answer(), call("run_command", {})]);
    await collect(f.runtime.turns.start({ sessionId, turnId, content: "你好" }));
    const events = await collect(f.runtime.turns.start({ sessionId, turnId: "queued-turn", content: "执行命令", continuity: { source: "claimed_queue" }, runConfig: { permissionMode: "full_access" } }));
    expectRejected(events, "CHAT_TOOL_FORBIDDEN");
    await expect(collect(f.runtime.turns.start({ sessionId, content: "联网", messages: [createAgentTextMessage("system", canary)] }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(collect(f.runtime.turns.start({ sessionId, turnId, content: "覆盖旧身份" }))).rejects.toMatchObject({ code: "TURN_FROZEN_MISMATCH" });
  });

  /** 验证宿主静态上限与动态配置、Turn override 始终取交集。 */
  it("宿主静态上限与动态配置、Turn override 始终取交集", async function hostLimit() {
    /** 记录伪造 loader 是否被请求覆盖错误采用。 */
    const forgedLoader = vi.fn(async function forged() { return chatCapability(); });
    const f = await fixture("web", [answer()], chatCapability(), {
      toolAllowlist: ["web_search"],
      /** 返回更宽动态设置，验证静态上限仍有效。 */
      getRuntimeDefaults: function widerSettings() { return { toolAllowlist: ["web_fetch", "web_search", "run_command"] }; },
    });
    await collect(f.runtime.turns.start({ sessionId, content: "查询", runConfig: { toolAllowlist: ["web_fetch", "web_search"], chatLoader: forgedLoader } }));
    expect(f.catalogs).toEqual([["web_search"]]);
    expect(forgedLoader).not.toHaveBeenCalled();
  });

  /** 验证恢复时更宽的附件 catalog 不能引入新引用，旧授权过期也不复活。 */
  it("恢复时更宽的附件 catalog 不能引入新引用，旧授权过期也不复活", async function frozenAttachments() {
    const capability = chatCapability();
    const f = await fixture("none", [call("chat_attachment_read", { attachmentRef: documentRef })], capability, { maxSteps: 1 });
    await collect(f.runtime.turns.start({ sessionId, turnId, content: "附件" }));
    const newRef = "attachment_new_image_001";
    Object.assign(capability, { attachments: [...capability.attachments!, { ref: newRef, kind: "image", sessionId, expiresAt: now + 100_000 }] });
    const contexts: string[] = [];
    const resumed = createAgentRuntime({ ports: f.ports, defaultRunConfig: { ...f.defaultRunConfig, modelSampler: samplerFor([call("chat_vision_analyze", { attachmentRef: newRef, prompt: "看图" }, "new-image")], [], contexts) } });
    expectRejected(await collect(resumed.turns.continue({ sessionId, turnId })), "CHAT_ATTACHMENT_UNAVAILABLE");
    expect(contexts[0]).not.toContain(newRef);
    expect(capability.readImage).not.toHaveBeenCalled();
  });

  /** 验证视觉调用额度随 checkpoint 保留，重建 Runtime 不能重置。 */
  it("视觉调用额度随 checkpoint 保留，重建 Runtime 不能重置", async function durableVisionBudget() {
    const capability = chatCapability();
    /** 生成四次不同调用编号的图片请求，耗尽当前 Turn 额度。 */
    const steps = Array.from({ length: 4 }, function imageCall(_unused, index) { return call("chat_vision_analyze", { attachmentRef: imageRef, prompt: "看图" }, `image-${index}`); });
    const f = await fixture("none", steps, capability, { maxSteps: 4 });
    await collect(f.runtime.turns.start({ sessionId, turnId, content: "看图" }));
    expect(capability.readImage).toHaveBeenCalledTimes(4);
    expect((await f.ports.checkpointStore.getLatest(sessionId))?.chatBudget?.imageCalls).toBe(4);
    const resumed = createAgentRuntime({ ports: f.ports, defaultRunConfig: { ...f.defaultRunConfig, modelSampler: samplerFor([call("chat_vision_analyze", { attachmentRef: imageRef, prompt: "看图" }, "image-5")]) } });
    expectRejected(await collect(resumed.turns.continue({ sessionId, turnId })), "CHAT_ATTACHMENT_UNAVAILABLE");
    expect(capability.readImage).toHaveBeenCalledTimes(4);
  });

  /** 验证Host 忽略取消时 Core 仍终止等待，不发送图片或迟到正文。 */
  it("Host 忽略取消时 Core 仍终止等待，不发送图片或迟到正文", async function cancelledRead() {
    const controller = new AbortController();
    const capability = chatCapability();
    /** 模拟开始读取后不响应取消的错误宿主。 */
    capability.readImage = vi.fn(async function blockedRead() {
      controller.abort();
      /** 保持 Promise 未完成，验证 Core 自身取消边界。 */
      return new Promise<never>(function neverResolve() { /* 模拟忽略 signal 的错误只读端口。 */ });
    });
    const f = await fixture("none", [call("chat_vision_analyze", { attachmentRef: imageRef, prompt: "看图" }), answer("迟到正文")], capability);
    const events = await collect(f.runtime.turns.start({ sessionId, turnId, content: "看图", signal: controller.signal }));
    expect(events.at(-1)?.type).toBe("turn_interrupted");
    expect(capability.visionAnalyzer?.analyze).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain("迟到正文");
  });

  /** 验证引用在搜索成功后撤销，最终答复仍返回证据不足。 */
  it("引用在搜索成功后撤销，最终答复仍返回证据不足", async function revokedBeforeAnswer() {
    const capability = chatCapability();
    let validations = 0;
    /** 检索成功后撤销证据，验证最终答复再次复查。 */
    capability.knowledge!.validateEvidence = vi.fn(async function revokeAfterSearch() { return ++validations === 1; });
    const f = await fixture("rag", [call("rag_search", { query: canary }), answer(JSON.stringify({ quotes: [{ evidenceId, quote: canary }] }))], capability);
    const events = await collect(f.runtime.turns.start({ sessionId, content: "知识问题" }));
    /** 核对最终只有知识不足正文，不泄漏撤销证据。 */
    expect(events.filter(function final(event) { return event.type === "answer_delta"; })).toMatchObject([{ delta: CHAT_RAG_INSUFFICIENT_MESSAGE }]);
  });

  /** 验证宿主删除当前图片 grant 后，恢复不能仅靠冻结 ref 继续读取。 */
  it("宿主删除当前图片 grant 后，恢复不能仅靠冻结 ref 继续读取", async function revokedAttachmentCatalog() {
    const capability = chatCapability();
    const f = await fixture("none", [call("chat_attachment_read", { attachmentRef: documentRef })], capability, { maxSteps: 1 });
    await collect(f.runtime.turns.start({ sessionId, turnId, content: "附件" }));
    Object.assign(capability, { attachments: [capability.attachments![0]] });
    const resumed = createAgentRuntime({ ports: f.ports, defaultRunConfig: { ...f.defaultRunConfig, modelSampler: samplerFor([call("chat_vision_analyze", { attachmentRef: imageRef, prompt: "看图" }, "revoked-image")]) } });
    expectRejected(await collect(resumed.turns.continue({ sessionId, turnId })), "CHAT_ATTACHMENT_UNAVAILABLE");
    expect(capability.readImage).not.toHaveBeenCalled();
  });

  /** 验证引用授权端口不响应时有硬超时，禁止永久挂起或进入读取。 */
  it("引用授权端口不响应时有硬超时，禁止永久挂起或进入读取", async function authorizationTimeout() {
    vi.useFakeTimers();
    try {
      const capability = chatCapability();
      /** 模拟永久等待的授权查询，验证五秒硬超时。 */
      capability.authorizeRef = vi.fn(async function unresponsive() { return new Promise<never>(function pending() { /* 模拟卡住的 Host 授权查询。 */ }); });
      const f = await fixture("none", [call("chat_vision_analyze", { attachmentRef: imageRef, prompt: "看图" })], capability);
      const pending = collect(f.runtime.turns.start({ sessionId, turnId, content: "看图" }));
      await vi.advanceTimersByTimeAsync(5_001);
      expectRejected(await pending, "CHAT_ATTACHMENT_UNAVAILABLE");
      expect(capability.readImage).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  /** 验证Chat 手动压缩创建无工具 sampler 时也不触碰 Workspace RAG。 */
  it("Chat 手动压缩创建无工具 sampler 时也不触碰 Workspace RAG", async function compactionIsolation() {
    /** 若压缩链错误绑定工作区 RAG 则立即失败。 */
    const withRerankPolicy = vi.fn(function forbiddenRagBinding(): never { throw new Error("WORKSPACE_RAG_MUST_NOT_LOAD"); });
    const f = await fixture("none", [answer()], {}, {
      rag: {
        /** 返回空工作区检索结果，避免真实知识库依赖。 */
        search: async function search() { return []; },
        /** 提供空跨表结果，仅用于检测错误能力装配。 */
        searchAcrossTables: async function search() { return { results: [] }; },
        /** 提供空预检索结果，仅用于检测错误能力装配。 */
        prepareRagSearch: async function prepare() { return { results: [] }; },
        withRerankPolicy,
      },
    });
    await collect(f.runtime.turns.start({ sessionId, turnId, content: "你好" }));
    await f.runtime.turns.compact({ sessionId, turnId, trigger: "manual" });
    expect(withRerankPolicy).not.toHaveBeenCalled();
  });
});
