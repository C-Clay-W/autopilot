/**
 * 独立数据库检索能力：在宿主注入的只读数据库 Port 上执行通用确定性查询，并与文档 RAG 完全隔离。
 */

import type { DatabaseSnapshotReadCapability, SnapshotQueryResult, SnapshotTableDescription } from "./database-snapshot";
import { createDatabaseError, DATABASE_ERROR_CODES, toDatabaseError } from "./database-error";
import { tokenizeLexicalText } from "./lib/lexical-index";
import type { VectorOutput } from "./types";

const MAX_STRUCTURED_ROWS = 200;
const MAX_VALUE_SEARCH_TABLES = 8;
const MAX_VALUE_SEARCH_COLUMNS = 24;
const MAX_VALUE_SEARCH_TOKENS = 8;

/** 当前 Turn 是否允许向 Agent 注册数据库检索工具。 */
export interface DatabaseSearchPolicy {
  enabled: boolean;
}

/** 当前 Turn 的文档来源范围；新资源身份在 Workspace 资源阶段启用。 */
export interface RagSourcePolicy {
  focusedResourceId?: string;
  focusedPdfFileName?: string;
  allowCloudVision?: boolean;
}

/** 数据库检索的判别式输入；自然语言确定性检索与受控 SQL 共用一个公开 Tool。 */
export type DatabaseSearchRequest =
  | { kind: "semantic"; query: string; topK?: number }
  | { kind: "sql"; sql: string };

/** 数据库检索的独立结构化结果，不能伪装成文档 RAG evidence。 */
export type DatabaseSearchResult =
  | { kind: "semantic"; results: VectorOutput[]; snapshotStatus: "current" | "stale" | "unavailable" }
  | { kind: "sql"; columns: string[]; rows: Record<string, unknown>[]; involvedTables: string[]; truncated: boolean; snapshotStatus: "current" | "stale" };

/** 通用聚合意图，不绑定语言、表名或字段名。 */
export interface DatabaseAggregationKeyword {
  keywords: string[];
  kind: "count" | "sum" | "avg" | "max" | "min";
}

/** 由宿主声明的自然语言筛选操作符；Core 不预设任何语言关键词。 */
export interface DatabaseFilterOperatorKeyword {
  keywords: string[];
  operator: "equals" | "contains";
}

/** 由应用层注入的数据库查询档案；Core 不提供任何业务表或字段默认值。 */
export interface DatabaseQueryProfile {
  aggregationKeywords?: DatabaseAggregationKeyword[];
  columnAliases?: Record<string, Record<string, string>>;
  commentSuffixes?: string[];
  filterOperators?: DatabaseFilterOperatorKeyword[];
  tableAliases?: Record<string, string[]>;
  valueSeparators?: string[];
  valueStopwords?: string[];
}

/** 歧义规划器只能从当前安全 Schema 中选择表、列、操作符和值。 */
export interface DatabaseQueryPlan {
  tableName: string;
  columnName: string;
  value: string;
  operator: "equals" | "contains";
}

/** 歧义规划器接收的安全输入，不含连接信息、数据库名或样本行。 */
export interface DatabaseQueryPlannerInput {
  query: string;
  tables: SnapshotTableDescription[];
}

/** 创建数据库能力时可注入应用 Profile 与当前 Turn 已冻结的轻量规划器。 */
export interface CreateDatabaseSearchCapabilityOptions {
  profile?: DatabaseQueryProfile;
  planAmbiguousQuery?: (input: DatabaseQueryPlannerInput) => Promise<DatabaseQueryPlan | null>;
}

/** Host 在 Trust 后装配的只读数据库能力。 */
export interface DatabaseSearchCapability {
  search(request: DatabaseSearchRequest): Promise<DatabaseSearchResult>;
}

interface ColumnCandidate {
  tableName: string;
  columnName: string;
  columnType: string;
  value: string;
  operator: "equals" | "contains";
}

/** 转义受控 SQLite 标识符；Profile 和规划器都不能绕过标识符白名单。 */
function quoteIdentifier(identifier: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(identifier)) throw createDatabaseError(DATABASE_ERROR_CODES.IDENTIFIER_INVALID);
  return `"${identifier}"`;
}

/** 转义 LIKE 字面量中的引号、通配符和转义符，避免用户值扩大查询范围。 */
function escapeLikeLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_").replace(/'/g, "''");
}

/** 将筛选值规范化为稳定文本，同时保留多值分隔符供后续拆分。 */
function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** 判断快照列是否为数值亲和类型。 */
function isNumericType(type: string): boolean {
  return /int|real|decimal|numeric|float|double/i.test(type);
}

/** 返回列的通用候选别名；业务同义词只能来自应用 Profile。 */
function getColumnAliases(table: SnapshotTableDescription, columnName: string, comment: string, profile: DatabaseQueryProfile): string[] {
  const aliases = new Set<string>([columnName]);
  if (comment) {
    aliases.add(comment);
    for (const suffix of profile.commentSuffixes ?? []) {
      if (suffix && comment.endsWith(suffix)) {
        const shorter = comment.slice(0, -suffix.length).trim();
        if (shorter) aliases.add(shorter);
      }
    }
  }
  for (const [alias, target] of Object.entries(profile.columnAliases?.[table.tableName] ?? {})) {
    if (target === columnName && alias) aliases.add(alias);
  }
  return [...aliases].sort(function longestFirst(left, right) { return right.length - left.length; });
}

/** 根据应用注入的表别名解析查询粒度；无法唯一确定时返回空值。 */
function resolveMentionedTable(query: string, tables: SnapshotTableDescription[], profile: DatabaseQueryProfile): string | undefined {
  const matches = tables.filter(function matchesTable(table) {
    const aliases = [table.tableName, table.comment, ...(profile.tableAliases?.[table.tableName] ?? [])].filter(Boolean);
    return aliases.some(function queryContains(alias) { return query.includes(alias); });
  });
  return matches.length === 1 ? matches[0].tableName : undefined;
}

/** 按宿主注入的“列、操作符、值”语法提取安全候选，供唯一命中或粒度消歧。 */
function extractColumnCandidates(query: string, tables: SnapshotTableDescription[], profile: DatabaseQueryProfile): ColumnCandidate[] {
  const candidates = new Map<string, ColumnCandidate>();
  const operators = (profile.filterOperators ?? []).flatMap(function flattenOperator(entry) {
    return entry.keywords.filter(Boolean).map(function withOperator(keyword) { return { keyword, operator: entry.operator }; });
  }).sort(function longestFirst(left, right) { return right.keyword.length - left.keyword.length; });
  if (!operators.length) return [];
  const operatorPattern = operators.map(function escapeOperator(entry) { return entry.keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|");
  for (const table of tables) {
    for (const column of table.columns) {
      for (const alias of getColumnAliases(table, column.name, column.comment, profile)) {
        const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = query.match(new RegExp(`${escapedAlias}\\s*(${operatorPattern})\\s*(.+)$`));
        if (!match?.[2]) continue;
        const value = normalizeValue(match[2]);
        if (!value) continue;
        const operator = operators.find(function matchesOperator(entry) { return entry.keyword === match[1]; })?.operator;
        if (!operator) continue;
        const candidate = { tableName: table.tableName, columnName: column.name, columnType: column.type, value, operator };
        candidates.set(`${candidate.tableName}\u0000${candidate.columnName}\u0000${candidate.value}`, candidate);
        break;
      }
    }
  }
  return [...candidates.values()];
}

/** 校验外部规划结果只能引用本次快照公开的安全表列。 */
function validatePlannedCandidate(plan: DatabaseQueryPlan | null, tables: SnapshotTableDescription[]): ColumnCandidate | null {
  if (!plan || !plan.value.trim()) return null;
  const table = tables.find(function matchesTable(item) { return item.tableName === plan.tableName; });
  const column = table?.columns.find(function matchesColumn(item) { return item.name === plan.columnName; });
  if (!table || !column) return null;
  return { tableName: table.tableName, columnName: column.name, columnType: column.type, value: normalizeValue(plan.value), operator: plan.operator };
}

/** 在唯一候选、明确表粒度或受控规划器之间选择一个确定性筛选计划。 */
async function resolveColumnCandidate(
  query: string,
  tables: SnapshotTableDescription[],
  profile: DatabaseQueryProfile,
  planner?: CreateDatabaseSearchCapabilityOptions["planAmbiguousQuery"],
): Promise<ColumnCandidate | null> {
  const candidates = extractColumnCandidates(query, tables, profile);
  if (candidates.length === 1) return candidates[0];
  const mentionedTable = resolveMentionedTable(query, tables, profile);
  const scoped = mentionedTable ? candidates.filter(function inMentionedTable(candidate) { return candidate.tableName === mentionedTable; }) : [];
  if (scoped.length === 1) return scoped[0];
  if (!planner) return null;
  return validatePlannedCandidate(await planner({ query, tables }), tables);
}

/** 把确定性列值计划编译为只读 SQL；多值要求同一字段同时包含每个值。 */
function buildColumnFilterSql(candidate: ColumnCandidate, profile: DatabaseQueryProfile): string | null {
  if (/;|--|\/\*/.test(candidate.value)) throw createDatabaseError(DATABASE_ERROR_CODES.QUERY_NOT_READ_ONLY);
  const separators = (profile.valueSeparators ?? []).filter(Boolean);
  const separatorPattern = separators.map(function escapeSeparator(separator) { return separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|");
  const values = (separatorPattern ? candidate.value.split(new RegExp(separatorPattern)) : [candidate.value]).map(normalizeValue).filter(Boolean);
  if (!values.length) return null;
  const conditions = values.map(function buildCondition(value) {
    if (isNumericType(candidate.columnType) && candidate.operator === "equals") {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return `${quoteIdentifier(candidate.columnName)} = ${numeric}`;
    }
    const escaped = escapeLikeLiteral(value);
    return `${quoteIdentifier(candidate.columnName)} LIKE '%${escaped}%' ESCAPE '\\'`;
  });
  return `SELECT * FROM ${quoteIdentifier(candidate.tableName)} WHERE ${conditions.join(" AND ")}`;
}

/** 从应用 Profile 中识别聚合类型；Core 不内置特定语言或领域关键词。 */
function resolveAggregation(query: string, profile: DatabaseQueryProfile): DatabaseAggregationKeyword["kind"] | null {
  for (const entry of profile.aggregationKeywords ?? []) {
    if (entry.keywords.some(function containsKeyword(keyword) { return keyword && query.includes(keyword); })) return entry.kind;
  }
  return null;
}

/** 为聚合选择唯一表和指标列；跨表或跨列歧义时拒绝猜测。 */
function buildAggregateSql(query: string, tables: SnapshotTableDescription[], profile: DatabaseQueryProfile): string | null {
  const aggregation = resolveAggregation(query, profile);
  if (!aggregation) return null;
  const mentionedTable = resolveMentionedTable(query, tables, profile);
  const table = mentionedTable ? tables.find(function matches(item) { return item.tableName === mentionedTable; }) : tables.length === 1 ? tables[0] : undefined;
  if (!table) return null;
  if (aggregation === "count") return `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.tableName)}`;
  const profileColumnNames = new Set(Object.entries(profile.columnAliases?.[table.tableName] ?? {})
    .filter(function mentionedAlias(entry) { return query.includes(entry[0]); })
    .map(function targetColumn(entry) { return entry[1]; }));
  const matchedColumns = table.columns.filter(function matchesColumn(column) {
    if (!isNumericType(column.type)) return false;
    if (profileColumnNames.size) return profileColumnNames.has(column.name);
    return [column.name, column.comment].filter(Boolean).some(function mentioned(alias) { return query.includes(alias); });
  });
  if (matchedColumns.length !== 1) return null;
  const functionName = aggregation.toUpperCase();
  return `SELECT ${functionName}(${quoteIdentifier(matchedColumns[0].name)}) AS ${aggregation}_value FROM ${quoteIdentifier(table.tableName)}`;
}

/** 为零列匹配场景生成有界值检索 SQL；只检索安全文本列和有意义的查询词。 */
function buildValueSearchSql(query: string, tables: SnapshotTableDescription[], profile: DatabaseQueryProfile): string[] {
  const stopwords = new Set(profile.valueStopwords ?? []);
  const tokens = tokenizeLexicalText(query)
    .filter(function usefulToken(token) { return token.length >= 2 && !stopwords.has(token); })
    .slice(0, MAX_VALUE_SEARCH_TOKENS);
  if (!tokens.length) return [];
  return tables.slice(0, MAX_VALUE_SEARCH_TABLES).flatMap(function buildForTable(table) {
    const columns = table.columns.filter(function textColumn(column) { return !isNumericType(column.type); }).slice(0, MAX_VALUE_SEARCH_COLUMNS);
    if (!columns.length) return [];
    const conditions = tokens.map(function tokenCondition(token) {
      const escaped = escapeLikeLiteral(token);
      return `(${columns.map(function columnCondition(column) { return `${quoteIdentifier(column.name)} LIKE '%${escaped}%' ESCAPE '\\'`; }).join(" OR ")})`;
    });
    return [`SELECT * FROM ${quoteIdentifier(table.tableName)} WHERE ${conditions.join(" OR ")}`];
  });
}

/** 合并结构化查询结果并在统一安全行上限处返回明确截断事实。 */
function mergeStructuredResults(results: SnapshotQueryResult[]): DatabaseSearchResult | null {
  if (!results.length) return null;
  const rows = results.flatMap(function rows(result) { return result.rows; });
  const columns = [...new Set(results.flatMap(function columns(result) { return result.columns; }))];
  const involvedTables = [...new Set(results.flatMap(function tables(result) { return result.involvedTables; }))];
  return {
    kind: "sql",
    columns,
    rows: rows.slice(0, MAX_STRUCTURED_ROWS),
    involvedTables,
    truncated: results.some(function isTruncated(result) { return result.truncated; }) || rows.length > MAX_STRUCTURED_ROWS,
    snapshotStatus: results[0].snapshot.status,
  };
}

/** 顺序执行受控 SQL；失败不会被隐藏为语义结果，只有零命中才允许继续降级。 */
async function executeStructuredQueries(snapshot: DatabaseSnapshotReadCapability, sqls: string[]): Promise<DatabaseSearchResult | null> {
  const results: SnapshotQueryResult[] = [];
  for (const sql of sqls) {
    const result = await snapshot.snapshotQuery(sql);
    if (result.rows.length) results.push(result);
  }
  return mergeStructuredResults(results);
}

/** 移除数据库名、sourceId 和本地快照身份，避免内部标识进入模型结果。 */
function sanitizeSemanticResults(results: VectorOutput[]): VectorOutput[] {
  return results.map(function sanitize(result) {
    const metadata = { ...result.metadata };
    delete metadata.databaseName;
    delete metadata.sourceId;
    delete metadata.syncedAt;
    return { ...result, metadata };
  });
}

/** 用通用确定性路径处理自然语言请求；无法证明时返回空值并交给语义召回。 */
async function searchDeterministically(
  snapshot: DatabaseSnapshotReadCapability,
  query: string,
  options: CreateDatabaseSearchCapabilityOptions,
): Promise<DatabaseSearchResult | null> {
  const tables = await snapshot.describeSnapshotTables();
  const profile = options.profile ?? {};
  const aggregateSql = buildAggregateSql(query, tables, profile);
  if (aggregateSql) return executeStructuredQueries(snapshot, [aggregateSql]);
  const extractedCandidates = extractColumnCandidates(query, tables, profile);
  const candidate = await resolveColumnCandidate(query, tables, profile, options.planAmbiguousQuery);
  if (!candidate && extractedCandidates.length > 1) return null;
  const preciseSql = candidate ? buildColumnFilterSql(candidate, profile) : null;
  if (preciseSql) {
    const precise = await executeStructuredQueries(snapshot, [preciseSql]);
    if (precise) return precise;
  }
  const valueSqls = candidate ? [] : buildValueSearchSql(query, tables, profile);
  return valueSqls.length ? executeStructuredQueries(snapshot, valueSqls) : null;
}

/** 将现有 SQLite/LanceDB 快照包装为独立 database_search capability。 */
export function createDatabaseSearchCapability(
  snapshot: DatabaseSnapshotReadCapability,
  options: CreateDatabaseSearchCapabilityOptions = {},
): DatabaseSearchCapability {
  return {
    async search(request) {
      try {
        if (request.kind === "sql") {
          const result = await snapshot.snapshotQuery(request.sql);
          return {
            kind: "sql",
            columns: result.columns,
            rows: result.rows,
            involvedTables: result.involvedTables,
            truncated: result.truncated,
            snapshotStatus: result.snapshot.status,
          };
        }
        const deterministic = await searchDeterministically(snapshot, request.query, options);
        if (deterministic) return deterministic;
        const [results, status] = await Promise.all([snapshot.search(request.query, request.topK), snapshot.getStatus()]);
        return { kind: "semantic", results: sanitizeSemanticResults(results), snapshotStatus: status?.status ?? "unavailable" };
      } catch (error) {
        throw toDatabaseError(error, DATABASE_ERROR_CODES.SEARCH_FAILED);
      }
    },
  };
}
