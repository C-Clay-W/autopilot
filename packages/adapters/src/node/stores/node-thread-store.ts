/** Node 协作组控制 Store：跨进程短锁与原子替换，不驱动 Turn。 */
import { sanitizeContinuationFailure } from "@autopilot-agent/core";
import fs from "node:fs";
import path from "node:path";
import type { ThreadControl, ThreadMessage, ThreadEvent, ThreadStore } from "@autopilot-agent/core";
import { atomicReplace, safeFilePath, withFileLock } from "../file-utils";
import { assertSafeNodePath } from "../chat-state";

/** 使用明确的已初始化状态根；查询不创建目录、锁或文件。 */
export function createNodeThreadStore(stateRoot: string): ThreadStore {
  const groups = path.join(stateRoot, "threads", "groups");
  const controlCache = new Map<string, { signature: string; value: ThreadControl; bytes: number }>();
  let controlCacheBytes = 0;

  /** 每次核对纳秒文件身份，原子替换和同尺寸改写都使已解析控制副本失效。 */
  function controlSignature(target: string): string {
    const stat = fs.statSync(target, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.birthtimeNs}`;
  }

  /** 淘汰解析副本并同步容量，异常后不得使用旧控制。 */
  function forgetControl(target: string): void {
    controlCacheBytes -= controlCache.get(target)?.bytes ?? 0;
    controlCache.delete(target);
  }

  /** 仅接受已经初始化的目标格式，不能让 Store 自动创建或修改旧根。 */
  function assertTargetRoot(): void {
    const manifest = path.join(stateRoot, "schema.json");
    let value: unknown;
    try {
      if (fs.lstatSync(stateRoot).isSymbolicLink() || fs.lstatSync(manifest).isSymbolicLink()) throw new Error("unsafe");
      value = JSON.parse(fs.readFileSync(manifest, "utf8"));
    } catch { throw new Error("STATE_SCHEMA_VERSION_UNSUPPORTED"); }
    if (!value || typeof value !== "object" || (value as { schemaVersion?: unknown }).schemaVersion !== 8) throw new Error("STATE_SCHEMA_VERSION_UNSUPPORTED");
  }

  /** 使用现有路径校验约束组 ID。 */
  function controlPath(groupId: string): string {
    const target = path.join(safeFilePath(groups, groupId, ""), "control.json");
    assertSafeNodePath(stateRoot, target);
    return target;
  }

  /** 新交互控制在读写两端校验，旧interrupt/resume记录保持原兼容格式。 */
  function assertInteractionControls(control: ThreadControl): void {
    if (control.controls !== undefined && !Array.isArray(control.controls)) throw new Error("THREAD_CONTROL_CORRUPTED");
    for (const intent of control.controls ?? []) {
      if (intent?.kind !== "continue_interaction") continue;
      if (intent.failureDiagnostic !== undefined && (!sanitizeContinuationFailure(intent.failureDiagnostic) || Object.keys(intent.failureDiagnostic).some(function invalid(key) { return !Object.prototype.hasOwnProperty.call(sanitizeContinuationFailure(intent.failureDiagnostic)!, key) || intent.failureDiagnostic![key as keyof NonNullable<typeof intent.failureDiagnostic>] !== sanitizeContinuationFailure(intent.failureDiagnostic)![key as keyof NonNullable<typeof intent.failureDiagnostic>]; }))) throw new Error("THREAD_CONTROL_CORRUPTED");
      const ids = [intent.controlId, intent.threadId, intent.expectedTurnId, intent.approvalId ?? intent.requestId];
      if (ids.some(function invalid(id) { return typeof id !== "string" || !id || id.length > 200 || /[\\/\x00-\x1f]/u.test(id); })
        || (intent.approvalId !== undefined && typeof intent.approvalId !== "string")
        || (intent.requestId !== undefined && typeof intent.requestId !== "string")
        || Boolean(intent.approvalId) === Boolean(intent.requestId)
        || !["pending", "claimed", "executing", "completed", "failed"].includes(intent.status)
        || typeof intent.checkpointDigest !== "string" || !/^[a-f0-9]{64}$/u.test(intent.checkpointDigest)
        || (intent.pauseSeq !== undefined && (!Number.isSafeInteger(intent.pauseSeq) || intent.pauseSeq < 0))
        || !Number.isFinite(intent.createdAt) || !Number.isFinite(intent.updatedAt)
        || ((intent.status === "claimed" || intent.status === "executing") && (typeof intent.ownerId !== "string" || !intent.ownerId || intent.ownerId.length > 500))
        || (intent.failureCode !== undefined && !["BOUNDARY_CHANGED", "CONTINUE_FAILED"].includes(intent.failureCode))) throw new Error("THREAD_CONTROL_CORRUPTED");
    }
  }

  /** 损坏控制记录必须报错，不能当作不存在或覆盖。 */
  function read(groupId: string): ThreadControl | null {
    const target = controlPath(groupId);
    try {
      const before = controlSignature(target);
      const cached = controlCache.get(target);
      if (cached?.signature === before) {
        controlCache.delete(target); controlCache.set(target, cached);
        return structuredClone(cached.value);
      }
      forgetControl(target);
      const text = fs.readFileSync(target, "utf8");
      let value: ThreadControl;
      try { value = JSON.parse(text) as ThreadControl; }
      catch { throw new Error("THREAD_CONTROL_CORRUPTED"); }
      if (!value || value.group?.groupId !== groupId || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("THREAD_CONTROL_CORRUPTED");
      assertInteractionControls(value);
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes <= 8 * 1024 * 1024 && before === controlSignature(target)) {
        while (controlCache.size >= 128 || controlCacheBytes + bytes > 8 * 1024 * 1024) forgetControl(controlCache.keys().next().value!);
        controlCache.set(target, { signature: before, value, bytes }); controlCacheBytes += bytes;
        return structuredClone(value);
      }
      return value;
    } catch (error) {
      forgetControl(target);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** 每条消息独立有界记录，按目标和序号定位，不扫描全量历史。 */
  function messagePath(groupId: string, threadId: string, seq: number): string {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("THREAD_CURSOR_INVALID");
    const dir = path.join(safeFilePath(groups, groupId, ""), "messages");
    const threadDir = safeFilePath(dir, threadId, "");
    const target = safeFilePath(threadDir, String(seq), ".json");
    assertSafeNodePath(stateRoot, target);
    return target;
  }

  /** 在不创建锁文件的情况下安全读取固定序号。 */
  function readMessage(groupId: string, threadId: string, seq: number): ThreadMessage | null {
    let value: ThreadMessage;
    try { value = JSON.parse(fs.readFileSync(messagePath(groupId, threadId, seq), "utf8")) as ThreadMessage; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("THREAD_MESSAGE_CORRUPTED");
    }
    if (!value || value.groupId !== groupId || value.toThreadId !== threadId || value.deliverySeq !== seq) throw new Error("THREAD_MESSAGE_CORRUPTED");
    return value;
  }

  /** 事件按固定序号寻址，单条记录有界且不扫描其他历史。 */
  function eventPath(groupId: string, seq: number): string {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("THREAD_CURSOR_INVALID");
    const dir = path.join(safeFilePath(groups, groupId, ""), "events");
    const target = safeFilePath(dir, String(seq), ".json");
    assertSafeNodePath(stateRoot, target);
    return target;
  }

  /** 损坏事件不可当作空记录。 */
  function readEvent(groupId: string, seq: number): ThreadEvent | null {
    let value: ThreadEvent;
    try { value = JSON.parse(fs.readFileSync(eventPath(groupId, seq), "utf8")) as ThreadEvent; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("THREAD_EVENT_CORRUPTED"); }
    if (!value || value.groupId !== groupId || value.groupSeq !== seq) throw new Error("THREAD_EVENT_CORRUPTED");
    return value;
  }

  /** 读取已持久预留；不存在时不创建目录或锁。 */
  function readRequest(id: string): { groupId: string; payloadDigest: string } | null {
    const target = safeFilePath(path.join(stateRoot, "threads", "requests"), id, ".json");
    assertSafeNodePath(stateRoot, target);
    try { return JSON.parse(fs.readFileSync(target, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("THREAD_REQUEST_CORRUPTED"); }
  }

  return {
    /** 只读检查，和预留中的最终检查共同处理并发。 */
    async verifyRequest(id, groupId, payloadDigest) {
      assertTargetRoot();
      const prior = readRequest(id);
      if (prior && (prior.groupId !== groupId || prior.payloadDigest !== payloadDigest)) throw new Error("THREAD_REQUEST_CONFLICT");
    },
    /** 请求身份独立于组，跨进程锁内持久预留，冲突不得重绑。 */
    async reserveRequest(id, groupId, payloadDigest) {
      assertTargetRoot();
      const target = safeFilePath(path.join(stateRoot, "threads", "requests"), id, ".json");
      assertSafeNodePath(stateRoot, target);
      await withFileLock(target, function reserveLocked() {
        if (fs.existsSync(target)) {
          let prior: { groupId: string; payloadDigest: string };
          try { prior = JSON.parse(fs.readFileSync(target, "utf8")); } catch { throw new Error("THREAD_REQUEST_CORRUPTED"); }
          if (prior.groupId !== groupId || prior.payloadDigest !== payloadDigest) throw new Error("THREAD_REQUEST_CONFLICT");
          return;
        }
        atomicReplace(target, JSON.stringify({ groupId, payloadDigest }));
      }, { requireExitedOwner: true });
    },
    /** 同序号重放幂等，不同事件冲突。 */
    async writeEvent(event) {
      assertTargetRoot();
      const target = eventPath(event.groupId, event.groupSeq);
      const serialized = JSON.stringify(event);
      if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) throw new Error("THREAD_PAYLOAD_TOO_LARGE");
      await withFileLock(target, function writeEventLocked() {
        const previous = readEvent(event.groupId, event.groupSeq);
        if (previous && JSON.stringify(previous) !== serialized) throw new Error("THREAD_REQUEST_CONFLICT");
        if (!previous) atomicReplace(target, serialized);
      }, { requireExitedOwner: true });
    },
    /** 查询不创建锁或目录。 */
    async readEvent(groupId, seq) { assertTargetRoot(); return readEvent(groupId, seq); },
    /** 短期 Session 锁只覆盖元数据变更与删除，不覆盖 Turn 执行。 */
    async withSessionLock(threadId, operation) {
      assertTargetRoot();
      const target = safeFilePath(path.join(stateRoot, "threads", "session-locks"), threadId, "");
      assertSafeNodePath(stateRoot, target);
      return withFileLock(target, operation, { requireExitedOwner: true });
    },
    /** 检查全部组控制记录；损坏记录明确报错，不遗漏受管引用。 */
    async hasMembership(threadId) {
      assertTargetRoot();
      if (!fs.existsSync(groups)) return false;
      for (const groupId of fs.readdirSync(groups)) {
        const control = read(groupId);
        if (!control) throw new Error("THREAD_CONTROL_CORRUPTED");
        if (control.members.some(function member(item) { return item.threadId === threadId; }) || control.creates.some(function intent(item) { return item.threadId === threadId || item.parentThreadId === threadId; })) return true;
      }
      return false;
    },
    /** 目标格式与稳定身份校验后按消息锁幂等写入。 */
    async writeMessage(message) {
      assertTargetRoot();
      const target = messagePath(message.groupId, message.toThreadId, message.deliverySeq);
      const serialized = JSON.stringify(message);
      if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) throw new Error("THREAD_PAYLOAD_TOO_LARGE");
      await withFileLock(target, function writeLocked() {
        const prior = readMessage(message.groupId, message.toThreadId, message.deliverySeq);
        if (prior && JSON.stringify(prior) !== serialized) throw new Error("THREAD_REQUEST_CONFLICT");
        if (!prior) atomicReplace(target, serialized);
      }, { requireExitedOwner: true });
    },
    /** 按序号读取，不创建目录或锁文件。 */
    async readMessage(groupId, threadId, seq) { assertTargetRoot(); return readMessage(groupId, threadId, seq); },
    /** 查询不触发状态根初始化或执行恢复。 */
    async readControl(groupId) { assertTargetRoot(); return read(groupId); },
    /** 只列出已有 control.json 的组，半初始化目录不冒充可执行目标。 */
    async listGroups() {
      assertTargetRoot();
      if (!fs.existsSync(groups)) return [];
      return fs.readdirSync(groups).filter(function hasControl(name) { return fs.existsSync(controlPath(name)); }).sort();
    },
    /**
     * 本进程内的文件变化唤醒；watchFile 只做 stat 轮询，不创建锁或文件。
     * 跨进程写入同样会改变 mtime，因此订阅不依赖同一进程的 CAS 回调。
     */
    subscribe(groupId, listener) {
      const target = controlPath(groupId);
      const onChange = function changed() {
        try { listener(); } catch { /* 观察者异常不改变存储事实 */ }
      };
      fs.watchFile(target, { interval: 200, persistent: false }, onChange);
      return () => { fs.unwatchFile(target, onChange); };
    },
    /** 加锁后重新读取和校验版本，原子替换而不跨 Session 持锁执行。 */
    async compareAndSetControl(groupId, expectedRevision, value) {
      assertTargetRoot();
      if (value.group.groupId !== groupId || value.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) throw new Error("THREAD_CONTROL_INVALID");
      assertInteractionControls(value);
      const serialized = JSON.stringify(value);
      if (Buffer.byteLength(serialized, "utf8") > 4 * 1024 * 1024) throw new Error("THREAD_STORAGE_FULL");
      return withFileLock(controlPath(groupId), function updateUnderLock() {
        const current = read(groupId);
        if (expectedRevision === null ? current !== null : current?.revision !== expectedRevision) return false;
        atomicReplace(controlPath(groupId), serialized);
        return true;
      }, { requireExitedOwner: true });
    },
  };
}
