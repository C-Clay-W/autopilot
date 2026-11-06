/** 验证 Transcript 按字节游标有界只读，跨 Session 游标拒绝。 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeNodeStateRoot } from "../../src/node/state-root";
import { createNodeTranscriptStore } from "../../src/node/stores/node-transcript-store";

/** 为每个测试分配独立的新状态根。 */
function root(): string {
  const base = path.resolve(process.cwd(), "../../.agent-tests/work-test/01a1831c-a3c3-7200-b56a-11bf9086de52/node-roots");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "page-"));
}

describe("Transcript 分页", function transcriptPage() {
  it("跨多页顺序读取且不改文件或创建目录", async function paginatesWithoutWrites() {
    const dir = root(); initializeNodeStateRoot(dir);
    const store = createNodeTranscriptStore({ stateRoot: dir });
    expect(await store.readPage("missing", { limit: 1 })).toEqual({ items: [] });
    expect(fs.readdirSync(dir)).toEqual(["schema.json"]);
    for (let i = 1; i <= 3; i++) await store.append("s", { sessionId: "s", turnId: "t", seq: i, timestamp: "2026-01-01T00:00:00Z", event: { type: "turn_started", turnId: "t" } } as never);
    const file = path.join(dir, "transcripts", "s.jsonl");
    const before = fs.readFileSync(file);
    const first = await store.readPage("s", { limit: 2 });
    expect(first.items.map(function seq(item) { return item.seq; })).toEqual([1, 2]);
    const next = await store.readPage("s", { limit: 2, cursor: first.nextCursor });
    expect(next.items.map(function seq(item) { return item.seq; })).toEqual([3]);
    expect(next.nextCursor).toBeUndefined();
    await expect(store.readPage("other", { limit: 1, cursor: first.nextCursor })).rejects.toThrow("THREAD_CURSOR_INVALID");
    expect(fs.readFileSync(file)).toEqual(before);
  });
  it("截断尾行明确报错，不能重复返回无进展游标", async function rejectsTruncatedTail() {
    const dir = root(); initializeNodeStateRoot(dir);
    fs.mkdirSync(path.join(dir, "transcripts"));
    fs.writeFileSync(path.join(dir, "transcripts", "s.jsonl"), '{"sessionId":"s"');
    const store = createNodeTranscriptStore({ stateRoot: dir });
    await expect(store.readPage("s", { limit: 1 })).rejects.toThrow("DURABLE_JSONL_CORRUPTED");
  });
  it("Transcript 文件被替换后旧游标明确失效", async function rejectsReplacedFile() {
    const dir = root(); initializeNodeStateRoot(dir);
    const store = createNodeTranscriptStore({ stateRoot: dir });
    for (let i = 1; i <= 2; i++) await store.append("s", { sessionId: "s", turnId: "t", seq: i, timestamp: "now", event: { type: "turn_started", turnId: "t" } } as never);
    const page = await store.readPage("s", { limit: 1 });
    const file = path.join(dir, "transcripts", "s.jsonl");
    fs.renameSync(file, `${file}.saved`);
    fs.copyFileSync(`${file}.saved`, file);
    await expect(store.readPage("s", { cursor: page.nextCursor, limit: 1 })).rejects.toThrow("THREAD_CURSOR_EXPIRED");
  });
});
