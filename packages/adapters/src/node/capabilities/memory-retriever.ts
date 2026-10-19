/**
 * node/capabilities/memory-retriever.ts — 旧 Memory 路径与安全兼容边界
 *
 * 保留路径解析供用户审阅；来源未验证前检索返回空，不读取或删除历史文件。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FrozenMemorySnippet } from "@autopilot-agent/core";

/** 为 canonical workspace 生成与旧 Web 格式兼容的稳定 Memory namespace。 */
export function getNodeMemoryWorkspaceId(workspaceRoot: string): string {
  return crypto.createHash("sha256").update(fs.realpathSync.native(workspaceRoot).toLowerCase()).digest("hex").slice(0, 24);
}

/** 返回 Runtime stateRoot 下的主 Memory 目录；只读时不创建目录。 */
export function getNodeMemoryDirectory(stateRoot: string, workspaceRoot: string): string {
  return path.join(path.resolve(stateRoot), "memory", getNodeMemoryWorkspaceId(workspaceRoot));
}

/** 返回旧 Web cwd 相对目录，仅用于只读兼容。 */
export function getLegacyWebMemoryDirectory(workspaceRoot: string, cwd = process.cwd()): string {
  return path.join(path.resolve(cwd), ".local", "agent", "workspaces", getNodeMemoryWorkspaceId(workspaceRoot), "memory");
}

/** 旧记录缺少产品和证据来源；兼容入口返回空集合，不读取、改写或自动迁移文件。 */
export function retrieveNodeMemories(_stateRoot: string, _workspaceRoot: string, _query: string, _maxItems = 5): FrozenMemorySnippet[] {
  return [];
}
