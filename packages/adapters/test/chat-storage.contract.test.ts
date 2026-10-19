/** Stage 2 定向存储契约：使用临时目录验证迁移、TTL、删除恢复和 User-only 装配，不调用真实 Provider。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRuntimeError, createAgentRuntime, type Session } from "@autopilot-agent/core";
import { NodeChatError, NodeStateError, CHAT_ATTACHMENT_TTL_MS, createNodeChatStorage, createNodeChatCapabilityLoader, createNodeCapabilityLoader, createNodeSettingsLoader, createNodeSessionStore, initializeNodeStateRoot, getNodeStateSchemaDiagnostic, NODE_CHAT_KNOWLEDGE_SPACE_ID, resolveNodeChatStatePaths, resolveNodeUserSettingsPath } from "../src/index";

const roots: string[] = [];
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);

/** 创建当前用例独占的临时全局根，真实 Home、Workspace 与配置不参与测试。 */
function temporary(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-stage2-")); roots.push(root); return root; }

/** 写入最小 JSON fixture，同时自动创建父目录。 */
function json(file: string, value: unknown): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }

/** 构造明确产品身份的 Session，所有时间只由测试时钟给出。 */
function session(id: string, mode: "none" | "web" | "rag" = "none"): Session { return { id, productMode: "chat", chatRetrievalMode: mode, status: "idle", persistenceMode: "durable", createdAt: 1, updatedAt: 1 }; }

/** 创建两个当前 Chat 会话与可推进时钟，复用同一组最小存储夹具。 */
async function fixture() {
  const root = temporary();
  let time = 1_000;
  /** 只读取测试变量，模拟跨重启保持一致的服务端时钟。 */
  function now(): number { return time; }
  const storage = createNodeChatStorage({ globalStateRoot: root, env: {}, now });
  await storage.ports.sessionStore.save(session("session-a"));
  await storage.ports.sessionStore.save(session("session-b", "rag"));
  /** 推进或乱序设置服务器时间，验证 TTL 不按目录顺序淘汰。 */
  function setTime(value: number): void { time = value; }
  return { root, storage, now, setTime };
}

/** 仅清理测试独占目录并恢复 spy，不删除或修改用户数据。 */
afterEach(function cleanup() { vi.restoreAllMocks(); vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

/** 验证固定根、产品域和 Core 装配均不借用 Workspace。 */
it("Chat 根与 Work 隔离，空 Chat 能运行且不初始化知识目录", async function isolatesStorage() {
  const f = await fixture();
  expect(f.storage.paths).toEqual(resolveNodeChatStatePaths({ globalStateRoot: f.root }));
  /** 拒绝相对全局根，避免启动目录改变存储身份。 */
  expect(() => resolveNodeChatStatePaths({ globalStateRoot: "relative" })).toThrow("CHAT_STATE_ROOT_INVALID");
  /** Chat 的全部工作区访问在适配端口即被拒绝。 */
  expect(() => f.storage.ports.workspaceAdapter.resolveWorkspaceRoot()).toThrow(expect.objectContaining({ name: "AgentRuntimeError", code: "WORKSPACE_REQUIRED" }));
  const work = createNodeSessionStore({ stateRoot: path.join(f.root, "workspaces", "work") });
  expect(await work.list()).toEqual([]);
  await expect(work.save(session("wrong-domain"))).rejects.toMatchObject({ name: "AgentRuntimeError", code: "SESSION_MODE_MISMATCH" });
  await expect(f.storage.ports.sessionStore.save({ ...session("session-a"), chatRetrievalMode: "web" })).rejects.toMatchObject({ name: "AgentRuntimeError", code: "CHAT_RETRIEVAL_MODE_LOCKED" });
  const runtime = createAgentRuntime({ ports: f.storage.ports, defaultRunConfig: { modelSampler: {
    /** 空 Chat 只接受空工具目录并返回固定答案，不读取任何外部环境。 */
    async sample(_messages, tools) { expect(tools).toEqual([]); return { content: "ok", reasoningSummary: "", toolCalls: [], finishReason: "stop" }; },
  } } });
  const events = [];
  for await (const event of runtime.turns.start({ sessionId: "session-a", content: "hello" })) events.push(event);
  expect(events.at(-1)?.type).toBe("turn_completed");
  expect(fs.existsSync(f.storage.paths.knowledgeRoot)).toBe(false);
});

/** 验证旧身份原子补写、备份保留原内容，以及两次 rename 之间退出后的恢复。 */
it("v4 迁移为 Work，保留历史及备份，并恢复中断切换", async function migratesLegacy() {
  const root = path.join(temporary(), "state");
  const legacy = { ...session("legacy"), productMode: undefined, chatRetrievalMode: undefined, projectId: "work-project" };
  json(path.join(root, "schema.json"), { schemaVersion: 4 });
  json(path.join(root, "sessions", "legacy.json"), legacy);
  json(path.join(root, "sessions", "unassigned.json"), { ...legacy, id: "unassigned", projectId: undefined });
  json(path.join(root, "projects", "work-project.json"), { id: "work-project", workspaceRoot: "/known-workspace" });
  json(path.join(root, "transcripts", "legacy.jsonl"), { privateHistory: "unchanged" });
  const knowledge = path.join(path.dirname(root), "legacy-knowledge", "resource.bin");
  json(knowledge, { privateResource: "stage7-knowledge-preserved" });
  json(path.join(root, "memory", "legacy.json"), { privateMemory: "stage7-memory-preserved" });
  const knowledgeBytes = fs.readFileSync(knowledge);
  const memoryBytes = fs.readFileSync(path.join(root, "memory", "legacy.json"));
  const history = fs.readFileSync(path.join(root, "transcripts", "legacy.jsonl"));
  fs.cpSync(root, `${root}.schema-staging`, { recursive: true });
  fs.renameSync(root, `${root}.schema-original`);
  initializeNodeStateRoot(root);
  expect(JSON.parse(fs.readFileSync(path.join(root, "schema.json"), "utf8")).schemaVersion).toBe(6);
  expect(await createNodeSessionStore({ stateRoot: root }).get("legacy")).toMatchObject({ productMode: "work", projectId: "work-project" });
  expect(await createNodeSessionStore({ stateRoot: root }).get("unassigned")).toMatchObject({ productMode: "work", projectId: "work-project" });
  expect(fs.readFileSync(path.join(root, "transcripts", "legacy.jsonl"))).toEqual(history);
  const backup = getNodeStateSchemaDiagnostic(root)!.backupPath;
  expect(JSON.parse(fs.readFileSync(path.join(backup, "sessions", "legacy.json"), "utf8"))).toEqual(legacy);
  expect(fs.existsSync(`${root}.schema-original`)).toBe(false);
  // 升级与再次启动保留旧资源；新 Chat 使用独立根，不继承旧 Work 会话、知识或 Memory。
  initializeNodeStateRoot(root);
  const chat = createNodeChatStorage({ globalStateRoot: path.dirname(root), env: {} });
  expect(await chat.ports.sessionStore.list()).toEqual([]);
  expect(fs.existsSync(chat.paths.knowledgeRoot)).toBe(false);
  expect(fs.existsSync(path.join(chat.paths.stateRoot, "memory"))).toBe(false);
  expect(fs.readFileSync(knowledge)).toEqual(knowledgeBytes);
  expect(fs.readFileSync(path.join(root, "memory", "legacy.json"))).toEqual(memoryBytes);
  expect(fs.readFileSync(path.join(root, "transcripts", "legacy.jsonl"))).toEqual(history);
});

/** 损坏记录与链接都必须使迁移失败，不能覆盖原文件或读取链接目标；Windows 创建目录 symlink 需要特权（EPERM），仅在非 Windows 运行。 */
it.skipIf(process.platform === "win32")("损坏与链接迁移失败保留原数据，当前 schema 的损坏 Session 也不静默消失", async function rejectsCorruption() {
  const root = path.join(temporary(), "state");
  json(path.join(root, "schema.json"), { schemaVersion: 4 });
  json(path.join(root, "sessions", "bad.json"), { broken: true });
  const original = fs.readFileSync(path.join(root, "sessions", "bad.json"));
  /** 失败不得用猜测值覆盖损坏旧记录。 */
  let migrationError: NodeStateError | undefined;
  try { initializeNodeStateRoot(root); } catch (error) { migrationError = error as NodeStateError; }
  expect(migrationError).toBeInstanceOf(NodeStateError);
  expect(migrationError).toMatchObject({ code: "STATE_SCHEMA_MIGRATION_FAILED", message: "STATE_SCHEMA_MIGRATION_FAILED" });
  const recovery = migrationError!.getRecoveryDiagnostic()!;
  expect(recovery).toMatchObject({ fromVersion: 4, toVersion: 6, reasonCode: "STATE_SESSION_CORRUPTED" });
  expect(fs.existsSync(recovery.backupPath!)).toBe(true);
  expect(JSON.stringify(migrationError)).not.toContain(root);
  expect(fs.readFileSync(path.join(root, "sessions", "bad.json"))).toEqual(original);
  json(path.join(root, "schema.json"), { schemaVersion: 6 });
  const store = createNodeSessionStore({ stateRoot: root });
  await expect(store.list()).rejects.toMatchObject({ name: "NodeStateError", code: "STATE_SESSION_CORRUPTED" });
  /** 读取失败不能误判为 JSON 记录损坏，也不能透传文件路径。 */
  const read = fs.readFileSync;
  const unreadable = fs.realpathSync(path.join(root, "sessions", "bad.json"));
  /** 使用 canonical 路径定点注入读取失败，其他 schema 文件仍正常读取。 */
  vi.spyOn(fs, "readFileSync").mockImplementation(function unavailableFile(file, options) {
    if (file === unreadable) throw new Error(root);
    return read(file, options);
  });
  await expect(store.get("bad")).rejects.toMatchObject({ code: "STATE_STORAGE_UNAVAILABLE", message: "STATE_STORAGE_UNAVAILABLE" });
  vi.mocked(fs.readFileSync).mockRestore();
  const global = temporary();
  fs.symlinkSync(root, path.join(global, "chat"), "dir");
  /** 独立 Chat 根也不能借链接映射到其他数据域。 */
  expect(() => createNodeChatStorage({ globalStateRoot: global, env: {} })).toThrow("STATE_STORAGE_UNSAFE_PATH");
  const linkedState = path.join(temporary(), "linked-state");
  json(path.join(linkedState, "schema.json"), { schemaVersion: 4 });
  fs.symlinkSync(path.join(root, "sessions"), path.join(linkedState, "sessions"), "dir");
  /** 迁移复制前先检查全部路径，不能通过 Session 目录链接越界。 */
  expect(() => initializeNodeStateRoot(linkedState)).toThrow("STATE_SCHEMA_UNSAFE_PATH");
  expect(fs.readFileSync(path.join(root, "sessions", "bad.json"))).toEqual(original);
});

/** 验证服务器类型识别、当前 Session 授权及缓存页图；用例尾部用文件 symlink 验证路径逃逸拒绝，Windows 创建 symlink 报 EPERM，仅在非 Windows 运行。 */
it.skipIf(process.platform === "win32")("临时文本和受控页图可读，跨会话、RAG 上传、路径与字节篡改被拒绝", async function readsOpaqueAttachments() {
  const f = await fixture();
  const text = await f.storage.attachments.put({ sessionId: "session-a", displayName: "C:\\private\\note.txt", bytes: Buffer.from("local text") });
  expect(text).toMatchObject({ displayName: "note.txt", mimeType: "text/plain", expiresAt: 1_000 + CHAT_ATTACHMENT_TTL_MS });
  expect(await f.storage.attachments.readAttachment("session-a", text.ref)).toEqual({ text: "local text", pageImages: [] });
  await expect(f.storage.attachments.put({ sessionId: "session-b", displayName: "image", bytes: png })).rejects.toMatchObject({ name: "NodeChatError", code: "CHAT_UPLOAD_MODE_MISMATCH" });
  await expect(f.storage.attachments.put({ sessionId: "session-a", displayName: "scan", bytes: Buffer.from("%PDF-fixture") })).rejects.toMatchObject({ name: "NodeChatError", code: "CHAT_ATTACHMENT_PARSER_UNAVAILABLE" });
  expect(await f.storage.attachments.authorizeRef("session-b", text.ref, "document")).toBe(false);
  await expect(f.storage.attachments.readBytes("session-a", "../note")).rejects.toMatchObject({ name: "NodeChatError", code: "CHAT_ATTACHMENT_UNAVAILABLE" });
  const target = path.join(f.storage.paths.attachmentsRoot, "sessions", "session-a", text.ref, "content");
  fs.writeFileSync(target, "changed");
  await expect(f.storage.attachments.readBytes("session-a", text.ref)).rejects.toMatchObject({ name: "NodeChatError", code: "CHAT_ATTACHMENT_UNAVAILABLE" });
  fs.unlinkSync(target);
  const outside = path.join(f.root, "outside.txt"); fs.writeFileSync(outside, "PRIVATE_OUTSIDE");
  fs.symlinkSync(outside, target, "file");
  await expect(f.storage.attachments.readBytes("session-a", text.ref)).rejects.toMatchObject({ name: "NodeStateError", code: "STATE_STORAGE_UNSAFE_PATH" });
  const storage = createNodeChatStorage({ globalStateRoot: f.root, env: {}, now: f.now,
    /** 用固定解析结果模拟既有 PDF 解析链，不接受文件路径或执行入库。 */
    async parseDocument() { return { text: "scanned page", pages: [png] }; },
  });
  const pdf = await storage.attachments.put({ sessionId: "session-a", displayName: "scan.pdf", bytes: Buffer.from("%PDF-fixture") });
  const parsed = await storage.attachments.readAttachment("session-a", pdf.ref);
  expect(await storage.attachments.authorizeRef("session-a", parsed.pageImages[0].ref, "image")).toBe(true);
  expect((await storage.attachments.readBytes("session-a", parsed.pageImages[0].ref)).bytes).toEqual(png);
});

/** 乱序时间、逐批清理、重启和取消共同验证固定 30 天生命周期。 */
it("TTL 只删除到期最早项，移除展示引用并保留正文，回滚状态也不复活字节", async function expiresOldest() {
  const f = await fixture();
  f.setTime(2_000);
  const newer = await f.storage.attachments.put({ sessionId: "session-a", displayName: "new", bytes: png });
  f.setTime(1_000);
  const older = await f.storage.attachments.put({ sessionId: "session-a", displayName: "old", bytes: png });
  const original = { ...session("session-a"), presentation: { messages: [{ id: "message", role: "user" as const, content: "保留正文", createdAt: 1, attachments: [{ id: older.ref, name: "old", mimeType: "image/png", relativePath: "opaque" }] }] } };
  await f.storage.ports.sessionStore.save(original);
  f.setTime(1_000 + CHAT_ATTACHMENT_TTL_MS);
  expect(await f.storage.attachments.cleanupExpired({ limit: 1 })).toEqual([older.ref]);
  expect((await f.storage.ports.sessionStore.get("session-a"))?.presentation?.messages[0]).toMatchObject({ content: "保留正文", attachments: [] });
  await f.storage.ports.sessionStore.save(original);
  expect((await f.storage.ports.sessionStore.get("session-a"))?.presentation?.messages[0].attachments).toEqual([]);
  const restarted = createNodeChatStorage({ globalStateRoot: f.root, env: {}, now: f.now });
  expect((await restarted.attachments.list("session-a")).map(
    /** 只比较仍可访问的引用，避免假定 UUID 或目录枚举顺序。 */
    function ref(item) { return item.ref; },
  )).toEqual([newer.ref]);
  f.setTime(2_000 + CHAT_ATTACHMENT_TTL_MS);
  const controller = new AbortController(); controller.abort();
  await expect(restarted.attachments.cleanupExpired({ signal: controller.signal })).rejects.toMatchObject({ name: "NodeChatError", code: "CHAT_ATTACHMENT_CANCELLED" });
  const stop = await restarted.attachments.startMaintenance(vi.fn()); stop();
  expect(await restarted.attachments.list("session-a")).toEqual([]);
});

/** 删除失败先关闭访问，重启后收敛临时数据，独立知识根不受级联影响。 */
it("会话删除失败可重试，阻止新增写入并保留独立知识", async function resumesDeletion() {
  const f = await fixture();
  const item = await f.storage.attachments.put({ sessionId: "session-a", displayName: "file", bytes: png });
  json(path.join(f.storage.paths.knowledgeRoot, "resource.json"), { independent: true });
  const remove = fs.rmSync;
  /** 模拟删字节时一次 I/O 失败，不能把成功响应建立在尽力清理上。 */
  vi.spyOn(fs, "rmSync").mockImplementationOnce(function failRemoval() { throw new Error("PRIVATE_IO_DETAIL"); });
  const runtime = createAgentRuntime({ ports: f.storage.ports });
  await expect(runtime.sessions.delete("session-a")).rejects.toMatchObject({ name: "NodeChatError", code: "CHAT_ATTACHMENT_CLEANUP_FAILED", message: "CHAT_ATTACHMENT_CLEANUP_FAILED" });
  vi.mocked(fs.rmSync).mockRestore();
  expect(fs.rmSync).toBe(remove);
  expect(f.storage.attachments.isSessionDeleting("session-a")).toBe(true);
  expect(await f.storage.attachments.authorizeRef("session-a", item.ref, "image")).toBe(false);
  await expect(f.storage.ports.sessionStore.save(session("session-a"))).rejects.toMatchObject({ name: "NodeChatError", code: "CHAT_SESSION_DELETING" });
  const restarted = createNodeChatStorage({ globalStateRoot: f.root, env: {}, now: f.now });
  await restarted.attachments.cleanupExpired();
  expect(await createAgentRuntime({ ports: restarted.ports }).sessions.delete("session-a")).toBe(true);
  expect(fs.existsSync(path.join(f.storage.paths.knowledgeRoot, "resource.json"))).toBe(true);
});

/** 两个 Store 实例复用同一锁，读取和清理没有半提交目录可见。 */
it("并发实例上传、读取与清理保持原子边界", async function serializesInstances() {
  const f = await fixture();
  const other = createNodeChatStorage({ globalStateRoot: f.root, env: {}, now: f.now });
  const [a, b] = await Promise.all([f.storage.attachments.put({ sessionId: "session-a", displayName: "a", bytes: png }), other.attachments.put({ sessionId: "session-a", displayName: "b", bytes: png }), other.attachments.cleanupExpired()]);
  expect(await f.storage.attachments.list("session-a")).toHaveLength(2);
  await Promise.all([other.attachments.readBytes("session-a", a.ref), f.storage.attachments.readBytes("session-a", b.ref), other.attachments.cleanupExpired()]);
  expect(fs.readdirSync(f.storage.paths.attachmentsRoot).some(
    /** 提交完成后不遗留 staging 目录。 */
    function staging(name) { return name.startsWith("staging-"); },
  )).toBe(false);
  let finish!: (value: { text: string }) => void;
  let started!: () => void;
  /** 等待解析真正开始，避免靠时间延迟制造竞态。 */
  const parsing = new Promise<void>(function waitForParsing(resolve) { started = resolve; });
  const slow = createNodeChatStorage({ globalStateRoot: f.root, env: {}, now: f.now,
    /** 阻塞在锁外解析阶段，验证删除不会被耗时解析阻塞。 */
    parseDocument() { started(); return new Promise(function waitForResult(resolve) { finish = resolve; }); },
  });
  const upload = slow.attachments.put({ sessionId: "session-a", displayName: "scan", bytes: Buffer.from("%PDF-fixture") });
  await parsing; await other.attachments.deleteBySession("session-a"); finish({ text: "late" });
  await expect(upload).rejects.toMatchObject({ name: "NodeChatError", code: "CHAT_ATTACHMENT_UNAVAILABLE" });
});

/** User-only 路径和 watcher 不涉及 cwd/Project，Web 与 RAG 在装配前互斥。 */
it("User-only 读取和重载不触碰项目配置，RAG 不加载 Web 设置或凭据", async function isolatesSettingsAndCapabilities() {
  const f = await fixture();
  const home = path.join(f.root, "home");
  const userFile = resolveNodeUserSettingsPath(home);
  json(userFile, { model: "user-model", availableModels: ["user-model", "next-model"] });
  expect(resolveNodeUserSettingsPath("C:\\Users\\tester", path.win32)).toBe("C:\\Users\\tester\\.autopilot\\settings.json");
  const loader = createNodeSettingsLoader({ homeDirectory: home, debounceMs: 1 });
  expect(loader.loadUser().paths).toEqual({ user: userFile });
  const callbacks: Array<(event: string, file: string) => void> = [];
  /** 记录监听目录并模拟事件，测试不依赖系统 watcher 配额。 */
  vi.spyOn(fs, "watch").mockImplementation(function watch(directory, callback) {
    expect([home, path.dirname(userFile)]).toContain(directory);
    callbacks.push(callback as (event: string, file: string) => void);
    return { close: vi.fn(), unref: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher;
  });
  vi.useFakeTimers();
  const reload = vi.fn(); const stop = loader.watchUser(reload);
  json(userFile, { model: "next-model", availableModels: ["next-model"] });
  callbacks[0]("rename", "settings.json"); await vi.advanceTimersByTimeAsync(2); stop();
  expect(reload.mock.calls[0][0].settings.modelRef.modelId).toBe("next-model");
  const userRead = vi.spyOn(loader, "loadUser"); const workRead = vi.spyOn(loader, "load");
  const web = createNodeCapabilityLoader({ settingsLoader: loader, env: {} });
  expect(await web.loadChatWeb({ sessionId: "session-b", turnId: "turn", retrievalMode: "rag" })).toBeUndefined();
  expect(userRead).not.toHaveBeenCalled(); expect(workRead).not.toHaveBeenCalled();
  expect((await web.loadChatWeb({ sessionId: "web-session", turnId: "turn", retrievalMode: "web" }))?.fetch).toBeDefined();
  expect(userRead).toHaveBeenCalledTimes(1); expect(workRead).not.toHaveBeenCalled();
  /** 只接收固定知识根并返回空能力，验证初始化身份而不运行检索链。 */
  const knowledge = vi.fn(async function loadKnowledge(input) { expect(input.knowledgeSpaceId).toBe(NODE_CHAT_KNOWLEDGE_SPACE_ID); expect(input.knowledgeRoot).toBe(f.storage.paths.knowledgeRoot); return {}; });
  const chat = createNodeChatCapabilityLoader({ storage: f.storage, loadKnowledge: knowledge });
  await chat({ sessionId: "session-a", turnId: "turn", retrievalMode: "none" });
  expect(knowledge).not.toHaveBeenCalled(); expect(fs.existsSync(f.storage.paths.knowledgeRoot)).toBe(false);
  await chat({ sessionId: "session-b", turnId: "turn", retrievalMode: "rag" });
  expect(knowledge).toHaveBeenCalledTimes(1);
});

/** 回归锁前初始化与可信错误识别，底层正文和伪造前缀不能越过 Adapter 边界。 */
it("公开边界使用明确错误码，未知错误和原生 I/O 不透传", async function normalizesBoundaryErrors() {
  const broken = createNodeChatStorage({ globalStateRoot: temporary(), env: {} });
  fs.writeFileSync(path.join(broken.paths.attachmentsRoot, "sessions"), "conflict");
  await expect(broken.attachments.list("session-a")).rejects.toMatchObject({ name: "NodeStateError", code: "STATE_STORAGE_UNAVAILABLE", message: "STATE_STORAGE_UNAVAILABLE" });
  await expect(broken.attachments.put({ sessionId: "session-a", displayName: "file", bytes: png })).rejects.toMatchObject({ code: "STATE_STORAGE_UNAVAILABLE" });
  const f = await fixture();
  /** 即使前缀像 Chat 错误，也不能成为可信错误码。 */
  await expect(f.storage.attachments.withActiveSession("session-a", async function forgedError() { throw new Error("CHAT_UNDECLARED_AUDIT_SENTINEL"); })).rejects.toMatchObject({ name: "NodeChatError", code: "CHAT_ATTACHMENT_UNAVAILABLE", message: "CHAT_ATTACHMENT_UNAVAILABLE" });
  /** 已声明的身份码使用 Core 类型，原始正文不能随错误透传。 */
  await expect(f.storage.attachments.withActiveSession("session-a", async function identityError() { throw new AgentRuntimeError("SESSION_MODE_MISMATCH", f.root); })).rejects.toMatchObject({ name: "AgentRuntimeError", code: "SESSION_MODE_MISMATCH", message: "Session 产品模式与归属不匹配" });
  const supplied = new NodeChatError("CHAT_ATTACHMENT_UNAVAILABLE"); supplied.message = f.root;
  /** 即使是正确类型，也重新生成固定文案。 */
  await expect(f.storage.attachments.withActiveSession("session-a", async function unsafeMessage() { throw supplied; })).rejects.toMatchObject({ message: "CHAT_ATTACHMENT_UNAVAILABLE" });
  const item = await f.storage.attachments.put({ sessionId: "session-a", displayName: "text", bytes: Buffer.from("local") });
  fs.writeFileSync(path.join(f.storage.paths.attachmentsRoot, "sessions", "session-a", item.ref, "metadata.json"), "{");
  /** 同步展示投影也覆盖 JSON 异常，避免绕过异步锁边界。 */
  expect(() => f.storage.attachments.sanitizeSession({ ...session("session-a"), presentation: { messages: [] } })).toThrow(expect.objectContaining({ code: "CHAT_ATTACHMENT_UNAVAILABLE", message: "CHAT_ATTACHMENT_UNAVAILABLE" }));
  const chat = createNodeChatCapabilityLoader({ storage: f.storage,
    /** 受信解析/检索插件的原始异常必须在装配边界收敛。 */
    async loadKnowledge() { throw new Error(f.root); },
  });
  await expect(chat({ sessionId: "session-b", turnId: "turn", retrievalMode: "rag" })).rejects.toMatchObject({ code: "CHAT_KNOWLEDGE_UNAVAILABLE", message: "CHAT_KNOWLEDGE_UNAVAILABLE" });
  /** 相对 Home 必须复用已导出的配置错误协议。 */
  expect(() => resolveNodeUserSettingsPath("relative")).toThrow(expect.objectContaining({ name: "UserConfigDirectoryError", code: "AUTOPILOT_HOME_UNRESOLVED" }));
});
