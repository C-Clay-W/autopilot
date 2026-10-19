/**
 * Node TrustPolicy：兼容既有 trust.json 格式，并把信任持久化根显式注入共享实现。
 */

import fs from "node:fs";
import path from "node:path";
import type { WorkspaceTrustEntry, WorkspaceTrustPolicy, WorkspaceTrustStatus } from "@autopilot-agent/core";
import { atomicReplace } from "./file-utils";
import { canonicalizeNodePath, resolveNodeTrustRoot } from "./state-root";
import type { NodeTrustPolicyOptions } from "./types";

/** Node 信任条目，保持 Web 既有 trust.json 的 version/workspaces 结构。 */
export interface NodeTrustEntry {
  workspaceRoot: string;
  status: WorkspaceTrustStatus;
  grantedAt?: number;
  expiresAt?: number;
  source: WorkspaceTrustEntry["source"];
  reason?: string;
}

interface NodeTrustFile {
  version: number;
  workspaces: Record<string, NodeTrustEntry>;
}

/** 创建同步信任存储，供 Web 兼容函数和异步 TrustPolicy 共同使用。 */
export function createNodeTrustStore(options: NodeTrustPolicyOptions): {
  getTrustEntry(workspaceRoot: string): NodeTrustEntry;
  isTrusted(workspaceRoot: string): boolean;
  grantTrust(workspaceRoot: string, settings?: { expiresAt?: number; source?: NodeTrustEntry["source"]; reason?: string }): NodeTrustEntry;
  denyTrust(workspaceRoot: string, reason?: string): NodeTrustEntry;
  revokeTrust(workspaceRoot: string): NodeTrustEntry;
  listTrustEntries(): NodeTrustEntry[];
} {
  const trustRoot = resolveNodeTrustRoot({ stateRoot: options.stateRoot, trustRoot: options.trustRoot });
  const trustFile = path.join(trustRoot, "trust.json");
  const now = options.now ?? (() => Date.now());

  /** 确保信任目录存在。 */
  function ensureDir(): void {
    fs.mkdirSync(trustRoot, { recursive: true });
  }

  /** 读取兼容格式的 trust.json；不存在或损坏时返回空记录。 */
  function loadStore(): NodeTrustFile {
    if (!fs.existsSync(trustFile)) return { version: 1, workspaces: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(trustFile, "utf8")) as Partial<NodeTrustFile>;
      if (parsed.version !== 1 || !parsed.workspaces || typeof parsed.workspaces !== "object") return { version: 1, workspaces: {} };
      return { version: 1, workspaces: parsed.workspaces as Record<string, NodeTrustEntry> };
    } catch {
      return { version: 1, workspaces: {} };
    }
  }

  /** 原子保存信任记录；写入前由宿主可选执行配额预检。 */
  function saveStore(store: NodeTrustFile): void {
    ensureDir();
    const content = JSON.stringify(store, null, 2);
    options.beforeWrite?.(Buffer.byteLength(content, "utf8") + 256);
    atomicReplace(trustFile, content);
  }

  /** 读取条目并根据当前时间转换过期状态。 */
  function getTrustEntry(workspaceRoot: string): NodeTrustEntry {
    const root = canonicalizeNodePath(workspaceRoot);
    const store = loadStore();
    const entry = store.workspaces[root];
    if (!entry) return { workspaceRoot: root, status: "pending", source: "default" };
    if (entry.status === "trusted" && entry.expiresAt !== undefined && now() > entry.expiresAt) {
      return { ...entry, status: "expired", reason: entry.reason ?? "信任已过期" };
    }
    return entry;
  }

  /** 创建或更新工作区信任条目。 */
  function grantTrust(workspaceRoot: string, settings: { expiresAt?: number; source?: NodeTrustEntry["source"]; reason?: string } = {}): NodeTrustEntry {
    const root = canonicalizeNodePath(workspaceRoot);
    const store = loadStore();
    const entry: NodeTrustEntry = {
      workspaceRoot: root,
      status: "trusted",
      grantedAt: now(),
      expiresAt: settings.expiresAt,
      source: settings.source ?? "user",
      reason: settings.reason,
    };
    store.workspaces[root] = entry;
    saveStore(store);
    return entry;
  }

  /** 持久化拒绝工作区信任。 */
  function denyTrust(workspaceRoot: string, reason?: string): NodeTrustEntry {
    const root = canonicalizeNodePath(workspaceRoot);
    const store = loadStore();
    const entry: NodeTrustEntry = { workspaceRoot: root, status: "denied", grantedAt: now(), source: "user", reason };
    store.workspaces[root] = entry;
    saveStore(store);
    return entry;
  }

  /** 将工作区信任恢复为 pending。 */
  function revokeTrust(workspaceRoot: string): NodeTrustEntry {
    const root = canonicalizeNodePath(workspaceRoot);
    const store = loadStore();
    const entry: NodeTrustEntry = { workspaceRoot: root, status: "pending", source: "default", reason: "已撤销" };
    store.workspaces[root] = entry;
    saveStore(store);
    return entry;
  }

  /** 列出信任记录并实时计算过期状态。 */
  function listTrustEntries(): NodeTrustEntry[] {
    const store = loadStore();
    return Object.values(store.workspaces).map((entry) => getTrustEntry(entry.workspaceRoot));
  }

  return {
    getTrustEntry,
    isTrusted: (workspaceRoot: string) => getTrustEntry(workspaceRoot).status === "trusted",
    grantTrust,
    denyTrust,
    revokeTrust,
    listTrustEntries,
  };
}

/** 将 Node 本地条目映射为 Core TrustPolicy DTO。 */
function toCoreEntry(entry: NodeTrustEntry): WorkspaceTrustEntry {
  return {
    workspaceRoot: entry.workspaceRoot,
    status: entry.status,
    grantedAt: entry.grantedAt,
    expiresAt: entry.expiresAt,
    source: entry.source,
    reason: entry.reason,
  };
}

/** 创建异步 Core WorkspaceTrustPolicy。 */
export function createNodeTrustPolicy(options: NodeTrustPolicyOptions): WorkspaceTrustPolicy {
  const store = createNodeTrustStore(options);
  return {
    async getTrustStatus(workspaceRoot: string): Promise<WorkspaceTrustEntry> {
      return toCoreEntry(store.getTrustEntry(workspaceRoot));
    },
    async isTrusted(workspaceRoot: string): Promise<boolean> {
      return store.isTrusted(workspaceRoot);
    },
    async grantTrust(workspaceRoot: string, settings?: { expiresAt?: number; source?: WorkspaceTrustEntry["source"]; reason?: string }): Promise<WorkspaceTrustEntry> {
      return toCoreEntry(store.grantTrust(workspaceRoot, settings));
    },
    async denyTrust(workspaceRoot: string, reason?: string): Promise<WorkspaceTrustEntry> {
      return toCoreEntry(store.denyTrust(workspaceRoot, reason));
    },
    async revokeTrust(workspaceRoot: string): Promise<WorkspaceTrustEntry> {
      return toCoreEntry(store.revokeTrust(workspaceRoot));
    },
    async listTrustEntries(): Promise<WorkspaceTrustEntry[]> {
      return store.listTrustEntries().map(toCoreEntry);
    },
  };
}
