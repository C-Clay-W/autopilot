/** Chat 临时附件存储：服务端签发引用，原子保存字节/解析缓存，并以可恢复删除标记收敛固定 TTL。 */
import { NodeChatError, toNodeBoundaryError } from "../node-errors";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ChatAttachmentGrant, Session, SessionStore } from "@autopilot-agent/core";
import { atomicReplace, withFileLock } from "../file-utils";
import { assertSafeNodePath, ensureChatDirectory, type NodeChatStatePaths } from "../chat-state";

export const CHAT_ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_BYTES = 5 * 1024 * 1024;
const opaque = /^[A-Za-z0-9_-]{16,128}$/;

/** 可安全展示的附件元数据；不包含本机路径或客户端提供的时间。 */
export interface NodeChatAttachment extends ChatAttachmentGrant {
  displayName: string;
  mimeType: string;
  byteLength: number;
  createdAt: number;
  sha256: string;
  status: "active";
}

/** 非纯文本解析复用宿主现有解析链，只有字节输入和有界结果，不允许指定文件路径。 */
export interface NodeChatParsedDocument {
  text: string;
  pages?: readonly Uint8Array[];
}

/** Store 只接入当前 Chat SessionStore；解析函数属于受信应用能力，不是模型工具。 */
export interface NodeChatAttachmentStoreOptions {
  paths: NodeChatStatePaths;
  sessionStore: SessionStore;
  now?: () => number;
  parseDocument?: (input: { bytes: Uint8Array; mimeType: string; signal?: AbortSignal }) => Promise<NodeChatParsedDocument>;
}

interface AttachmentRecord extends NodeChatAttachment {
  pages: Array<{ ref: string; mimeType: string; byteLength: number; sha256: string }>;
}
interface Retirement {
  sessionId: string;
  ref: string;
  refs: string[];
}

/** 统一生成不包含文件名、引用或底层异常的稳定错误。 */
function unavailable(): never { throw new NodeChatError("CHAT_ATTACHMENT_UNAVAILABLE"); }

/** 校验会话文件键，同时拒绝 Windows 分隔符、设备名和冒号路径。 */
function sessionKey(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) unavailable();
  return id;
}

/** 计算实际字节摘要，用于读取时检测损坏或替换。 */
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** 根据字节识别受支持类型；二进制文档仍须由受信解析器成功解析才能保存。 */
function detectMime(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) {
    if (bytes.includes(Buffer.from("word/document.xml"))) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (bytes.includes(Buffer.from("xl/workbook.xml"))) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    unavailable();
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]))) return "application/vnd.ms-excel";
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) unavailable();
    return "text/plain";
  } catch { return unavailable(); }
}

/** 创建 Store；文件锁只覆盖短文件操作，耗时解析在锁外完成并在提交前重新验证身份。 */
export function createNodeChatAttachmentStore(options: NodeChatAttachmentStoreOptions) {
  const { paths, sessionStore } = options;
  const now = options.now ?? Date.now;
  const root = paths.attachmentsRoot;
  const dataRoot = path.join(root, "sessions");
  const retiredRoot = path.join(root, "retired");
  const deletingRoot = path.join(root, "deleting");
  const lock = path.join(root, "lifecycle");

  /** 初始化临时域专用目录，绝不创建知识根。 */
  function ensure(): void {
    assertSafeNodePath(path.dirname(paths.root), paths.root);
    for (const directory of [root, dataRoot, retiredRoot, deletingRoot]) ensureChatDirectory(paths.root, directory);
    assertSafeNodePath(root, `${lock}.lock`);
  }

  /** 检查取消后立即停止下一次文件操作。 */
  function checkSignal(signal?: AbortSignal): void {
    if (signal?.aborted) throw new NodeChatError("CHAT_ATTACHMENT_CANCELLED");
  }

  /** 同一临时域的读、提交、清理和会话写入共享跨进程锁。 */
  async function locked<T>(operation: () => Promise<T> | T, signal?: AbortSignal, fallback: "CHAT_ATTACHMENT_UNAVAILABLE" | "CHAT_ATTACHMENT_CLEANUP_FAILED" = "CHAT_ATTACHMENT_UNAVAILABLE"): Promise<T> {
    try {
      ensure();
      checkSignal(signal);
      /** 获取锁后再次检查取消与目录，防止等待期间路径被替换。 */
      return await withFileLock(lock, async function runLocked() {
        checkSignal(signal);
        ensure();
        return operation();
      });
    } catch (error) { throw toNodeBoundaryError(error, fallback); }
  }

  /** 删除态在独立临时域持久化，durable schema 回滚不会让引用重新可用。 */
  function isSessionDeleting(sessionId: string): boolean {
    try {
      const target = path.join(deletingRoot, `${sessionKey(sessionId)}.json`);
      assertSafeNodePath(root, target);
      return fs.existsSync(target);
    } catch (error) { throw toNodeBoundaryError(error, "CHAT_ATTACHMENT_UNAVAILABLE"); }
  }

  /** 会话和 Turn 写入与删除标记互斥，禁止删除期间创建新的运行记录。 */
  async function withActiveSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    /** 标记一旦存在便拒绝新增写入，删除流程仍可通过基础 Store 幂等收尾。 */
    return locked(async function writeActiveSession() {
      if (isSessionDeleting(sessionId)) throw new NodeChatError("CHAT_SESSION_DELETING");
      return operation();
    });
  }

  /** 只有持久化 none/web Chat 身份能访问临时域，客户端不能选择上传目的地。 */
  async function requireSession(sessionId: string): Promise<void> {
    if (isSessionDeleting(sessionId)) unavailable();
    const session = await sessionStore.get(sessionKey(sessionId));
    if (session?.productMode !== "chat" || !["none", "web"].includes(session.chatRetrievalMode ?? "")) throw new NodeChatError("CHAT_UPLOAD_MODE_MISMATCH");
  }

  /** 校验并读取原子元数据；过期项仍可供清理器排序，但永远不能用于读取字节。 */
  function records(sessionId: string): AttachmentRecord[] {
    const directory = path.join(dataRoot, sessionKey(sessionId));
    assertSafeNodePath(root, directory);
    if (!fs.existsSync(directory)) return [];
    const result: AttachmentRecord[] = [];
    for (const ref of fs.readdirSync(directory)) {
      if (!opaque.test(ref)) unavailable();
      const target = path.join(directory, ref, "metadata.json");
      assertSafeNodePath(root, target);
      if (!fs.statSync(target).isFile() || fs.statSync(target).size > 16_384) unavailable();
      const record = JSON.parse(fs.readFileSync(target, "utf8")) as AttachmentRecord;
      if (record.ref !== ref || record.sessionId !== sessionId || record.status !== "active" || !["image", "document"].includes(record.kind) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || record.expiresAt !== record.createdAt + CHAT_ATTACHMENT_TTL_MS || !Array.isArray(record.pages) || record.pages.length > 20) unavailable();
      for (const page of record.pages) if (!opaque.test(page.ref)) unavailable();
      result.push(record);
    }
    return result;
  }

  /** 转换为 Core 所需的最小授权字段，不包含展示名或存储元数据。 */
  function grant(record: ChatAttachmentGrant): ChatAttachmentGrant {
    return { ref: record.ref, sessionId: record.sessionId, kind: record.kind, expiresAt: record.expiresAt };
  }

  /** 检查删除日志和固定有效期，读取和列表使用同一存活标准。 */
  function active(record: AttachmentRecord): boolean {
    return record.expiresAt > now() && !isSessionDeleting(record.sessionId) && !fs.existsSync(path.join(retiredRoot, `${record.ref}.json`));
  }

  /** 读取或保存投影时移除已失效的附件，防止旧缓存写回而复活展示引用。 */
  function sanitizeSession(session: Session): Session {
    try {
      if (!session.presentation) return session;
      const result = structuredClone(session);
      const refs = new Set<string>();
      for (const record of records(session.id)) if (active(record)) {
        refs.add(record.ref);
        for (const page of record.pages) refs.add(page.ref);
      }
      for (const message of result.presentation!.messages) {
        /** 只保留当前存活引用；历史正文保持原样。 */
        message.attachments = message.attachments?.filter(function liveReference(item) { return refs.has(item.id); });
      }
      return result;
    } catch (error) { throw toNodeBoundaryError(error, "CHAT_ATTACHMENT_UNAVAILABLE"); }
  }

  /** 只移除结构化附件展示引用，保留用户和助手的历史正文。 */
  async function removePresentationRefs(sessionId: string, refs?: string[]): Promise<void> {
    const session = await sessionStore.get(sessionId);
    if (!session?.presentation) return;
    for (const message of session.presentation.messages) {
      /** 已退休附件不再保留文件名、MIME 或原路径投影。 */
      message.attachments = message.attachments?.filter(function keepAttachment(item) { return refs !== undefined && !refs.includes(item.id); });
    }
    await sessionStore.save(session);
  }

  /** 先删除全部字节和缓存，再删除引用；中断时保留无敏感元数据的重试日志。 */
  async function finishRetirement(item: Retirement): Promise<void> {
    sessionKey(item.sessionId);
    if (!opaque.test(item.ref) || !Array.isArray(item.refs) || item.refs.some(
      /** 重试日志只能引用本存储签发的 opaque 标识。 */
      function invalidRef(ref) { return !opaque.test(ref); },
    )) unavailable();
    const directory = path.join(dataRoot, item.sessionId, item.ref);
    assertSafeNodePath(root, directory);
    fs.rmSync(directory, { recursive: true, force: true });
    await removePresentationRefs(item.sessionId, item.refs);
    fs.rmSync(path.join(retiredRoot, `${item.ref}.json`), { force: true });
  }

  /** 退休日志先于字节删除提交，清理失败后引用立即不可用。 */
  async function retire(record: AttachmentRecord): Promise<void> {
    /** 父文件及所有页图作为一次生命周期操作清理。 */
    const item = { sessionId: record.sessionId, ref: record.ref, refs: [record.ref, ...record.pages.map(function pageRef(page) { return page.ref; })] };
    atomicReplace(path.join(retiredRoot, `${record.ref}.json`), JSON.stringify(item));
    await finishRetirement(item);
  }

  /** 解析和校验完成后原子提交目录；未完成 staging 不会进入列表或引用目录。 */
  async function put(input: { sessionId: string; displayName: string; bytes: Uint8Array; signal?: AbortSignal }): Promise<NodeChatAttachment> {
    try {
      ensure();
      checkSignal(input.signal);
      await requireSession(input.sessionId);
      if (!input.bytes.byteLength || input.bytes.byteLength > MAX_BYTES) unavailable();
      const bytes = Buffer.from(input.bytes);
      const mimeType = detectMime(bytes);
      const kind = mimeType.startsWith("image/") ? "image" : "document";
      if (kind === "image" && bytes.byteLength > IMAGE_BYTES) unavailable();
      let parsed: NodeChatParsedDocument | undefined;
      if (kind === "document") {
        if (mimeType === "text/plain") parsed = { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
        else {
          if (!options.parseDocument) throw new NodeChatError("CHAT_ATTACHMENT_PARSER_UNAVAILABLE");
          try { parsed = await options.parseDocument({ bytes: new Uint8Array(bytes), mimeType, signal: input.signal }); }
          catch { checkSignal(input.signal); unavailable(); }
        }
        if (typeof parsed?.text !== "string" || (parsed.pages?.length ?? 0) > 20) unavailable();
      }
      checkSignal(input.signal);
      /** 等待解析期间可能删除会话；提交锁内重新校验服务端身份和取消。 */
      return await locked(async function commitAttachment() {
        await requireSession(input.sessionId);
        const createdAt = now();
        if (!Number.isSafeInteger(createdAt) || createdAt < 0) unavailable();
        const ref = randomUUID();
        const parent = path.join(dataRoot, sessionKey(input.sessionId));
        ensureChatDirectory(root, parent);
        const staging = path.join(root, `staging-${ref}`);
        const record: AttachmentRecord = { ref, sessionId: input.sessionId, kind, mimeType, byteLength: bytes.length, sha256: digest(bytes), createdAt, expiresAt: createdAt + CHAT_ATTACHMENT_TTL_MS, status: "active", displayName: input.displayName.split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120) || "附件", pages: [] };
        try {
          ensureChatDirectory(root, staging);
          fs.writeFileSync(path.join(staging, "content"), bytes, { flag: "wx", mode: 0o600 });
          let pageBytes = 0;
          for (const inputPage of parsed?.pages ?? []) {
            const page = Buffer.from(inputPage);
            const type = detectMime(page);
            pageBytes += page.length;
            if (!type.startsWith("image/") || !page.length || page.length > IMAGE_BYTES || pageBytes > MAX_BYTES) unavailable();
            const pageRef = randomUUID();
            fs.writeFileSync(path.join(staging, pageRef), page, { flag: "wx", mode: 0o600 });
            record.pages.push({ ref: pageRef, mimeType: type, byteLength: page.length, sha256: digest(page) });
          }
          if (parsed) fs.writeFileSync(path.join(staging, "parsed.json"), JSON.stringify({ text: parsed.text.slice(0, 16_000) }), { flag: "wx", mode: 0o600 });
          fs.writeFileSync(path.join(staging, "metadata.json"), JSON.stringify(record), { flag: "wx", mode: 0o600 });
          checkSignal(input.signal);
          fs.renameSync(staging, path.join(parent, ref));
          const { pages: _pages, ...view } = record;
          return view;
        } finally { fs.rmSync(staging, { recursive: true, force: true }); }
      }, input.signal);
    } catch (error) { throw toNodeBoundaryError(error, "CHAT_ATTACHMENT_UNAVAILABLE"); }
  }

  /** 取得当前 Session 可用附件，只返回根附件，页图授权由文档读取按需派生。 */
  async function list(sessionId: string): Promise<NodeChatAttachment[]> {
    /** 列表与删除共享锁，避免返回删除到一半的元数据。 */
    return locked(async function listActive() {
      await requireSession(sessionId);
      /** 对外不暴露解析缓存或页图存储信息。 */
      return records(sessionId).filter(active).map(function project(record) { const { pages: _pages, ...view } = record; return view; });
    });
  }

  /** 在锁内定位当前合法父附件或页图；不扫描其他 Session。 */
  async function find(sessionId: string, ref: string) {
    await requireSession(sessionId);
    if (!opaque.test(ref)) unavailable();
    for (const record of records(sessionId)) {
      if (!active(record)) continue;
      /** 页图只能在同一父附件元数据中解析，不能靠路径或任意文件名寻址。 */
      const page = record.pages.find(function matchingPage(item) { return item.ref === ref; });
      if (record.ref === ref || page) return { record, page };
    }
    return unavailable();
  }

  /** Core 每次调用前复查引用；不存在、过期和撤销统一返回 false。 */
  async function authorizeRef(sessionId: string, ref: string, kind: "image" | "document"): Promise<boolean> {
    try {
      /** 校验引用类型与当前实际记录相同。 */
      return await locked(async function authorize() { const found = await find(sessionId, ref); return (found.page ? "image" : found.record.kind) === kind; });
    } catch { return false; }
  }

  /** 读取已缓存的临时解析结果，无向量库依赖，也不在工具调用期间解析任意文件。 */
  async function readAttachment(sessionId: string, ref: string, signal?: AbortSignal) {
    /** 从受控目录读取解析缓存，页图仍使用与父文件相同的有效期。 */
    return locked(async function readParsed() {
      const { record, page } = await find(sessionId, ref);
      if (page || record.kind !== "document") unavailable();
      const target = path.join(dataRoot, sessionId, ref, "parsed.json");
      assertSafeNodePath(root, target);
      if (fs.statSync(target).size > 100_000) unavailable();
      const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      if (typeof parsed.text !== "string") unavailable();
      /** 只投影页图授权，不向 Core 返回路径或缓存字段。 */
      return { text: parsed.text.slice(0, 16_000), pageImages: record.pages.map(function pageGrant(item) { return grant({ ...record, ref: item.ref, kind: "image" }); }) };
    }, signal);
  }

  /** 返回通过摘要验证的图片/原始文件字节，仅供受信宿主和 Core 只读端口消费。 */
  async function readBytes(sessionId: string, ref: string, signal?: AbortSignal) {
    /** 字节读取与删除互斥，读取结束后不把文件句柄留给调用方。 */
    return locked(async function readContent() {
      const { record, page } = await find(sessionId, ref);
      const target = path.join(dataRoot, sessionId, record.ref, page?.ref ?? "content");
      assertSafeNodePath(root, target);
      const metadata = page ?? record;
      if (fs.statSync(target).size !== metadata.byteLength || metadata.byteLength > MAX_BYTES) unavailable();
      const bytes = fs.readFileSync(target);
      if (digest(bytes) !== metadata.sha256) unavailable();
      return { bytes: new Uint8Array(bytes), mimeType: metadata.mimeType };
    }, signal);
  }

  /** 删除 Session 时先写永久最小标记；失败可重试，知识资源完全不在此目录中。 */
  async function deleteBySession(sessionId: string): Promise<void> {
    /** 标记与附件清理在同一锁内，阻止新上传和 Turn 写入。 */
    await locked(async function deleteSessionAttachments() {
      atomicReplace(path.join(deletingRoot, `${sessionKey(sessionId)}.json`), JSON.stringify({ sessionId }));
      for (const record of records(sessionId)) await retire(record);
      await removePresentationRefs(sessionId);
      fs.rmSync(path.join(dataRoot, sessionId), { recursive: true, force: true });
    }, undefined, "CHAT_ATTACHMENT_CLEANUP_FAILED");
  }

  /** 重试中断删除并按创建时间/引用顺序清理一批到期附件，不淘汰未满 30 天的数据。 */
  async function cleanupExpired(input: { limit?: number; signal?: AbortSignal } = {}): Promise<string[]> {
    const limit = input.limit ?? 32;
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new NodeChatError("CHAT_ATTACHMENT_CLEANUP_FAILED");
    /** 全局排序与删除共享跨进程锁，避免并发实例重复选择或与上传竞态。 */
    return locked(async function cleanupBatch() {
      for (const file of fs.readdirSync(root)) {
        if (!/^staging-[0-9a-f-]{36}$/.test(file)) continue;
        const target = path.join(root, file);
        assertSafeNodePath(root, target);
        fs.rmSync(target, { recursive: true, force: true });
      }
      for (const file of fs.readdirSync(retiredRoot)) {
        if (!file.endsWith(".json")) continue;
        const target = path.join(retiredRoot, file);
        assertSafeNodePath(root, target);
        checkSignal(input.signal);
        const item = JSON.parse(fs.readFileSync(target, "utf8")) as Retirement;
        if (file !== `${item.ref}.json`) unavailable();
        await finishRetirement(item);
      }
      const expired: AttachmentRecord[] = [];
      for (const sessionId of fs.readdirSync(dataRoot)) {
        for (const record of records(sessionId)) if (record.expiresAt <= now() || isSessionDeleting(sessionId)) expired.push(record);
      }
      /** 时间相同按服务端 attachmentRef 排序，保证跨实例批次顺序稳定。 */
      expired.sort(function oldestFirst(left, right) { return left.createdAt - right.createdAt || left.ref.localeCompare(right.ref); });
      const cleaned: string[] = [];
      for (const record of expired.slice(0, limit)) {
        checkSignal(input.signal);
        await retire(record);
        cleaned.push(record.ref);
      }
      return cleaned;
    }, input.signal, "CHAT_ATTACHMENT_CLEANUP_FAILED");
  }

  /** Host 启动时先收敛过期项，随后每小时维护；句柄可停止且不阻止进程退出。 */
  async function startMaintenance(onError: (code: "CHAT_ATTACHMENT_CLEANUP_FAILED") => void, signal?: AbortSignal): Promise<() => void> {
    let running = false;
    /** 逐批检查取消并收敛存量；错误只交付固定安全码。 */
    async function maintain(): Promise<void> {
      if (running || signal?.aborted) return;
      running = true;
      try { while ((await cleanupExpired({ signal })).length === 32) checkSignal(signal); }
      finally { running = false; }
    }
    await maintain();
    /** 定时轮次失败保留删除日志，下一轮重试。 */
    const timer = setInterval(function scheduledMaintenance() { void maintain().catch(function reportFailure() { onError("CHAT_ATTACHMENT_CLEANUP_FAILED"); }); }, 60 * 60 * 1000);
    timer.unref();
    /** 停止维护定时器，同时移除父信号监听。 */
    function stop(): void { clearInterval(timer); signal?.removeEventListener("abort", stop); }
    signal?.addEventListener("abort", stop, { once: true });
    return stop;
  }

  return { put, list, authorizeRef, readAttachment, readBytes, deleteBySession, cleanupExpired, startMaintenance, isSessionDeleting, withActiveSession, sanitizeSession };
}

export type NodeChatAttachmentStore = ReturnType<typeof createNodeChatAttachmentStore>;
