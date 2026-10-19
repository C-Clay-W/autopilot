/**
 * Node MCP capability loader：trust 后读取 workspace `.autopilot/mcp.json`，不启动子进程。
 */

import fs from "node:fs";
import path from "node:path";
import { parseMcpConfig, type McpCapability } from "@autopilot-agent/core";

/** 从 canonical workspaceRoot 读取并解析 MCP 配置。 */
export function loadMcpConfigFromWorkspace(workspaceRoot: string): McpCapability | undefined {
  const configPath = path.join(workspaceRoot, ".autopilot", "mcp.json");
  if (!fs.existsSync(configPath)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
  const capability = parseMcpConfig(raw);
  capability.configPath = configPath;
  return capability.servers.length > 0 ? capability : undefined;
}
