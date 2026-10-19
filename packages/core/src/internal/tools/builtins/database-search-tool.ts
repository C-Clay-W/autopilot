/**
 * database_search 工具：通过宿主注入的只读能力执行语义检索或受校验 SQL，不接触连接凭据。
 */

import { z } from "zod";
import type { DatabaseSearchCapability, DatabaseSearchRequest, DatabaseSearchResult } from "../../database-search";
import { DATABASE_ERROR_CODES, toDatabaseError } from "../../database-error";
import { createToolError } from "../tool-error";
import type { AgentToolDefinition } from "../types";

const databaseSearchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("semantic"), query: z.string().trim().min(1).max(4_000), topK: z.number().int().min(1).max(20).optional() }).strict(),
  z.object({ kind: z.literal("sql"), sql: z.string().trim().min(1).max(8_000) }).strict(),
]);

/** 创建只绑定当前 Workspace 已登记数据源的只读数据库工具。 */
export function createDatabaseSearchTool(capability: DatabaseSearchCapability): AgentToolDefinition<DatabaseSearchRequest, DatabaseSearchResult> {
  return {
    name: "database_search",
    description: "查询当前已配置的只读数据库快照。自然语言筛选使用 kind=semantic，系统会优先执行确定性筛选/聚合并在无法确定时语义降级；明确的 SELECT/JOIN/聚合使用 kind=sql。禁止写入、DDL、多语句和连接参数。",
    inputSchema: databaseSearchSchema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 1, resourceKey: "database:search" }, retry: { safe: false } },
    createActionFacts: () => ({ toolName: "database_search", effect: "none", destructive: false, operation: "query", risk: "read_only" }),
    async execute(input) {
      try {
        return await capability.search(input);
      } catch (error) {
        const databaseError = toDatabaseError(error, DATABASE_ERROR_CODES.SEARCH_FAILED);
        throw createToolError(databaseError.code, databaseError.message);
      }
    },
    serializeOutput(output) { return output; },
  };
}
