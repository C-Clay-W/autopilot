/**
 * Node WorkspaceRegistry：维护宿主级受信工作区索引，不扫描磁盘或承载 Runtime 事实状态。
 */

import fs from "node:fs";
import path from "node:path";
import { atomicReplace } from "./file-utils";
import { canonicalizeNodePath, createNodeWorkspaceId, resolveNodeGlobalStateRoot } from "./state-root";

/** Registry 中保存的最小工作区记录；路径仅供宿主下次打开，不向普通 CLI 输出泄露。 */
export interface WorkspaceRegistryEntry {
  workspaceId: string;
  workspaceRoot: string;
  displayName: string;
  lastOpenedAt: number;
}

/** WorkspaceRegistry 的公共操作；仅 register/remove 会写入全局状态根。 */
export interface WorkspaceRegistry {
  list(): WorkspaceRegistryEntry[];
  get(workspaceId: string): WorkspaceRegistryEntry | undefined;
  register(workspaceRoot: string): WorkspaceRegistryEntry;
  remove(workspaceId: string): boolean;
}

/** 创建宿主级 Registry；默认读取不会创建全局状态根。 */
export function createNodeWorkspaceRegistry(options: { globalStateRoot?: string; cwd?: string; now?: () => number } = {}): WorkspaceRegistry {
  const globalStateRoot = resolveNodeGlobalStateRoot({ globalStateRoot: options.globalStateRoot, cwd: options.cwd });
  const registryPath = path.join(globalStateRoot, "workspace-registry.json");
  const now = options.now ?? (() => Date.now());

  /** 读取并校验不可信 JSON，损坏时 fail closed 为无记录而不输出原文。 */
  function load(): WorkspaceRegistryEntry[] {
    if (!fs.existsSync(registryPath)) return [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(registryPath, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function isEntry(value): value is WorkspaceRegistryEntry {
        return Boolean(value) && typeof value === "object"
          && typeof (value as WorkspaceRegistryEntry).workspaceId === "string"
          && typeof (value as WorkspaceRegistryEntry).workspaceRoot === "string"
          && typeof (value as WorkspaceRegistryEntry).displayName === "string"
          && typeof (value as WorkspaceRegistryEntry).lastOpenedAt === "number";
      });
    } catch {
      return [];
    }
  }

  /** 原子替换整个小型 Registry，避免部分写入形成第二份状态源。 */
  function save(entries: WorkspaceRegistryEntry[]): void {
    atomicReplace(registryPath, JSON.stringify(entries, null, 2));
  }

  /** 按不透明 ID 查询索引条目；调用方仍须复查目录与 Trust，不能把 ID 当作路径或授权。 */
  function get(workspaceId: string): WorkspaceRegistryEntry | undefined {
    return load().find(function findWorkspace(entry) { return entry.workspaceId === workspaceId; });
  }

  /** 仅在 canonical workspace 已经通过 Trust 后由 Composition Root 调用。 */
  function register(workspaceRoot: string): WorkspaceRegistryEntry {
    const canonicalRoot = canonicalizeNodePath(workspaceRoot);
    const workspaceId = createNodeWorkspaceId(canonicalRoot);
    const next: WorkspaceRegistryEntry = {
      workspaceId,
      workspaceRoot: canonicalRoot,
      displayName: path.basename(canonicalRoot) || canonicalRoot,
      lastOpenedAt: now(),
    };
    const entries = load().filter(function removeExisting(entry) { return entry.workspaceId !== workspaceId; });
    entries.push(next);
    save(entries);
    return next;
  }

  /** 仅注销索引条目，绝不触碰源码、Trust 或 workspace durable state。 */
  function remove(workspaceId: string): boolean {
    const entries = load();
    const remaining = entries.filter(function keepEntry(entry) { return entry.workspaceId !== workspaceId; });
    if (remaining.length === entries.length) return false;
    save(remaining);
    return true;
  }

  return { list: load, get, register, remove };
}
