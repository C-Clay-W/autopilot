/**
 * Agent 存储配额：维护实例级上限并只统计 .local/agent，绝不扫描或回收 RAG、Runtime、SQLite 快照等数据资产。
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_HARD_LIMIT = 5 * 1024 * 1024 * 1024;
const MIN_HARD_LIMIT = 256 * 1024 * 1024;
const MAX_HARD_LIMIT = 100 * 1024 * 1024 * 1024;
const AGENT_ROOT = path.resolve(process.cwd(), ".local", "agent");
const SETTINGS_PATH = path.join(AGENT_ROOT, "quota-settings.json");

export interface AgentStorageQuota { usedBytes: number; status: "healthy" | "warning" | "degraded"; hardLimit: number; softLimit: number; targetLimit: number; minHardLimit: number; maxHardLimit: number; }

/** 读取本机服务端的全局配额设置；损坏或不存在的配置回退到 5 GiB 默认值。 */
function getConfiguredHardLimit(): number {
  try {
    const value = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as { hardLimit?: unknown };
    if (typeof value.hardLimit === "number" && Number.isSafeInteger(value.hardLimit) && value.hardLimit >= MIN_HARD_LIMIT && value.hardLimit <= MAX_HARD_LIMIT) return value.hardLimit;
  } catch { /* 首次运行或配置损坏时使用默认值。 */ }
  return DEFAULT_HARD_LIMIT;
}

/** 原子保存本机服务端的全局配额设置，避免写入中断留下半个 JSON 文件。 */
function saveConfiguredHardLimit(hardLimit: number): void {
  fs.mkdirSync(AGENT_ROOT, { recursive: true });
  const temporaryPath = `${SETTINGS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify({ hardLimit }), "utf8");
  fs.renameSync(temporaryPath, SETTINGS_PATH);
}

/** 校验并保存用户设置的实例级上限；配额立即生效，现有数据在下次写入预检时按既有回收规则处理。 */
export function setAgentStorageHardLimit(hardLimit: number): AgentStorageQuota {
  if (!Number.isSafeInteger(hardLimit) || hardLimit < MIN_HARD_LIMIT || hardLimit > MAX_HARD_LIMIT) throw new Error(`存储上限必须在 ${MIN_HARD_LIMIT} 到 ${MAX_HARD_LIMIT} 字节之间`);
  saveConfiguredHardLimit(hardLimit);
  return reconcileAgentStorage();
}

/** 仅递归统计明确允许的 Agent 自维护根目录，不将数据库快照纳入配额。 */
function measureDirectory(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const item = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) total += measureDirectory(item);
    if (entry.isFile() && !entry.isSymbolicLink()) total += fs.statSync(item).size;
  }
  return total;
}

/** 实测 Agent 已占用空间；quota.json 仅可作为后续优化清单，不能替代此检查。 */
export function reconcileAgentStorage(): AgentStorageQuota {
  const usedBytes = measureDirectory(AGENT_ROOT);
  const hardLimit = getConfiguredHardLimit();
  const softLimit = Math.floor(hardLimit * 0.9);
  const targetLimit = Math.floor(hardLimit * 0.8);
  const status = usedBytes >= hardLimit ? "degraded" : usedBytes >= softLimit ? "warning" : "healthy";
  return { usedBytes, status, hardLimit, softLimit, targetLimit, minHardLimit: MIN_HARD_LIMIT, maxHardLimit: MAX_HARD_LIMIT };
}

/** 在可选写入前执行保护性预检；无法回收到安全水位时拒绝非必要写入。 */
export function ensureAgentStorageWritable(requiredBytes = 0, essential = false): AgentStorageQuota {
  const quota = reconcileAgentStorage();
  if (!essential && quota.usedBytes + requiredBytes > quota.hardLimit) throw new Error("Agent 存储配额已降级，当前拒绝非必要记忆写入");
  return quota;
}
