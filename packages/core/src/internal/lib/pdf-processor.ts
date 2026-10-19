/**
 * PDF 批处理与 OCR 运行时。
 *
 * 通过可取消的 Python worker 让 PyMuPDF 每次任务只打开一次 PDF，并仅渲染需要的页；
 * Tesseract 是可选本地 OCR，缺失时返回稳定诊断而不伪装成功。
 */
import path from "node:path";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { RagError, toRagError, type RagErrorCode } from "../rag-error";

/** 单页 PDF 文本。 */
export interface PdfTextPage {
  pageNumber: number;
  text: string;
  textBlockCount: number;
  imageCount: number;
  drawingCount: number;
  imageCoverageRatio: number;
  width: number;
  height: number;
}

/** PDF 文本提取结果。 */
export interface PdfTextExtractResult { totalPages: number; encrypted: boolean; pages: PdfTextPage[]; }

/** 按需渲染出的临时页图。 */
export interface PdfImagePage { pageNumber: number; filePath: string; buffer: Buffer; width: number; height: number; }

/** PDF/OCR 依赖预检的安全结果。 */
export interface PdfRuntimeDiagnostics {
  pyMuPdf: { available: boolean; code?: RagErrorCode };
  tesseract: { available: boolean; code?: RagErrorCode };
  cloudOcrConfigured: boolean;
}

/** 将 AbortSignal 的取消统一映射为稳定错误。 */
export class PdfProcessingCancelledError extends RagError {
  constructor() { super("RAG_OPERATION_CANCELLED"); this.name = "PdfProcessingCancelledError"; }
}

/** 返回打包后的 PyMuPDF worker 路径。 */
function getPdfWorkerPath(): string {
  const packaged = path.resolve(__dirname, "../../scripts/pdf_extract.py");
  return existsSync(packaged) ? packaged : path.resolve(__dirname, "../../../scripts/pdf_extract.py");
}

/** 执行可取消子进程，并限制输出避免错误正文或大内容进入日志。 */
function runFile(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(new PdfProcessingCancelledError());
  return new Promise<string>(function waitForProcess(resolve, reject) {
    execFile(command, args, { signal, windowsHide: true, maxBuffer: 256 * 1024 }, function onExit(error, stdout) {
      if (signal?.aborted || (error as NodeJS.ErrnoException | null)?.name === "AbortError") {
        reject(new PdfProcessingCancelledError());
        return;
      }
      if (error) {
        reject(new Error(String((error as NodeJS.ErrnoException).code || "PROCESS_FAILED")));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/** 在 Node PDF 降级路径的异步边界统一检查取消。 */
function assertPdfNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PdfProcessingCancelledError();
}

/** 使用项目内置 pdf-parse 一次打开 PDF 并提取逐页文本。 */
async function extractPdfTextWithPdfParse(pdfPath: string, signal?: AbortSignal): Promise<PdfTextExtractResult> {
  assertPdfNotCancelled(signal);
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: await readFile(path.resolve(pdfPath)) });
  const cancelParser = function cancelParser(): void { void parser.destroy().catch(function ignoreDestroyError() {}); };
  signal?.addEventListener("abort", cancelParser, { once: true });
  try {
    const result = await parser.getText();
    assertPdfNotCancelled(signal);
    const totalPages = Number(result.total || result.pages.length || 0);
    if (!Number.isInteger(totalPages) || totalPages < 1) throw new RagError("RAG_PDF_ZERO_PAGES");
    const textByPage = new Map(result.pages.map(function byPage(page) { return [page.num, page.text || ""] as const; }));
    const pages = Array.from({ length: totalPages }, function page(_, index): PdfTextPage {
      const text = textByPage.get(index + 1) || "";
      return {
        pageNumber: index + 1,
        text,
        textBlockCount: text.split(/\n{2,}/u).filter(function block(value) { return Boolean(value.trim()); }).length,
        imageCount: 0,
        drawingCount: 0,
        imageCoverageRatio: 0,
        width: 0,
        height: 0,
      };
    });
    return { totalPages, encrypted: false, pages };
  } catch (error) {
    if (signal?.aborted) throw new PdfProcessingCancelledError();
    throw toRagError(error, "RAG_PARSE_FAILED");
  } finally {
    signal?.removeEventListener("abort", cancelParser);
    await parser.destroy().catch(function ignoreDestroyError() {});
  }
}

/** 使用项目内置 pdf-parse 批量渲染指定页，并保持与 Python worker 相同的临时文件契约。 */
async function renderPdfPagesWithPdfParse(
  pdfPath: string,
  pageNumbers: number[],
  outputDir: string,
  signal?: AbortSignal,
): Promise<PdfImagePage[]> {
  assertPdfNotCancelled(signal);
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: await readFile(path.resolve(pdfPath)) });
  const cancelParser = function cancelParser(): void { void parser.destroy().catch(function ignoreDestroyError() {}); };
  signal?.addEventListener("abort", cancelParser, { once: true });
  try {
    const result = await parser.getScreenshot({ scale: 1.5, partial: pageNumbers, imageDataUrl: false });
    assertPdfNotCancelled(signal);
    const rendered: PdfImagePage[] = [];
    for (const page of result.pages) {
      assertPdfNotCancelled(signal);
      const filePath = path.join(outputDir, `page-${page.pageNumber}.png`);
      const buffer = Buffer.from(page.data);
      await writeFile(filePath, buffer);
      rendered.push({ pageNumber: page.pageNumber, filePath, buffer, width: page.width, height: page.height });
    }
    return rendered;
  } catch (error) {
    if (signal?.aborted) throw new PdfProcessingCancelledError();
    throw toRagError(error, "RAG_PARSE_FAILED");
  } finally {
    signal?.removeEventListener("abort", cancelParser);
    await parser.destroy().catch(function ignoreDestroyError() {});
  }
}

/** 检查 PyMuPDF、Tesseract 与云 OCR 配置是否可用，不读取任何 PDF。 */
export async function preflightPdfRuntime(signal?: AbortSignal): Promise<PdfRuntimeDiagnostics> {
  const python = process.env.PYMUPDF_PYTHON?.trim() || "python";
  const tesseract = process.env.TESSERACT_PATH?.trim() || "tesseract";
  const [pyMuPdf, tesseractResult] = await Promise.all([
    runFile(python, [getPdfWorkerPath(), "check"], signal)
      .then(function ok() { return { available: true } as const; })
      .catch(function unavailable() { return { available: false, code: "RAG_PDF_RUNTIME_UNAVAILABLE" } as const; }),
    runFile(tesseract, ["--version"], signal)
      .then(function ok() { return { available: true } as const; })
      .catch(function unavailable() { return { available: false, code: "RAG_OCR_UNAVAILABLE" } as const; }),
  ]);
  if (signal?.aborted) throw new PdfProcessingCancelledError();
  return { pyMuPdf, tesseract: tesseractResult, cloudOcrConfigured: Boolean(process.env.RAG_CLOUD_OCR_URL && process.env.RAG_CLOUD_OCR_API_KEY) };
}

/** 使用一个 PyMuPDF worker 一次性提取整份 PDF 的页级文本。 */
export async function extractPdfText(pdfPath: string, signal?: AbortSignal): Promise<PdfTextExtractResult> {
  const python = process.env.PYMUPDF_PYTHON?.trim() || "python";
  try {
    const output = await runFile(python, [getPdfWorkerPath(), "extract", "--pdf", path.resolve(pdfPath)], signal);
    const parsed = JSON.parse(output) as PdfTextExtractResult & { error?: string };
    if (parsed.error) throw toRagError(new Error(parsed.error), "RAG_PARSE_FAILED");
    if (!Number.isInteger(parsed.totalPages) || parsed.totalPages < 1) throw new RagError("RAG_PDF_ZERO_PAGES");
    return parsed;
  } catch (error) {
    if (signal?.aborted || error instanceof PdfProcessingCancelledError) throw error;
    return extractPdfTextWithPdfParse(pdfPath, signal);
  }
}

/** 一次打开 PDF 并批量渲染指定页；结果只写入调用方提供的临时目录。 */
export async function renderPdfPages(pdfPath: string, pageNumbers: number[], outputDir: string, signal?: AbortSignal): Promise<PdfImagePage[]> {
  const pages = [...new Set(pageNumbers)].filter(function valid(page) { return Number.isInteger(page) && page > 0; }).sort(function ascending(a, b) { return a - b; });
  if (!pages.length) return [];
  await mkdir(outputDir, { recursive: true });
  const python = process.env.PYMUPDF_PYTHON?.trim() || "python";
  try {
    const output = await runFile(python, [getPdfWorkerPath(), "render", "--pdf", path.resolve(pdfPath), "--output", path.resolve(outputDir), "--pages", pages.join(",")], signal);
    const parsed = JSON.parse(output) as { pages: Array<{ pageNumber: number; fileName: string; width: number; height: number }>; error?: string };
    if (parsed.error) throw toRagError(new Error(parsed.error), "RAG_PARSE_FAILED");
    return Promise.all(parsed.pages.map(async function readPage(page): Promise<PdfImagePage> {
      const filePath = path.join(outputDir, path.basename(page.fileName));
      return { ...page, filePath, buffer: await readFile(filePath) };
    }));
  } catch (error) {
    if (signal?.aborted || error instanceof PdfProcessingCancelledError) throw error;
    return renderPdfPagesWithPdfParse(pdfPath, pages, outputDir, signal);
  }
}

/** 渲染包含首尾页的闭区间，供安全页预览复用。 */
export async function renderPdfPageRange(pdfPath: string, firstPage: number, lastPage: number, outputDir: string, signal?: AbortSignal): Promise<PdfImagePage[]> {
  if (!Number.isInteger(firstPage) || !Number.isInteger(lastPage) || firstPage < 1 || lastPage < firstPage || lastPage - firstPage > 99) throw new RagError("RAG_PDF_PAGE_RANGE_INVALID");
  return renderPdfPages(pdfPath, Array.from({ length: lastPage - firstPage + 1 }, function page(_, index) { return firstPage + index; }), outputDir, signal);
}

/** 使用本地 Tesseract OCR 一张临时页图；调用结束后不保留额外文件。 */
export async function ocrPdfPage(imagePath: string, signal?: AbortSignal): Promise<string> {
  const tesseract = process.env.TESSERACT_PATH?.trim() || "tesseract";
  const language = process.env.RAG_TESSERACT_LANG?.trim() || "chi_sim+eng";
  return runFile(tesseract, [path.resolve(imagePath), "stdout", "-l", language, "--psm", "6"], signal);
}

/** 调用应用层显式配置的云 OCR；错误只返回稳定码，不透传 Provider 正文。 */
export async function ocrPdfPageWithCloud(imageBuffer: Buffer, signal?: AbortSignal): Promise<string> {
  const endpoint = process.env.RAG_CLOUD_OCR_URL?.trim();
  const apiKey = process.env.RAG_CLOUD_OCR_API_KEY?.trim();
  if (!endpoint || !apiKey) throw new RagError("RAG_OCR_UNAVAILABLE");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ image: `data:image/png;base64,${imageBuffer.toString("base64")}` }),
    signal,
  });
  if (!response.ok) throw new RagError("RAG_OCR_FAILED");
  const body = await response.json() as { text?: unknown; result?: { text?: unknown } };
  const text = typeof body.text === "string" ? body.text : typeof body.result?.text === "string" ? body.result.text : "";
  if (!text.trim()) throw new RagError("RAG_OCR_EMPTY");
  return text;
}

/** 删除本次任务的临时渲染目录。 */
export async function cleanupPdfRenderDirectory(outputDir: string): Promise<void> { await rm(outputDir, { recursive: true, force: true }); }

/** 解码受控图片并转成有界 PNG，复用已有 Canvas 依赖供 OCR、视觉和预览消费。 */
export async function normalizeKnowledgeImage(bytes: Buffer, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) throw new PdfProcessingCancelledError();
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new RagError("RAG_INVALID_INPUT");
  const { loadImage, createCanvas } = await import("@napi-rs/canvas");
  const image = await loadImage(bytes);
  if (!image.width || !image.height || image.width * image.height > 40_000_000) throw new RagError("RAG_INVALID_INPUT");
  const scale = Math.min(1, 2048 / Math.max(image.width, image.height));
  const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  const result = canvas.toBuffer("image/png");
  if (result.length > 5 * 1024 * 1024) throw new RagError("RAG_INVALID_INPUT");
  if (signal?.aborted) throw new PdfProcessingCancelledError();
  return result;
}
