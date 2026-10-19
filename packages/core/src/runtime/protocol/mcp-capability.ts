/**
 * runtime/protocol/mcp-capability.ts — MCP 能力协议
 *
 * 定义工作区 MCP 配置的结构化能力对象。Phase 2.5 只负责在 workspace trust 建立后
 * 读取并解析 `.autopilot/mcp.json`。配置本身不启动子进程；Runtime 仅在精确
 * server grant 命中后才会用它建立本机 stdio 连接。
 */

import { createHash } from "node:crypto";
import type { CredentialRef } from "../domain";

/** 单个 MCP server 的受控配置；对应 .autopilot/mcp.json 中的一项。 */
export interface McpServerConfig {
  /** server 唯一名称，用于展示与后续注册隔离。 */
  name: string;
  /** 启动命令；Trust 与精确 server grant 通过后由 MCP Runtime 执行。 */
  command: string;
  /** 命令参数。 */
  args?: string[];
  /** 相对工作区的启动目录；缺省为工作区根目录。 */
  cwd?: string;
  /** server 执行方式；缺省 host，只有显式 sandbox 才经 SandboxPort 隔离。 */
  execution?: "sandbox" | "host";
  /** 非敏感固定环境变量或由 CredentialStore 延迟解析的引用。 */
  env?: Record<string, string | { credentialRef: CredentialRef }>;
  /** 是否启用；缺省视为 true。 */
  enabled?: boolean;
}

/** 工作区加载后的 MCP 能力；trust 建立后由 CapabilityLoader.loadMcp 返回。 */
export interface McpCapability {
  /** 已解析的 server 列表。 */
  servers: McpServerConfig[];
  /** 配置来源路径，便于审计。 */
  configPath?: string;
}

/** MCP server 授权约束的稳定前缀；配置任何受控字段变化都会改变 hash。 */
export function getMcpServerConfigHash(server: McpServerConfig): string {
  return createHash("sha256").update(JSON.stringify({
    name: server.name,
    command: server.command,
    args: server.args ?? [],
    cwd: server.cwd ?? ".",
    env: Object.entries(server.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    execution: server.execution === "sandbox" ? "sandbox" : "host",
  })).digest("hex");
}

/** 返回绑定 serverName 与 configHash 的持久授权约束。 */
export function getMcpServerGrantConstraint(server: McpServerConfig): string {
  return `mcp-server:${server.name}:${getMcpServerConfigHash(server)}`;
}

/**
 * 把 .autopilot/mcp.json 的原始 JSON 解析为结构化 McpCapability。
 * 仅做字段校验与归一化，不读取文件系统，也不启动子进程。
 * @param raw 已 JSON.parse 的原始对象
 * @returns 结构化 MCP 能力；无可用 server 时返回空列表
 */
export function parseMcpConfig(raw: unknown): McpCapability {
  const servers: McpServerConfig[] = [];
  if (!raw || typeof raw !== "object") {
    return { servers };
  }

  // 兼容两种写法：{ mcpServers: { name: {...} } } 与 { servers: [ {...} ] }。
  const record = raw as Record<string, unknown>;
  const source = record.mcpServers ?? record.servers;

  if (Array.isArray(source)) {
    for (const item of source) {
      const server = normalizeServer(item);
      if (server) servers.push(server);
    }
  } else if (source && typeof source === "object") {
    for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
      const server = normalizeServer(value, name);
      if (server) servers.push(server);
    }
  }

  return { servers };
}

/**
 * 把单个 server 配置归一化为 McpServerConfig；非法配置跳过而非抛错。
 * @param value 原始配置项
 * @param fallbackName 对象写法时的键名
 */
function normalizeServer(value: unknown, fallbackName?: string): McpServerConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;

  const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : fallbackName;
  if (!name) return undefined;

  const command = typeof item.command === "string" ? item.command : undefined;
  if (!command) return undefined;

  const args = Array.isArray(item.args)
    ? item.args.filter((arg): arg is string => typeof arg === "string")
    : undefined;

  const cwd = typeof item.cwd === "string" && item.cwd.trim() ? item.cwd.trim() : undefined;
  const env: McpServerConfig["env"] = {};
  if (item.env && typeof item.env === "object" && !Array.isArray(item.env)) {
    for (const [key, entry] of Object.entries(item.env as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) continue;
      // 配置文件中的敏感环境变量一律拒绝，避免把 Key 写入 workspace 或 transcript。
      if (/(?:key|token|password|secret|credential)/iu.test(key) && typeof entry === "string") continue;
      if (typeof entry === "string") { env[key] = entry; continue; }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const ref = (entry as { credentialRef?: unknown }).credentialRef;
      if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue;
      const record = ref as { provider?: unknown; key?: unknown };
      if (typeof record.provider === "string" && record.provider && typeof record.key === "string" && record.key) env[key] = { credentialRef: { provider: record.provider, key: record.key } };
    }
  }

  const enabled = typeof item.enabled === "boolean" ? item.enabled : item.disabled === true ? false : undefined;

  return { name, command, args, cwd, execution: item.execution === "sandbox" ? "sandbox" : "host", env: Object.keys(env).length ? env : undefined, enabled };
}
