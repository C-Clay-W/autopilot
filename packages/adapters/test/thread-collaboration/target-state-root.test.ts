/** 验证目标状态根初始化与旧状态保护，绝不使用真实用户目录。 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSessionStore } from "../../src/node/stores/node-session-store";
import { assertNodeStateSchema, initializeNodeStateRoot } from "../../src/node/state-root";

/** 创建本任务下的隔离测试目录。 */
function root(): string {
  const base = path.resolve(process.cwd(), "../../.agent-tests/work-test/plan1101-01a196cc/fixtures/node-roots");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "schema-"));
}

describe("目标状态根", function targetRootTests() {
  it("空根初始化为 8 并允许重新打开", function createsTarget() {
    const dir = root();
    initializeNodeStateRoot(dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "schema.json"), "utf8")).schemaVersion).toBe(8);
    expect(() => assertNodeStateSchema(dir)).not.toThrow();
    expect(() => initializeNodeStateRoot(dir)).not.toThrow();
  });
  it("拒绝未知新版和非空无标识根而不修改", function preservesOtherRoots() {
    const old = root();
    const legacy = root();
    fs.writeFileSync(path.join(old, "schema.json"), '{"schemaVersion":99}');
    fs.writeFileSync(path.join(old, "data"), "original");
    fs.writeFileSync(path.join(legacy, "data"), "legacy");
    expect(() => initializeNodeStateRoot(old)).toThrow();
    expect(() => initializeNodeStateRoot(legacy)).toThrow();
    expect(fs.readdirSync(old).sort()).toEqual(["data", "schema.json"]);
    expect(fs.readFileSync(path.join(old, "data"), "utf8")).toBe("original");
    expect(fs.readFileSync(path.join(old, "schema.json"), "utf8")).toBe('{"schemaVersion":99}');
    expect(fs.readdirSync(legacy)).toEqual(["data"]);
  });
  it("当前格式读取缺失身份记录时拒绝且不回填", async function rejectsLegacySession() {
    const dir = root(); initializeNodeStateRoot(dir);
    fs.mkdirSync(path.join(dir, "sessions"));
    const file = path.join(dir, "sessions", "legacy.json");
    const source = JSON.stringify({ id: "legacy", projectId: "p", persistenceMode: "durable", status: "idle", createdAt: 1, updatedAt: 1 });
    fs.writeFileSync(file, source);
    await expect(createNodeSessionStore({ stateRoot: dir }).get("legacy")).rejects.toMatchObject({ code: "SESSION_MODE_MISMATCH" });
    expect(fs.readFileSync(file, "utf8")).toBe(source);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["legacy.json"]);
  });
});
