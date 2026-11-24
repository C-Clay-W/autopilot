/**
 * @文件提及提交侧契约测试：覆盖 mention 提取去重、越界拒绝、8MiB/2000 行/256KiB 截断、
 * 目录一层上限与 <system-reminder> 附加块格式（真实临时目录 + 默认 fs 接缝）。
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractFileMentions, prepareFileMentionContext, resolveFileMentionContext, resolveFileMentionSections, type FileMentionFs } from "../src/file-mention-context.js";

const temporaryRoots: string[] = [];

/** 创建带文本、中文文件、超大文件与多层目录的独立提交侧工作区。 */
async function createMentionWorkspace(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "autopilot-mention-ctx-")));
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

  it("根内目录链接可引用文件，根外目录链接的正文和清单均被拒绝", async function boundsDirectoryLinks() {
    const root = await createMentionWorkspace();
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "autopilot-mention-outside-"));
    temporaryRoots.push(fixtureRoot);
    await writeFile(path.join(fixtureRoot, "outside.txt"), "OUTSIDE_MENTION_BODY\n", "utf8");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(path.join(root, "docs"), path.join(root, "inside"), linkType);
    await symlink(fixtureRoot, path.join(root, "outside"), linkType);

    const original = "@inside/guide.md @outside/outside.txt @outside/";
    const result = await resolveFileMentionContext(original, root);
    expect(result.content.slice(original.length)).toContain("第一行");
    expect(result.content.slice(original.length)).not.toMatch(/OUTSIDE_MENTION_BODY|outside\.txt/);
    expect(result.notices).toEqual([
      "@outside/outside.txt 超出工作区边界，已拒绝读取",
      "@outside/ 超出工作区边界，已拒绝读取",
    ]);
    await expect(resolveFileMentionContext("@outside.txt", path.join(root, "outside"))).resolves.toEqual({
      content: "@outside.txt",
      notices: ["@outside.txt 无法核实工作区，已拒绝读取"],
    });
  });

  it.each(["stat", "read"])("目标在 %s 期间变动时不附加正文", async function rejectsChangedTarget(phase) {
    const root = path.resolve("trusted");
    const target = path.join(root, "target.txt");
    let changed = false;
    const read = vi.fn(async function readTarget() {
      changed = true;
      return "UNVERIFIED_BODY";
    });
    const fs: FileMentionFs = {
      async realpath(candidate) {
        return candidate === target && changed ? path.resolve("outside.txt") : candidate;
      },
      async stat() {
        changed = phase === "stat";
        return { isFile: true, isDirectory: false, size: 10 };
      },
      readFile: read,
      async listDirectory() { return []; },
    };

    await expect(resolveFileMentionContext("@target.txt", root, { fs })).resolves.toEqual({
      content: "@target.txt",
      notices: ["@target.txt 读取失败或路径无法核实"],
    });
    expect(read).toHaveBeenCalledTimes(phase === "stat" ? 0 : 1);
  });

  it("无法核实真实路径时保留原文并且不读文件", async function rejectsUnverifiedTarget() {
    const root = path.resolve("trusted");
    const stat = vi.fn();
    const readFile = vi.fn();
    const fs: FileMentionFs = {
      async realpath(candidate) {
        if (candidate === root) return root;
        throw Object.assign(new Error("fixture"), { code: "EACCES" });
      },
      stat,
      readFile,
      listDirectory: vi.fn(),
    };

    await expect(resolveFileMentionContext("@target.txt", root, { fs })).resolves.toEqual({
      content: "@target.txt",
      notices: ["@target.txt 无法核实路径，已拒绝读取"],
    });
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
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
    const result = await resolveFileMentionSections("看看 @long.txt", root);
    expect(result.notices).toEqual([]);
    expect(result.sections[0]?.label).toBe("前 2000 行，共 3000 行");
    expect(result.sections[0]?.excerpt).toContain("第 1999 行");
    expect(result.sections[0]?.excerpt).not.toContain("第 2999 行");
  });

  it("单行超过 256KiB 时按 UTF-8 字节边界截断", async function truncatesWideLineByBytes() {
    const root = await createMentionWorkspace();
    const result = await resolveFileMentionSections("看看 @wide.txt", root);
    expect(result.notices).toEqual([]);
    expect(result.sections[0]?.label).toBe("前 256KiB，共 1 行");
    expect(Buffer.byteLength(result.sections[0]!.excerpt, "utf8")).toBeLessThanOrEqual(256 * 1024);
  });

  it("共同预算先保留原文和多文件路径，再填充 Unicode 摘录", async function appliesSharedInputBudget() {
    const root = await createMentionWorkspace();
    const body = "中🙂".repeat(12_000);
    await writeFile(path.join(root, "wide.txt"), body, "utf8");
    const original = "看 @wide.txt 和 @docs/guide.md";
    const { references } = await prepareFileMentionContext(original, root);
    expect(references).toEqual([
      { path: "wide.txt", excerpt: expect.any(String), truncated: true },
      { path: "docs/guide.md" },
    ]);
    const excerpt = references![0]!.excerpt!;
    expect(excerpt).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(body.startsWith(excerpt)).toBe(true);
    const { content } = await resolveFileMentionContext(original, root);
    expect(content.startsWith(`${original}\n\n`)).toBe(true);
    expect(content).toContain(`(摘录已截断) ---\n${excerpt}`);
    expect(content).toContain("--- @docs/guide.md (仅路径) ---");
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(32 * 1024);
  });

  it("原文超过共同预算时完整保留原文和其中的 @ 路径", async function preservesOriginalAtBudgetLimit() {
    const root = await createMentionWorkspace();
    const original = `${"字".repeat(12_000)} @docs/guide.md`;
    await expect(resolveFileMentionContext(original, root)).resolves.toEqual({ content: original, notices: [] });
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
