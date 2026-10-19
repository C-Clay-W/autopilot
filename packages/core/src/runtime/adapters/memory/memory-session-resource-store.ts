/** 内存 SessionResourceStore：记录已清理的 Session，供 Runtime 契约测试断言共享删除边界。 */

import type { SessionResourceStore } from "../../ports";

/** 不保存真实文件的测试用 Session 外围资源存储。 */
export class MemorySessionResourceStore implements SessionResourceStore {
  private readonly deletedSessionIds = new Set<string>();

  /** 标记指定 Session 的外围资源已清理。 */
  async deleteBySession(sessionId: string): Promise<void> {
    this.deletedSessionIds.add(sessionId);
  }

  /** 仅供契约测试读取清理结果。 */
  hasDeleted(sessionId: string): boolean {
    return this.deletedSessionIds.has(sessionId);
  }
}
