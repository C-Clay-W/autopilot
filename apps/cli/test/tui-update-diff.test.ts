/** TUI diff 回归测试：备用屏恢复历史版本的直角卡片与 unified diff 语义颜色。 */

import { describe, expect, it } from "vitest";
import { createTuiViewportDiffSource } from "../src/tui.js";

describe("TUI diff card history compatibility", function tuiDiffCardSuite() {
  it("保留历史版本的边框、标题和增删元信息文本", function preservesHistoricalDiffCard() {
    const source = createTuiViewportDiffSource("diff-1", "--- a/card.html\n+++ b/card.html\n@@ -1 +1 @@\n-old\n+new", 40);

    expect(source.text).toContain("┌");
    expect(source.text).toContain("│ diff");
    expect(source.text).toContain("--- a/card.html");
    expect(source.text).toContain("+++ b/card.html");
    expect(source.text).toContain("@@ -1 +1 @@");
    expect(source.text).toContain("-old");
    expect(source.text).toContain("+new");
    expect(source.text).toContain("┘");
    expect(source.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ style: "diff-meta" }),
      expect.objectContaining({ style: "diff-removed" }),
      expect.objectContaining({ style: "diff-added" }),
      expect.objectContaining({ style: "diff-border" }),
    ]));
  });

  it("不依赖 ANSI 颜色即可保留完整 diff 文本", function preservesDiffWithoutColor() {
    const source = createTuiViewportDiffSource("diff-no-color", "@@\n-old\n+new", 24);

    expect(source.text).toContain("@@");
    expect(source.text).toContain("-old");
    expect(source.text).toContain("+new");
    expect(source.text).not.toMatch(/\u001b\[/u);
  });
});
