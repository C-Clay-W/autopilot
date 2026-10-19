/**
 * Node SessionStore：在显式 stateRoot/sessions 下原子保存 Core Session 元数据。
 */

import { NodeStateError, createNodeIdentityError, toNodeBoundaryError } from "../node-errors";
import fs from "node:fs";
import type { ProductMode, Session, SessionStore } from "@autopilot-agent/core";
import { atomicReplace, safeFilePath, withFileLock } from "../file-utils";
import { ensureNodeStateRoot, getNodeStatePaths } from "../state-root";
import type { NodeStoreOptions } from "../types";
import { assertNodeSessionIdentity, normalizeNodeSession } from "../session-record";
import { assertSafeNodePath } from "../chat-state";

/** 明确 Store 产品域；默认保持现有 Work 宿主，Chat 必须显式指定。 */
export interface NodeSessionStoreOptions extends NodeStoreOptions {
  productMode?: ProductMode;
}

/** 创建基于共享状态根的 SessionStore。 */
export function createNodeSessionStore(options: NodeSessionStoreOptions): SessionStore {
  const paths = getNodeStatePaths(options.stateRoot);
  const productMode = options.productMode ?? "work";

  /** 确保存储目录存在并校验状态 schema。 */
  function ensureDir(): void {
    const state = ensureNodeStateRoot(options.stateRoot);
    assertSafeNodePath(state.root, state.sessionsDir);
    fs.mkdirSync(state.sessionsDir, { recursive: true });
  }

  /** 返回指定 Session 的安全文件路径。 */
  function filePath(sessionId: string): string {
    const target = safeFilePath(paths.sessionsDir, sessionId, ".json");
    assertSafeNodePath(paths.root, target);
    return target;
  }

  /** 严格读取并补写兼容记录；损坏、错域和身份不匹配均拒绝，不能静默跳过。 */
  function read(id: string): Session | null {
    const target = filePath(id);
    if (!fs.existsSync(target)) return null;
    let value: unknown;
    const content = fs.readFileSync(target, "utf8");
    try { value = JSON.parse(content); }
    catch { throw new NodeStateError("STATE_SESSION_CORRUPTED"); }
    const session = normalizeNodeSession(value, id);
    if (session.productMode !== productMode) throw createNodeIdentityError("SESSION_MODE_MISMATCH");
    if ((value as Session).productMode === undefined) atomicReplace(target, JSON.stringify(session, null, 2));
    return session;
  }

  return {
    /** 在文件锁内校验并读取当前产品域的 Session。 */
    async get(id: string): Promise<Session | null> {
      try {
        ensureDir();
        /** 兼容补写与并发 save 使用同一把锁。 */
        return await withFileLock(filePath(id), function readLocked() { return read(id); });
      } catch (error) { throw toNodeBoundaryError(error, "STATE_STORAGE_UNAVAILABLE"); }
    },

    /** 逐项加锁读取，损坏记录不能从列表中无声消失。 */
    async list(): Promise<Session[]> {
      try {
        ensureDir();
        const sessions: Session[] = [];
        for (const file of fs.readdirSync(paths.sessionsDir)) {
          if (!file.endsWith(".json")) continue;
          const session = await this.get(file.slice(0, -5));
          if (session) sessions.push(session);
        }
        /** 保持既有最近更新优先的列表顺序。 */
        return sessions.sort((left, right) => right.updatedAt - left.updatedAt);
      } catch (error) { throw toNodeBoundaryError(error, "STATE_STORAGE_UNAVAILABLE"); }
    },

    /** 在同一临界区比较持久化身份并原子替换，拒绝底层直接越权写入。 */
    async save(session: Session): Promise<void> {
      try {
        ensureDir();
        const next = normalizeNodeSession(session, session.id);
        if (next.productMode !== productMode) throw createNodeIdentityError("SESSION_MODE_MISMATCH");
        /** 读取旧身份与保存共享锁，避免两个 Store 实例发生检查和写入竞态。 */
        await withFileLock(filePath(session.id), function saveLocked() {
          const previous = read(session.id);
          if (previous) assertNodeSessionIdentity(previous, next);
          atomicReplace(filePath(session.id), JSON.stringify(next, null, 2));
        });
      } catch (error) { throw toNodeBoundaryError(error, "STATE_STORAGE_UNAVAILABLE"); }
    },

    /** 只删除当前产品域记录；外围资源仍由 SessionResourceStore 先行清理。 */
    async delete(id: string): Promise<boolean> {
      try {
        ensureDir();
        const target = filePath(id);
        /** 锁内先验证归属，不能通过直接删除调用越过模式边界。 */
        return await withFileLock(target, function deleteLocked() {
          if (!read(id)) return false;
          fs.unlinkSync(target);
          return true;
        });
      } catch (error) { throw toNodeBoundaryError(error, "STATE_STORAGE_UNAVAILABLE"); }
    },
  };
}
