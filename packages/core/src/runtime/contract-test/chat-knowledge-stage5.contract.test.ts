/** Stage5 新增质量门与图片解码边界；不重跑既有 Chat/Work Runtime 矩阵。 */
import { describe, expect, it } from "vitest";
import { hasSufficientPrivateEvidence } from "../../internal/agent-flow";
import { normalizeKnowledgeImage } from "../../internal/lib/pdf-processor";

/** 构造只含当前测试需要字段的 canonical 候选。 */
function candidate(text: string, metadata: Record<string, unknown> = {}) { return { id: "fixture", text, score: 1, metadata }; }

describe("Chat knowledge Stage5 boundaries", function suite() {
  it("正文匹配才允许基础候选，低精排分数、空正文和伪文字不能变成充分证据", function checksQuality() {
    expect(hasSufficientPrivateEvidence("orchid", candidate("orchid release is Friday"))).toBe(true);
    expect(hasSufficientPrivateEvidence("orchid", candidate("unrelated weather report"))).toBe(false);
    expect(hasSufficientPrivateEvidence("orchid", candidate("orchid release", { rerankRelevance: 0.1, rerankRelevant: false }))).toBe(false);
    expect(hasSufficientPrivateEvidence("orchid", candidate("unrelated weather report", { rerankRelevance: 90 }))).toBe(false);
    expect(hasSufficientPrivateEvidence("orchid", candidate("文件：orchid", { source: "pdf", pageText: "" }))).toBe(false);
    expect(hasSufficientPrivateEvidence("orchid", candidate("���"))).toBe(false);
    expect(hasSufficientPrivateEvidence("orchid", candidate("", { source: "image", fileName: "orchid.png", hasImage: true }))).toBe(true);
  });
  it("图片解码不接受损坏字节，预先取消不触发解码", async function imageBoundaries() {
    await expect(normalizeKnowledgeImage(Buffer.from("not an image"))).rejects.toThrow();
    await expect(normalizeKnowledgeImage(Buffer.from("x"), AbortSignal.abort())).rejects.toMatchObject({ code: "RAG_OPERATION_CANCELLED" });
  });
});
