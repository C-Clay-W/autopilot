/** 内存组控制 Store，提供与 durable Store 一致的原子比较及副本隔离。 */
import type { ThreadControl, ThreadMessage, ThreadEvent } from "../../domain/thread-collaboration";
import type { ThreadStore } from "../../ports/thread-store";

/** 单实例内通过同步比较与写入实现原子 CAS。 */
export class MemoryThreadStore implements ThreadStore {
  private controls = new Map<string, ThreadControl>();
  private messages = new Map<string, ThreadMessage>();
  private events = new Map<string, ThreadEvent>();
  private requests = new Map<string, { groupId: string; payloadDigest: string }>();
  private listeners = new Map<string, Set<() => void>>();

  /** 只检查已有请求绑定。 */
  async verifyRequest(id: string, groupId: string, payloadDigest: string): Promise<void> {
    const prior = this.requests.get(id);
    if (prior && (prior.groupId !== groupId || prior.payloadDigest !== payloadDigest)) throw new Error("THREAD_REQUEST_CONFLICT");
  }

  /** 相同请求仅可重复绑定原组和负载。 */
  async reserveRequest(id: string, groupId: string, payloadDigest: string): Promise<void> {
    const prior = this.requests.get(id);
    if (prior && (prior.groupId !== groupId || prior.payloadDigest !== payloadDigest)) throw new Error("THREAD_REQUEST_CONFLICT");
    if (!prior) this.requests.set(id, { groupId, payloadDigest });
  }
  private locks = new Map<string, Promise<void>>();

  /** 同 Session 的短临界区串行，其他 Session 互不等待。 */
  async withSessionLock<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(function wait(resolve) { release = resolve; });
    const tail = previous.then(function enqueue() { return current; });
    this.locks.set(threadId, tail);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.locks.get(threadId) === tail) this.locks.delete(threadId); }
  }

  /** 被组成员或未完成创建引用的 Session 不能删除。 */
  async hasMembership(threadId: string): Promise<boolean> {
    return [...this.controls.values()].some(function referenced(control) {
      return control.members.some(function member(item) { return item.threadId === threadId; }) || control.creates.some(function intent(item) { return item.threadId === threadId || item.parentThreadId === threadId; });
    });
  }

  /** 幂等保存事件，不允许覆盖相同序号。 */
  async writeEvent(event: ThreadEvent): Promise<void> {
    const key = JSON.stringify([event.groupId, event.groupSeq]);
    const prior = this.events.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) throw new Error("THREAD_REQUEST_CONFLICT");
    if (!prior) this.events.set(key, structuredClone(event));
  }

  /** 按组序号返回事件副本。 */
  async readEvent(groupId: string, seq: number): Promise<ThreadEvent | null> {
    const event = this.events.get(JSON.stringify([groupId, seq]));
    return event ? structuredClone(event) : null;
  }

  /** 使用稳定组、目标与序号作为不可变消息身份。 */
  private messageKey(groupId: string, threadId: string, seq: number): string { return JSON.stringify([groupId, threadId, seq]); }

  /** 重放相同内容幂等，不同内容冲突。 */
  async writeMessage(message: ThreadMessage): Promise<void> {
    const key = this.messageKey(message.groupId, message.toThreadId, message.deliverySeq);
    const prior = this.messages.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(message)) throw new Error("THREAD_REQUEST_CONFLICT");
    if (!prior) this.messages.set(key, structuredClone(message));
  }

  /** 查询返回隔离副本。 */
  async readMessage(groupId: string, threadId: string, seq: number): Promise<ThreadMessage | null> {
    const message = this.messages.get(this.messageKey(groupId, threadId, seq));
    return message ? structuredClone(message) : null;
  }

  /** 读取隔离副本，缺失时不产生状态。 */
  async readControl(groupId: string): Promise<ThreadControl | null> {
    const value = this.controls.get(groupId);
    return value ? structuredClone(value) : null;
  }

  /** 严格校验组标识和版本，并在无异步间隙的临界区内更新。 */
  async compareAndSetControl(groupId: string, expectedRevision: number | null, value: ThreadControl): Promise<boolean> {
    const current = this.controls.get(groupId);
    if (value.group.groupId !== groupId || value.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) {
      throw new Error("THREAD_CONTROL_INVALID");
    }
    if (expectedRevision === null ? current !== undefined : current?.revision !== expectedRevision) return false;
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 4 * 1024 * 1024) throw new Error("THREAD_STORAGE_FULL");
    this.controls.set(groupId, structuredClone(value));
    this.notify(groupId);
    return true;
  }

  /** 返回已持久化组标识，供宿主 Runner 发现目标。 */
  async listGroups(): Promise<string[]> {
    return [...this.controls.keys()];
  }

  /** 同进程变化唤醒；只代表可能变化，判定仍以复读快照为准。 */
  subscribe(groupId: string, listener: () => void): () => void {
    const group = this.listeners.get(groupId) ?? new Set<() => void>();
    group.add(listener);
    this.listeners.set(groupId, group);
    return () => { group.delete(listener); if (!group.size) this.listeners.delete(groupId); };
  }

  /** 唤醒失败不能影响已提交的存储结果。 */
  private notify(groupId: string): void {
    for (const listener of this.listeners.get(groupId) ?? []) {
      try { listener(); } catch { /* 观察者异常不改变存储事实 */ }
    }
  }
}
