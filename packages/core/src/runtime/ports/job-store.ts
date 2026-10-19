/** JobStore Port — 后台 Job 元数据与受限输出的 durable 存储接口。 */

import type { Job, JobOwner } from "../domain";

/** Job 条件更新前提；owner 与 revision 必须同时匹配。 */
export interface JobStoreWriteCondition {
  expectedRevision: number;
  expectedOwner: JobOwner;
}

/** Core 仅通过该 Port 管理 Job durable record，进程句柄不允许写入其中。 */
export interface JobStore {
  /** 兼容测试／迁移写入；JobService 的新记录更新不得调用无条件 save。 */
  save(job: Job): Promise<void>;
  /** 仅当 ID 尚不存在时创建 Job。 */
  create(job: Job): Promise<boolean>;
  /** owner/revision 同时匹配时保存 next revision。 */
  compareAndSave(job: Job, condition: JobStoreWriteCondition): Promise<boolean>;
  /** 读取指定 Job。 */
  get(id: string): Promise<Job | null>;
  /** 列出某个 workspace 下的全部 Job。 */
  list(workspaceId: string): Promise<Job[]>;
  /** 返回 Session 的全部 Job，供删除冲突和级联清理使用。 */
  listBySession(sessionId: string): Promise<Job[]>;
  /** 删除 Session 关联的全部 Job record。 */
  deleteBySession(sessionId: string): Promise<void>;
  /** 串行化同一 Session 的 Job 启动登记与 Session 删除。 */
  withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
}
