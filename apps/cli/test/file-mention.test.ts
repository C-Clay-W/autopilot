/**
 * @文件提及输入侧纯函数契约测试：覆盖 token 提取（中文/反斜杠/光标中间）、四档评分排序与插入替换。
 */

import { describe, expect, it } from "vitest";
import {
  FILE_MENTION_MAX_CANDIDATES,
  applyFileMentionSuggestion,
  extractFileMentionToken,
  filterFileMentionCandidates,
  splitTuiFileMentionSegments,
} from "../src/tui/input/file-mention.js";

describe("extractFileMentionToken", function tokenSuite() {
  it("提取行首与空白后的 @ token", function extractsAtLineStartAndAfterSpace() {
    expect(extractFileMentionToken("@apps", 5)).toEqual({ start: 0, end: 5, query: "apps" });
    expect(extractFileMentionToken("看看 @app", 7)).toEqual({ start: 3, end: 7, query: "app" });
  });

  it("光标在 token 中间时返回光标前的查询文本并覆盖右侧残余", function extractsMidTokenCursor() {
    expect(extractFileMentionToken("@src/main.ts", 7)).toEqual({ start: 0, end: 12, query: "src/ma" });
  });

  it("支持中文文件名并保持 grapheme 索引一致", function extractsChineseFileName() {
    expect(extractFileMentionToken("看看 @文档/说明.md", 12)).toEqual({ start: 3, end: 12, query: "文档/说明.md" });
  });

  it("把反斜杠归一为正斜杠", function normalizesBackslashes() {
    expect(extractFileMentionToken("@apps\\cli\\src", 13)?.query).toBe("apps/cli/src");
  });

  it("@ 前不是行首或空白时不激活（如邮箱）", function rejectsNonBoundaryAt() {
    expect(extractFileMentionToken("邮箱 a@b.com", 12)).toBeNull();
  });

  it("token 中途遇到空白即中断", function stopsAtWhitespace() {
    expect(extractFileMentionToken("看看 @app 的内容", 11)).toBeNull();
  });

  it("空输入、光标在开头或 @ 之前时不返回 token", function rejectsInvalidCursor() {
    expect(extractFileMentionToken("", 0)).toBeNull();
    expect(extractFileMentionToken("@apps", 0)).toBeNull();
    expect(extractFileMentionToken("看看 @", 3)).toBeNull();
  });

  it("多行输入的第二行行首 @ 有效，光标紧随 @ 后为空查询", function supportsMultilineAndEmptyQuery() {
    expect(extractFileMentionToken("第一行\n@app", 8)).toEqual({ start: 4, end: 8, query: "app" });
    expect(extractFileMentionToken("看看 @", 4)?.query).toBe("");
  });
});

describe("filterFileMentionCandidates", function filterSuite() {
  const files = [
    "apps/cli/src/main.ts",
    "apps/cli/src/ma/notes.md",
    "apps/web/main.tsx",
    "docs/main-guide.md",
    "tools/maintain.py",
    "src/",
  ];

  it("按四档评分排序：完整路径前缀 > 文件名前缀 > 路径子串 > 文件名子串", function ranksByFourTiers() {
    const ranked = filterFileMentionCandidates(files, "ma");
    expect(ranked).toEqual([
      "apps/cli/src/main.ts",
      "apps/web/main.tsx",
      "docs/main-guide.md",
      "tools/maintain.py",
      "apps/cli/src/ma/notes.md",
    ]);
  });

  it("输入越完整候选越少，精确路径排第一", function narrowsAndPinsExactMatch() {
    const narrowed = filterFileMentionCandidates(files, "apps/cli/src/ma");
    expect(narrowed).toHaveLength(2);
    expect(narrowed).toContain("apps/cli/src/main.ts");

    const exact = filterFileMentionCandidates(files, "apps/cli/src/main.ts");
    expect(exact[0]).toBe("apps/cli/src/main.ts");
  });

  it("大小写不敏感匹配", function matchesCaseInsensitive() {
    expect(filterFileMentionCandidates(files, "MAIN")[0]).toBe("apps/cli/src/main.ts");
  });

  it("空查询返回排序后的全部候选，目录候选（尾随 /）与文件一起参与匹配", function handlesEmptyQueryAndDirectories() {
    expect(filterFileMentionCandidates(files, "")).toHaveLength(files.length);
    expect(filterFileMentionCandidates(files, "sr")).toContain("src/");
  });

  it("候选集上限为 50", function capsCandidates() {
    const many = Array.from({ length: 60 }, function buildFile(index) {
      return `f${String(index).padStart(3, "0")}.txt`;
    });
    expect(filterFileMentionCandidates(many, "f")).toHaveLength(FILE_MENTION_MAX_CANDIDATES);
  });
});

describe("applyFileMentionSuggestion", function applySuite() {
  it("文件候选插入后带尾随空格，光标停在空格之后", function insertsFileWithTrailingSpace() {
    const token = extractFileMentionToken("看看 @ma", 5)!;
    const applied = applyFileMentionSuggestion("看看 @ma", token, "main.ts");
    expect(applied).toEqual({ input: "看看 @main.ts ", cursor: 12 });
  });

  it("目录候选插入后保留尾随 / 且不加空格，可继续下钻输入", function insertsDirectoryWithoutSpace() {
    const token = extractFileMentionToken("@sr", 3)!;
    const applied = applyFileMentionSuggestion("@sr", token, "src/");
    expect(applied).toEqual({ input: "@src/", cursor: 5 });
  });

  it("光标在 token 中间时整体替换完整 token", function replacesWholeToken() {
    const token = extractFileMentionToken("@src/main.ts", 7)!;
    const applied = applyFileMentionSuggestion("@src/main.ts", token, "src/index.ts");
    expect(applied).toEqual({ input: "@src/index.ts ", cursor: 14 });
  });

  it("光标右侧紧邻的中文正文不参与替换，不会被吞掉", function keepsAdjacentChineseText() {
    // 用户删除旧提及后中文正文与新 token 直连（无空白）的场景。
    const token = extractFileMentionToken("@back一些字", 5)!;
    expect(token.end).toBe(5);
    const applied = applyFileMentionSuggestion("@back一些字", token, "back.html");
    expect(applied.input).toBe("@back.html 一些字");
  });

  it("ASCII 残余仍被整体替换，但停在中文正文边界", function replacesAsciiResidueOnly() {
    const token = extractFileMentionToken("@back.html更多字", 5)!;
    expect(token.end).toBe(10);
    const applied = applyFileMentionSuggestion("@back.html更多字", token, "back.html");
    expect(applied.input).toBe("@back.html 更多字");
  });
});

describe("splitTuiFileMentionSegments", function segmentSuite() {
  it("把多个 @文件 切成强调段，普通文本保持原样", function splitsMultipleMentions() {
    expect(splitTuiFileMentionSegments("@Runbook-P3.md @back.html 剪短总结这两个文件")).toEqual([
      { text: "@Runbook-P3.md", isMention: true },
      { text: " ", isMention: false },
      { text: "@back.html", isMention: true },
      { text: " 剪短总结这两个文件", isMention: false },
    ]);
  });

  it("支持中文文件名，邮箱与孤立 @ 不染色", function handlesChineseAndNonMentions() {
    expect(splitTuiFileMentionSegments("看看 @文档/说明.md")).toEqual([
      { text: "看看 ", isMention: false },
      { text: "@文档/说明.md", isMention: true },
    ]);
    expect(splitTuiFileMentionSegments("联系 a@b.com 获取")).toEqual([
      { text: "联系 a@b.com 获取", isMention: false },
    ]);
    expect(splitTuiFileMentionSegments("看看 @ 的内容")).toEqual([
      { text: "看看 @ 的内容", isMention: false },
    ]);
  });

  it("无 mention 时返回单段普通文本", function returnsPlainSegment() {
    expect(splitTuiFileMentionSegments("普通提问")).toEqual([{ text: "普通提问", isMention: false }]);
  });
});
