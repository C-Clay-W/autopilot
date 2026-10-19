/**
 * lancedb_query 工具：限定为列举、描述与分页读行，拒绝模型传入原始 SQL 或向量。
 */
import { z } from "zod";
import { describeVectorTable, listVectorRows, listVectorTables } from "../../lib/vector-store";
import type { AgentToolDefinition } from "../types";

const filterSchema = z.object({
  field: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/),
  op: z.enum(["=", "!=", ">", ">=", "<", "<=", "in", "like"]),
  value: z.union([z.string().max(1_000), z.number(), z.boolean(), z.null(), z.array(z.union([z.string().max(1_000), z.number(), z.boolean()])).min(1).max(20)]),
}).strict();

const lancedbQuerySchema = z.object({
  operation: z.enum(["list_tables", "describe_table", "list_rows"]),
  tableName: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(20),
  filters: z.array(filterSchema).max(10).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.operation !== "list_tables" && !input.tableName) ctx.addIssue({ code: "custom", message: "describe_table 和 list_rows 必须提供 tableName" });
});

/** 创建只读 LanceDB 浏览工具，使用结构化操作而非任意 where 语句。 */
export function createLanceDbQueryTool(): AgentToolDefinition<z.infer<typeof lancedbQuerySchema>, Record<string, unknown>> {
  return {
    name: "lancedb_query",
    description: "只读查看 LanceDB：列出数据表、描述表结构或分页读取已脱敏的原始行。",
    inputSchema: lancedbQuerySchema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 3, resourceKey: "lancedb:query" }, retry: { safe: true } },
    createActionFacts: () => ({ toolName: "lancedb_query", effect: "none", destructive: false, operation: "query", risk: "read_only" }),
    async execute(input) {
      if (input.operation === "list_tables") return { tables: await listVectorTables() };
      if (input.operation === "describe_table") return { table: await describeVectorTable(input.tableName!) };
      return { tableName: input.tableName, offset: input.offset, limit: input.limit, rows: await listVectorRows(input.tableName!, input.offset, input.limit, input.filters) };
    },
    serializeOutput(output) { return output; },
  };
}
