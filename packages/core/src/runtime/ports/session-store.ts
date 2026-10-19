/**
 * SessionStore Port — Session 元数据持久化接口
 *
 * Core 通过该接口读取/保存 Session 状态，不依赖具体文件或数据库实现。
 */

import type { Session } from "../domain";

/** Session 存储端口。 */
export interface SessionStore {
  /** 根据 ID 读取 Session；不存在时返回 null。 */
  get(id: string): Promise<Session | null>;

  /** 列出当前宿主持久化的全部 Session。 */
  list(): Promise<Session[]>;

  /** 保存或更新 Session。 */
  save(session: Session): Promise<void>;

  /** 删除指定 Session 元数据；不存在时返回 false。 */
  delete(id: string): Promise<boolean>;
}
