/**
 * SessionResourceStore Port：清理不属于 Core 状态库但生命周期归属 Session 的宿主资源。
 *
 * 例如 Web 图片附件。删除必须由共享 SessionService 发起，避免不同宿主出现遗留资源。
 */

/** Session-owned 外围资源的清理接口。 */
export interface SessionResourceStore {
  /** 删除指定 Session 的全部外围资源；不存在时视为已清理。 */
  deleteBySession(sessionId: string): Promise<void>;
}
