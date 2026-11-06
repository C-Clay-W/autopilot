/** 组控制存储端口：短原子操作和持久化由宿主实现。 */
import type { ThreadControl, ThreadMessage, ThreadEvent } from "../domain/thread-collaboration";

/** CAS 接受完整组快照，调用方不得持有可变存储引用。 */
export interface ThreadStore {
  /** 只读检查已有请求身份，不创建存储。 */
  verifyRequest(id: string, groupId: string, payloadDigest: string): Promise<void>;
  /** 全状态根的请求身份原子预留；同身份不得绑定不同组或负载。 */
  reserveRequest(id: string, groupId: string, payloadDigest: string): Promise<void>;
  /** 成员登记与 Session 删除共享短锁，不持有到模型执行。 */
  withSessionLock<T>(threadId: string, operation: () => Promise<T>): Promise<T>;
  /** 检查 Session 是否仍被组成员或创建意图引用。 */
  hasMembership(threadId: string): Promise<boolean>;
  /** 按组标识读取副本；不存在返回 null。 */
  readControl(groupId: string): Promise<ThreadControl | null>;
  /** 按组序号幂等写入事件；同序号不同内容拒绝。 */
  writeEvent(event: ThreadEvent): Promise<void>;
  /** 按组序号只读一条事件。 */
  readEvent(groupId: string, seq: number): Promise<ThreadEvent | null>;
  /** 按稳定身份写入不可变消息；同身份不同内容必须拒绝。 */
  writeMessage(message: ThreadMessage): Promise<void>;
  /** 按目标与序号读取单条消息；不存在返回 null。 */
  readMessage(groupId: string, threadId: string, seq: number): Promise<ThreadMessage | null>;
  /** 新建时 expectedRevision 为 null；否则必须与当前 revision 一致。 */
  compareAndSetControl(groupId: string, expectedRevision: number | null, value: ThreadControl): Promise<boolean>;
  /** 列出已持久化组的标识；为宿主 Runner 发现目标，不读取其他工作区。 */
  listGroups(): Promise<string[]>;
  /**
   * 可选的本进程唤醒：存储变化时回调，不排队事件也不代表事实来源。
   * 未实现时调用方必须自行复读，跨进程写入仍以持久记录为准。
   */
  subscribe?(groupId: string, listener: () => void): () => void;
}
