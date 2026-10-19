/**
 * @文件提及提交侧契约测试：覆盖 mention 提取去重、越界拒绝、8MiB/2000 行/256KiB 截断、
 * 目录一层上限与 <system-reminder> 附加块格式（真实临时目录 + 默认 fs 接缝）。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractFileMentions, resolveFileMentionContext } from "../src/file-mention-context.js";

const temporaryRoots: string[] = [];

/** 创建带文本、中文文件、超大文件与多层目录的独立提交侧工作区。 */
async function createMentionWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "autopilot-mention-ctx-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "文档"), { recursive: true });
  await mkdir(path.join(root, "many"), { recursive: true });
  await writeFile(path.join(root, "docs", "guide.md"), "第一行\n第二行\n", "utf8");
  await writeFile(path.join(root, "docs", "todo.md"), "待办事项\n", "utf8");
  await writeFile(path.join(root, "文档", "说明.md"), "中文内容\n", "utf8");
  await writeFile(path.join(root, "README.md"), "# demo\n", "utf8");
  await writeFile(path.join(root, "big.bin"), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
  await writeFile(path.join(root, "long.txt"), Array.from({ length: 3000 }, function buildLine(_element, index) {
    return `第 ${index} 行`;
  }).join("\n") + "\n", "utf8");
  await writeFile(path.join(root, "wide.txt"), "字".repeat(300 * 1024) + "\n", "utf8");
  await Promise.all(Array.from({ length: 150 }, function buildEntryName(_element, index) {
    return `entry-${String(index).padStart(3, "0")}.txt`;
  }).map(async function writeEntry(name) {
    return writeFile(path.join(root, "many", name), "x\n", "utf8");
  }));
  return root;
}

/** 清理自动化测试创建的临时工作区。 */
afterEach(async function cleanupWorkspaces() {
  await Promise.all(temporaryRoots.splice(0).map(function removeRoot(root) {
    return rm(root, { recursive: true, force: true });
  }));
});

describe("extractFileMentions", function mentionsSuite() {
  it("提取 @ 引用并去重保序，反斜杠归一为正斜杠", function extractsAndDeduplicates() {
    expect(extractFileMentions("看看 @docs/guide.md 和 @docs\\guide.md，再看 @docs/todo.md")).toEqual([
      "docs/guide.md",
      "docs/todo.md",
    ]);
  });

  it("@ 前必须是行首或空白，邮箱不触发", function rejectsNonBoundaryAt() {
    expect(extractFileMentions("联系 a@b.com 获取")).toEqual([]);
  });
});

describe("resolveFileMentionContext", function contextSuite() {
  it("无 @ 引用时原样返回", async function keepsPlainContent() {
    const root = await createMentionWorkspace();
    const original = "普通提问，无引用";
    await expect(resolveFileMentionContext(original, root)).resolves.toEqual({ content: original, notices: [] });
  });

  it("按冻结契约构造附加块（原文 + system-reminder + 行数标注）", async function buildsAttachmentBlock() {
    const root = await createMentionWorkspace();
    const original = "看看 @docs/guide.md 的内容";
    const result = await resolveFileMentionContext(original, root);
    expect(result.notices).toEqual([]);
    expect(result.content).toBe([
      "看看 @docs/guide.md 的内容",
      "",
      "<system-reminder>",
      "用户通过 @ 引用了以下工作区文件，内容已直接附加：",
      "--- @docs/guide.md (2 行) ---",
      "第一行",
      "第二行",
      "</system-reminder>",
    ].join("\n"));
  });

  it("同一文件多次引用只附加一次", async function deduplicatesMentions() {
    const root = await createMentionWorkspace();
    const result = await resolveFileMentionContext("@docs/todo.md 再看 @docs/todo.md", root);
    expect(result.content.match(/--- @docs\/todo\.md/g)).toHaveLength(1);
  });

  it("不存在的路径产生未找到 notice 且不追加附加块", async function reportsMissingPath() {
    const root = await createMentionWorkspace();
    const original = "看看 @missing.txt";
    const result = await resolveFileMentionContext(original, root);
    expect(result.notices).toEqual(["@missing.txt 未找到"]);
    expect(result.content).toBe(original);
  });

  it("拒绝越界与绝对路径", async function rejectsEscapePaths() {
    const root = await createMentionWorkspace();
    const result = await resolveFileMentionContext("@../outside 与 @/etc/passwd", root);
    expect(result.notices).toEqual([
      "@../outside 超出工作区边界，已拒绝读取",
      "@/etc/passwd 超出工作区边界，已拒绝读取",
    ]);
  });

  it("超过 8MiB 的文件被拒绝", async function rejectsOversizedFile() {
    const root = await createMentionWorkspace();
    const original = "看看 @big.bin";
    const result = await resolveFileMentionContext(original, root);
    expect(result.notices).toEqual(["@big.bin 超过 8MiB，已拒绝读取"]);
    expect(result.content).toBe(original);
  });

  it("超过 2000 行的文件截断为前 2000 行并标注", async function truncatesLongFiles() {
    const root = await createMentionWorkspace();
    const result = await resolveFileMentionContext("看看 @long.txt", root);
    expect(result.notices).toEqual([]);
    expect(result.content).toContain("--- @long.txt (前 2000 行，共 3000 行) ---");
    expect(result.content).toContain("第 1999 行");
    expect(result.content).not.toContain("第 2999 行");
  });

  it("单行超过 256KiB 时按 UTF-8 字节边界截断", async function truncatesWideLineByBytes() {
    const root = await createMentionWorkspace();
    const result = await resolveFileMentionContext("看看 @wide.txt", root);
    expect(result.notices).toEqual([]);
    expect(result.content).toContain("--- @wide.txt (前 256KiB，共 1 行) ---");
    expect(result.content.length).toBeLessThan("看看 @wide.txt".length + 256 * 1024 + 200);
  });

  it("目录引用附加一层条目列表，超出 100 项时截断标注", async function listsDirectoryOneLevel() {
    const root = await createMentionWorkspace();
    const docs = await resolveFileMentionContext("看看 @docs/ 的结构", root);
    expect(docs.content).toContain("--- @docs/ (2 项) ---\nguide.md\ntodo.md");

    const many = await resolveFileMentionContext("看看 @many", root);
    expect(many.content).toContain("--- @many (前 100 项，共 150 项) ---");
    expect(many.content.match(/entry-\d+\.txt/g)).toHaveLength(100);
  });

  it("支持中文路径并按出现顺序拼接多个文件", async function supportsChineseAndMultipleFiles() {
    const root = await createMentionWorkspace();
    const original = "先看 @文档/说明.md 再看 @README.md";
    const result = await resolveFileMentionContext(original, root);
    expect(result.notices).toEqual([]);
    const chineseIndex = result.content.indexOf("--- @文档/说明.md (1 行) ---");
    const readmeIndex = result.content.indexOf("--- @README.md (1 行) ---");
    expect(chineseIndex).toBeGreaterThan(-1);
    expect(readmeIndex).toBeGreaterThan(chineseIndex);
    expect(result.content).toContain("中文内容");
  });

  it("部分引用失败时成功的仍附加，失败的产生 notice", async function mixesSuccessAndFailure() {
    const root = await createMentionWorkspace();
    const original = "看 @docs/guide.md 和 @missing.txt";
    const result = await resolveFileMentionContext(original, root);
    expect(result.notices).toEqual(["@missing.txt 未找到"]);
    expect(result.content.startsWith(`${original}\n\n<system-reminder>`)).toBe(true);
    expect(result.content).toContain("--- @docs/guide.md (2 行) ---");
  });
});
