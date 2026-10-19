/** 无知识存储的文档解析适配：复用 PDF、Excel 与 DOCX 解析，仅返回临时分析所需文本和页图。 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractTextDocument } from "./text-document";
import { extractPdfText, renderPdfPages } from "./pdf-processor";
import { parseExcel } from "./excel-parser";
import { RagError, toRagError } from "../rag-error";

/** 接受已校验的上传字节；临时文件只供既有路径型解析器使用，所有终态均清理。 */
export async function parseDocument(input: { bytes: Uint8Array; mimeType: string; signal?: AbortSignal }): Promise<{ text: string; pages?: readonly Uint8Array[] }> {
  let directory: string | undefined;
  /** 每个异步解析边界都复查取消，不能把取消结果当成成功上传。 */
  function checkCancelled(): void {
    if (input.signal?.aborted) throw new RagError("RAG_OPERATION_CANCELLED");
  }
  try {
    checkCancelled();
    if (!input.bytes.byteLength || input.bytes.byteLength > 20 * 1024 * 1024) throw new RagError("RAG_PARSE_FAILED");
    if (["text/plain", "text/markdown", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(input.mimeType)) {
      const text = await extractTextDocument(input.bytes, input.mimeType);
      checkCancelled();
      return { text };
    }
    const extension = input.mimeType === "application/pdf" ? ".pdf"
      : input.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ? ".xlsx"
        : input.mimeType === "application/vnd.ms-excel" ? ".xls" : undefined;
    if (!extension) throw new RagError("RAG_PARSE_FAILED");
    directory = await mkdtemp(path.join(os.tmpdir(), "autopilot-document-"));
    const file = path.join(directory, `document${extension}`);
    await writeFile(file, input.bytes, { flag: "wx", mode: 0o600 });
    checkCancelled();
    if (extension !== ".pdf") {
      const rows = await parseExcel(file);
      checkCancelled();
      return { text: JSON.stringify(rows) };
    }
    const document = await extractPdfText(file, input.signal);
    if (document.totalPages > 20) throw new RagError("RAG_PARSE_FAILED");
    const pages = await renderPdfPages(file, document.pages.map(function pageNumber(page) { return page.pageNumber; }), directory, input.signal);
    checkCancelled();
    return { text: document.pages.map(function pageText(page) { return `第 ${page.pageNumber} 页\n${page.text}`; }).join("\n\n"), pages: pages.map(function image(page) { return new Uint8Array(page.buffer); }) };
  } catch (error) { throw toRagError(error, "RAG_PARSE_FAILED"); }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}
