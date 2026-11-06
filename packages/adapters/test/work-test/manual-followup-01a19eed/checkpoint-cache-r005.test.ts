/** 真实Node合成checkpoint缓存：重复读取、外部替换/截断、损坏与写后失效。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createNodeCheckpointStore } from "../../../src/node/stores/node-checkpoint-store";

/** 仅创建任务所属合成状态根，不删除既有证据。 */
function fixture() {
  const stateRoot = path.join(fileURLToPath(new URL("../../../../../.agent-tests/work-test/manual-followup-01a19eed/fixtures/r005/", import.meta.url)), randomUUID());
  const store = createNodeCheckpointStore({ stateRoot });
  const file = path.join(stateRoot, "checkpoints/s.jsonl");
  return { store, file };
}
/** 最小合法checkpoint保留可变messages，验证缓存不泄露可变引用。 */
function checkpoint(turnId: string) { return { turnId, status: "completed" as const, stepCount: 0, messages: [], completedCallIds: [] }; }

it("未变化文件只完整解析一次且不同Session与调用方变更隔离", async function unchanged() {
  const { store, file } = fixture(); await store.save("s", checkpoint("one")); await store.save("other", checkpoint("two"));
  const original = fs.readFileSync; let reads = 0;
  const spy = vi.spyOn(fs, "readFileSync").mockImplementation(function read(...args: Parameters<typeof fs.readFileSync>) { if (String(args[0]) === file) reads++; return original(...args); });
  try {
    const first = await store.getLatest("s"); first!.turnId = "mutated";
    const values = await Promise.all([store.getLatest("s"), store.getLatest("other"), store.getLatest("s")]);
    expect(values.map(function id(value) { return value?.turnId; })).toEqual(["one", "two", "one"]);
    expect(reads).toBe(1);
  } finally { spy.mockRestore(); }
});

it("外部替换/同尺寸改写/截断/损坏及本Store写入绝不返回旧缓存", async function invalidation() {
  const { store, file } = fixture(); await store.save("s", checkpoint("one")); expect((await store.getLatest("s"))?.turnId).toBe("one");
  const replacement = file + ".replacement"; fs.writeFileSync(replacement, JSON.stringify(checkpoint("two")) + "\n"); fs.renameSync(replacement, file);
  expect((await store.getLatest("s"))?.turnId).toBe("two");
  const old = fs.statSync(file); fs.writeFileSync(file, JSON.stringify(checkpoint("tri")) + "\n"); fs.utimesSync(file, old.atime, old.mtime);
  expect((await store.getLatest("s"))?.turnId).toBe("tri");
  fs.truncateSync(file, 0); expect(await store.getLatest("s")).toBeNull();
  const warn = vi.spyOn(console, "warn").mockImplementation(function quiet() {});
  try { fs.writeFileSync(file, "broken\n"); expect(await store.getLatest("s")).toBeNull(); expect(warn).toHaveBeenCalled(); } finally { warn.mockRestore(); }
  await store.save("s", checkpoint("new")); expect((await store.getLatest("s"))?.turnId).toBe("new");
  expect((await store.getByTurn("s", "new"))?.turnId).toBe("new");
});


it("九个Session触发有界淘汰，读取异常及缺失后不复活旧值", async function boundedAndFailed() {
  const { store, file } = fixture();
  for (let index = 0; index < 9; index++) await store.save(`s${index}`, checkpoint(`t${index}`));
  const original = fs.readFileSync; const reads: string[] = [];
  const spy = vi.spyOn(fs, "readFileSync").mockImplementation(function read(...args: Parameters<typeof fs.readFileSync>) { if (String(args[0]).endsWith(".jsonl")) reads.push(String(args[0])); return original(...args); });
  try {
    for (let index = 0; index < 9; index++) await store.getLatest(`s${index}`);
    await store.getLatest("s0"); expect(reads.filter(function first(file) { return file.endsWith("s0.jsonl"); })).toHaveLength(2);
    await store.save("s", checkpoint("old")); await store.getLatest("s");
    fs.appendFileSync(file, JSON.stringify(checkpoint("new")) + "\n");
    // 精确只使checkpoint读取失败，schema/锁元数据仍走原入口。
    spy.mockImplementation(function failCheckpoint(...args: Parameters<typeof fs.readFileSync>) { if (String(args[0]) === file) throw new Error("synthetic checkpoint read error"); return original(...args); });
    await expect(store.getLatest("s")).rejects.toThrow("synthetic checkpoint read error");
    spy.mockImplementation(function read(...args: Parameters<typeof fs.readFileSync>) { return original(...args); });
    expect((await store.getLatest("s"))?.turnId).toBe("new");
    // 重命名保留合成证据，同时制造缺失状态。
    fs.renameSync(file, file + ".removed"); expect(await store.getLatest("s")).toBeNull();
  } finally { spy.mockRestore(); }
});
