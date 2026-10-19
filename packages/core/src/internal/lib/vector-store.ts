/**
 * LanceDB 向量数据库单例管理（单例：全局只创建一个 LanceDB 连接实例）
 * - 持久化路径：./lancedb/（项目根目录）
 * - 使用 @lancedb/lancedb 原生 Node.js 绑定
 * - 云端文本向量维度：1024，PDF 页级融合向量维度：1152
 *
 * 数据存储策略：
 * - 所有业务数据（Excel 行等）统一存入 metadata JSON 字符串列
 * - 不做列展开（兼容任意结构的数据共存一张表）
 * - 搜索走纯语义向量搜索（text 字段），不依赖 SQL WHERE 精确过滤，这是RAG标准做法，精确查找是MySQL的范畴，RAG只做语义检索。
 * - 精确过滤仅适用于入库时手动提取的标量 fields 列（当前已弃用 fields 机制）
 * 
 * noted by clayw on 20260708
 * 
 */
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import * as lancedb from "@lancedb/lancedb";
import type { VectorInput, VectorRecord, VectorOutput, SearchFilter } from "../types";
import { RagError } from "../rag-error";

/** 每个显式 RAG Root 复用自己的连接，禁止并发 Workspace 共用全局数据库。 */
const connections = new Map<string, lancedb.Connection>();
const vectorStorePathContext = new AsyncLocalStorage<string>();

/** 在一次异步调用链内固定向量库路径，供 AgentFlow 的所有深层 helper 复用。 */
export function withVectorStorePath<T>(dbPath: string, operation: () => Promise<T>): Promise<T> {
  return vectorStorePathContext.run(path.resolve(dbPath), operation);
}

/**
 * 初始化 LanceDB 连接（单例）
 * 多次调用不会创建新连接，复用已有实例
 */
export async function initVectorStore(dbPath?: string): Promise<lancedb.Connection> {
  const selectedPath = path.resolve(dbPath ?? vectorStorePathContext.getStore() ?? process.env.LANCE_DB_PATH ?? "./lancedb");
  const existing = connections.get(selectedPath);
  if (existing?.isOpen()) return existing;
  const connection = await lancedb.connect(selectedPath);
  connections.set(selectedPath, connection);
  return connection;
}

/**
 * 关闭 LanceDB 连接（释放资源）
 */
export async function closeVectorStore(): Promise<void> {
  for (const connection of connections.values()) connection.close();
  connections.clear();
}

/** 删除或重试前按稳定记录 ID 幂等替换页级向量。 */
export async function upsertVectors(tableName: string, vectors: VectorInput[]): Promise<number> {
  if (!vectors.length) return 0;
  const db = await initVectorStore();
  if ((await db.tableNames()).includes(tableName)) {
    const table = await db.openTable(tableName);
    for (let offset = 0; offset < vectors.length; offset += 100) {
      const condition = vectors.slice(offset, offset + 100)
        .map(function byId(vector) { return `id = '${escapeLanceString(vector.id)}'`; })
        .join(" OR ");
      if (condition) await table.delete(condition);
    }
  }
  return insertVectors(tableName, vectors);
}

/**
 * 构建 LanceDB SQL WHERE 子句
 * 应用于精确标量列过滤（非 metadata JSON），当前已弃用——搜索纯走语义向量匹配。
 * 如需恢复精确过滤，需将业务字段提取为独立列并重建表。
 *
 * added by clayw on 20260708
 * 
 * @param filters 过滤条件数组
 * @returns SQL WHERE 字符串（不含 "WHERE" 关键字）
 */
export function buildWhereClause(filters: SearchFilter[]): string {
  if (!filters || filters.length === 0) return "";

  const parts: string[] = [];

  for (const f of filters) {
    // LanceDB 使用反引号包裹列名（双引号对中文列名无效）
    const fieldExpr = `\`${f.field}\``;

    switch (f.op) {
      case "=":
      case "!=":
      case ">":
      case ">=":
      case "<":
      case "<=":
        if (f.value === null || f.value === undefined) {
          const safetyExpr = `\`${f.field}\``;
          parts.push(f.op === "=" ? `${safetyExpr} IS NULL` : `${safetyExpr} IS NOT NULL`);
        } else if (typeof f.value === "string") {
          parts.push(`${fieldExpr} ${f.op} '${f.value.replace(/'/g, "''")}'`);
        } else {
          parts.push(`${fieldExpr} ${f.op} ${f.value}`);
        }
        break;

      case "in": {
        const values = Array.isArray(f.value) ? f.value : [f.value];
        const formatted = values
          .map((v) => (typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v)))
          .join(", ");
        parts.push(`${fieldExpr} IN (${formatted})`);
        break;
      }

      case "like":
        parts.push(`${fieldExpr} LIKE '${String(f.value).replace(/'/g, "''")}'`);
        break;
    }
  }

  return parts.join(" AND ");
}

/**
 * 获取或创建指定名称的向量表
 *
 * 如果表已存在则直接打开。
 * 如果表不存在，则根据第一条数据的 fields 和 metadata 推断 schema 并创建。
 *
 * Stage 4 前没有真实数据 recall/latency 基线，因此不复制固定 IVF/nprobes 参数；
 * 在 Stage 7 真实基准冻结参数前保持 LanceDB 默认精确检索。
 *
 * @param name 表名
 * @param sampleFields （已弃用）用于推断标量列 schema，当前不用
 * @param sampleMetadata 首条数据的 metadata，用于建表时推断 JSON 字符串列
 */
export async function getTable(
  name: string,
  sampleFields?: Record<string, unknown>,
  sampleMetadata?: Record<string, unknown>,
  sampleVectorDimension = 1024
): Promise<lancedb.Table> {
  const db = await initVectorStore();
  const tableNames = await db.tableNames();

  if (tableNames.includes(name)) {
    return await db.openTable(name);
  }

  // 使用第一条数据的 metadata 字符串建表
  const placeholder: Record<string, unknown> = {
    id: "__placeholder__",
    vector: new Array(sampleVectorDimension).fill(0),
    text: "",
    metadata: JSON.stringify(sampleMetadata ?? {}),
  };

  if (sampleFields) {
    for (const [key, value] of Object.entries(sampleFields)) {

      // @deprecated — fields 机制已弃用，所有业务数据统一存入 metadata JSON 字符串
      // 保留此代码仅用于兼容旧数据。新入库数据不走此分支。
      // 标量值可直接在 LanceDB 的 .where() 中写 SQL 条件过滤（=、!=、>、>=、<、<=、IN、LIKE 等）
      // 但当前搜索策略已改为纯语义搜索，不再依赖 SQL WHERE 精确过滤。
      if (value === null || value === undefined) {
        placeholder[key] = null;
      } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        placeholder[key] = value;
      }
    }
  }

  const table = await db.createTable(name, [placeholder], {
    mode: "create",
    existOk: false,
  });

  // 删除占位数据，保留空表结构
  await table.delete("id = '__placeholder__'");

  return table;
}

/**
 * 读取 LanceDB 表的向量维度，优先从已有记录读取，空表则读取 schema。
 *
 * @param table 目标 LanceDB 表
 * @returns 向量维度；无法识别时返回 null
 */
async function getTableVectorDimension(table: lancedb.Table): Promise<number | null> {
  const rows = await table.query().limit(1).toArray();
  const row = rows[0] as Record<string, unknown> | undefined;
  if (Array.isArray(row?.vector)) {
    return row.vector.length;
  }

  const schema = await table.schema();
  const vectorField = (schema.fields || []).find((field: any) => field.name === "vector");
  const dimension = Number((vectorField?.type as any)?.listSize);
  return Number.isInteger(dimension) && dimension > 0 ? dimension : null;
}

/**
 * 校验目标表向量维度，阻止不同模型的同名表静默混写或查询。
 *
 * @param table 目标 LanceDB 表
 * @param expectedDimension 本次写入或查询所要求的固定维度
 * @param tableName 目标表名，仅用于错误定位
 */
async function assertTableVectorDimension(
  table: lancedb.Table,
  expectedDimension: number,
  tableName: string
): Promise<void> {
  const actualDimension = await getTableVectorDimension(table);
  if (actualDimension !== null && actualDimension !== expectedDimension) {
    throw new RagError("RAG_VECTOR_SPACE_MISMATCH");
  }
}

/**
 * 校验目标表的完整 Embedding 空间，旧记录缺少空间 ID 时退回 Provider 兼容检查。
 *
 * @param table 目标 LanceDB 表
 * @param expectedMetadata 本次写入记录声明的 Embedding 元数据
 */
async function assertTableEmbeddingSpace(
  table: lancedb.Table,
  expectedMetadata: Record<string, unknown>
): Promise<void> {
  const expectedProvider = String(expectedMetadata.embeddingProvider ?? "");
  if (!expectedProvider) return;

  const rows = await table.query().limit(1).toArray();
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return;

  let metadata: Record<string, unknown> = {};
  if (typeof row.metadata === "string") {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      throw new RagError("RAG_VECTOR_SPACE_MISMATCH");
    }
  } else if (row.metadata && typeof row.metadata === "object") {
    metadata = row.metadata as Record<string, unknown>;
  }

  if (metadata.embeddingProvider !== expectedProvider) {
    throw new RagError("RAG_VECTOR_SPACE_MISMATCH");
  }
  const actualSpaceId = typeof metadata.embeddingSpaceId === "string" ? metadata.embeddingSpaceId : "";
  const expectedSpaceId = typeof expectedMetadata.embeddingSpaceId === "string" ? expectedMetadata.embeddingSpaceId : "";
  if (actualSpaceId && expectedSpaceId && actualSpaceId !== expectedSpaceId) throw new RagError("RAG_VECTOR_SPACE_MISMATCH");
}

/**
 * 批量插入向量数据
 *
 * metadata 统一存为 JSON 字符串（兼容任意列结构的数据共存一张表），
 * 不再将 fields 展开为独立列。
 *
 * @param tableName 表名
 * @param vectors 向量数组（含 id、vector、text、metadata）
 */
export async function insertVectors(
  tableName: string,
  vectors: VectorInput[]
): Promise<number> {
  if (vectors.length === 0) return 0;

  const expectedDimension = vectors[0].vector.length;
  if (expectedDimension === 0 || vectors.some((vector) => vector.vector.length !== expectedDimension)) {
    throw new Error(`写入 ${tableName} 失败：同一批向量维度不一致`);
  }

  // 提取第一条数据的 fields 和 metadata 作为建表参考
  const sampleFields = vectors.length > 0 ? vectors[0].fields : undefined;
  const sampleMetadata = vectors.length > 0 ? vectors[0].metadata : undefined;
  const sampleVectorDimension = vectors.length > 0 ? vectors[0].vector.length : 1024;
  const table = await getTable(tableName, sampleFields, sampleMetadata, sampleVectorDimension);
  await assertTableVectorDimension(table, expectedDimension, tableName);
  await assertTableEmbeddingSpace(table, vectors[0].metadata ?? {});

  const records: VectorRecord[] = vectors.map((v) => {
    const record: VectorRecord = {
      id: v.id,
      vector: v.vector,
      text: v.text,
      metadata: JSON.stringify(v.metadata ?? {}),
    };

    // 将 fields 中的标量值直接挂到 record 上（作为独立列）
    if (v.fields) {
      for (const [key, value] of Object.entries(v.fields)) {
        if (value === null || value === undefined) {
          (record as any)[key] = null;
        } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          (record as any)[key] = value;
        }
      }
    }

    return record;
  });

  const result = await table.add(records);
  return records.length;
}

/**
 * 向量搜索（纯向量搜索，无过滤）
 *
 * @param tableName 表名
 * @param queryVector 查询向量
 * @param topK 返回 topK 条结果
 * @returns 搜索结果数组（id + score + metadata），score ∈ [-1, 1]
 */
export async function searchVectors(
  tableName: string,
  queryVector: number[],
  topK: number = 5
): Promise<VectorOutput[]> {
  return searchVectorsWithFilter(tableName, queryVector, topK);
}


// 下边是新增的，保证了检索结果的准确性！！ added by clayw on 20260707

/**
 * 向量搜索（纯语义搜索，不做精确过滤）
 *
 * RAG 标准做法：语义相似度排序，所有业务数据已拼接为 text 字段并向量化，
 * 不同列结构的数据共存一张表，不依赖 SQL WHERE 精确过滤。
 * 如需过滤，在查询结果中由用户自行判断原始 metadata。
 *
 * @param tableName 表名
 * @param queryVector 查询向量
 * @param topK 返回 topK 条结果
 * @param filters 可选的前置过滤条件（仅对独立标量列生效，当前 metadata 为 JSON 字符串，不适用）
 * @returns 搜索结果数组（id + score + metadata），score ∈ [-1, 1]
 *
 * @example
 * // 纯语义搜索
 * searchVectors("employee_test", queryVec, 5);
 */
export async function searchVectorsWithFilter(
  tableName: string,
  queryVector: number[],
  topK: number = 5,
  filters?: SearchFilter[]
): Promise<VectorOutput[]> {
  const table = await initVectorStore().then((db) => db.openTable(tableName));
  await assertTableVectorDimension(table, queryVector.length, tableName);

  let query = table.search(queryVector).limit(topK);

  // 如果有过滤条件，通过 .where() 做前置过滤
  if (filters && filters.length > 0) {
    const whereClause = buildWhereClause(filters);
    if (whereClause) {
      query = query.where(whereClause);
    }
  }

  const results = await query.toArray();

  return results.map((row: Record<string, unknown>) => {
    const dist = row._distance as number | undefined;
    // 归一化向量：L2² = 2(1 - cosθ) → cosθ = 1 - L2²/2
    // 建 cosine 索引后 _distance 即为余弦距离，此公式仍然正确（L2²≈0 → cosθ≈1）
    const score = dist !== undefined ? 1 - (dist * dist) / 2 : 0;

    return {
      id: row.id as string,
      score: Math.max(-1, Math.min(1, score)),
      text: row.text as string,
      metadata: typeof row.metadata === "string"
        ? JSON.parse(row.metadata as string)
        : (row.metadata as Record<string, unknown> ?? {}),
    };
  });
}

/**
 * 读取表中首条记录的 metadata，用于判断表的向量模型类型
 */
export async function getTableSampleMetadata(tableName: string): Promise<Record<string, unknown> | null> {
  const table = await initVectorStore().then((db) => db.openTable(tableName));
  const rows = await table.query().limit(1).toArray();
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  if (typeof row.metadata === "string") {
    try {
      return JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return (row.metadata as Record<string, unknown>) ?? null;
}

/**
 * 从 PDF 页级表中按页码读取一条页面记录，用于明确页码问题的精确定位。
 *
 * @param tableName PDF 页级向量表名
 * @param pageNumber 指定页码；传入 "last" 时返回页码最大的页面
 * @returns 对应 PDF 页记录；找不到时返回 null
 */
export async function getPdfPage(
  tableName: string,
  pageNumber: number | "last"
): Promise<VectorOutput | null> {
  const table = await initVectorStore().then((db) => db.openTable(tableName));
  const rows = await table.query().toArray();
  const pdfRows = rows.map((row: Record<string, unknown>) => {
    let metadata: Record<string, unknown> = {};
    if (typeof row.metadata === "string") {
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        return null;
      }
    } else if (row.metadata && typeof row.metadata === "object") {
      metadata = row.metadata as Record<string, unknown>;
    }

    const currentPageNumber = Number(metadata.pageNumber);
    if (metadata.source !== "pdf" || !Number.isInteger(currentPageNumber) || currentPageNumber < 1) {
      return null;
    }
    return { row, metadata, pageNumber: currentPageNumber };
  }).filter((item): item is { row: Record<string, unknown>; metadata: Record<string, unknown>; pageNumber: number } => item !== null);

  const matched = pageNumber === "last"
    ? pdfRows.reduce<typeof pdfRows[number] | null>((latest, item) => (!latest || item.pageNumber > latest.pageNumber ? item : latest), null)
    : pdfRows.find((item) => item.pageNumber === pageNumber) ?? null;

  if (!matched) return null;
  return {
    id: String(matched.row.id || ""),
    score: 1,
    text: String(matched.row.text || ""),
    metadata: matched.metadata,
  };
}

/**
 * 获取表中记录总数
 */
export async function countRows(tableName: string): Promise<number> {
  const table = await initVectorStore().then((db) => db.openTable(tableName));
  return table.countRows();
}

/**
 * 列出 LanceDB 数据表名称，供只读工具和多表检索编排复用同一连接。
 */
export async function listVectorTables(): Promise<string[]> {
  const db = await initVectorStore();
  return db.tableNames();
}

/**
 * 读取表结构与行数；向量字段只返回维度，不返回向量内容。
 */
export async function describeVectorTable(tableName: string): Promise<{ name: string; totalRows: number; columns: { name: string; type: string }[]; vectorDimension: number | null }> {
  const db = await initVectorStore();
  const table = await db.openTable(tableName);
  const schema = await table.schema();
  const vectorField = (schema.fields || []).find((field: any) => field.name === "vector");
  const vectorDimension = Number((vectorField?.type as any)?.listSize);
  return {
    name: tableName,
    totalRows: await table.countRows(),
    columns: (schema.fields || []).filter((field: any) => field.name !== "vector").map((field: any) => ({ name: field.name, type: String(field.type || "unknown") })),
    vectorDimension: Number.isInteger(vectorDimension) && vectorDimension > 0 ? vectorDimension : null,
  };
}

/**
 * 分页读取原始行并隐藏内部距离与向量数据，metadata 保持对象形式。
 */
export async function listVectorRows(tableName: string, offset: number, limit: number, filters?: SearchFilter[]): Promise<Record<string, unknown>[]> {
  const db = await initVectorStore();
  const table = await db.openTable(tableName);
  let query = table.query().limit(limit).offset(offset);
  if (filters && filters.length > 0) {
    query = query.where(buildWhereClause(filters));
  }
  const rows = await query.toArray();
  return rows.map((row: Record<string, unknown>) => {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith("_") || key === "vector") continue;
      if (key === "metadata" && typeof value === "string") {
        try { cleaned[key] = JSON.parse(value); } catch { cleaned[key] = {}; }
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  });
}

/**
 * 读取表中的文本和 metadata，供同表 BM25 索引构建使用。
 * 不返回向量，避免混合检索重复传输或泄露高维向量数据。
 */
export async function listVectorTextRecords(tableName: string): Promise<VectorOutput[]> {
  const table = await initVectorStore().then((db) => db.openTable(tableName));
  const rows = await table.query().toArray();
  return rows.map((row: Record<string, unknown>) => {
    let metadata: Record<string, unknown> = {};
    if (typeof row.metadata === "string") {
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        metadata = {};
      }
    } else if (row.metadata && typeof row.metadata === "object") {
      metadata = row.metadata as Record<string, unknown>;
    }
    return {
      id: String(row.id ?? ""),
      score: 0,
      text: String(row.text ?? ""),
      metadata,
    };
  });
}

/**
 * 清空表（删除后重建）
 */
export async function clearTable(tableName: string): Promise<void> {
  const db = await initVectorStore();
  const tableNames = await db.tableNames();
  if (tableNames.includes(tableName)) {
    await db.dropTable(tableName);
  }
}

/** 转义 LanceDB 删除条件中的字符串字面量，避免资源名称影响查询语义。 */
function escapeLanceString(value: string): string {
  return value.replace(/'/g, "''");
}

/** 读取一条记录的 metadata，兼容 LanceDB 保存为 JSON 字符串和对象的两种形式。 */
function readRecordMetadata(row: Record<string, unknown>): Record<string, unknown> {
  if (typeof row.metadata === "string") {
    try { return JSON.parse(row.metadata) as Record<string, unknown>; } catch { return {}; }
  }
  return row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
}

/** 资源配置页展示的文档级聚合信息，不包含向量或文本内容。 */
export interface KnowledgeResource {
  tableName: string;
  fileName: string;
  source: string;
  recordCount: number;
}

/** 指定文档删除后的可审计结果。 */
export interface DeleteKnowledgeResourceResult {
  tableName: string;
  fileName: string;
  deletedRecordCount: number;
  deletedImageCount: number;
  removedTable: boolean;
}

/** 列出非数据库快照 LanceDB 表中的已入库文档，供管理页按文件展示和删除。 */
export async function listKnowledgeResources(): Promise<KnowledgeResource[]> {
  const db = await initVectorStore();
  const tableNames = await db.tableNames();
  const groupedResources = new Map<string, KnowledgeResource>();
  for (const tableName of tableNames) {
    if (tableName.startsWith("mysql_")) continue;
    const table = await db.openTable(tableName);
    const rows = await table.query().toArray() as Record<string, unknown>[];
    for (const row of rows) {
      const metadata = readRecordMetadata(row);
      const fileName = typeof metadata.fileName === "string" ? metadata.fileName.trim() : "";
      if (!fileName) continue;
      const source = typeof metadata.source === "string" ? metadata.source : "document";
      const key = `${tableName}\u0000${fileName}\u0000${source}`;
      const existing = groupedResources.get(key);
      if (existing) existing.recordCount += 1;
      else groupedResources.set(key, { tableName, fileName, source, recordCount: 1 });
    }
  }
  return [...groupedResources.values()].sort((left, right) => (
    left.fileName.localeCompare(right.fileName, "zh-CN") || left.tableName.localeCompare(right.tableName)
  ));
}

/** 删除同一 LanceDB 表内指定文件的全部向量记录，并清理其 PDF 页面图片。 */
export async function deleteKnowledgeResource(tableName: string, fileName: string): Promise<DeleteKnowledgeResourceResult> {
  if (!/^[a-zA-Z0-9_-]+$/.test(tableName) || tableName.startsWith("mysql_")) throw new Error("不允许删除数据库快照资源");
  if (!fileName || path.basename(fileName) !== fileName) throw new Error("文件名不合法");
  const db = await initVectorStore();
  const tableNames = await db.tableNames();
  if (!tableNames.includes(tableName)) throw new Error("资源表不存在");
  const table = await db.openTable(tableName);
  const rows = await table.query().toArray() as Record<string, unknown>[];
  const matchedRows = rows.filter((row) => readRecordMetadata(row).fileName === fileName);
  const recordIds = matchedRows.map((row) => String(row.id ?? "")).filter(Boolean);
  if (!recordIds.length) return { tableName, fileName, deletedRecordCount: 0, deletedImageCount: 0, removedTable: false };
  for (let offset = 0; offset < recordIds.length; offset += 100) {
    const condition = recordIds.slice(offset, offset + 100).map((id) => `id = '${escapeLanceString(id)}'`).join(" OR ");
    await table.delete(condition);
  }
  const imageFileNames = matchedRows.map((row) => readRecordMetadata(row).imageFileName).filter((value): value is string => typeof value === "string");
  const { deleteStoredImagesByName } = await import("./file-storage");
  const deletedImageCount = await deleteStoredImagesByName(imageFileNames);
  const removedTable = await table.countRows() === 0;
  if (removedTable) await db.dropTable(tableName);
  return { tableName, fileName, deletedRecordCount: recordIds.length, deletedImageCount, removedTable };
}

/** 按新 manifest 的不透明资源 ID 删除一个表内的页/块记录。 */
export async function deleteKnowledgeResourceById(tableName: string, resourceId: string): Promise<number> {
  if (!/^[a-zA-Z0-9_-]+$/.test(tableName) || tableName.startsWith("mysql_")) throw new RagError("RAG_RESOURCE_NOT_FOUND");
  if (!/^resource_[a-f0-9]{32}$/.test(resourceId)) throw new RagError("RAG_RESOURCE_NOT_FOUND");
  const db = await initVectorStore();
  if (!(await db.tableNames()).includes(tableName)) return 0;
  const table = await db.openTable(tableName);
  const rows = await table.query().toArray() as Record<string, unknown>[];
  const ids = rows
    .filter(function sameResource(row) { return readRecordMetadata(row).resourceId === resourceId; })
    .map(function recordId(row) { return String(row.id ?? ""); })
    .filter(Boolean);
  for (let offset = 0; offset < ids.length; offset += 100) {
    const condition = ids.slice(offset, offset + 100).map(function byId(id) { return `id = '${escapeLanceString(id)}'`; }).join(" OR ");
    if (condition) await table.delete(condition);
  }
  if (ids.length && await table.countRows() === 0) await db.dropTable(tableName);
  return ids.length;
}
