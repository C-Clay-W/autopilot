/** 验证 Node 组控制在并发实例和重新打开后的 CAS 持久语义。 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeThreadStore } from "../../src/node/stores/node-thread-store";
import type { ThreadControl } from "../../../core/src/runtime/domain/thread-collaboration";

/** 创建测试组快照，避免依赖任何真实工作区状态。 */
function control(): ThreadControl {
  const actor = { kind: "human" as const, principalId: "user" };
  return { group: { groupId: "g", workspaceId: "w", projectId: "p", rootThreadId: "s", enabled: true, createdAt: 1, createdBy: actor, allowedTools: [] }, revision: 0, members: [], receipts: [], creates: [], sharedState: {}, stateRevision: 0, stateUpdatedAt: 1, stateUpdatedBy: actor, nextGroupSeq: 1, eventIntents: [], nextDeliverySeq: {}, messageIntents: [] };
}

/** 将测试状态隔离在本任务产物根，不接触用户状态。 */
function testRoot(): string {
  const root = path.resolve(process.cwd(), "../../.agent-tests/work-test/plan1101-01a196cc/fixtures/node-roots");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

describe("NodeThreadStore", function nodeStoreContract() {
  it("读缺失组不写入，两个实例竞争时 CAS 不丢更新并可重启读取", async function persistentCas() {
    const root = fs.mkdtempSync(path.join(testRoot(), "store-"));
    fs.writeFileSync(path.join(root, "schema.json"), JSON.stringify({ schemaVersion: 8 }));
    const first = createNodeThreadStore(root);
    const second = createNodeThreadStore(root);
    expect(await first.readControl("g")).toBeNull();
    expect(fs.readdirSync(root)).toEqual(["schema.json"]);
    const item = control();
    expect(await first.compareAndSetControl("g", null, item)).toBe(true);
    const values = await Promise.all([first.compareAndSetControl("g", 0, { ...item, revision: 1, sharedState: { winner: 1 } }), second.compareAndSetControl("g", 0, { ...item, revision: 1, sharedState: { winner: 2 } })]);
    expect(values.filter(Boolean)).toHaveLength(1);
    expect((await createNodeThreadStore(root).readControl("g"))?.revision).toBe(1);
  });

  it("损坏的控制文件拒绝读取与覆盖", async function corruptedControl() {
    const root = fs.mkdtempSync(path.join(testRoot(), "store-"));
    fs.writeFileSync(path.join(root, "schema.json"), JSON.stringify({ schemaVersion: 8 }));
    const file = path.join(root, "threads", "groups", "g", "control.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "broken");
    const store = createNodeThreadStore(root);
    await expect(store.readControl("g")).rejects.toThrow("THREAD_CONTROL_CORRUPTED");
    await expect(store.compareAndSetControl("g", null, control())).rejects.toThrow("THREAD_CONTROL_CORRUPTED");
    expect(fs.readFileSync(file, "utf8")).toBe("broken");
  });
  it("拒绝旧格式且不改写状态根", async function rejectsOldRoot() {
    const root = fs.mkdtempSync(path.join(testRoot(), "old-"));
    const manifest = path.join(root, "schema.json");
    fs.writeFileSync(manifest, '{"schemaVersion":6}');
    const store = createNodeThreadStore(root);
    await expect(store.compareAndSetControl("g", null, control())).rejects.toThrow("STATE_SCHEMA_VERSION_UNSUPPORTED");
    expect(fs.readFileSync(manifest, "utf8")).toBe('{"schemaVersion":6}');
    expect(fs.readdirSync(root)).toEqual(["schema.json"]);
  });
  it("跨组同时预留相同请求只能有一个成功", async function concurrentRequestReservation() {
    const root = fs.mkdtempSync(path.join(testRoot(), "request-"));
    fs.writeFileSync(path.join(root, "schema.json"), JSON.stringify({ schemaVersion: 8 }));
    const first = createNodeThreadStore(root); const second = createNodeThreadStore(root);
    const results = await Promise.allSettled([first.reserveRequest("same", "a", "hash"), second.reserveRequest("same", "b", "hash")]);
    expect(results.filter(function success(item) { return item.status === "fulfilled"; })).toHaveLength(1);
    expect(results.filter(function failed(item) { return item.status === "rejected"; })).toHaveLength(1);
  });
});
