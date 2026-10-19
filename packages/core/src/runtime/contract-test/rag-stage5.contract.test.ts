/**
 * RAG Stage 5 契约测试：验证通用 database_search 的确定性检索、只读 SQL、歧义降级和安全边界。
 */

import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseSearchCapability, type DatabaseQueryProfile } from "../../internal/database-search";
import { DATABASE_ERROR_CODES, readDatabaseErrorCode, toDatabaseError } from "../../internal/database-error";
import { createDatabaseSnapshot, getDefaultDatabaseSource, type DatabaseSnapshotReadCapability } from "../../internal/database-snapshot";
import { createDatabaseSearchTool } from "../../internal/tools/builtins/database-search-tool";
import { createSnapshotQueryTool } from "../../internal/tools/builtins/snapshot-query-tool";
import { toToolError } from "../../internal/tools/tool-error";
import type { VectorOutput } from "../../internal/types";

const originalSources = process.env.MYSQL_SOURCES_JSON;
const roots: string[] = [];

/** 捕获同步数据库边界抛出的稳定错误码。 */
function captureDatabaseErrorCode(operation: () => unknown): string | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    return readDatabaseErrorCode(error);
  }
}

/** 创建不含真实凭据且显式声明表 allowlist 的测试数据源注册项。 */
beforeEach(function configureFixtureSource() {
  process.env.MYSQL_SOURCES_JSON = JSON.stringify([{
    sourceId: "fixture-source",
    displayName: "Fixture",
    database: "fixture_db",
    allowedTables: ["projects", "teams", "events"],
    readConnection: { host: "127.0.0.1", port: 3306, user: "fixture", password: "fixture", ssl: false },
  }]);
});

/** 恢复环境并移除本轮测试创建的隔离快照。 */
afterEach(async function cleanupFixtures() {
  if (originalSources === undefined) delete process.env.MYSQL_SOURCES_JSON;
  else process.env.MYSQL_SOURCES_JSON = originalSources;
  await Promise.all(roots.splice(0).map(function removeRoot(root) { return rm(root, { recursive: true, force: true }); }));
});

/** 创建带列字典的真实 sql.js 快照，避免用 SQL 字符串断言冒充执行结果。 */
async function createFixtureCapability(queryTimeoutMs?: number): Promise<DatabaseSnapshotReadCapability> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rag-stage5-"));
  roots.push(root);
  const databaseDir = path.join(root, "fixture_db");
  await mkdir(databaseDir, { recursive: true });
  const sqlitePath = path.join(databaseDir, "snapshot-fixture.sqlite");
  const moduleRequire = createRequire(import.meta.url);
  const SqlJs = await initSqlJs({ locateFile: function locateFile() { return moduleRequire.resolve("sql.js/dist/sql-wasm.wasm"); } });
  const database = new SqlJs.Database();
  database.run("CREATE TABLE projects (id INTEGER, name TEXT, owner TEXT, status TEXT, tags TEXT, budget REAL, team_id INTEGER)");
  database.run("CREATE TABLE teams (id INTEGER, name TEXT, status TEXT)");
  database.run("CREATE TABLE events (id INTEGER, label TEXT)");
  database.run("INSERT INTO projects VALUES (1, '星火', '张三', '进行中', '安全、后端', 120, 1), (2, '远航', '李四', '已完成', '前端', 80, 2), (3, '磐石', '张三', '进行中', '安全', 100, 1)");
  database.run("INSERT INTO teams VALUES (1, '平台', '进行中'), (2, '体验', '已完成')");
  for (let index = 1; index <= 205; index += 1) database.run("INSERT INTO events VALUES (?, ?)", [index, `事件-${index}`]);
  await writeFile(sqlitePath, Buffer.from(database.export()));
  database.close();
  const columns = {
    projects: [
      { name: "id", type: "INTEGER", comment: "项目编号" },
      { name: "name", type: "TEXT", comment: "项目名称" },
      { name: "owner", type: "TEXT", comment: "负责人" },
      { name: "status", type: "TEXT", comment: "状态" },
      { name: "tags", type: "TEXT", comment: "标签" },
      { name: "budget", type: "REAL", comment: "预算" },
      { name: "team_id", type: "INTEGER", comment: "团队编号" },
    ],
    teams: [
      { name: "id", type: "INTEGER", comment: "团队编号" },
      { name: "name", type: "TEXT", comment: "团队名称" },
      { name: "status", type: "TEXT", comment: "状态" },
    ],
    events: [
      { name: "id", type: "INTEGER", comment: "事件编号" },
      { name: "label", type: "TEXT", comment: "事件名称" },
    ],
  };
  await writeFile(path.join(databaseDir, "manifest.json"), `${JSON.stringify({
    sourceId: "fixture-source",
    databaseName: "fixture_db",
    sqlitePath,
    lanceDbScope: "fixture",
    version: "fixture-version",
    syncedAt: "2026-09-03T00:00:00.000Z",
    status: "current",
    tables: [
      { tableName: "projects", lanceTableName: "mysql_fixture_projects", comment: "项目", columns: columns.projects },
      { tableName: "teams", lanceTableName: "mysql_fixture_teams", comment: "团队", columns: columns.teams },
      { tableName: "events", lanceTableName: "mysql_fixture_events", comment: "事件", columns: columns.events },
    ],
  }, null, 2)}\n`, "utf8");
  return createDatabaseSnapshot({ databaseName: "fixture_db", snapshotRoot: root, queryTimeoutMs }).getReadCapability();
}

/** 返回测试应用显式注入的别名、表粒度和聚合关键词。 */
function createFixtureProfile(): DatabaseQueryProfile {
  return {
    aggregationKeywords: [
      { keywords: ["总数"], kind: "count" },
      { keywords: ["总预算"], kind: "sum" },
    ],
    commentSuffixes: ["名称", "编号"],
    filterOperators: [
      { keywords: ["是", "为", "等于"], operator: "equals" },
      { keywords: ["包含", "含有"], operator: "contains" },
    ],
    tableAliases: { projects: ["项目"], teams: ["团队"], events: ["事件"] },
    columnAliases: {
      projects: { 负责人: "owner", 状态: "status", 标签: "tags", 预算: "budget" },
      teams: { 状态: "status" },
    },
    valueSeparators: [",", "，", "、"],
    valueStopwords: ["查找"],
  };
}

describe("RAG Stage 5 database_search", function stage5Suite() {
  it("数据源配置、来源选择和快照缺失分别返回真实错误码", async function distinguishesDatabaseFailures() {
    delete process.env.MYSQL_SOURCES_JSON;
    expect(captureDatabaseErrorCode(getDefaultDatabaseSource)).toBe(DATABASE_ERROR_CODES.CONFIG_MISSING);
    process.env.MYSQL_SOURCES_JSON = "not-json";
    expect(captureDatabaseErrorCode(getDefaultDatabaseSource)).toBe(DATABASE_ERROR_CODES.CONFIG_JSON_INVALID);
    process.env.MYSQL_SOURCES_JSON = "{}";
    expect(captureDatabaseErrorCode(getDefaultDatabaseSource)).toBe(DATABASE_ERROR_CODES.CONFIG_NOT_ARRAY);
    process.env.MYSQL_SOURCES_JSON = "[{}]";
    expect(captureDatabaseErrorCode(getDefaultDatabaseSource)).toBe(DATABASE_ERROR_CODES.CONFIG_SOURCE_INVALID);
    process.env.MYSQL_SOURCES_JSON = "[]";
    expect(captureDatabaseErrorCode(getDefaultDatabaseSource)).toBe(DATABASE_ERROR_CODES.SOURCE_DEFAULT_UNAVAILABLE);
    const source = { sourceId: "fixture-source", displayName: "Fixture", database: "fixture_db", allowedTables: [], readConnection: { host: "127.0.0.1", port: 3306, user: "fixture", password: "fixture", ssl: false } };
    process.env.MYSQL_SOURCES_JSON = JSON.stringify([source, { ...source, sourceId: "second-source", database: "second_db" }]);
    expect(captureDatabaseErrorCode(getDefaultDatabaseSource)).toBe(DATABASE_ERROR_CODES.SOURCE_AMBIGUOUS);
    process.env.MYSQL_SOURCES_JSON = JSON.stringify([source]);
    const root = await mkdtemp(path.join(os.tmpdir(), "rag-stage5-missing-"));
    roots.push(root);
    await expect(createDatabaseSnapshot({ databaseName: "fixture_db", snapshotRoot: root }).getReadCapability().describeSnapshotTables()).rejects.toMatchObject({ code: DATABASE_ERROR_CODES.SNAPSHOT_NOT_FOUND });
  });

  it("底层认证、连接和超时错误映射为不同数据库错误码", function mapsConnectionFailures() {
    expect(toDatabaseError(Object.assign(new Error("denied"), { code: "ER_ACCESS_DENIED_ERROR" }), DATABASE_ERROR_CODES.INSPECTION_FAILED).code).toBe(DATABASE_ERROR_CODES.CONNECTION_AUTHENTICATION_FAILED);
    expect(toDatabaseError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), DATABASE_ERROR_CODES.SYNC_FAILED).code).toBe(DATABASE_ERROR_CODES.CONNECTION_TIMEOUT);
    expect(toDatabaseError(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), DATABASE_ERROR_CODES.SYNC_FAILED).code).toBe(DATABASE_ERROR_CODES.CONNECTION_FAILED);
  });

  it("持久列字典支持中文别名、列值、多值与跨表粒度消歧", async function searchesDeterministically() {
    const snapshot = await createFixtureCapability();
    const capability = createDatabaseSearchCapability(snapshot, { profile: createFixtureProfile() });
    await expect(snapshot.describeSnapshotTables()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ tableName: "projects", columns: expect.arrayContaining([expect.objectContaining({ name: "owner", comment: "负责人" })]) })]));
    await expect(capability.search({ kind: "semantic", query: "项目负责人是张三" })).resolves.toMatchObject({ kind: "sql", rows: [{ name: "星火" }, { name: "磐石" }], truncated: false });
    await expect(capability.search({ kind: "semantic", query: "项目标签是安全、后端" })).resolves.toMatchObject({ kind: "sql", rows: [{ name: "星火" }], truncated: false });
    await expect(capability.search({ kind: "semantic", query: "查找星火" })).resolves.toMatchObject({ kind: "sql", rows: [expect.objectContaining({ name: "星火" })] });
    const scoped = await capability.search({ kind: "semantic", query: "项目状态是进行中" });
    expect(scoped).toMatchObject({ kind: "sql", involvedTables: ["projects"] });
    expect(scoped.kind === "sql" ? scoped.rows : []).toHaveLength(2);
  });

  it("自然语言聚合和显式 COUNT/SUM/JOIN 都保留结构化完整结果", async function returnsStructuredAggregates() {
    const capability = createDatabaseSearchCapability(await createFixtureCapability(), { profile: createFixtureProfile() });
    await expect(capability.search({ kind: "semantic", query: "项目总数" })).resolves.toMatchObject({ kind: "sql", rows: [{ count: 3 }], truncated: false });
    await expect(capability.search({ kind: "semantic", query: "项目总预算" })).resolves.toMatchObject({ kind: "sql", rows: [{ sum_value: 300 }], truncated: false });
    await expect(capability.search({ kind: "sql", sql: "SELECT COUNT(*) AS total, SUM(budget) AS budget FROM projects" })).resolves.toMatchObject({ kind: "sql", rows: [{ total: 3, budget: 300 }], truncated: false });
    await expect(capability.search({ kind: "sql", sql: "SELECT projects.name AS project, teams.name AS team FROM projects JOIN teams ON projects.team_id = teams.id ORDER BY projects.id" })).resolves.toMatchObject({ kind: "sql", rows: [{ project: "星火", team: "平台" }, { project: "远航", team: "体验" }, { project: "磐石", team: "平台" }], involvedTables: ["projects", "teams"] });
  });

  it("安全行上限返回截断事实并拒绝注入、多语句、DDL 与注释绕过", async function enforcesSqlBoundary() {
    const capability = createDatabaseSearchCapability(await createFixtureCapability(), { profile: createFixtureProfile() });
    const limited = await capability.search({ kind: "sql", sql: "SELECT * FROM events ORDER BY id" });
    expect(limited).toMatchObject({ kind: "sql", truncated: true });
    expect(limited.kind === "sql" ? limited.rows : []).toHaveLength(200);
    await expect(capability.search({ kind: "sql", sql: "SELECT * FROM projects; DROP TABLE projects" })).rejects.toMatchObject({ code: DATABASE_ERROR_CODES.QUERY_NOT_READ_ONLY });
    await expect(capability.search({ kind: "sql", sql: "SELECT * FROM projects -- 绕过" })).rejects.toMatchObject({ code: DATABASE_ERROR_CODES.QUERY_NOT_READ_ONLY });
    await expect(capability.search({ kind: "sql", sql: "DELETE FROM projects" })).rejects.toMatchObject({ code: DATABASE_ERROR_CODES.QUERY_NOT_READ_ONLY });
    await expect(capability.search({ kind: "semantic", query: "项目负责人是张三' OR 1=1 --" })).rejects.toMatchObject({ code: DATABASE_ERROR_CODES.QUERY_NOT_READ_ONLY });
  });

  it("SQLite 超时会终止隔离 Worker，而不是查询结束后补记超时", async function interruptsTimedOutQuery() {
    const snapshot = await createFixtureCapability(1);
    const startedAt = Date.now();
    await expect(snapshot.snapshotQuery("SELECT * FROM events")).rejects.toMatchObject({ code: DATABASE_ERROR_CODES.QUERY_TIMEOUT });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("Core 不预设中文操作符，宿主未注入 Profile 时不编译精确列筛选", async function requiresInjectedLanguageProfile() {
    const base = await createFixtureCapability();
    const snapshot: DatabaseSnapshotReadCapability = {
      ...base,
      snapshotQuery: vi.fn(async function emptyStructuredResult(sql: string) {
        return { columns: [], rows: [], involvedTables: sql.includes("projects") ? ["projects"] : [], snapshot: { databaseName: "fixture_db", version: "fixture-version", syncedAt: "2026-09-03T00:00:00.000Z", status: "current" as const }, truncated: false };
      }),
      search: vi.fn(async function semanticSearch() { return []; }),
    };
    const capability = createDatabaseSearchCapability(snapshot);
    await expect(capability.search({ kind: "semantic", query: "项目负责人是张三" })).resolves.toEqual({ kind: "semantic", results: [], snapshotStatus: "current" });
    expect(snapshot.snapshotQuery).toHaveBeenCalled();
    expect(vi.mocked(snapshot.snapshotQuery).mock.calls[0][0]).not.toBe("SELECT * FROM \"projects\" WHERE \"owner\" LIKE '%张三%' ESCAPE '\\'");
    expect(snapshot.search).toHaveBeenCalledTimes(1);
  });

  it("数据库真实错误码进入 Agent Tool 结果时保持精确分类", async function preservesDatabaseToolErrorCode() {
    const capability = createDatabaseSearchCapability(await createFixtureCapability());
    const tool = createDatabaseSearchTool(capability);
    let caught: unknown;
    try {
      await tool.execute({ kind: "sql", sql: "DELETE FROM projects" }, {} as never);
    } catch (error) {
      caught = error;
    }
    expect(toToolError(caught)).toEqual({ code: DATABASE_ERROR_CODES.QUERY_NOT_READ_ONLY, message: "数据库查询只允许单条只读 SELECT、JOIN 或聚合 SQL" });
  });

  it("零命中与未消歧查询走语义兜底且清除内部数据库身份", async function fallsBackSafely() {
    const base = await createFixtureCapability();
    const semanticResult: VectorOutput = { id: "semantic-1", score: 1, text: "语义结果", metadata: { source: "mysql_entity", sourceId: "secret-source", databaseName: "secret_db", syncedAt: "secret-time", tableName: "projects" } };
    const snapshot: DatabaseSnapshotReadCapability = {
      ...base,
      search: vi.fn(async function semanticSearch() { return [semanticResult]; }),
    };
    const capability = createDatabaseSearchCapability(snapshot, { profile: createFixtureProfile() });
    await expect(capability.search({ kind: "semantic", query: "完全不存在" })).resolves.toEqual({ kind: "semantic", results: [{ id: "semantic-1", score: 1, text: "语义结果", metadata: { source: "mysql_entity", tableName: "projects" } }], snapshotStatus: "current" });
    await expect(capability.search({ kind: "semantic", query: "状态是进行中" })).resolves.toMatchObject({ kind: "semantic" });
    expect(snapshot.search).toHaveBeenCalledTimes(2);
  });

  it("受控规划器只能返回当前快照存在的表列", async function validatesPlannerOutput() {
    const base = await createFixtureCapability();
    const snapshot: DatabaseSnapshotReadCapability = {
      ...base,
      search: vi.fn(async function semanticFallback() { return []; }),
    };
    const rejectedPlanner = createDatabaseSearchCapability(snapshot, {
      profile: createFixtureProfile(),
      planAmbiguousQuery: vi.fn(async function invalidPlan() { return { tableName: "private_table", columnName: "secret", value: "x", operator: "equals" as const }; }),
    });
    const fallback = await rejectedPlanner.search({ kind: "semantic", query: "状态是进行中" });
    expect(fallback.kind).toBe("semantic");
  });

  it("旧 snapshot_query 只保留内部恢复能力且不会改变统一公开名称", async function keepsLegacyRecoveryOnly() {
    const snapshot = await createFixtureCapability();
    const legacy = createSnapshotQueryTool(snapshot);
    expect(legacy.name).toBe("snapshot_query");
    await expect(legacy.execute({ sql: "SELECT COUNT(*) AS total FROM projects" }, {} as never)).resolves.toMatchObject({ rows: [{ total: 3 }] });
  });
});
