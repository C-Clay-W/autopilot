/** S5真实Node读取缓存的外部变化、审计、隔离及Core取消回归。 */
import { mkdir, mkdtemp, readFile, writeFile, appendFile, rename } from "node:fs/promises";
import path from "node:path";
import fs from "node:fs";
import { Readable } from "node:stream";
import { it, expect, vi } from "vitest";
import { createNodeRuntimePorts } from "../../../../adapters/src/node/create-node-runtime-ports";
import { readTurnExecutionView } from "../../../src/runtime/application/turn/turn-execution-view";

/** 每项使用独占根与两个真实Store实例，所有副作用属于本任务。 */
async function fixture() {
  const root = await mkdtemp(path.resolve("../../.agent-tests/work-test/cli-core-web-refix-01a1a631/runs/r001/s5-contract-"));
  const options = { stateRoot: path.join(root, "state"), workspaceRoot: root };
  const ports = createNodeRuntimePorts(options), external = createNodeRuntimePorts(options);
  await ports.projectStore.save({ id: "project", name: "controlled", workspaceRoot: root, createdAt: 1, updatedAt: 1 });
  await ports.sessionStore.save({ id: "session", productMode: "work", projectId: "project", persistenceMode: "durable", status: "waiting_approval", createdAt: 1, updatedAt: 1 });
  await ports.turnStore.save({ id: "turn", sessionId: "session", status: "waiting_approval", createdAt: 1, updatedAt: 1 } as any);
  const checkpoint = { turnId: "turn", status: "awaiting_approval", stepCount: 1, messages: [{ role: "user", content: "old" }], pendingCalls: [], completedCallIds: [], lease: { leaseId: "lease", ownerId: "owner", heartbeatAt: 1, safeBoundarySeq: 1 } } as any;
  await ports.checkpointStore.save("session", checkpoint);
  await mkdir(path.join(root, "state/transcripts"), { recursive: true });
  /** 使用固定Envelope而不依赖Provider。 */
  function event(seq: number, type = "answer_delta") { return { sessionId: "session", turnId: "turn", seq, timestamp: new Date(1).toISOString(), event: { type, turnId: "turn", delta: "controlled" } } as any; }
  return { root, ports, external, checkpoint, event, transcript: path.join(root, "state/transcripts/session.jsonl"), checkpoints: path.join(root, "state/checkpoints/session.jsonl") };
}

it("S5 Transcript分页增量、外部追加、相邻去重/损坏审计与返回副本", async function transcriptCompatibility() {
  const f = await fixture();
  const first = JSON.stringify(f.event(1));
  await writeFile(f.transcript, first + "\n" + first + "\n" + JSON.stringify(f.event(2)) + "\n");
  const all = await f.ports.transcriptStore.getEvents("session");
  expect(all.map(function seq(item) { return item.seq; })).toEqual([1, 2]);
  (all[0]!.event as any).delta = "caller-mutated";
  expect((await f.ports.transcriptStore.getEvents("session"))[0]!.event).toMatchObject({ delta: "controlled" });
  const page = await f.ports.transcriptStore.readPage("session", { limit: 2 });
  expect(page.items).toHaveLength(2);
  const second = await f.ports.transcriptStore.readPage("session", { cursor: page.cursor, limit: 2 });
  expect(second.items.map(function seq(item) { return item.seq; })).toEqual([2]);
  await f.external.transcriptStore.append("session", f.event(3));
  expect((await f.ports.transcriptStore.readPage("session", { cursor: second.cursor, limit: 2 })).items[0]?.seq).toBe(3);
  await appendFile(f.transcript, "broken\n" + JSON.stringify(f.event(4)) + "\n");
  const warning = vi.spyOn(console, "warn").mockImplementation(function quiet() {});
  try { expect((await f.ports.transcriptStore.getEvents("session")).map(function seq(item) { return item.seq; })).toEqual([1, 2, 3, 4]); expect(warning).toHaveBeenCalled(); }
  finally { warning.mockRestore(); }
  expect(await readFile(f.transcript, "utf8")).toContain("broken");
});

it("S5 Transcript同尺寸改写/原子替换/截断过期游标，追加索引重新审计", async function transcriptIdentity() {
  const f = await fixture();
  await f.ports.transcriptStore.append("session", f.event(1));
  const page = await f.ports.transcriptStore.readPage("session", { limit: 100 });
  await writeFile(f.transcript, JSON.stringify(f.event(9)) + "\n");
  await expect(f.ports.transcriptStore.readPage("session", { cursor: page.cursor, limit: 100 })).rejects.toThrow("THREAD_CURSOR_EXPIRED");
  await f.ports.transcriptStore.append("session", f.event(1));
  expect((await f.ports.transcriptStore.getEvents("session")).map(function seq(item) { return item.seq; })).toEqual([9, 1]);
  const current = await f.ports.transcriptStore.readPage("session", { limit: 100 });
  await writeFile(f.transcript + ".replacement", JSON.stringify(f.event(2)) + "\n");
  await rename(f.transcript + ".replacement", f.transcript);
  await expect(f.ports.transcriptStore.readPage("session", { cursor: current.cursor, limit: 100 })).rejects.toThrow("THREAD_CURSOR_EXPIRED");
  const replacement = await f.ports.transcriptStore.readPage("session", { limit: 100 });
  await writeFile(f.transcript, "");
  await expect(f.ports.transcriptStore.readPage("session", { cursor: replacement.cursor, limit: 100 })).rejects.toThrow("THREAD_CURSOR_EXPIRED");
});

it("S5 Checkpoint逐行审计历史Turn、双Store外部追加/同尺寸替换/截断与缓存隔离", async function checkpointCompatibility() {
  const f = await fixture();
  await f.external.checkpointStore.save("session", { ...f.checkpoint, turnId: "other" });
  expect((await f.ports.checkpointStore.getByTurn("session", "turn"))?.turnId).toBe("turn");
  const latest = (await f.ports.checkpointStore.getLatest("session"))!;
  (latest.messages[0] as any).content = "mutated";
  expect((await f.ports.checkpointStore.getLatest("session"))?.messages[0]).toMatchObject({ content: "old" });
  await f.external.checkpointStore.save("session", f.checkpoint);
  expect((await f.ports.checkpointStore.getLatest("session"))?.turnId).toBe("turn");
  const original = await readFile(f.checkpoints, "utf8");
  await writeFile(f.checkpoints, original.replaceAll('"old"', '"new"'));
  expect((await f.ports.checkpointStore.getLatest("session"))?.messages[0]).toMatchObject({ content: "new" });
  await writeFile(f.checkpoints, "broken\n" + JSON.stringify(f.checkpoint) + "\n");
  const warning = vi.spyOn(console, "warn").mockImplementation(function quiet() {});
  try { expect((await f.ports.checkpointStore.getByTurn("session", "turn"))?.turnId).toBe("turn"); expect(warning).toHaveBeenCalledWith(expect.stringContaining("lines=1")); }
  finally { warning.mockRestore(); }
  expect(await readFile(f.checkpoints, "utf8")).toContain("broken");
  await writeFile(f.checkpoints, "");
  expect(await f.ports.checkpointStore.getLatest("session")).toBeNull();
});

it("S5 安全投影游标替换/截断/外部追加重建且取消阻止后续页读取", async function viewInvalidationAndCancellation() {
  const f = await fixture();
  const started = JSON.stringify(f.event(1, "turn_started")) + "\n";
  const ended = JSON.stringify(f.event(2, "turn_completed"));
  await writeFile(f.transcript, started + ended + "\n");
  expect((await readTurnExecutionView(f.ports, { sessionId: "session" }))?.result).toBe("completed");
  const failed = JSON.stringify(f.event(2, "turn_failed")).padEnd(ended.length, " ");
  await writeFile(f.transcript, started + failed + "\n");
  expect((await readTurnExecutionView(f.ports, { sessionId: "session" }))?.result).toBe("failed");
  await writeFile(f.transcript, started);
  expect((await readTurnExecutionView(f.ports, { sessionId: "session" }))?.result).toBeUndefined();
  await f.external.transcriptStore.append("session", f.event(3, "turn_completed"));
  expect((await readTurnExecutionView(f.ports, { sessionId: "session" }))?.result).toBe("completed");
  const abort = new AbortController();
  const page = vi.spyOn(f.ports.transcriptStore, "readPage").mockImplementation(async function stop() { abort.abort(); return { items: [], nextCursor: "more" }; });
  await expect(readTurnExecutionView(f.ports, { sessionId: "session", signal: abort.signal })).rejects.toThrow();
  expect(page).toHaveBeenCalledTimes(1);
});

it("S5 控制副本热缓存保持隔离且外部CAS与损坏/同尺寸改写立即失效", async function controlIdentity() {
  const f = await fixture();
  const control = { group: { groupId: "group", enabled: true }, revision: 0, members: [], controls: [], sharedState: { label: "old" } } as any;
  await f.ports.threadStore.compareAndSetControl("group", null, control);
  const first = (await f.ports.threadStore.readControl("group"))!;
  first.sharedState.label = "mutated";
  expect((await f.ports.threadStore.readControl("group"))?.sharedState.label).toBe("old");
  await f.external.threadStore.compareAndSetControl("group", 0, { ...control, revision: 1 });
  expect((await f.ports.threadStore.readControl("group"))?.revision).toBe(1);
  const file = path.join(f.root, "state/threads/groups/group/control.json");
  const raw = await readFile(file, "utf8");
  await writeFile(file, raw.replace('"old"', '"new"'));
  expect((await f.ports.threadStore.readControl("group"))?.sharedState.label).toBe("new");
  await writeFile(file, "broken");
  await expect(f.ports.threadStore.readControl("group")).rejects.toThrow("THREAD_CONTROL_CORRUPTED");
  expect(await readFile(file, "utf8")).toBe("broken");
});

it("S5投影替换按保留量计费，并发迟到/取消摘要不能覆盖新游标", async function projectionConcurrency() {
  const f = await fixture();
  let position = 0;
  const cursors: Array<string | undefined> = [];
  const page = vi.spyOn(f.ports.transcriptStore, "readPage").mockImplementation(async function tail(_id, input) {
    cursors.push(input.cursor);
    position++;
    return { items: [{ ...f.event(position, "thread_wait"), event: { type: "thread_wait", turnId: "turn", phase: "waiting", padding: "x".repeat(600 * 1024) } }], cursor: String(position) } as any;
  });
  for (let n = 0; n < 5; n++) await readTurnExecutionView(f.ports, { sessionId: "session" });
  expect(cursors).toEqual([undefined, "1", "2", "3", "4"]);
  let releaseOld!: (value: any) => void;
  const oldPage = new Promise<any>(function hold(resolve) { releaseOld = resolve; });
  page.mockImplementationOnce(function delayed() { return oldPage; });
  const old = readTurnExecutionView(f.ports, { sessionId: "session" });
  // 等待旧查询进入正式page边界，然后新查询先提交更靠后的游标。
  for (let n = 0; n < 100 && page.mock.calls.length < 6; n++) await new Promise(function wait(resolve) { setTimeout(resolve, 5); });
  page.mockResolvedValueOnce({ items: [], cursor: "newer" });
  await readTurnExecutionView(f.ports, { sessionId: "session" });
  releaseOld({ items: [], cursor: "older" }); await old;
  page.mockResolvedValueOnce({ items: [], cursor: "after-newer" });
  await readTurnExecutionView(f.ports, { sessionId: "session" });
  expect(page.mock.calls.at(-1)![1].cursor).toBe("newer");
  const abort = new AbortController();
  page.mockImplementationOnce(async function cancelled() { abort.abort(); return { items: [], cursor: "cancelled" }; });
  await expect(readTurnExecutionView(f.ports, { sessionId: "session", signal: abort.signal })).rejects.toThrow();
  page.mockResolvedValueOnce({ items: [], cursor: "fresh" });
  await readTurnExecutionView(f.ports, { sessionId: "session" });
  expect(page.mock.calls.at(-1)![1].cursor).not.toBe("cancelled");
});

it.each(["open", "read"])("S5 checkpoint stream %s错误拒绝并释放流和原锁", async function checkpointStreamFailure(stage) {
  const f = await fixture();
  /** 在有记录前或部分记录后模拟原生流I/O失败，不改真实文件。 */
  async function* failingSource() {
    if (stage === "read") { yield JSON.stringify(f.checkpoint) + "\n"; await new Promise(function next(resolve) { setImmediate(resolve); }); }
    throw new Error("CONTROLLED_STREAM_READ_ERROR");
  }
  const stream = Readable.from(failingSource());
  const mocked = vi.spyOn(fs, "createReadStream").mockReturnValueOnce(stream as any);
  try { await expect(f.ports.checkpointStore.getLatest("session")).rejects.toThrow("CONTROLLED_STREAM_READ_ERROR"); }
  finally { mocked.mockRestore(); }
  expect(stream.destroyed).toBe(true);
  expect((await f.ports.checkpointStore.getLatest("session"))?.turnId).toBe("turn");
});
