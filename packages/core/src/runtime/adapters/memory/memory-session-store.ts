/**
 * 内存 Session 存储适配器
 *
 * 仅供测试与 contract test 使用；数据随进程结束而丢失。
 */

import type { Session } from "../../domain";
import type { SessionStore } from "../../ports";
import type { SessionDirectoryPage, SessionDirectoryQuery } from "../../ports/session-store";

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  async get(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }

  /** 列出内存中的全部 Session。 */
  async list(): Promise<Session[]> {
    return [...this.sessions.values()];
  }

  /** 只投影元数据，不复制presentation等正文属性。 */
  async getDirectoryEntry(id: string) {
    const session = this.sessions.get(id);
    if (!session) return null;
    const { title, productMode, projectId, chatRetrievalMode, status, activeTurnId, createdAt, updatedAt } = session;
    return { id, title, productMode, projectId, chatRetrievalMode, status, activeTurnId, createdAt, updatedAt };
  }

  /** 按UUID稳定分页，不复制或读取presentation正文。 */
  async listDirectoryPage(query: SessionDirectoryQuery): Promise<SessionDirectoryPage> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new Error("SESSION_CURSOR_INVALID");
    let after = "";
    if (query.cursor) {
      try {
        const value = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
        if (value.projectId !== query.projectId || value.view !== "session-directory" || typeof value.after !== "string") throw new Error();
        after = value.after;
      } catch { throw new Error("SESSION_CURSOR_INVALID"); }
    }
    const candidates = [...this.sessions.keys()].sort().filter(function remaining(id) { return id > after; });
    const items: SessionDirectoryPage["items"] = [];
    let scanned = 0;
    for (const id of candidates.slice(0, query.limit)) {
      scanned++;
      after = id;
      const session = this.sessions.get(id)!;
      if (session.productMode === "work" && session.projectId === query.projectId) items.push({ id, ...(session.title !== undefined ? { title: session.title } : {}) });
    }
    return { items, ...(scanned < candidates.length ? { nextCursor: Buffer.from(JSON.stringify({ view: "session-directory", projectId: query.projectId, after })).toString("base64url") } : {}) };
  }

  /** 在同一同步临界区创建，禁止覆盖已有身份。 */
  async createIfAbsent(session: Session): Promise<boolean> {
    if (this.sessions.has(session.id)) return false;
    this.sessions.set(session.id, structuredClone(session));
    return true;
  }

  async save(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async delete(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }
}
