/**
 * 内存 Session 存储适配器
 *
 * 仅供测试与 contract test 使用；数据随进程结束而丢失。
 */

import type { Session } from "../../domain";
import type { SessionStore } from "../../ports";

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  async get(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }

  /** 列出内存中的全部 Session。 */
  async list(): Promise<Session[]> {
    return [...this.sessions.values()];
  }

  async save(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async delete(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }
}
