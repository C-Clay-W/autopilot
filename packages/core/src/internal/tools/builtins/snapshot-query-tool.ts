/**
 * snapshot_query 工具：只对已发布的单库 SQLite 快照执行受校验的 SELECT/JOIN/聚合查询。
 */
import { z } from "zod";
import type { DatabaseSnapshotReadCapability, SnapshotQueryResult } from "../../database-snapshot";
import { DATABASE_ERROR_CODES, toDatabaseError } from "../../database-error";
import { createToolError } from "../tool-error";
import type { AgentToolDefinition } from "../types";

const snapshotQuerySchema = z.object({
  sql: z.string().trim().min(1).max(8_000),
}).strict();

/** @deprecated 仅供旧调用方恢复；新 Turn 只注册 database_search。 */
export function createSnapshotQueryTool(capability: DatabaseSnapshotReadCapability): AgentToolDefinition<z.infer<typeof snapshotQuerySchema>, SnapshotQueryResult> {
  return {
    name: "snapshot_query",
    description: "仅在当前已选数据库的离线 SQLite 快照中执行单条 SELECT/JOIN/聚合查询。禁止写入、DDL、多语句、跨库和敏感表；最多返回 200 行。",
    inputSchema: snapshotQuerySchema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 1, resourceKey: "snapshot:query" }, retry: { safe: false } },
    createActionFacts: () => ({ toolName: "snapshot_query", effect: "none", destructive: false, operation: "query", risk: "read_only" }),
    async execute(input) {
      try {
        return await capability.snapshotQuery(input.sql);
      } catch (error) {
        const databaseError = toDatabaseError(error, DATABASE_ERROR_CODES.QUERY_FAILED);
        throw createToolError(databaseError.code, databaseError.message);
      }
    },
    serializeOutput(output) { return output; },
  };
}
