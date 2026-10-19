/** knowledge-service.test.ts — Workspace 上传校验与写队列终态回归。 */
import { describe, expect, it } from "vitest";
import { KnowledgeUploadError, toKnowledgeErrorResponse, toSafeKnowledgeError } from "@/lib/knowledge-error";
import { validateKnowledgeUpload, withKnowledgeWriteLock } from "@/lib/knowledge-service";

describe("Web knowledge service", function knowledgeServiceSuite() {
  it("拒绝扩展名与 magic 不匹配的 PDF", async function rejectsFakePdf() {
    const file = new File(["not-pdf"], "manual.pdf", { type: "application/pdf" });
    await expect(validateKnowledgeUpload(file)).rejects.toThrow("UPLOAD_MIME_INVALID");
  });

  it("接受具有 PDF magic 的受控文件名", async function acceptsPdfMagic() {
    const file = new File(["%PDF-1.7\nfixture"], "manual.pdf", { type: "application/pdf" });
    const upload = await validateKnowledgeUpload(file);
    expect(upload.type).toBe("pdf");
    expect(upload.safeName).toBe("manual.pdf");
  });

  it("按结构化 code 映射上传与 Core RAG 错误", async function mapsStructuredErrors() {
    expect(toSafeKnowledgeError(new KnowledgeUploadError("UPLOAD_MIME_INVALID"))).toEqual({ code: "UPLOAD_MIME_INVALID", message: "文件内容与类型不匹配" });
    expect(toSafeKnowledgeError({ code: "RAG_PDF_CORRUPTED" })).toEqual({ code: "RAG_PDF_CORRUPTED", message: "PDF 文件已损坏" });
    expect(toSafeKnowledgeError({ code: "RAG_VECTOR_SPACE_MISMATCH" })).toEqual({ code: "RAG_VECTOR_SPACE_MISMATCH", message: "知识索引与当前向量配置不匹配" });
    expect(toSafeKnowledgeError(new Error("RAG_PDF_CORRUPTED"))).toEqual({ code: "KNOWLEDGE_OPERATION_FAILED", message: "知识资源操作失败" });
    expect(toKnowledgeErrorResponse({ code: "RAG_RESOURCE_NOT_FOUND" })?.status).toBe(404);
    expect(toKnowledgeErrorResponse(new KnowledgeUploadError("UPLOAD_SIZE_INVALID"))?.status).toBe(413);
    const sessionError = toKnowledgeErrorResponse(new KnowledgeUploadError("UPLOAD_SESSION_INVALID"));
    expect(sessionError?.status).toBe(400);
    expect(await sessionError?.json()).toEqual({ code: "UPLOAD_SESSION_INVALID", error: "入库会话记录标识无效" });
  });

  it("同 Workspace 写任务串行且不同 Workspace 可独立执行", async function serializesPerWorkspace() {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>(function createGate(resolve) { releaseFirst = resolve; });
    const first = withKnowledgeWriteLock("a", async function firstTask() { events.push("a1-start"); await gate; events.push("a1-end"); });
    const second = withKnowledgeWriteLock("a", async function secondTask() { events.push("a2"); });
    const other = withKnowledgeWriteLock("b", async function otherTask() { events.push("b1"); });
    await other;
    expect(events).toEqual(["a1-start", "b1"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["a1-start", "b1", "a1-end", "a2"]);
  });
});
