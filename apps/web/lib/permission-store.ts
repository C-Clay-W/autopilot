/**
 * 持久化 Agent 授权：保存 session/workspace scope、策略版本、撤销与审计，不保存工具完整输入。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PERMISSION_FILE = path.resolve(process.cwd(), ".local/agent-permissions.json");
const POLICY_VERSION = "p3-v1";
const EXPIRED_GRANT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let lastExpiredGrantCleanupAt = 0;

export type PersistentGrantScope = "allow_session" | "allow_workspace";
export interface PersistentGrant {
  id: string;
  scope: PersistentGrantScope;
  workspaceRoot: string;
  sessionId?: string;
  toolName: string;
  constraint: string;
  risk?: string;
  policyVersion: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
}

/** 确保权限文件的父目录存在。 */
function ensurePermissionDir(): void {
  fs.mkdirSync(path.dirname(PERMISSION_FILE), { recursive: true });
}

/** 读取授权数组；损坏文件不静默覆盖，直接报错以避免扩大权限。 */
function readGrants(): PersistentGrant[] {
  ensurePermissionDir();
  if (!fs.existsSync(PERMISSION_FILE)) return [];
  const parsed = JSON.parse(fs.readFileSync(PERMISSION_FILE, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Agent 授权存储格式无效");
  return parsed as PersistentGrant[];
}

/** 原子写入完整授权列表。 */
function writeGrants(grants: PersistentGrant[]): void {
  ensurePermissionDir();
  const temporaryPath = `${PERMISSION_FILE}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(grants, null, 2), "utf8");
    fs.renameSync(temporaryPath, PERMISSION_FILE);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

/** canonical 化服务端工作区；grant 比较不接受未解析的相对路径或大小写漂移。 */
function normalizeWorkspaceRoot(workspaceRoot: string): string {
  const resolved = fs.realpathSync.native(path.resolve(workspaceRoot));
  const normalized = path.normalize(resolved).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** 规范化 path/program 约束，拒绝绝对路径、UNC、NUL 与向上逃逸的历史/输入记录。 */
function normalizePermissionConstraint(constraint: string): string {
  if (constraint.startsWith("path:")) {
    const rawPath = constraint.slice("path:".length).replace(/\\/g, "/");
    if (!rawPath || rawPath.includes("\0") || path.posix.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath)) {
      throw new Error("授权 path constraint 必须是工作区内相对路径");
    }
    const normalizedPath = path.posix.normalize(rawPath).replace(/^\.\//, "");
    if (normalizedPath === ".." || normalizedPath.startsWith("../")) {
      throw new Error("授权 path constraint 不能逃离工作区");
    }
    return `path:${normalizedPath}`;
  }
  if (constraint.startsWith("program:")) {
    const program = constraint.slice("program:".length).trim();
    if (!program || /[\\/\0]/.test(program)) throw new Error("授权 program constraint 不合法");
    return `program:${process.platform === "win32" ? program.toLowerCase() : program}`;
  }
  return constraint;
}

/** 定期物理删除已过期 grant；撤销记录保留给审计，不在此处删除。 */
export async function cleanupExpiredGrants(now = Date.now()): Promise<number> {
  if (now - lastExpiredGrantCleanupAt < EXPIRED_GRANT_CLEANUP_INTERVAL_MS) return 0;
  const grants = readGrants();
  const active = grants.filter((grant) => !grant.expiresAt || grant.expiresAt > now);
  const removed = grants.length - active.length;
  if (removed > 0) writeGrants(active);
  lastExpiredGrantCleanupAt = now;
  return removed;
}

/** 读取 grant 前触发受节流的过期清理，并始终在逻辑层排除过期记录。 */
async function getCurrentGrants(now = Date.now()): Promise<PersistentGrant[]> {
  await cleanupExpiredGrants(now);
  return readGrants().filter((grant) => !grant.expiresAt || grant.expiresAt > now);
}

/** 创建真实 session/workspace grant；allow_once 不会进入本存储。 */
export async function createPersistentGrant(input: {
  scope: PersistentGrantScope;
  workspaceRoot: string;
  sessionId: string;
  toolName: string;
  constraint: string;
  risk?: string;
}): Promise<PersistentGrant> {
  const grants = await getCurrentGrants();
  const grant: PersistentGrant = {
    id: crypto.randomUUID(),
    ...input,
    workspaceRoot: normalizeWorkspaceRoot(input.workspaceRoot),
    constraint: normalizePermissionConstraint(input.constraint),
    policyVersion: POLICY_VERSION,
    createdAt: Date.now(),
  };
  grants.push(grant);
  writeGrants(grants);
  return grant;
}

/** 读取某 session 与 workspace 可见的授权，供 UI 展示。 */
export async function listPersistentGrants(sessionId: string, workspaceRoot: string): Promise<PersistentGrant[]> {
  const canonicalWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  return (await getCurrentGrants()).filter((grant) => normalizeWorkspaceRoot(grant.workspaceRoot) === canonicalWorkspaceRoot && (grant.scope === "allow_workspace" || grant.sessionId === sessionId));
}

/** 撤销授权但保留审计记录。 */
export async function revokePersistentGrant(grantId: string, sessionId: string, workspaceRoot: string): Promise<boolean> {
  await cleanupExpiredGrants();
  const grants = readGrants();
  const canonicalWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  const grant = grants.find((item) => item.id === grantId && normalizeWorkspaceRoot(item.workspaceRoot) === canonicalWorkspaceRoot && (item.scope === "allow_workspace" || item.sessionId === sessionId));
  if (!grant || grant.revokedAt) return false;
  grant.revokedAt = Date.now();
  writeGrants(grants);
  return true;
}
