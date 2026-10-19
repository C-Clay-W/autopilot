/**
 * RAG 统一错误码契约测试。
 *
 * 验证 RagError 的稳定 code/cause、旧字符串码兼容收敛和未知错误降级。
 */
import { describe, expect, it } from "vitest";
import { createRAGAgent, RagError, readRagErrorCode, toRagError } from "../../index";

describe("RagError contract", function ragErrorContractSuite() {
  it("携带独立于 Agent Runtime 的稳定 code 与 cause", function carriesCodeAndCause() {
    const cause = new Error("底层错误");
    const error = new RagError("RAG_INGEST_FAILED", undefined, cause);
    expect(error.name).toBe("RagError");
    expect(error.code).toBe("RAG_INGEST_FAILED");
    expect(error.message).toBe("RAG 入库失败");
    expect(error.cause).toBe(cause);
  });

  it("把旧 RAG 字符串码收敛为新错误码", function mapsLegacyCode() {
    const error = toRagError(new Error("PDF_CORRUPTED"), "RAG_INGEST_FAILED");
    expect(error.code).toBe("RAG_PDF_CORRUPTED");
    expect(error.message).toBe("PDF 文件已损坏");
  });

  it("未知异常只暴露调用方指定的稳定降级码", function hidesUnknownError() {
    const error = toRagError(new Error("含路径和 Provider 正文"), "RAG_SEARCH_FAILED");
    expect(error.code).toBe("RAG_SEARCH_FAILED");
    expect(error.message).toBe("RAG 检索失败");
    expect(error.message).not.toContain("Provider");
  });

  it("跨模块实例只接受白名单 RAG code", function readsOnlyKnownCode() {
    expect(readRagErrorCode({ code: "RAG_RESOURCE_NOT_FOUND" })).toBe("RAG_RESOURCE_NOT_FOUND");
    expect(readRagErrorCode({ code: "ARBITRARY_ERROR" })).toBeUndefined();
  });

  it("createRAGAgent 公共边界返回 RagError 而不是字符串错误", async function normalizesPublicBoundary() {
    const rag = createRAGAgent({ storage: { rootPath: ".rag-error-contract" } });
    await expect(rag.getPdfPageImage("invalid-resource", 1)).rejects.toMatchObject({
      name: "RagError",
      code: "RAG_RESOURCE_NOT_FOUND",
    });
  });
});
