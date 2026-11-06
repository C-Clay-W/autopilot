/** 验证内存协作组的原子 CAS 与状态副本隔离。 */
import { describe, expect, it } from "vitest";
import { MemoryThreadStore } from "../../src/runtime/adapters/memory/memory-thread-store";
import type { ThreadControl } from "../../src/runtime/domain/thread-collaboration";

/** 构造一个独立的协作组控制快照。 */
function control(): ThreadControl {
  const actor = { kind: "human" as const, principalId: "user" };
  return { group: { groupId: "g", workspaceId: "w", projectId: "p", rootThreadId: "s", enabled: true, createdAt: 1, createdBy: actor, allowedTools: [] }, revision: 0, members: [], receipts: [], creates: [], sharedState: {}, stateRevision: 0, stateUpdatedAt: 1, stateUpdatedBy: actor, nextGroupSeq: 1, eventIntents: [], nextDeliverySeq: {}, messageIntents: [] };
}

describe("MemoryThreadStore", function threadStoreContract() {
  it("并发同版本写入只有一个成功，旧版本不覆盖", async function casConflict() {
    const store = new MemoryThreadStore();
    const initial = control();
    expect(await store.compareAndSetControl("g", null, initial)).toBe(true);
    const a = { ...initial, revision: 1, sharedState: { result: "a" } };
    const b = { ...initial, revision: 1, sharedState: { result: "b" } };
    expect(await Promise.all([store.compareAndSetControl("g", 0, a), store.compareAndSetControl("g", 0, b)])).toEqual([true, false]);
    expect((await store.readControl("g"))?.sharedState).toEqual({ result: "a" });
  });

  it("写入和读取均复制，调用者不能绕过 CAS 修改", async function copyIsolation() {
    const store = new MemoryThreadStore();
    const input = control();
    await store.compareAndSetControl("g", null, input);
    input.group.enabled = false;
    const copy = (await store.readControl("g"))!;
    expect(copy.group.enabled).toBe(true);
    copy.group.enabled = false;
    expect((await store.readControl("g"))?.group.enabled).toBe(true);
    expect(await store.readControl("unknown")).toBeNull();
  });
});
