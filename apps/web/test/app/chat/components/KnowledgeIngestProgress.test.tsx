/** KnowledgeIngestProgress 回归测试：直接展示 Core 页级事件与真实 current/total。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import KnowledgeIngestProgress, { getKnowledgeIngestProcessStep } from "@/app/chat/components/KnowledgeIngestProgress";

describe("KnowledgeIngestProgress", function knowledgeIngestProgressSuite() {
  it("区分文本提取、页面渲染和向量生成事件", function mapsCoreIngestSteps() {
    expect(getKnowledgeIngestProcessStep({ step: "text_parse_page", message: "已提取第 7/7 页文本", current: 7, total: 7 }))
      .toEqual({ stage: "text-parse", message: "已提取第 7/7 页文本", current: 7, total: 7 });
    expect(getKnowledgeIngestProcessStep({ step: "image_render_page", message: "已渲染第 3/7 页图片", current: 3, total: 7 }))
      .toEqual({ stage: "image-render", message: "已渲染第 3/7 页图片", current: 3, total: 7 });
    expect(getKnowledgeIngestProcessStep({ step: "page_embed_item", message: "第 3/7 页向量生成完成", current: 3, total: 7 }))
      .toEqual({ stage: "embed", message: "第 3/7 页向量生成完成", current: 3, total: 7 });
  });

  it("只渲染当前阶段、页数、百分比和反复轻扫，不罗列历史步骤", function rendersLiveProgress() {
    const markup = renderToStaticMarkup(<KnowledgeIngestProgress steps={[
      { stage: "upload", message: "正在上传文件：测试.pdf" },
      { stage: "text-parse", message: "已提取第 7/7 页文本", current: 7, total: 7 },
      { stage: "image-render", message: "已渲染第 3/7 页图片", current: 3, total: 7 },
    ]} />);

    expect(markup).toContain("正在加入知识库");
    expect(markup).toContain("已渲染第 3/7 页图片");
    expect(markup).toContain("3/7 · 43%");
    expect(markup).toContain("43%");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="43"');
    expect(markup).toContain("knowledge-ingest-sweep");
    expect(markup).not.toContain("正在上传文件：测试.pdf");
    expect(markup).not.toContain("已提取第 7/7 页文本");
    expect(markup).not.toContain("正在等待下一步事件");
  });

  it("写入阶段隐藏 Core 内部表名", function hidesInternalTableName() {
    expect(getKnowledgeIngestProcessStep({ step: "write_pages", message: "写入 7 条向量到 pdf_internal" }))
      .toEqual({ stage: "write", message: "正在写入知识库" });
  });
});
