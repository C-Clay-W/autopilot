/** 回答链接回归：公开链接可交互，脚本/凭据地址与代码内容不会变成跳转目标。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MarkdownRenderer from "@/app/components/MarkdownRenderer";

describe("MarkdownRenderer links", function markdownLinkSuite() {
  /** 标准 Markdown 标题、嵌套列表、多表格和转义管道均保留正确语义。 */
  it("支持六级标题、列表和连续表格，代码中的井号保持字面值", function standardMarkdown() {
    const content = "# 一级\n\n## 二级\n\n### 三级\n\n#### 四级\n\n##### 五级\n\n###### 六级\n\n- 一项\n  - 子项\n\n1. 顺序\n\n| 姓名 | 部门 |\n| --- | --- |\n| 张三 | 技术部 |\n\n| 列 |\n| --- |\n| a\\|b |\n\n```md\n# 代码标题\n```";
    const html = renderToStaticMarkup(<MarkdownRenderer content={content} />);
    for (let level = 1; level <= 6; level++) expect(html).toContain(`<h${level} `);
    expect(html.match(/<table /g)).toHaveLength(2);
    expect(html).toContain("a|b"); expect(html).toContain("list-disc"); expect(html).toContain("list-decimal");
    expect(html).toContain("# 代码标题"); expect(html).toContain('aria-label="复制代码"');
    expect(html).toContain("text-2xl font-bold");
  });

  /** 老回答不用回写 History；只把完整 canonical 表格块转成结构化展示。 */
  it("RAG 表格摘录呈现原值和来源，残缺行及代码不猜测补全", function ragTables() {
    const content = "表头: 姓名 | 部门\n记录 #1: 姓名: 张三; 部门: 技术部\n记录 #2: 姓名: 李四; 部门: **市场部** [1]\n\n来源：\n\n[1] 员工.xlsx";
    const html = renderToStaticMarkup(<MarkdownRenderer content={content} ragEvidence />);
    expect(html.match(/<table /g)).toHaveLength(1); expect(html).toContain("张三"); expect(html).toContain("**市场部**"); expect(html).not.toContain("<strong>"); expect(html).toContain("[1] 员工.xlsx");
    expect(renderToStaticMarkup(<MarkdownRenderer content={content} />)).not.toContain("<table");
    expect(renderToStaticMarkup(<MarkdownRenderer content={"表头: 姓名 | 部门\n记录 #1: 姓名: 张三; 部门: 技术部\n记录 #2: 姓名: 李四"} ragEvidence />)).not.toContain("<table");
    expect(renderToStaticMarkup(<MarkdownRenderer content={"```txt\n" + content + "\n```"} ragEvidence />)).not.toContain("<table");
  });

  /** 同源连续片段只显示一次来源，不误合并不同文件的摘录。 */
  it("合并相同来源的连续表格，单一来源仅在文末显示一次编号", function mergeTableSources() {
    const chunk = "表头: 姓名 | 部门\n记录 #1: 姓名: 张三; 部门: 技术部 [1]";
    const second = "表头: 姓名 | 部门\n记录 #2: 姓名: 李四; 部门: 市场部 [1]";
    const html = renderToStaticMarkup(<MarkdownRenderer content={chunk + "\n\n" + second + "\n\n来源：\n\n[1] 员工.xlsx"} ragEvidence />);
    expect(html.match(/<table /g)).toHaveLength(1); expect(html.match(/\[1\]/g)).toHaveLength(1); expect(html).toContain("张三"); expect(html).toContain("李四");
    const mixed = renderToStaticMarkup(<MarkdownRenderer content={chunk + "\n\n" + second.replace("[1]", "[2]") + "\n\n来源：\n\n[1] 员工.xlsx\n\n[2] 另一份.xlsx"} ragEvidence />);
    expect(mixed.match(/<table /g)).toHaveLength(2); expect(mixed).toContain("资料摘录（来源 [1]）"); expect(mixed).toContain("资料摘录（来源 [2]）");
  });

  /** 图片加载只限 RAG 答复和严格站内路由，不因 GFM 支持图片而加载任意网络内容。 */
  it("仅 RAG 展示受控图片及 PDF 引用页，拒绝远程和伪造路径", function controlledImages() {
    const preview = "/api/chat/knowledge/resource_0123456789abcdef0123456789abcdef/preview";
    const content = `![测试图片](${preview})\n\n![扫描件第2页](${preview}/pages/2)\n\n![外部](https://example.com/tracker.png)\n\n![路径](${preview}/../../secret)\n\n![坏页](${preview}/pages/0)`;
    const html = renderToStaticMarkup(<MarkdownRenderer content={content} ragEvidence />);
    expect(html.match(/<img /g)).toHaveLength(2); expect(html).toContain('alt="扫描件第2页"'); expect(html).toContain(preview + "/pages/2"); expect(html).not.toContain("tracker.png"); expect(html).not.toContain("../../secret");
    expect(renderToStaticMarkup(<MarkdownRenderer content={content} />)).not.toContain("<img");
  });
  /** Markdown 与裸链接都经过同一确认入口，并提供 hover/focus 反馈。 */
  it("渲染可确认的 Markdown、粗体链接和带括号的裸 URL", function rendersPublicLinks() {
    const html = renderToStaticMarkup(<MarkdownRenderer content={'**[官方文档](https://example.com/docs?a=1&b=2)**\nhttps://example.com/a_(b)。\nhttps://nodejs.org/en/about/previous-releases（版本时间线）'} />);
    expect(html.match(/<a /g)).toHaveLength(3);
    expect(html).toContain('href="https://example.com/docs?a=1&amp;b=2"');
    expect(html).toContain('href="https://example.com/a_(b)"');
    expect(html).toContain('href="https://nodejs.org/en/about/previous-releases"');
    expect(html).not.toContain("%EF%BC%88");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("hover:bg-accent/15");
    expect(html).toContain("focus-visible:outline-accent");
  });

  /** 模型文本不会突破 HTML 转义或把脚本、带凭据地址、代码示例变成可点击链接。 */
  it("拒绝危险地址并保留代码字面值", function keepsUntrustedTextInert() {
    const html = renderToStaticMarkup(<MarkdownRenderer content={'[脚本](javascript:alert(1)) [文件](file:///tmp/test) https://user:pass@example.com/\n`https://example.com/code`\n```txt\nhttps://example.com/fenced\n```\n<img src=x onerror=alert(1)>'} />);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
