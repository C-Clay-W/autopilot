/** r004目录与tail游标边界：合成旧/新状态，禁止完整Session读取和正文JSON解析。 */
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { initializeNodeStateRoot } from "../../../src/node/state-root";
import { createNodeSessionStore } from "../../../src/node/stores/node-session-store";
import { createNodeTranscriptStore } from "../../../src/node/stores/node-transcript-store";

/** 测试根仅使用本任务固定产物目录，保留历史证据。 */
function root() {
  const base = path.resolve(process.cwd(), "../../.agent-tests/work-test/manual-followup-01a19eed/fixtures/r004");
  fs.mkdirSync(base, { recursive: true });
  const stateRoot = fs.mkdtempSync(path.join(base, "directory-"));
  initializeNodeStateRoot(stateRoot); fs.mkdirSync(path.join(stateRoot, "sessions")); return stateRoot;
}
/** 使用presentation先于标题的历史顺序，正文含转义与跨分片Unicode。 */
function session(id: string, projectId = "p") { return { presentation: { messages: [{ content: "秘密正文\"\\\n👩🏽‍💻".repeat(5000) }] }, id, productMode: "work", projectId, title: "同名标题", status: "idle", createdAt: 1, updatedAt: 1 }; }

it("目录只扫描有界页且过滤空页能继续，不调用get/list或解析presentation", async function boundedDirectory() {
  const dir = root();
  for (const [id, project] of [["a", "other"], ["b", "p"], ["c", "p"]]) fs.writeFileSync(path.join(dir, "sessions", `${id}.json`), JSON.stringify(session(id, project)));
  const store = createNodeSessionStore({ stateRoot: dir });
  const get = vi.spyOn(store, "get"); const list = vi.spyOn(store, "list"); const parse = vi.spyOn(JSON, "parse");
  try {
    const first = await store.listDirectoryPage!({ projectId: "p", limit: 1 }); expect(first.items).toEqual([]); expect(first.nextCursor).toBeTruthy();
    const second = await store.listDirectoryPage!({ projectId: "p", limit: 1, cursor: first.nextCursor }); expect(second.items).toEqual([{ id: "b", title: "同名标题" }]);
    fs.writeFileSync(path.join(dir, "sessions", "aa.json"), JSON.stringify(session("aa")));
    const third = await store.listDirectoryPage!({ projectId: "p", limit: 1, cursor: second.nextCursor }); expect(third.items).toEqual([{ id: "c", title: "同名标题" }]); expect(third.nextCursor).toBeUndefined();
    expect(await store.getDirectoryEntry!("b")).toMatchObject({ id: "b", title: "同名标题", productMode: "work" });
    expect(get).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
    expect(parse.mock.calls.every(function noBody(call) { return !String(call[0]).includes("秘密正文"); })).toBe(true);
    await expect(store.listDirectoryPage!({ projectId: "other", limit: 1, cursor: first.nextCursor })).rejects.toThrow();
  } finally { vi.restoreAllMocks(); }
});

it("损坏JSON结构与错身份不能被轻量目录默默跳过", async function rejectsCorruption() {
  const dir = root(); const store = createNodeSessionStore({ stateRoot: dir });
  const file = path.join(dir, "sessions", "bad.json");
  for (const content of ['{"presentation":[true,],"id":"bad"}', JSON.stringify({ ...session("bad"), productMode: undefined })]) {
    fs.writeFileSync(file, content); await expect(store.listDirectoryPage!({ projectId: "p", limit: 1 })).rejects.toThrow();
  }
  fs.writeFileSync(file, JSON.stringify(session("different"))); await expect(store.getDirectoryEntry!("bad")).rejects.toThrow("STATE_SESSION_CORRUPTED");
});

it("末尾cursor只返回后续追加事件，重复打开不写历史或schema", async function followsTail() {
  const dir = root(); const store = createNodeTranscriptStore({ stateRoot: dir });
  const schema = fs.readFileSync(path.join(dir, "schema.json"));
  /** 合成安全事件不包含用户数据。 */
  function event(seq: number) { return { sessionId: "s", turnId: "t", seq, timestamp: "2026-11-03T00:00:00Z", event: { type: "turn_started", turnId: "t" } } as never; }
  await store.append("s", event(1));
  const first = await store.readPage("s", { limit: 1 }); expect(first.nextCursor).toBeUndefined(); expect(first.cursor).toBeTruthy();
  const file = path.join(dir, "transcripts", "s.jsonl"); const before = fs.readFileSync(file);
  const empty = await createNodeTranscriptStore({ stateRoot: dir }).readPage("s", { limit: 1, cursor: first.cursor }); expect(empty.items).toEqual([]); expect(empty.cursor).toBe(first.cursor); expect(fs.readFileSync(file)).toEqual(before);
  await store.append("s", event(2)); const next = await store.readPage("s", { limit: 1, cursor: empty.cursor }); expect(next.items.map(function seq(item) { return item.seq; })).toEqual([2]); expect(fs.readFileSync(path.join(dir, "schema.json"))).toEqual(schema);
});
