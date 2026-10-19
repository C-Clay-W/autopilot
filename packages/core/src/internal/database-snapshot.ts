/**
 * MySQL 数据库快照：同步时短连接只读 MySQL，发布后仅提供 LanceDB 与 SQLite 本地只读能力。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import mysql, { type Connection, type ConnectionOptions, type RowDataPacket } from "mysql2/promise";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { createDatabaseError, DATABASE_ERROR_CODES, toDatabaseError } from "./database-error";
import { embedText, getTextEmbeddingSpaceId } from "./lib/embeddings";
import { clearTable, insertVectors, withVectorStorePath } from "./lib/vector-store";
import type { VectorInput, VectorOutput } from "./types";

const MAX_QUERY_ROWS = 200;
const forbiddenSql = /\b(?:insert|update|delete|replace|create|drop|alter|attach|detach|pragma|vacuum|reindex|analyze|load_extension|into\s+outfile)\b/i;
const sensitiveTableName = /(?:^|[_-])(?:user|users|app_user|admin|admins|administrator|sys|auth|credential|token|account|role|permission|session)(?:[_-]|$)|^(?:user|users|app_user|admin|admins|administrator|sys|auth|credential|token|account|role|permission|session)/i;
const sensitiveColumnName = /password|passwd|pwd|salt|token|secret|credential|private_?key|id_?card|identity_?card|phone|mobile|email|address/i;
const binaryColumnType = /blob|binary|varbinary|geometry|json/i;

/** MySQL 连接注册信息；只从服务端 MYSQL_SOURCES_JSON 读取，绝不由浏览器传入。 */
export interface MySQLSourceConfig {
  sourceId: string;
  displayName: string;
  database: string;
  readConnection: { host: string; port: number; user: string; password: string; ssl: boolean };
  agentMutationConnection?: { host: string; port: number; user: string; password: string; ssl: boolean };
  allowedTables?: string[];
}

/** 已发布快照的安全标识与本地存储位置。 */
export interface DatabaseSnapshotConfig {
  sourceId: string;
  databaseName: string;
  sqlitePath: string;
  lanceDbScope: string;
  version: string;
  syncedAt: string;
  status: "current" | "stale";
}

/** 同步前可安全返回给管理端的库检查摘要。 */
export interface DatabaseInspection {
  databaseName: string;
  displayName: string;
  readableTableCount: number;
  excludedTables: { tableName: string; reason: string }[];
  tables: { tableName: string; comment: string; primaryKey: string[]; columns: string[] }[];
}

/** 同步发布结果；不携带连接串、账号或密码。 */
export interface DatabaseSyncResult extends DatabaseSnapshotConfig {
  tableCount: number;
  vectorCount: number;
  excludedTableCount: number;
}

/** 注入 RAG 的本地只读快照能力，不包含 MySQL 运行时连接。 */
export interface DatabaseSnapshotReadCapability {
  databaseName: string;
  getStatus(): Promise<DatabaseSnapshotConfig | null>;
  describeSnapshotTables(): Promise<SnapshotTableDescription[]>;
  search(query: string, topK?: number): Promise<VectorOutput[]>;
  snapshotQuery(sql: string): Promise<SnapshotQueryResult>;
}

/** 快照持久化并向确定性查询公开的安全列描述。 */
export interface SnapshotColumnDescription {
  name: string;
  type: string;
  comment: string;
}

/** 快照持久化并向确定性查询公开的安全表描述。 */
export interface SnapshotTableDescription {
  tableName: string;
  comment: string;
  columns: SnapshotColumnDescription[];
}

/** SQLite 查询的受控结构化返回值。 */
export interface SnapshotQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  involvedTables: string[];
  snapshot: Pick<DatabaseSnapshotConfig, "databaseName" | "version" | "syncedAt" | "status">;
  truncated: boolean;
}

interface SourceTable {
  tableName: string;
  comment: string;
  columns: SourceColumn[];
  primaryKey: string[];
}

interface SourceColumn {
  name: string;
  type: string;
  nullable: boolean;
  comment: string;
}

interface SnapshotManifest extends DatabaseSnapshotConfig {
  tables: Array<SnapshotTableDescription & { lanceTableName: string }>;
}

/** 加载唯一允许使用的数据源注册表，并在缺失或格式错误时拒绝请求。 */
function loadSources(): MySQLSourceConfig[] {
  const raw = process.env.MYSQL_SOURCES_JSON;
  if (!raw) throw createDatabaseError(DATABASE_ERROR_CODES.CONFIG_MISSING);
  let value: unknown;
  try { value = JSON.parse(raw); } catch (error) { throw createDatabaseError(DATABASE_ERROR_CODES.CONFIG_JSON_INVALID, error); }
  if (!Array.isArray(value)) throw createDatabaseError(DATABASE_ERROR_CODES.CONFIG_NOT_ARRAY);
  const sources = value.filter((item): item is MySQLSourceConfig => Boolean(
    item && typeof item === "object"
    && typeof (item as MySQLSourceConfig).sourceId === "string"
    && typeof (item as MySQLSourceConfig).database === "string"
    && typeof (item as MySQLSourceConfig).readConnection?.host === "string"
    && typeof (item as MySQLSourceConfig).readConnection?.user === "string"
    && typeof (item as MySQLSourceConfig).readConnection?.password === "string"
    && ((item as MySQLSourceConfig).allowedTables === undefined || Array.isArray((item as MySQLSourceConfig).allowedTables))
  ));
  if (sources.length !== value.length) throw createDatabaseError(DATABASE_ERROR_CODES.CONFIG_SOURCE_INVALID);
  return sources;
}

/** 按浏览器传入的库名精确映射服务端注册项，禁止扫描或切换其他数据库。 */
function resolveSource(databaseName: string): MySQLSourceConfig {
  if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) throw createDatabaseError(DATABASE_ERROR_CODES.SOURCE_NAME_INVALID);
  const source = loadSources().find((item) => item.database === databaseName);
  if (!source) throw createDatabaseError(DATABASE_ERROR_CODES.SOURCE_NOT_FOUND);
  return source;
}

/** 返回环境中唯一的数据库源；多源选择必须由宿主使用受控 sourceId 解析。 */
export function getDefaultDatabaseSource(): Pick<MySQLSourceConfig, "database" | "displayName"> {
  const sources = loadSources();
  if (sources.length === 0) throw createDatabaseError(DATABASE_ERROR_CODES.SOURCE_DEFAULT_UNAVAILABLE);
  if (sources.length > 1) throw createDatabaseError(DATABASE_ERROR_CODES.SOURCE_AMBIGUOUS);
  return { database: sources[0].database, displayName: sources[0].displayName };
}

/** 从服务端数据源注册项读取显式表 allowlist；缺失时安全地不开放任何业务表。 */
function getAllowedTableNames(source: MySQLSourceConfig): ReadonlySet<string> {
  return new Set((source.allowedTables ?? []).filter(function validTableName(tableName) { return /^[a-zA-Z0-9_]+$/.test(tableName); }));
}

/** 转义数据库标识符，所有动态表名和列名都只能经此函数进入 SQL。 */
function quoteIdentifier(identifier: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(identifier)) throw createDatabaseError(DATABASE_ERROR_CODES.IDENTIFIER_INVALID);
  return `\`${identifier}\``;
}

/** 判断整表是否必须在 Schema、行数据、向量与快照阶段完全排除。 */
function getSensitiveTableReason(tableName: string, columns: SourceColumn[] = []): string | null {
  if (sensitiveTableName.test(tableName)) return "表名命中认证/授权敏感规则";
  const sensitiveColumn = columns.find((column) => sensitiveColumnName.test(column.name));
  return sensitiveColumn ? "字段名命中凭据或个人敏感信息规则" : null;
}

/** 仅保留适合本地事实查询和语义检索的安全标量列。 */
function isProjectedColumn(column: SourceColumn): boolean {
  return /^[a-zA-Z0-9_]+$/.test(column.name)
    && !sensitiveColumnName.test(column.name)
    && !binaryColumnType.test(column.type);
}

/** 生成可发布版本中稳定且不含敏感信息的 LanceDB 表名。 */
function getLanceTableName(sourceId: string, databaseName: string, tableName: string, version: string): string {
  const safe = `${sourceId}_${databaseName}_${tableName}_${version.slice(0, 8)}`.replace(/[^a-zA-Z0-9_]/g, "_");
  return `mysql_${safe}`.slice(0, 120);
}

/** 将连接配置转换为只读短连接选项，显式关闭多语句以防止 SQL 拼接提权。 */
function getReadConnectionOptions(source: MySQLSourceConfig): ConnectionOptions {
  return {
    host: source.readConnection.host,
    port: source.readConnection.port,
    user: source.readConnection.user,
    password: source.readConnection.password,
    database: source.database,
    ssl: source.readConnection.ssl ? {} : undefined,
    multipleStatements: false,
    connectTimeout: 10_000,
  };
}

/** 加载 sql.js 的 wasm，生成纯本地 SQLite 文件而不引入原生编译依赖。 */
async function loadSql(): Promise<SqlJsStatic> {
  const modulePath = import.meta.url || (typeof __filename === "string" ? __filename : path.join(process.cwd(), "package.json"));
  const moduleRequire = createRequire(modulePath);
  const wasmPath = moduleRequire.resolve("sql.js/dist/sql-wasm.wasm");
  return initSqlJs({ locateFile: () => wasmPath });
}

/** 返回数据库快照根目录；目录由服务端部署配置控制。 */
function getSnapshotRoot(explicitRoot?: string): string {
  return path.resolve(explicitRoot ?? process.env.DATABASE_SNAPSHOT_PATH ?? "./database-snapshots");
}

/** 在可终止 Worker 中执行 SQLite 查询，使超时能真正停止 CPU/WASM 工作。 */
async function executeSnapshotSql(sqliteBytes: Buffer, sql: string, timeoutMs: number): Promise<{ columns: string[]; values: unknown[][] } | undefined> {
  const modulePath = import.meta.url || (typeof __filename === "string" ? __filename : path.join(process.cwd(), "package.json"));
  const moduleRequire = createRequire(modulePath);
  const sqlJsPath = moduleRequire.resolve("sql.js");
  const wasmPath = moduleRequire.resolve("sql.js/dist/sql-wasm.wasm");
  return new Promise(function execute(resolve, reject) {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      Promise.resolve(require(workerData.sqlJsPath)({ locateFile: function locateFile() { return workerData.wasmPath; } }))
        .then(function run(SqlJs) {
          const database = new SqlJs.Database(new Uint8Array(workerData.sqliteBytes));
          try { parentPort.postMessage({ ok: true, result: database.exec(workerData.sql)[0] }); }
          finally { database.close(); }
        })
        .catch(function fail(error) { parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : "SQLITE_WORKER_FAILED" }); });
    `, { eval: true, workerData: { sqlJsPath, wasmPath, sqliteBytes, sql } });
    let settled = false;
    const timer = setTimeout(function timeout() {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(createDatabaseError(DATABASE_ERROR_CODES.QUERY_TIMEOUT));
    }, timeoutMs);
    worker.once("message", function message(payload: { ok?: boolean; result?: { columns: string[]; values: unknown[][] }; message?: string }) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (payload.ok) resolve(payload.result);
      else reject(createDatabaseError(DATABASE_ERROR_CODES.QUERY_FAILED, new Error(payload.message ?? "SQLITE_WORKER_FAILED")));
    });
    worker.once("error", function workerError(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(createDatabaseError(DATABASE_ERROR_CODES.QUERY_FAILED, error));
    });
  });
}

/** 获取单一 databaseName 的 manifest 文件路径，防止不同库共享本地资产。 */
function getManifestPath(databaseName: string, snapshotRoot?: string): string {
  return path.join(getSnapshotRoot(snapshotRoot), databaseName, "manifest.json");
}

/** 原子写入 JSON 元数据，避免同步中断覆盖最后一次可用快照。 */
async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

/** 读取并校验最后一次成功快照 manifest；不存在时返回 null 而不是回连 MySQL。 */
async function readManifest(databaseName: string, snapshotRoot?: string): Promise<SnapshotManifest | null> {
  const manifestPath = getManifestPath(databaseName, snapshotRoot);
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SnapshotManifest;
    if (manifest.databaseName !== databaseName || !manifest.sqlitePath || !Array.isArray(manifest.tables)) throw createDatabaseError(DATABASE_ERROR_CODES.SNAPSHOT_INVALID);
    const databaseRoot = path.join(getSnapshotRoot(snapshotRoot), databaseName);
    const relativeSqlitePath = path.relative(databaseRoot, path.resolve(manifest.sqlitePath));
    if (!relativeSqlitePath || relativeSqlitePath.startsWith("..") || path.isAbsolute(relativeSqlitePath)) throw createDatabaseError(DATABASE_ERROR_CODES.SNAPSHOT_INVALID);
    manifest.tables = manifest.tables.map(function normalizeLegacyTable(table) {
      return { ...table, comment: typeof table.comment === "string" ? table.comment : "", columns: Array.isArray(table.columns) ? table.columns : [] };
    });
    return manifest;
  } catch (error) { throw toDatabaseError(error, DATABASE_ERROR_CODES.SNAPSHOT_INVALID); }
}

/** 对连接账号执行最小安全检查；测试期开关开启时仅跳过授权检查，同步 SQL 仍只读。 */
async function assertReadOnlyGrants(connection: Connection): Promise<void> {
  if (process.env.MYSQL_ALLOW_WRITE_FOR_TESTING === "true") return;
  const [grantRows] = await connection.query<RowDataPacket[]>("SHOW GRANTS");
  const grants = grantRows.flatMap((row) => Object.values(row).map(String)).join("\n");
  if (/\b(?:ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i.test(grants)) {
    throw createDatabaseError(DATABASE_ERROR_CODES.SYNC_ACCOUNT_NOT_READ_ONLY);
  }
}

/** 从 INFORMATION_SCHEMA 发现所有非敏感表及其字段与主键，不读取敏感表细节。 */
async function inspectConnection(connection: Connection, source: MySQLSourceConfig): Promise<{ tables: SourceTable[]; excludedTables: { tableName: string; reason: string }[] }> {
  const [tableRows] = await connection.execute<RowDataPacket[]>(
    "SELECT TABLE_NAME, TABLE_COMMENT FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
    [source.database],
  );
  const tables: SourceTable[] = [];
  const excludedTables: { tableName: string; reason: string }[] = [];
  const allowedTableNames = getAllowedTableNames(source);
  for (const row of tableRows) {
    const tableName = String(row.TABLE_NAME);
    if (!allowedTableNames.has(tableName)) {
      excludedTables.push({ tableName, reason: "不在当前数据源已审计的同步表清单中" });
      continue;
    }
    const tableReason = getSensitiveTableReason(tableName);
    if (tableReason) { excludedTables.push({ tableName, reason: tableReason }); continue; }
    const [columnRows] = await connection.execute<RowDataPacket[]>(
      "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_COMMENT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
      [source.database, tableName],
    );
    const columns = columnRows.map((column) => ({
      name: String(column.COLUMN_NAME), type: String(column.COLUMN_TYPE), nullable: String(column.IS_NULLABLE) === "YES", comment: String(column.COLUMN_COMMENT ?? ""),
    }));
    const columnReason = getSensitiveTableReason(tableName, columns);
    if (columnReason) { excludedTables.push({ tableName, reason: columnReason }); continue; }
    const [keyRows] = await connection.execute<RowDataPacket[]>(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION",
      [source.database, tableName],
    );
    tables.push({ tableName, comment: String(row.TABLE_COMMENT ?? ""), columns, primaryKey: keyRows.map((key) => String(key.COLUMN_NAME)) });
  }
  return { tables, excludedTables };
}

/** 规范化 MySQL 类型到 SQLite 亲和类型，保留原类型在 Schema 文本和 manifest 外层。 */
function toSqliteType(mysqlType: string): string {
  if (/int|bit|bool/i.test(mysqlType)) return "INTEGER";
  if (/decimal|numeric|float|double|real/i.test(mysqlType)) return "REAL";
  return "TEXT";
}

/** 读取行内非空文本字段，避免把 null、数值或对象拼入实体语义文档。 */
function getRowText(row: Record<string, unknown>, fieldName: string): string {
  const value = row[fieldName];
  return typeof value === "string" ? value.trim() : "";
}

/** 从任意安全标量行构造通用实体语义文本，不内置业务表名、字段名或领域 Prompt。 */
function buildSemanticEntityText(table: SourceTable, row: Record<string, unknown>): string | null {
  const fields = table.columns.filter(isProjectedColumn).flatMap(function toSemanticField(column) {
    const value = row[column.name];
    if (value == null || value === "") return [];
    const text = typeof value === "string" ? getRowText(row, column.name) : String(value);
    if (!text) return [];
    return [`${column.comment || column.name}: ${text.slice(0, 2_000)}`];
  }).slice(0, 32);
  if (!fields.length) return null;
  return [`表: ${table.comment || table.tableName}`, ...fields].join("\n").slice(0, 12_000);
}

/** 将 Schema 转换为可召回的文本，同时包含表、主键、字段与安全注释。 */
function buildSchemaText(source: MySQLSourceConfig, table: SourceTable): string {
  const fields = table.columns.filter(isProjectedColumn).map((column) => `- ${column.name} ${column.type}${column.comment ? `，${column.comment}` : ""}`).join("\n");
  return `数据源: ${source.displayName}\n表: ${table.tableName}\n表说明: ${table.comment}\n主键: ${table.primaryKey.join(", ") || "无"}\n字段:\n${fields}`;
}

/** 提取主键或行哈希，确保一次快照中每个实体均有稳定可追溯 ID。 */
function getPrimaryKeyValue(table: SourceTable, row: Record<string, unknown>): string {
  if (table.primaryKey.length) return table.primaryKey.map((key) => `${key}=${String(row[key] ?? "")}`).join("|");
  return createHash("sha256").update(JSON.stringify(row)).digest("hex").slice(0, 16);
}

/** 限制 SQLite 查询为单条 SELECT/WITH-SELECT，并拒绝跨快照、写入与危险函数。 */
function validateSnapshotSql(sql: string, tableNames: Set<string>): { sql: string; involvedTables: string[] } {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed || /;/.test(trimmed) || /--|\/\*/.test(trimmed) || !/^(?:select|with\b)/i.test(trimmed) || forbiddenSql.test(trimmed)) throw createDatabaseError(DATABASE_ERROR_CODES.QUERY_NOT_READ_ONLY);
  if (/\b(?:sqlite_master|temp\.|main\.)/i.test(trimmed)) throw createDatabaseError(DATABASE_ERROR_CODES.QUERY_SYSTEM_ACCESS_FORBIDDEN);
  const involvedTables = [...trimmed.matchAll(/\b(?:from|join)\s+[`"]?([a-zA-Z0-9_]+)[`"]?/gi)].map((match) => match[1]);
  if (!involvedTables.length || involvedTables.some((tableName) => !tableNames.has(tableName))) throw createDatabaseError(DATABASE_ERROR_CODES.QUERY_TABLE_FORBIDDEN);
  return { sql: `SELECT * FROM (${trimmed}) AS "__database_search_result" LIMIT ${MAX_QUERY_ROWS + 1}`, involvedTables: [...new Set(involvedTables)] };
}

/** 创建与指定 databaseName 一一对应的同步管理对象；构造本身不会连接 MySQL。 */
export function createDatabaseSnapshot(input: { databaseName: string; snapshotRoot?: string; queryTimeoutMs?: number }): {
  inspectSource(): Promise<DatabaseInspection>;
  sync(): Promise<DatabaseSyncResult>;
  getReadCapability(): DatabaseSnapshotReadCapability;
} {
  const source = resolveSource(input.databaseName);
  const snapshotRoot = getSnapshotRoot(input.snapshotRoot);
  const vectorStorePath = input.snapshotRoot ? path.join(snapshotRoot, "lancedb") : path.resolve(process.env.LANCE_DB_PATH ?? "./lancedb");
  const queryTimeoutMs = Math.max(1, Math.min(input.queryTimeoutMs ?? 10_000, 30_000));

  /** 使用短连接检查数据源，并在 finally 中始终释放连接。 */
  async function inspectSource(): Promise<DatabaseInspection> {
    try {
      const connection = await mysql.createConnection(getReadConnectionOptions(source));
      try {
        await connection.query("SELECT 1");
        await assertReadOnlyGrants(connection);
        const discovery = await inspectConnection(connection, source);
        return {
          databaseName: source.database,
          displayName: source.displayName,
          readableTableCount: discovery.tables.length,
          excludedTables: discovery.excludedTables,
          tables: discovery.tables.map((table) => ({ tableName: table.tableName, comment: table.comment, primaryKey: table.primaryKey, columns: table.columns.filter(isProjectedColumn).map((column) => column.name) })),
        };
      } finally { await connection.end(); }
    } catch (error) {
      throw toDatabaseError(error, DATABASE_ERROR_CODES.INSPECTION_FAILED);
    }
  }

  /** 全量同步非敏感表，先写版本化资产，最后原子发布 manifest。 */
  async function sync(): Promise<DatabaseSyncResult> {
    try {
      const connection = await mysql.createConnection(getReadConnectionOptions(source));
      const version = randomUUID().replace(/-/g, "");
      const syncedAt = new Date().toISOString();
      const databaseDir = path.join(snapshotRoot, source.database);
      const sqlitePath = path.join(databaseDir, `snapshot-${version}.sqlite`);
      let database: Database | null = null;
      let vectorCount = 0;
      try {
        await connection.query("SELECT 1");
        await assertReadOnlyGrants(connection);
        const discovery = await inspectConnection(connection, source);
        const SqlJs = await loadSql();
        database = new SqlJs.Database();
        const manifestTables: SnapshotManifest["tables"] = [];
        for (const table of discovery.tables) {
          const projectedColumns = table.columns.filter(isProjectedColumn);
          if (!projectedColumns.length) continue;
          const definition = projectedColumns.map((column) => `${quoteIdentifier(column.name)} ${toSqliteType(column.type)}`).join(", ");
          database.run(`CREATE TABLE ${quoteIdentifier(table.tableName)} (${definition})`);
          const columnList = projectedColumns.map((column) => quoteIdentifier(column.name)).join(", ");
          const [rows] = await connection.query<RowDataPacket[]>(`SELECT ${columnList} FROM ${quoteIdentifier(table.tableName)}`);
          const insert = database.prepare(`INSERT INTO ${quoteIdentifier(table.tableName)} (${columnList}) VALUES (${projectedColumns.map(() => "?").join(", ")})`);
          const vectorInputs: VectorInput[] = [];
          const lanceTableName = getLanceTableName(source.sourceId, source.database, table.tableName, version);
          const schemaText = buildSchemaText(source, table);
          vectorInputs.push({
            id: `mysql-schema:${source.sourceId}:${source.database}:${table.tableName}:${version}`,
            vector: await embedText(schemaText), text: schemaText,
            metadata: { source: "mysql_schema", sourceId: source.sourceId, databaseName: source.database, tableName: table.tableName, objectType: "table", syncedAt, embeddingProvider: "cloud-text", embeddingSpaceId: getTextEmbeddingSpaceId() },
            fields: { databaseName: source.database, tableName: table.tableName },
          });
          for (const rowPacket of rows) {
            const row = rowPacket as Record<string, unknown>;
            insert.run(projectedColumns.map((column) => row[column.name] == null ? null : String(row[column.name])));
            const primaryKey = getPrimaryKeyValue(table, row);
            const text = buildSemanticEntityText(table, row);
            if (text) {
              vectorInputs.push({
                id: `mysql-entity:${source.sourceId}:${source.database}:${table.tableName}:${Buffer.from(primaryKey).toString("base64url")}:${version}`,
                vector: await embedText(text), text,
                metadata: { source: "mysql_entity", sourceId: source.sourceId, databaseName: source.database, tableName: table.tableName, primaryKey, syncedAt, contentHash: createHash("sha256").update(text).digest("hex"), embeddingProvider: "cloud-text", embeddingSpaceId: getTextEmbeddingSpaceId() },
                fields: { databaseName: source.database, tableName: table.tableName },
              });
            }
          }
          insert.free();
          await withVectorStorePath(vectorStorePath, async function publishVectors() {
            await clearTable(lanceTableName);
            vectorCount += await insertVectors(lanceTableName, vectorInputs);
          });
          manifestTables.push({ tableName: table.tableName, lanceTableName, comment: table.comment, columns: projectedColumns.map(function describeColumn(column) { return { name: column.name, type: column.type, comment: column.comment }; }) });
        }
        await mkdir(databaseDir, { recursive: true });
        const temporarySqlitePath = `${sqlitePath}.${randomUUID()}.tmp`;
        await writeFile(temporarySqlitePath, Buffer.from(database.export()));
        await rename(temporarySqlitePath, sqlitePath);
        const manifest: SnapshotManifest = { sourceId: source.sourceId, databaseName: source.database, sqlitePath, lanceDbScope: `mysql:${source.sourceId}:${source.database}`, version, syncedAt, status: "current", tables: manifestTables };
        await writeJsonAtomically(getManifestPath(source.database, snapshotRoot), manifest);
        return { ...manifest, tableCount: manifestTables.length, vectorCount, excludedTableCount: discovery.excludedTables.length };
      } finally {
        database?.close();
        await connection.end();
      }
    } catch (error) {
      throw toDatabaseError(error, DATABASE_ERROR_CODES.SYNC_FAILED);
    }
  }

  /** 返回离线快照 capability；所有方法都只读取 manifest、LanceDB 或 SQLite。 */
  function getReadCapability(): DatabaseSnapshotReadCapability {
    return {
      databaseName: source.database,
      async getStatus() {
        const manifest = await readManifest(source.database, snapshotRoot);
        return manifest ? { sourceId: manifest.sourceId, databaseName: manifest.databaseName, sqlitePath: manifest.sqlitePath, lanceDbScope: manifest.lanceDbScope, version: manifest.version, syncedAt: manifest.syncedAt, status: manifest.status } : null;
      },
      async describeSnapshotTables() {
        const manifest = await readManifest(source.database, snapshotRoot);
        if (!manifest) throw createDatabaseError(DATABASE_ERROR_CODES.SNAPSHOT_NOT_FOUND);
        return manifest.tables.map(function describeTable(table) { return { tableName: table.tableName, comment: table.comment, columns: table.columns.map(function describeColumn(column) { return { ...column }; }) }; });
      },
      async search(query: string, topK = 5) {
        try {
          const manifest = await readManifest(source.database, snapshotRoot);
          if (!manifest) throw createDatabaseError(DATABASE_ERROR_CODES.SNAPSHOT_NOT_FOUND);
          const vector = await embedText(query);
          const results: VectorOutput[] = [];
          const { searchVectors } = await import("./lib/vector-store");
          await withVectorStorePath(vectorStorePath, async function searchSnapshotVectors() {
            for (const table of manifest.tables) results.push(...await searchVectors(table.lanceTableName, vector, Math.min(Math.max(topK, 1), 20)));
          });
          return results
            .filter((result) => result.metadata.databaseName === source.database)
            .sort((left, right) => right.score - left.score)
            .slice(0, Math.min(Math.max(topK, 1), 20));
        } catch (error) {
          throw toDatabaseError(error, DATABASE_ERROR_CODES.SEMANTIC_SEARCH_FAILED);
        }
      },
      async snapshotQuery(sql: string) {
        try {
          const manifest = await readManifest(source.database, snapshotRoot);
          if (!manifest) throw createDatabaseError(DATABASE_ERROR_CODES.SNAPSHOT_NOT_FOUND);
          if (!existsSync(manifest.sqlitePath)) throw createDatabaseError(DATABASE_ERROR_CODES.SNAPSHOT_FILE_MISSING);
          const validated = validateSnapshotSql(sql, new Set(manifest.tables.map((table) => table.tableName)));
          const result = await executeSnapshotSql(await readFile(manifest.sqlitePath), validated.sql, queryTimeoutMs);
          const columns = result?.columns ?? [];
          const values = result?.values ?? [];
          const rows = values.slice(0, MAX_QUERY_ROWS).map((valueRow) => Object.fromEntries(columns.map((column, index) => [column, valueRow[index] ?? null])));
          return { columns, rows, involvedTables: validated.involvedTables, snapshot: { databaseName: manifest.databaseName, version: manifest.version, syncedAt: manifest.syncedAt, status: manifest.status }, truncated: values.length > MAX_QUERY_ROWS };
        } catch (error) {
          throw toDatabaseError(error, DATABASE_ERROR_CODES.QUERY_FAILED);
        }
      },
    };
  }

  return { inspectSource, sync, getReadCapability };
}
