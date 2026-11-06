/**
 * SessionStore Port — Session 元数据持久化接口
 *
 * Core 通过该接口读取/保存 Session 状态，不依赖具体文件或数据库实现。
 */

import type { Session } from "../domain";

/** 目录只返回可读标题与精确身份，不携带会话正文。 */
export interface SessionDirectoryPage {
  items: Array<{ id: string; title?: string }>;
  nextCursor?: string;
}

/** 目录按稳定身份排序分页，Project 与产品域属于游标绑定。 */
export interface SessionDirectoryQuery {
  projectId: string;
  limit: number;
  cursor?: string;
}

/** 受信宿主的轻量身份/活动事实，不包含presentation或checkpoint。 */
export type SessionDirectoryEntry = Pick<Session, "id" | "title" | "productMode" | "projectId" | "chatRetrievalMode" | "status" | "activeTurnId" | "createdAt" | "updatedAt">;

/** Session 存储端口。 */
export interface SessionStore {
  /** 根据 ID 读取 Session；不存在时返回 null。 */
  get(id: string): Promise<Session | null>;

  /** 列出当前宿主持久化的全部 Session。 */
  list(): Promise<Session[]>;

  /** 可选轻量目录能力；不支持时宿主应明确拒绝，不能回退全量历史读取。 */
  listDirectoryPage?(query: SessionDirectoryQuery): Promise<SessionDirectoryPage>;

  /** 按精确身份读取轻量元数据，供关联状态与当前标题复用。 */
  getDirectoryEntry?(id: string): Promise<SessionDirectoryEntry | null>;

  /** 仅在 ID 不存在时原子创建，存在则返回 false。 */
  createIfAbsent(session: Session): Promise<boolean>;

  /** 保存或更新 Session。 */
  save(session: Session): Promise<void>;

  /** 删除指定 Session 元数据；不存在时返回 false。 */
  delete(id: string): Promise<boolean>;
}
