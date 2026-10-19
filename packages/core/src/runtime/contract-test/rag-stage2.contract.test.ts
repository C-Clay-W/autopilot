/** RAG Stage 2 契约测试：PDF 路由、资源终态、批处理边界与取消前置门。 */
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { classifyPdfPage, selectPdfIngestPages } from "../../internal/agent-flow";
import { extractPdfText, PdfProcessingCancelledError, renderPdfPageRange, renderPdfPages } from "../../internal/lib/pdf-processor";

/** 创建不依赖额外测试库的单页 PDF fixture。 */
function createSinglePagePdf(text: string): Buffer {
  const escapedText = text.replace(/([\\()])/g, "\\$1");
  const content = `BT /F1 18 Tf 72 720 Td (${escapedText}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream\nendobj\n`,
  ];
  const header = "%PDF-1.4\n";
  const offsets: number[] = [];
  let body = "";
  for (const object of objects) {
    offsets.push(Buffer.byteLength(header + body, "ascii"));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(header + body, "ascii");
  const xrefEntries = offsets.map(function entry(offset) { return `${String(offset).padStart(10, "0")} 00000 n \n`; }).join("");
  return Buffer.from(`${header}${body}xref\n0 6\n0000000000 65535 f \n${xrefEntries}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "ascii");
}

describe("RAG Stage 2 contract", function ragStage2ContractSuite() {
  it("页级质量门稳定区分文本、融合和 OCR", function classifiesPdfPages() {
    expect(classifyPdfPage({ text: "Short English heading", textBlockCount: 1, imageCount: 0, drawingCount: 0, imageCoverageRatio: 0, width: 595, height: 842 })).toBe("text");
    expect(classifyPdfPage({ text: "图表说明", textBlockCount: 1, imageCount: 1, drawingCount: 2, imageCoverageRatio: 0.5, width: 595, height: 842 })).toBe("fused");
    expect(classifyPdfPage({ text: "���", textBlockCount: 1, imageCount: 1, imageCoverageRatio: 0.8 })).toBe("ocr");
    expect(classifyPdfPage({ text: "  \n ", textBlockCount: 0, imageCount: 0 })).toBe("ocr");
  });

  it("partial 重试只恢复失败页而不重复处理成功页", function resumesFailedPagesOnly() {
    const pages = [{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }];
    expect(selectPdfIngestPages(pages, [2])).toEqual([{ pageNumber: 2 }]);
    expect(selectPdfIngestPages(pages)).toEqual(pages);
  });

  it("批渲染 worker 只打开一次文档且不为每页重新解析", function usesSingleDocumentOpen() {
    const script = readFileSync(path.resolve(__dirname, "../../../scripts/pdf_extract.py"), "utf8");
    expect(script.match(/fitz\.open\(args\.pdf\)/g)).toHaveLength(2);
    expect(script).not.toMatch(/for page_number[\s\S]+fitz\.open/);
    expect(script).toContain("requested = sorted");
  });

  it("非法页区间在启动 worker 前失败", async function rejectsInvalidRange() {
    await expect(renderPdfPageRange("fixture.pdf", 0, 1, "tmp")).rejects.toMatchObject({ code: "RAG_PDF_PAGE_RANGE_INVALID" });
    await expect(renderPdfPageRange("fixture.pdf", 1, 101, "tmp")).rejects.toMatchObject({ code: "RAG_PDF_PAGE_RANGE_INVALID" });
  });

  it("已取消任务不启动 PDF worker", async function rejectsPreAbortedWork() {
    const controller = new AbortController();
    controller.abort();
    await expect(renderPdfPageRange("fixture.pdf", 1, 1, "tmp", controller.signal)).rejects.toBeInstanceOf(PdfProcessingCancelledError);
  });

  it("PyMuPDF 不可用时使用 pdf-parse 提取并渲染页面", async function fallsBackToPdfParse() {
    const previousPython = process.env.PYMUPDF_PYTHON;
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rag-pdf-fallback-"));
    const pdfPath = path.join(tempRoot, "fixture.pdf");
    const renderRoot = path.join(tempRoot, "rendered");
    process.env.PYMUPDF_PYTHON = path.join(tempRoot, "missing-python.exe");
    try {
      await writeFile(pdfPath, createSinglePagePdf("Fallback PDF text"));
      const parsed = await extractPdfText(pdfPath);
      const rendered = await renderPdfPages(pdfPath, [1], renderRoot);
      expect(parsed.totalPages).toBe(1);
      expect(parsed.pages[0]?.text).toContain("Fallback PDF text");
      expect(rendered).toHaveLength(1);
      expect(rendered[0]?.buffer.length).toBeGreaterThan(0);
    } finally {
      if (previousPython === undefined) delete process.env.PYMUPDF_PYTHON;
      else process.env.PYMUPDF_PYTHON = previousPython;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
