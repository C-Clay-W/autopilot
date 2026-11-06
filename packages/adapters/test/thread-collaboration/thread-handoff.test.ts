/** 验证 Node 交接写入：固定目录、固定文件名、同内容幂等、不同内容冲突与无法越界。 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeThreadHandoffWriter } from "../../src/node/thread-handoff";

/** 创建本任务下的隔离工作区目录，不使用真实用户项目。 */
function workspace(): string {
  const base = path.resolve(process.cwd(), "../../.agent-tests/work-test/01a1831c-a3c3-7200-b56a-11bf9086de52/node-roots");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "handoff-"));
}

/** 固定 32 位十六进制标识，与 Core 派生格式一致。 */
const handoffId = "a".repeat(32);

describe("Node 交接写入", function nodeHandoffTests() {
  // 跨进程文件锁在 Windows 并行负载下可能超过默认 5 秒，单独放宽超时。
  it("写入固定相对路径并可重复读取同一内容", async function writesFixedPath() {
    const root = workspace();
    const writer = createNodeThreadHandoffWriter({ workspaceRoot: root });
    const document = await writer.write({ workspaceId: "workspace", handoffId, title: "S4b", markdown: "目标与下一步" });
    expect(document.relativePath).toBe(`.autopilot/thread-passdown-${handoffId}.md`);
    expect(document.sha256).toMatch(/^[0-9a-f]{64}$/);
    const file = path.join(root, ".autopilot", `thread-passdown-${handoffId}.md`);
    expect(fs.readFileSync(file, "utf8")).toBe(`# Handoff：S4b\n\n目标与下一步\n`);
    // 同内容重放返回同一引用，不重写文件。
    const replay = await writer.write({ workspaceId: "workspace", handoffId, title: "S4b", markdown: "目标与下一步" });
    expect(replay).toEqual(document);
  }, 20_000);

  it("同 ID 不同内容返回冲突且不覆盖原文件", async function conflicts() {
    const root = workspace();
    const writer = createNodeThreadHandoffWriter({ workspaceRoot: root });
    await writer.write({ workspaceId: "workspace", handoffId, title: "S4b", markdown: "第一版" });
    await expect(writer.write({ workspaceId: "workspace", handoffId, title: "S4b", markdown: "第二版" })).rejects.toThrow("THREAD_HANDOFF_CONFLICT");
    expect(fs.readFileSync(path.join(root, ".autopilot", `thread-passdown-${handoffId}.md`), "utf8")).toContain("第一版");
  }, 20_000);

  it("拒绝非法 handoffId 与指向工作区外的目录链接", async function rejectsEscapes() {
    const root = workspace();
    const outside = workspace();
    const writer = createNodeThreadHandoffWriter({ workspaceRoot: root });
    await expect(writer.write({ workspaceId: "workspace", handoffId: "../../escape", title: "A", markdown: "B" })).rejects.toThrow("THREAD_HANDOFF_WRITE_FAILED");
    // 目录链接指向工作区外时拒绝写入；Windows 无特权环境用 junction 表达同一越界语义。
    fs.symlinkSync(outside, path.join(root, ".autopilot"), "junction");
    await expect(writer.write({ workspaceId: "workspace", handoffId, title: "A", markdown: "B" })).rejects.toThrow("THREAD_HANDOFF_WRITE_FAILED");
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
