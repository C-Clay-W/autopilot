/** KnowledgeIngestCard 回归测试：锁定用户文案、知识库去向和内部细节隐藏。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import KnowledgeIngestCard from "@/app/chat/components/KnowledgeIngestCard";

describe("KnowledgeIngestCard", function knowledgeIngestCardSuite() {
  it("Work 历史知识卡只有已存结果，不提示继续查询或进入退休资源入口", function readOnlyHistory() {
    const markup = renderToStaticMarkup(<KnowledgeIngestCard readOnly workspaceName="旧工作区" items={[{ name: "历史.pdf", status: "completed" }]} />);
    expect(markup).toContain("历史知识记录（仅查看）");
    expect(markup).toContain("历史.pdf");
    expect(markup).not.toContain('href="/lancedb"');
    expect(markup).not.toContain("现在可以直接提问");
  });

  it("成功时说明资源保存在 Chat 知识库，不暴露工程字段或重复管理入口", function rendersFriendlySuccess() {
    const markup = renderToStaticMarkup(<KnowledgeIngestCard workspaceName="aa" items={[{ name: "员工信息.xlsx", status: "completed", contentCount: 2 }]} />);

    expect(markup).toContain("已加入知识库");
    expect(markup).toContain("员工信息.xlsx");
    expect(markup).toContain("已整理 2 个内容片段");
    expect(markup).toContain("已保存到 Chat 私有知识库，可从左侧资源目录管理");
    expect(markup).not.toContain("查看知识库");
    expect(markup).not.toContain('href="/lancedb"');
    expect(markup).not.toContain("resource_");
    expect(markup).not.toContain("向量");
  });

  it("失败时提供明确重试方向", function rendersFailureGuidance() {
    const markup = renderToStaticMarkup(<KnowledgeIngestCard workspaceName="aa" items={[{ name: "损坏文件.pdf", status: "failed", error: "文件内容无法解析" }]} />);

    expect(markup).toContain("未能加入知识库");
    expect(markup).toContain("文件内容无法解析");
    expect(markup).toContain("bg-error");
  });
});
