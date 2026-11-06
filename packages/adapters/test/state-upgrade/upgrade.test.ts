/** 状态升级回归：隔离验证已发布6/7、旧历史、完整备份、新根、重开与失败恢复。 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Session } from "@autopilot-agent/core";
import { initializeNodeStateRoot, getNodeStateSchemaDiagnostic } from "../../src/node/state-root";
import { createNodeSessionStore } from "../../src/node/stores/node-session-store";

/** 所有测试文件留在本任务的固定产物目录。 */
function root(): string {
  const base = path.resolve(process.cwd(), "../../.agent-tests/work-test/state-upgrade-01a19ad3/fixtures");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "state-"));
}

/** 写入最小旧版夹具，正文不含真实用户数据。 */
function json(directory: string, relative: string, value: unknown): string {
  const file = path.join(directory, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

/** 保持两种产品各自的持久身份，不从目录名称猜测产品。 */
function session(productMode: "chat" | "work", id = "history"): Session {
  return { id, productMode, ...(productMode === "work" ? { projectId: "project" } : { chatRetrievalMode: "none" }), persistenceMode: "durable", status: "completed", createdAt: 1, updatedAt: 2, presentation: { messages: [{ id: "answer", role: "assistant", content: "历史回答", createdAt: 2 }] } };
}

describe("已发布状态升级", function upgradeSuite() {
  /** 真实短进程退出后遗留的锁可识别，不要求用户删除锁或编辑历史。 */
  it("已退出进程的遗留写锁不阻止自动升级", function toleratesExitedWriter() {
    const child = spawnSync(process.execPath, ["-e", ""], { timeout: 10_000, windowsHide: true });
    expect(child.status).toBe(0);
    const directory = root();
    json(directory, "schema.json", { schemaVersion: 6 });
    json(directory, "transcripts/history.jsonl.lock", { pid: child.pid, ownerId: "exited", createdAt: 1 });
    json(directory, "sessions/history.json", session("work"));
    expect(() => initializeNodeStateRoot(directory)).not.toThrow();
    expect(getNodeStateSchemaDiagnostic(directory)).toMatchObject({ fromVersion: 6, toVersion: 8 });
  });

  /** 两条宿主共用的历史读取、追加会话和幂等初始化均通过真实 Session Store 验证。 */
  it.each([{ version: 6, mode: "chat" as const }, { version: 7, mode: "chat" as const }, { version: 6, mode: "work" as const }, { version: 7, mode: "work" as const }])("v$version $mode 历史保留且可继续创建，重开不重复备份", async function upgradesPublished({ version, mode }) {
    const directory = root();
    json(directory, "schema.json", { schemaVersion: version });
    const file = json(directory, "sessions/history.json", session(mode));
    const original = fs.readFileSync(file);
    const transcript = json(directory, "transcripts/history.jsonl", { history: "不可丢失的原记录" });
    const transcriptBytes = fs.readFileSync(transcript);
    expect(() => initializeNodeStateRoot(directory)).not.toThrow();
    const store = createNodeSessionStore({ stateRoot: directory, productMode: mode });
    expect(await store.list()).toEqual([session(mode)]);
    expect(fs.readFileSync(file)).toEqual(original);
    expect(fs.readFileSync(transcript)).toEqual(transcriptBytes);
    const diagnostic = getNodeStateSchemaDiagnostic(directory)!;
    expect(diagnostic).toMatchObject({ fromVersion: version, toVersion: 8 });
    expect(fs.readFileSync(path.join(diagnostic.backupPath, "sessions/history.json"))).toEqual(original);
    await store.save(session(mode, "new-session"));
    initializeNodeStateRoot(directory);
    expect(await createNodeSessionStore({ stateRoot: directory, productMode: mode }).list()).toHaveLength(2);
    expect(getNodeStateSchemaDiagnostic(directory)).toEqual(diagnostic);
    expect(fs.readdirSync(`${directory}.schema-backups`)).toHaveLength(1);
  });

  /** v6 当时允许省略 Work 产品字段；升级只补该字段，不改归属或历史来源版本。 */
  it("v6 缺省 Work 身份在副本补齐并保留原始备份", async function upgradesLegacyIdentity() {
    const directory = root();
    json(directory, "schema.json", { schemaVersion: 6 });
    const { productMode: _mode, ...old } = session("work");
    const file = json(directory, "sessions/history.json", old);
    initializeNodeStateRoot(directory);
    expect(await createNodeSessionStore({ stateRoot: directory }).get("history")).toEqual(session("work"));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).not.toHaveProperty("workContextVersion");
    expect(JSON.parse(fs.readFileSync(path.join(getNodeStateSchemaDiagnostic(directory)!.backupPath, "sessions/history.json"), "utf8"))).not.toHaveProperty("productMode");
  });

  /** 旧来源有唯一可验证创建摘要时才回填；旧进展、冻结权限与组记录不改写。 */
  it("v7 恢复可信创建来源并保留旧组进展和权限", async function preservesThreadHistory() {
    const directory = root();
    json(directory, "schema.json", { schemaVersion: 7 });
    const actor = { kind: "thread", threadId: "parent", turnId: "source-turn" };
    const actorKey = JSON.stringify(["thread", "parent"]);
    const creationId = createHash("sha256").update(JSON.stringify(["group", actorKey, "create-child"])).digest("hex");
    json(directory, "sessions/history.json", { ...session("work"), collaborationCreationId: creationId, collaborationAllowedTools: ["read_file"] });
    const file = json(directory, "threads/groups/group/control.json", { group: { groupId: "group", projectId: "project" }, creates: [{ threadId: "history", actorKey, requestId: "create-child", from: actor }], progress: [{ threadId: "history", progressSeq: 1, summary: "旧进展" }] });
    const original = fs.readFileSync(file);
    initializeNodeStateRoot(directory);
    expect(await createNodeSessionStore({ stateRoot: directory }).get("history")).toMatchObject({ collaborationAllowedTools: ["read_file"], creationSource: { actor, requestId: "create-child" } });
    expect(fs.readFileSync(file)).toEqual(original);
  });

  /** 新目录仍走原有初始化分支，两种产品均可写入和重新读取。 */
  it.each(["work", "chat"] as const)("全新 %s 状态正常初始化并可重新打开", async function createsNew(mode) {
    const directory = root();
    initializeNodeStateRoot(directory);
    const store = createNodeSessionStore({ stateRoot: directory, productMode: mode });
    await store.save(session(mode));
    initializeNodeStateRoot(directory);
    expect(await store.get("history")).toEqual(session(mode));
    expect(fs.existsSync(`${directory}.schema-backups`)).toBe(false);
  });

  /** 真正损坏的身份无法自动推断；迁移失败必须保留原数据及完整恢复副本。 */
  it("升级失败保留原状态和备份，修正数据后可重试", function keepsFailedMigration() {
    const directory = root();
    const manifest = json(directory, "schema.json", { schemaVersion: 6 });
    const file = json(directory, "sessions/history.json", { ...session("work"), projectId: undefined });
    const before = fs.readFileSync(file);
    expect(() => initializeNodeStateRoot(directory)).toThrow(expect.objectContaining({ code: "STATE_SCHEMA_MIGRATION_FAILED" }));
    expect(JSON.parse(fs.readFileSync(manifest, "utf8")).schemaVersion).toBe(6);
    expect(fs.readFileSync(file)).toEqual(before);
    const backups = `${directory}.schema-backups`;
    expect(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0], "sessions/history.json"))).toEqual(before);
    json(directory, "sessions/history.json", session("work"));
    expect(() => initializeNodeStateRoot(directory)).not.toThrow();
  });

  /** 并发升级和仍运行的 Turn 都明确阻塞，不能带着活跃写入切换根。 */
  it.each(["lock", "lease", "writer", "unknown-writer"])("%s 占用时保留旧状态，释放后可升级", function respectsBusyState(kind) {
    const directory = root();
    json(directory, "schema.json", { schemaVersion: 7 });
    json(directory, "sessions/history.json", session("work"));
    if (kind === "lock") fs.writeFileSync(`${directory}.schema-lock`, String(process.pid));
    else if (kind === "lease") json(directory, "leases/history.json", { lease: { heartbeatAt: Date.now() } });
    else json(directory, "transcripts/history.jsonl.lock", { pid: kind === "writer" ? process.pid : 0 });
    expect(() => initializeNodeStateRoot(directory)).toThrow(expect.objectContaining({ code: "STATE_SCHEMA_BUSY" }));
    expect(JSON.parse(fs.readFileSync(path.join(directory, "schema.json"), "utf8")).schemaVersion).toBe(7);
    if (kind === "lock") fs.unlinkSync(`${directory}.schema-lock`);
    else if (kind === "lease") json(directory, "leases/history.json", { lease: { heartbeatAt: 0 } });
    else fs.unlinkSync(path.join(directory, "transcripts/history.jsonl.lock"));
    expect(() => initializeNodeStateRoot(directory)).not.toThrow();
  });

  /** 两次切换之间退出后，从原副本恢复再完整重试；不把临时目录当用户新根。 */
  it("中断在根切换窗口后可恢复并重新升级", async function recoversInterruptedSwitch() {
    const directory = root();
    json(directory, "schema.json", { schemaVersion: 7 });
    json(directory, "sessions/history.json", session("work"));
    fs.renameSync(directory, `${directory}.schema-original`);
    json(`${directory}.schema-staging`, "partial.json", { unfinished: true });
    initializeNodeStateRoot(directory);
    expect(await createNodeSessionStore({ stateRoot: directory }).get("history")).toEqual(session("work"));
    expect(fs.existsSync(path.join(directory, "partial.json"))).toBe(false);
  });
});
