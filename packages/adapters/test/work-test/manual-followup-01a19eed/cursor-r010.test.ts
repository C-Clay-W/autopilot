/** r010回归：Windows大inode的历史游标可连续追尾，且仍拒绝被替换的文件。 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { initializeNodeStateRoot } from "../../../src/node/state-root";
import { createNodeTranscriptStore } from "../../../src/node/stores/node-transcript-store";

it("大于安全整数的Windows文件身份可分页追尾，换inode立即失效", async function largeWindowsInode() {
  const base = path.resolve("../../.agent-tests/work-test/manual-followup-01a19eed/fixtures/r010");
  fs.mkdirSync(base, { recursive: true });
  const stateRoot = fs.mkdtempSync(path.join(base, "cursor-"));
  initializeNodeStateRoot(stateRoot);
  const store = createNodeTranscriptStore({ stateRoot });
  /** 使用无业务正文的最小持久事件。 */
  function event(seq: number) { return { sessionId: "s", turnId: "t", seq, timestamp: "2026-11-03T00:00:00Z", event: { type: "turn_started", turnId: "t" } } as never; }
  await store.append("s", event(1));
  await store.append("s", event(2));
  let inode = 9007199254740993n;
  const open = fsp.open.bind(fsp);
  const spy = vi.spyOn(fsp, "open").mockImplementation(async function openLarge(...args) {
    const handle = await open(...args);
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementation(async function largeStat(options) {
      const info = await stat(options);
      return { ...info, ino: options?.bigint ? inode : Number(inode) };
    } as typeof handle.stat);
    return handle;
  });
  try {
    const first = await store.readPage("s", { limit: 1 });
    const second = await store.readPage("s", { limit: 1, cursor: first.nextCursor });
    expect(second.items.map(function seq(item) { return item.seq; })).toEqual([2]);
    const tail = await store.readPage("s", { limit: 1, cursor: second.cursor });
    expect(tail.items).toEqual([]);
    await store.append("s", event(3));
    const added = await store.readPage("s", { limit: 1, cursor: tail.cursor });
    expect(added.items.map(function seq(item) { return item.seq; })).toEqual([3]);
    // 这两个相邻64位身份转成number会相等，必须保留完整精度。
    inode = 9007199254740992n;
    await expect(store.readPage("s", { limit: 1, cursor: added.cursor })).rejects.toThrow("THREAD_CURSOR_EXPIRED");
    inode = 42n;
    const safe = await store.readPage("s", { limit: 1 });
    const legacy = JSON.parse(Buffer.from(safe.cursor!, "base64url").toString("utf8"));
    legacy.dev = Number(legacy.dev); legacy.ino = 42;
    const compatible = await store.readPage("s", { limit: 1, cursor: Buffer.from(JSON.stringify(legacy)).toString("base64url") });
    expect(compatible.items.map(function seq(item) { return item.seq; })).toEqual([2]);
  } finally { spy.mockRestore(); }
});
