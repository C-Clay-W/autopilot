/** ToolDetail 定向测试：工具明细只渲染 Core 已投影的安全字段，正文、查询与匹配文本绝不进入 DOM。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolDisplayDetail } from "@autopilot-agent/core";
import ToolDetail from "@/app/chat/components/ToolDetail";

describe("ToolDetail", function toolDetailSuite() {
  it("read 明细显示相对路径、实际行范围与总行数，并标注截断", function rendersReadDetail() {
    const detail: ToolDisplayDetail = { kind: "read_file", path: "agent/API-Design.md", startLine: 205, endLine: 245, totalLines: 912, returnedLines: 41, truncated: true };
    const markup = renderToStaticMarkup(<ToolDetail detail={detail} />);

    expect(markup).toContain("agent/API-Design.md");
    expect(markup).toContain("已读取第");
    expect(markup).toContain("205–245");
    expect(markup).toContain("共");
    expect(markup).toContain("912");
    expect(markup).toContain("已截断");
  });

  it("read 空范围显示明确空状态，不生成非法行号范围", function rendersEmptyReadDetail() {
    const detail: ToolDisplayDetail = { kind: "read_file", path: "agent/Design.md", startLine: 6, endLine: null, totalLines: 5, returnedLines: 0, truncated: false };
    const markup = renderToStaticMarkup(<ToolDetail detail={detail} />);

    expect(markup).toContain("未读取到内容");
    expect(markup).toContain("共");
    expect(markup).toContain(">5<");
    expect(markup).not.toContain("已读取第");
    expect(markup).not.toContain("–");
  });

  it("glob 明细显示相对路径、精确二级折叠与独立截断提示", function rendersGlobDetail() {
    const detail: ToolDisplayDetail = {
      kind: "glob_files",
      paths: ["apps/a.tsx", "apps/b.tsx", "apps/c.tsx", "apps/d.tsx", "apps/e.tsx", "apps/f.tsx", "apps/g.tsx"],
      shownCount: 7,
      totalCount: 7,
      executionTruncated: false,
    };
    const markup = renderToStaticMarkup(<ToolDetail detail={detail} />);

    expect(markup).toContain("apps/a.tsx");
    expect(markup).toContain("apps/e.tsx");
    expect(markup).not.toContain("apps/f.tsx");
    expect(markup).toContain("其余 2 项");
    expect(markup).toContain('aria-label="展开其余 2 项"');
  });

  it("glob 未知总数只显示 Core 截断提示，不伪造精确剩余数量", function rendersUnknownTotalGlob() {
    const detail: ToolDisplayDetail = { kind: "glob_files", paths: ["packages/core/src/index.ts"], shownCount: 1, executionTruncated: true };
    const markup = renderToStaticMarkup(<ToolDetail detail={detail} />);

    expect(markup).toContain("packages/core/src/index.ts");
    expect(markup).toContain("结果已截断，请缩小搜索范围");
    expect(markup).not.toContain("其余");
  });

  it("Core display 截断独立提示，不与工具执行截断混淆", function rendersDisplayTruncationSeparately() {
    const detail: ToolDisplayDetail = {
      kind: "glob_files",
      paths: ["packages/core/src/internal/tools/tool-executor.ts"],
      shownCount: 1,
      executionTruncated: false,
      displayTruncated: true,
    };
    const markup = renderToStaticMarkup(<ToolDetail detail={detail} />);

    expect(markup).toContain("展示明细已截断，请缩小搜索范围");
    expect(markup).not.toContain("结果已截断，请缩小搜索范围");
  });

  it("glob 空结果显示稳定空态", function rendersEmptyGlobDetail() {
    const detail: ToolDisplayDetail = { kind: "glob_files", paths: [], shownCount: 0, totalCount: 0, executionTruncated: false };
    expect(renderToStaticMarkup(<ToolDetail detail={detail} />)).toContain("未发现文件");
  });

  it("grep content 按文件分组显示命中数与行号，不出现匹配文本", function rendersGrepContentDetail() {
    const detail: ToolDisplayDetail = {
      kind: "grep_content",
      files: [
        { path: "packages/core/src/internal/tools/types.ts", matchedLineCount: 3, lineNumbers: [41, 46, 52] },
        { path: "packages/presentation/src/model.ts", matchedLineCount: 2, lineNumbers: [19, 36] },
      ],
      shownMatchedLineCount: 5,
      totalMatchedLineCount: 5,
      executionTruncated: false,
    };
    const markup = renderToStaticMarkup(<ToolDetail detail={detail} />);

    expect(markup).toContain("packages/core/src/internal/tools/types.ts");
    expect(markup).toContain("3 处");
    expect(markup).toContain("行 ");
    expect(markup).toContain(">41<");
    expect(markup).toContain(">52<");
    expect(markup).toContain(">19<");
    expect(markup).toContain(">36<");
    expect(markup).not.toContain("RAW_GREP_TEXT_MUST_NOT_RENDER");
  });

  it("grep content 行号过多时先折叠，剩余数量只基于真实行号", function foldsGrepLineNumbers() {
    const lineNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const detail: ToolDisplayDetail = {
      kind: "grep_content",
      files: [{ path: "packages/core/src/index.ts", matchedLineCount: lineNumbers.length, lineNumbers }],
      shownMatchedLineCount: lineNumbers.length,
      totalMatchedLineCount: lineNumbers.length,
      executionTruncated: false,
    };
    const markup = renderToStaticMarkup(<ToolDetail detail={detail} />);

    expect(markup).toContain("11 处");
    expect(markup).not.toContain(">11<");
    expect(markup).toContain("其余 3 项");
  });

  it("grep paths 与 count 模式各自渲染，不显示对方才有的字段", function rendersOtherGrepModes() {
    const paths: ToolDisplayDetail = { kind: "grep_paths", paths: ["apps/a.ts", "apps/b.ts"], shownCount: 2, totalCount: 2, executionTruncated: false };
    const pathsMarkup = renderToStaticMarkup(<ToolDetail detail={paths} />);

    expect(pathsMarkup).toContain("apps/a.ts");
    expect(pathsMarkup).toContain("apps/b.ts");
    expect(pathsMarkup).not.toContain("行 ");

    const counts: ToolDisplayDetail = { kind: "grep_counts", files: [{ path: "src/registry.ts", count: 5 }], shownFileCount: 1, totalFileCount: 1, executionTruncated: false };
    const countsMarkup = renderToStaticMarkup(<ToolDetail detail={counts} />);

    expect(countsMarkup).toContain("src/registry.ts");
    expect(countsMarkup).toContain("5 次命中");
    expect(countsMarkup).not.toContain("行 ");
  });

  it("grep 空结果与未知总数截断显示稳定文案", function rendersGrepEmptyAndTruncated() {
    const empty: ToolDisplayDetail = { kind: "grep_content", files: [], shownMatchedLineCount: 0, totalMatchedLineCount: 0, executionTruncated: false };
    expect(renderToStaticMarkup(<ToolDetail detail={empty} />)).toContain("未找到匹配");

    const truncated: ToolDisplayDetail = { kind: "grep_paths", paths: ["a.ts"], shownCount: 1, executionTruncated: true };
    expect(renderToStaticMarkup(<ToolDetail detail={truncated} />)).toContain("结果已截断，请缩小搜索范围");
  });

  it("分页总数已知时说明当前页，不误报执行截断", function rendersKnownPagination() {
    const detail: ToolDisplayDetail = { kind: "grep_content", files: [{ path: "src/a.ts", matchedLineCount: 2, lineNumbers: [1, 4] }], shownMatchedLineCount: 2, totalMatchedLineCount: 6, executionTruncated: false };
    const markup = renderToStaticMarkup(<ToolDetail detail={detail} />);

    expect(markup).toContain("当前显示 2/6 行");
    expect(markup).toContain("其余结果请缩小搜索范围");
    expect(markup).not.toContain("结果已截断，请缩小搜索范围");
  });

  /** Search detail 不允许出现 query 或来源 URL。 */
  it("Web Search 只展示来源数量和截断事实", function rendersSafeWebSearchDetail() {
    const detail: ToolDisplayDetail = { kind: "web_search", sourceCount: 7, truncated: true };
    const markup = renderToStaticMarkup(<ToolDetail detail={detail} />);

    expect(markup).toContain("找到 7 个公开来源");
    expect(markup).toContain("结果已截断");
    expect(markup).not.toContain("PRIVATE_QUERY");
    expect(markup).not.toContain("https://");
  });

  /** Fetch detail 不允许出现 URL 路径、query 或网页正文。 */
  it("Web Fetch 只展示最终域名、内容类型和截断事实", function rendersSafeWebFetchDetail() {
    const detail: ToolDisplayDetail = { kind: "web_fetch", host: "docs.example.com", contentType: "text/html", truncated: true };
    const markup = renderToStaticMarkup(<ToolDetail detail={detail} />);

    expect(markup).toContain("docs.example.com");
    expect(markup).toContain("text/html");
    expect(markup).toContain("内容已截断");
    expect(markup).not.toContain("PRIVATE_PAGE_BODY");
    expect(markup).not.toContain("?token=");
  });

  it("缺失明细时保持通用回退，不渲染任何结果体", function rendersFallbackWithoutDetail() {
    expect(renderToStaticMarkup(<ToolDetail detail={undefined} />)).toBe("");
  });
});
