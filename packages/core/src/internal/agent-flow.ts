/**
 * AgentFlow - RAG 核心 Agent 工作流
 *
 * 提供统一的入库入口，按 options.type 分发到不同解析/向量化/写入逻辑。
 * 同时暴露 Excel 辅助方法（parseExcelFile / listExcelSheets / getExcelSheetInfo）。
 */
import path from "node:path";
import { extractTextDocument } from "./lib/text-document";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import type { VectorOutput } from "./types";
import { createKnowledgeResourceId, createKnowledgeResourceStore, deriveKnowledgeTableName, isKnowledgeResourceId, type KnowledgeResourceManifest, type KnowledgeResourceStatus, type PdfPageMetadata, type RagEvidence, type TableProfile } from "./knowledge-resource-store";
import { resolveRagStorage, type RagStorageOptions, type ResolvedRagStorage } from "./rag-storage";
import { RagError, toRagError } from "./rag-error";
import { hybridSearch } from "./lib/hybrid-search";
import { createLexicalIndex, LexicalIndexUnavailableError, LEXICAL_INDEX_VERSION, tokenizeLexicalText } from "./lib/lexical-index";
import { assertEmbeddingProfileCompatible, createQueryVectorCache, resolveRetrievalEmbeddingProfile, selectSearchTables } from "./lib/retrieval-planner";
import { generateHydeQuery } from "./lib/hyde";
import { classifyQuery } from "./lib/query-classify";
import { rerankCandidates, type RerankPolicy, type RerankRuntime, type RerankVisionImage } from "./lib/rerank";
import type { EmbeddingRuntime } from "./lib/embeddings";

// ── 类型定义 ────────────────────────────────────

/** Excel 解析选项 */
export interface ParseExcelOptions {
  sheetName?: string;
  headerRow?: number;
  dataStartRow?: number;
  skipEmptyRows?: boolean;
}

/** Excel 工作表信息 */
export interface SheetInfo {
  sheetName: string;
  rowCount: number;
  colCount: number;
  headers: string[];
}

// 暴露外部的进度展示 -- added by clayw on 20260708
/** 入库进度事件 */
export interface IngestProgressEvent {
  /** 步骤标识 */
  step: "parse" | "parse_start" | "parse_page" | "text_parse_page" | "image_render_page" | "page_merge" | "page_embed_item" | "write_pages" | "chunk_row" | "chunk_complete" | "chunk_item" | "embed" | "write" | "done" | "error";
  /** 可读描述 */
  message: string;
  /** 当前进度位置（1-based） */
  current?: number;
  /** 总量 */
  total?: number;
  /** 当前行号（0-based） */
  rowIndex?: number;
  /** 当前块索引（0-based） */
  chunkIndex?: number;
  /** 当前行拆出的总块数 */
  totalChunks?: number;
  /** 块文本内容 */
  chunkText?: string;
}

/** 统一入库选项 — 按 type 分发到对应的入库逻辑 */
export interface IngestOptions {
  /** 文档类型 — 必填 */
  type: "excel" | "text" | "pdf" | "image" | "video";
  /** 表名（默认 employee_test） */
  tableName?: string;
  /** 是否先清空旧表 */
  clearFirst?: boolean;
  /** Excel 专属：表头行（0-based，默认 1） */
  headerRow?: number;
  /** Excel 专属：工作表名（默认第一个） */
  sheetName?: string;
  /** 分块大小（字符数，默认 512，由 chunk.ts 定义） */
  chunkSize?: number;
  /** 分块重叠（字符数，默认 128，由 chunk.ts 定义） */
  chunkOverlap?: number;
  /** 文档标题兜底值 */
  title?: string;
  /** 进度回调（在前端流式展示分块过程） */
  onProgress?: (event: IngestProgressEvent) => void;
  /** 上传请求或任务取消信号；取消后不得继续 OCR、Embedding 或写入。 */
  signal?: AbortSignal;
  /** 原始安全展示名；避免临时上传文件名进入资源身份。 */
  displayName?: string;
  /** @internal Core 在重试链内部传递的资源 ID；公开 ingest 会忽略调用方值。 */
  resourceId?: string;
}

/** 统一入库结果 */
export interface IngestResult {
  type: string;
  tableName: string;
  totalRows: number;
  /** 分块后的向量记录总数（≥ totalRows），用于验证分块是否生效 */
  totalChunks: number;
  columns: string[];
  previewRows: Record<string, unknown>[];
  resourceId?: string;
  status?: KnowledgeResourceStatus;
  failedPages?: number[];
}

/** 多表检索编排结果：候选按表内名次均衡合并，绝不比较跨向量空间原始分数。 */
export interface SearchAcrossTablesResult {
  searchedTables: string[];
  selectedTable: string | null;
  tableScores: Record<string, number>;
  results: VectorOutput[];
  allResults: VectorOutput[];
}

/** Agent 可选 rag_search capability 的受控结果；证据与最终来源保持同一批结果。 */
export interface RagSearchResult {
  evidence: RagEvidence[];
  results: VectorOutput[];
  sources: VectorOutput[];
  answerMode: "text" | "vision";
  evidenceIds: string[];
  visualEvidenceRefs: string[];
  /** @deprecated 新结果不再暴露内部页图文件名。 */
  imageFileName?: string;
  warnings: string[];
}

/** AgentFlow 的专用 Rerank 运行时；默认策略仅供非 Session 兼容入口使用。 */
export interface AgentFlowRerankOptions extends RerankRuntime {
  defaultPolicy?: RerankPolicy;
}

/** AgentFlow 的两类 Embedding 运行连接；由宿主按操作冻结。 */
export type AgentFlowEmbeddingOptions = EmbeddingRuntime;

/** 校验候选确实属于当前 Workspace manifest，并为 PDF 页附加 opaque 视觉引用。 */
export function validateRagEvidenceResults(results: VectorOutput[], manifests: KnowledgeResourceManifest[]): VectorOutput[] {
  const validResources = new Map(manifests
    .filter(function usable(manifest) { return manifest.status === "completed" || manifest.status === "partial"; })
    .map(function pair(manifest) { return [manifest.resourceId, manifest.tableName] as const; }));
  return results.filter(function belongsToWorkspace(result) {
    const resourceId = result.metadata.resourceId;
    const tableName = result.metadata.tableName;
    return typeof resourceId === "string" && typeof tableName === "string" && validResources.get(resourceId) === tableName;
  }).map(function attachVisualReference(result) {
    const resourceId = String(result.metadata.resourceId);
    const pageNumber = Number(result.metadata.pageNumber);
    return result.metadata.source === "image"
      ? { ...result, metadata: { ...result.metadata, visualEvidenceRef: `rag-resource:${resourceId}:image` } }
      : Number.isInteger(pageNumber) && pageNumber > 0
      ? { ...result, metadata: { ...result.metadata, visualEvidenceRef: `rag-resource:${resourceId}:page:${pageNumber}` } }
      : result;
  });
}

/** 流式问答输出选项：控制是否在 SSE 完成阶段附带可展示的检索来源。 */
export interface AskStreamOptions {
  includeSources?: boolean;
  includeProcess?: boolean;
  /** API Route 已构建的多表候选池，避免问答前重复检索。 */
  searchResults?: VectorOutput[];
  /** 会话上一轮命中的 PDF 文件名，用于“第几页”等追问的文件范围继承。 */
  focusedPdfFileName?: string;
}

// ── 运行时动态加载（绕过 esbuild/Turbopack 静态分析）──

/** 按既有打包布局加载共享解析/检索模块，避免把原生依赖打进宿主。 */
export async function loadInternalModule<T = any>(encodedPath: string): Promise<T> {
  let req: NodeRequire;
  try {
    const { createRequire } = await import("node:module");
    req = createRequire(import.meta.url);
  } catch {
    req = eval("require") as NodeRequire;
  }
  const modPath = Buffer.from(encodedPath, "base64").toString();
  return req(modPath) as T;
}

let _dbViewer: Record<string, unknown> | null = null;

/** 在每个有副作用的阶段前检查取消，保证取消后不继续计费或写入。 */
function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RagError("RAG_OPERATION_CANCELLED");
  }
}

/** PyMuPDF 提取的页级结构信号，用于避免以固定字符数判断解析质量。 */
export interface PdfPageQualityInput {
  text: string;
  textBlockCount?: number;
  imageCount?: number;
  drawingCount?: number;
  imageCoverageRatio?: number;
  width?: number;
  height?: number;
}

/** 综合文本可读性、替代字符、块结构与视觉占比选择 text、fused 或 OCR 路径。 */
export function classifyPdfPage(input: string | PdfPageQualityInput): "text" | "fused" | "ocr" {
  const page = typeof input === "string" ? { text: input } : input;
  const characters = [...page.text];
  const nonWhitespaceCount = characters.filter(function nonWhitespace(character) { return !/\s/u.test(character); }).length;
  const printableCount = characters.filter(function printable(character) { return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(character); }).length;
  const replacementCount = characters.filter(function replacement(character) { return character === "\uFFFD"; }).length;
  const printableRatio = characters.length > 0 ? printableCount / characters.length : 0;
  const replacementRatio = nonWhitespaceCount > 0 ? replacementCount / nonWhitespaceCount : 0;
  const textBlockCount = Math.max(0, page.textBlockCount ?? page.text.split(/\n{2,}/u).filter(function block(value) { return Boolean(value.trim()); }).length);
  const visualObjects = Math.max(0, page.imageCount ?? 0) + Math.max(0, page.drawingCount ?? 0);
  const imageCoverageRatio = Math.max(0, Math.min(1, page.imageCoverageRatio ?? 0));
  const hasReliableText = nonWhitespaceCount > 0 && printableRatio >= 0.9 && replacementRatio <= 0.02 && textBlockCount > 0;
  const visualMaterial = visualObjects > 0 && (imageCoverageRatio >= 0.15 || !hasReliableText);

  if (!hasReliableText) return nonWhitespaceCount === 0 || visualMaterial ? "ocr" : "fused";
  if (visualMaterial) return "fused";
  return "text";
}

/** partial 重试只返回上次失败页；首次入库返回全部页面。 */
export function selectPdfIngestPages<T extends { pageNumber: number }>(pages: T[], failedPages?: number[]): T[] {
  if (!failedPages?.length) return pages;
  const failed = new Set(failedPages);
  return pages.filter(function failedPreviously(page) { return failed.has(page.pageNumber); });
}

async function loadVectorStore() {
  if (!_dbViewer) {
    let req: NodeRequire;
    try {
      const { createRequire } = await import("node:module");
      req = createRequire(import.meta.url);
    } catch {
      req = eval("require") as NodeRequire;
    }
    const vsPath = Buffer.from("Li9pbnRlcm5hbC9saWIvdmVjdG9yLXN0b3Jl", "base64").toString();
    _dbViewer = req(vsPath);
  }
  return _dbViewer;
}

// ── AgentFlow 类 ── added by clayw on 20260708 ───────────────────────

export class AgentFlow {
  private readonly storage: ResolvedRagStorage;
  private readonly resourceStore: ReturnType<typeof createKnowledgeResourceStore>;
  private readonly lexicalIndex: ReturnType<typeof createLexicalIndex>;
  private readonly rerankRuntime: RerankRuntime;
  private readonly defaultRerankPolicy?: RerankPolicy;
  private readonly embeddingRuntime?: EmbeddingRuntime;

  /** 创建绑定到单个 RAG Root 的工作流；未传时仅保留旧入口兼容。 */
  constructor(storageOptions: RagStorageOptions = {}, rerankOptions: AgentFlowRerankOptions = {}, embeddingOptions?: AgentFlowEmbeddingOptions) {
    this.storage = resolveRagStorage(storageOptions);
    this.resourceStore = createKnowledgeResourceStore(this.storage.manifestPath);
    this.lexicalIndex = createLexicalIndex(this.storage.lexicalPath);
    this.rerankRuntime = { resolveApiKey: rerankOptions.resolveApiKey, fetch: rerankOptions.fetch, adapter: rerankOptions.adapter };
    this.defaultRerankPolicy = rerankOptions.defaultPolicy ? { ...rerankOptions.defaultPolicy } : undefined;
    this.embeddingRuntime = embeddingOptions;
  }

  /** 在动态 vector-store 模块自身的 AsyncLocalStorage 中固定当前实例路径。 */
  private async withStorage<T>(operation: () => Promise<T>): Promise<T> {
    const vectorStore = await loadVectorStore();
    const embeddings = await loadInternalModule<typeof import("./lib/embeddings")>("Li9pbnRlcm5hbC9saWIvZW1iZWRkaW5ncw==");
    const vectorPath = this.storage.vectorPath;
    return embeddings.withEmbeddingRuntime(this.embeddingRuntime, function withEmbeddingConnection() {
      return (vectorStore as any).withVectorStorePath(vectorPath, operation);
    });
  }

  // ═══════════════════════════════════════════════
  //  统一入库入口
  // ═══════════════════════════════════════════════

  /** 统一入库入口 — 按 options.type 分发到对应逻辑 */
  async ingest(filePath: string, options: IngestOptions): Promise<IngestResult> {
    return this.withStorage(async () => {
      assertNotAborted(options.signal);
      if (options.type !== "excel" && options.type !== "text" && options.type !== "pdf" && options.type !== "image") throw new RagError("RAG_UNSUPPORTED_DOCUMENT_TYPE");
      const buffer = readFileSync(filePath);
      const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 32);
      const embMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZW1iZWRkaW5ncw==");
      const embeddingProfile = (embMod as any).getEmbeddingProfile(options.type === "pdf" || options.type === "image" ? "multimodal" : "text");
      const existingPartial = options.type === "pdf"
        ? (await this.resourceStore.list()).find(function samePartialPdf(resource) { return resource.type === "pdf" && resource.status === "partial" && resource.storedSourceFileName === `pdf-${hash}.pdf` && resource.tableProfile?.embeddingSpaceId === embeddingProfile.embeddingSpaceId; })
        : undefined;
      const resourceId = existingPartial?.resourceId ?? createKnowledgeResourceId();
      const embeddingSpaceId = embeddingProfile.embeddingSpaceId;
      const tableName = existingPartial?.tableName ?? deriveKnowledgeTableName(resourceId, embeddingSpaceId);
      const scopedOptions = { ...options, resourceId, tableName, clearFirst: false };
      if (options.type === "pdf") return this._ingestPdf(filePath, scopedOptions);
      if (options.type === "image") return this._ingestImage(filePath, scopedOptions);
      const displayName = path.basename(options.displayName?.trim() || options.title?.trim() || filePath);
      const now = Date.now();
      const baseManifest: KnowledgeResourceManifest = {
        schemaVersion: 1, pipelineVersion: "rag-v2", resourceId, displayName, type: options.type,
        status: "running", tableName, recordCount: 0, createdAt: now, updatedAt: now,
      };
      await this.resourceStore.save(baseManifest);
      try {
        const result = options.type === "excel" ? await this._ingestExcel(filePath, scopedOptions) : await this._ingestText(filePath, scopedOptions);
        assertNotAborted(options.signal);
        if (!result.totalChunks) throw new RagError("RAG_PARSE_FAILED");
        const tableProfile: TableProfile = {
          tableName,
          resourceId,
          sourceType: options.type,
          embeddingProvider: embeddingProfile.provider,
          embeddingModel: embeddingProfile.model,
          embeddingDimension: embeddingProfile.dimension,
          embeddingSpaceId: embeddingProfile.embeddingSpaceId,
          lexicalIndexVersion: LEXICAL_INDEX_VERSION,
          pipelineVersion: "rag-v2",
          schemaVersion: 1,
        };
        const extension = path.extname(displayName).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin";
        const storedSourceFileName = `source-${hash}${extension}`;
        const storageMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZmlsZS1zdG9yYWdl");
        await storageMod.saveFile(buffer, storedSourceFileName, this.storage.sourcePath);
        await this.resourceStore.save({ ...baseManifest, status: "completed", recordCount: result.totalChunks, storedSourceFileName, tableProfile, updatedAt: Date.now() });
        return { ...result, resourceId, status: "completed" };
      } catch (error) {
        const vectorStore = await loadVectorStore();
        await (vectorStore as any).deleteKnowledgeResourceById(tableName, resourceId);
        await this.lexicalIndex.removeResource(tableName, resourceId);
        await this.resourceStore.save({ ...baseManifest, status: options.signal?.aborted ? "cancelled" : "failed", updatedAt: Date.now() });
        throw error;
      }
    });
  }

  // ═══════════════════════════════════════════════
  //  Excel 辅助方法（查看/预览，不入库）
  // ═══════════════════════════════════════════════

  /** 仅解析 Excel 为行数据（不入库） */
  async parseExcelFile(
    filePath: string,
    options?: ParseExcelOptions
  ): Promise<Record<string, unknown>[]> {
    const mod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZXhjZWwtcGFyc2Vy");
    return mod.parseExcel(filePath, options);
  }

  /** 列出 Excel 工作表名称 */
  async listExcelSheets(filePath: string): Promise<string[]> {
    const mod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZXhjZWwtcGFyc2Vy");
    return mod.listSheetNames(filePath);
  }

  /** 获取 Excel 工作表概览（行数/列数/表头） */
  async getExcelSheetInfo(
    filePath: string,
    sheetName?: string
  ): Promise<SheetInfo> {
    const mod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZXhjZWwtcGFyc2Vy");
    return mod.getSheetInfo(filePath, sheetName);
  }

  /** 读取受控存储目录中的图片二进制，供应用层安全展示 PDF 来源图 */
  async getStoredImage(fileName: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const storageMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZmlsZS1zdG9yYWdl");
    return storageMod.readStoredImageByName(fileName, this.storage.sourcePath);
  }

  /** 从 manifest 列出当前 RAG Root 的资源，不扫描向量表。 */
  async listResources(): Promise<KnowledgeResourceManifest[]> { return this.resourceStore.list(); }

  /** 按资源 ID 返回有界预览；文档复用临时解析器，不公开存储文件名或路径。 */
  async getResourcePreview(resourceId: string, signal?: AbortSignal): Promise<{ buffer: Buffer; mimeType: string }> {
    assertNotAborted(signal);
    const manifest = await this.resourceStore.get(resourceId);
    if (!manifest || !["completed", "partial"].includes(manifest.status) || !manifest.storedSourceFileName) throw new RagError("RAG_RESOURCE_NOT_FOUND");
    if (manifest.type === "pdf") return this.getPdfPageImage(resourceId, 1, signal);
    const storageMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZmlsZS1zdG9yYWdl");
    if (manifest.type === "image") return storageMod.readStoredImageByName(manifest.storedSourceFileName, this.storage.sourcePath);
    const bytes = await storageMod.readStoredSource(manifest.storedSourceFileName, this.storage.sourcePath);
    const extension = path.extname(manifest.storedSourceFileName);
    const mimeType = extension === ".docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : extension === ".xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : extension === ".xls" ? "application/vnd.ms-excel" : "text/plain";
    const parser = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZG9jdW1lbnQtcGFyc2Vy");
    const parsed = await parser.parseDocument({ bytes, mimeType, signal });
    return { buffer: Buffer.from(parsed.text.slice(0, 16_000)), mimeType: "text/plain; charset=utf-8" };
  }

  /** 显式从 LanceDB 受控正文快照重建关键词索引；普通查询绝不调用此方法。 */
  async rebuildLexicalIndexes(tableName?: string): Promise<{ tableName: string; recordCount: number }[]> {
    return this.withStorage(async () => {
      const vsMod = await loadVectorStore();
      const db = await (vsMod as any).initVectorStore(this.storage.vectorPath);
      const manifests = await this.resourceStore.list();
      const tables = tableName
        ? [tableName]
        : [...new Set(manifests.filter(function usable(resource) { return resource.status === "completed" || resource.status === "partial"; }).map(function table(resource) { return resource.tableName; }))];
      const targets = tables.length > 0 ? tables : (await db.tableNames()).filter(function documentTable(name: string) { return !name.startsWith("mysql_"); });
      const rebuilt: { tableName: string; recordCount: number }[] = [];
      for (const target of targets) {
        const recordCount = await this.lexicalIndex.rebuild(target, function loadRecords() { return (vsMod as any).listVectorTextRecords(target); });
        rebuilt.push({ tableName: target, recordCount });
      }
      return rebuilt;
    });
  }

  /** 删除单个 manifest 资源及其向量和来源文件；不存在时保持幂等。 */
  async deleteResource(resourceId: string): Promise<{ resourceId: string; deleted: boolean; deletedRecordCount: number }> {
    if (!isKnowledgeResourceId(resourceId)) return { resourceId, deleted: false, deletedRecordCount: 0 };
    return this.withStorage(async () => {
      const manifest = await this.resourceStore.get(resourceId);
      if (!manifest) return { resourceId, deleted: false, deletedRecordCount: 0 };
      await this.resourceStore.save({ ...manifest, status: "deleting", updatedAt: Date.now() });
      try {
        const vsMod = await loadVectorStore();
        const deletedRecordCount = await (vsMod as any).deleteKnowledgeResourceById(manifest.tableName, resourceId);
        await this.lexicalIndex.removeResource(manifest.tableName, resourceId);
        if (manifest.storedSourceFileName && !(await this.resourceStore.list()).some(function sharesSource(item) { return item.resourceId !== resourceId && item.storedSourceFileName === manifest.storedSourceFileName; })) {
          const storageMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZmlsZS1zdG9yYWdl");
          await storageMod.deleteStoredSource(manifest.storedSourceFileName, this.storage.sourcePath);
        }
        await this.resourceStore.remove(resourceId);
        return { resourceId, deleted: true, deletedRecordCount };
      } catch (error) {
        await this.resourceStore.save({ ...manifest, status: "failed", updatedAt: Date.now() });
        throw error;
      }
    });
  }

  /** 按资源与页码从原始 PDF 即时渲染预览，不永久保存页图。 */
  async getPdfPageImage(resourceId: string, pageNumber: number, signal?: AbortSignal): Promise<{ buffer: Buffer; mimeType: "image/png" }> {
    const manifest = await this.resourceStore.get(resourceId);
    if (!manifest || !["completed", "partial"].includes(manifest.status) || manifest.type !== "pdf" || !manifest.storedSourceFileName || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > (manifest.pageCount ?? 0)) throw new RagError("RAG_RESOURCE_NOT_FOUND");
    const storageMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZmlsZS1zdG9yYWdl");
    const pdfMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvcGRmLXByb2Nlc3Nvcg==");
    const pdfPath = await storageMod.resolveReadableStoredPdf(manifest.storedSourceFileName, this.storage.sourcePath);
    const renderRoot = path.join(this.storage.tempPath, `${resourceId}-preview-${pageNumber}-${Date.now()}`);
    try {
      const pages = await pdfMod.renderPdfPageRange(pdfPath, pageNumber, pageNumber, renderRoot, signal);
      if (!pages[0]) throw new RagError("RAG_RESOURCE_NOT_FOUND");
      return { buffer: pages[0].buffer, mimeType: "image/png" };
    } finally {
      await pdfMod.cleanupPdfRenderDirectory(renderRoot);
    }
  }

  /** 解析并读取当前 Workspace 的 opaque 视觉证据引用，不接受文件路径。 */
  async readVisualEvidence(visualEvidenceRef: string, signal?: AbortSignal): Promise<{ dataUrl: string; mimeType: "image/png" }> {
    const imageMatch = /^rag-resource:(resource_[a-f0-9]{32}):image$/.exec(visualEvidenceRef);
    if (imageMatch) {
      const image = await this.getResourcePreview(imageMatch[1], signal);
      if (image.mimeType !== "image/png") throw new RagError("RAG_RESOURCE_NOT_FOUND");
      return { dataUrl: `data:image/png;base64,${image.buffer.toString("base64")}`, mimeType: "image/png" };
    }
    const match = /^rag-resource:(resource_[a-f0-9]{32}):page:([1-9]\d*)$/.exec(visualEvidenceRef);
    if (!match) throw new RagError("RAG_INVALID_INPUT");
    const image = await this.getPdfPageImage(match[1], Number(match[2]), signal);
    return { dataUrl: `data:${image.mimeType};base64,${image.buffer.toString("base64")}`, mimeType: image.mimeType };
  }

  // ═══════════════════════════════════════════════
  //  Private: Excel 入库完整流程
  //  （从原 index.ts ingestExcel 完整搬运，逻辑不变）
  // ═══════════════════════════════════════════════

  private async _ingestExcel(
    filePath: string,
    options: IngestOptions
  ): Promise<IngestResult> {
    const { tableName = "employee_test", clearFirst = false, headerRow = 1, sheetName, chunkSize, chunkOverlap } = options;

    // 1. 解析 Excel
    const excelMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZXhjZWwtcGFyc2Vy");
    const rows: Record<string, unknown>[] = await excelMod.parseExcel(filePath, { headerRow, sheetName });

    if (rows.length === 0) {
      return { type: "excel", tableName, totalRows: 0, totalChunks: 0, columns: [], previewRows: [] };
    }

    // 2. 保留表头并按 5 行聚合，避免 Excel 向量丢失列名和邻近行关系。
    const columns = Object.keys(rows[0]);
    const rowsPerChunk = 5;
    const excelGroups: { text: string; rowIndexes: number[] }[] = [];
    for (let start = 0; start < rows.length; start += rowsPerChunk) {
      const groupRows = rows.slice(start, start + rowsPerChunk);
      const rowTexts = groupRows.map((row, groupIndex) => {
        const parts = Object.entries(row)
          .filter(([, value]) => value !== null && value !== undefined && value !== "")
          .map(([key, value]) => `${key}: ${value}`);
        return `记录 #${start + groupIndex + 1}: ${parts.join("; ")}`;
      });
      excelGroups.push({
        text: `表头: ${columns.join(" | ")}\n${rowTexts.join("\n")}`,
        rowIndexes: groupRows.map((_, groupIndex) => start + groupIndex),
      });
    }

    // 3. 文本分块（长文本拆成多块，短文本保持原样）
    const { onProgress } = options;
    const chunkMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvY2h1bms=");

    onProgress?.({ step: "parse", message: `已解析 ${rows.length} 行数据，开始分块…`, total: rows.length });

    type ChunkItem = {
      text: string;
      rowIndex: number;
      rowIndexes: number[];
      chunkIndex: number;
      totalChunks: number;
    };
    const chunkItems: ChunkItem[] = [];
    for (let i = 0; i < excelGroups.length; i++) {
      const group = excelGroups[i];
      const chunks: string[] = (chunkMod as any).chunkText(group.text, chunkSize, chunkOverlap);
      // 上报组级分块
      onProgress?.({
        step: "chunk_row",
        message: `第 ${group.rowIndexes[0] + 1}-${group.rowIndexes[group.rowIndexes.length - 1] + 1}/${rows.length} 行 → 拆分为 ${chunks.length} 块`,
        current: i + 1,
        total: excelGroups.length,
        rowIndex: group.rowIndexes[0],
        totalChunks: chunks.length,
      });
      for (let j = 0; j < chunks.length; j++) {
        chunkItems.push({
          text: chunks[j],
          rowIndex: group.rowIndexes[0],
          rowIndexes: group.rowIndexes,
          chunkIndex: j,
          totalChunks: chunks.length,
        });
        // 上报每块内容
        onProgress?.({
          step: "chunk_item",
          message: `  块 ${j + 1}/${chunks.length}`,
          rowIndex: group.rowIndexes[0],
          chunkIndex: j,
          totalChunks: chunks.length,
          chunkText: chunks[j],
        });
      }
    }

    // 4. 向量化（逐条调用云端文本 Embedding）
    onProgress?.({ step: "embed", message: `开始向量化 ${chunkItems.length} 个文本块…`, total: chunkItems.length });
    const embMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZW1iZWRkaW5ncw==");
    const embeddingProfile = (embMod as any).getEmbeddingProfile("text");
    const vectors: number[][] = [];
    for (let i = 0; i < chunkItems.length; i++) {
      assertNotAborted(options.signal);
      vectors.push(await (embMod as any).embedText(chunkItems[i].text, options.signal));
      if ((i + 1) % 5 === 0 || i === chunkItems.length - 1) {
        onProgress?.({
          step: "embed",
          message: `向量化 ${i + 1}/${chunkItems.length}…`,
          current: i + 1,
          total: chunkItems.length,
        });
      }
    }

    // 5. 构建入库数据（优先读环境变量，默认项目根 lancedb/）
    const vsMod = await loadVectorStore();
    await (vsMod as any).initVectorStore(this.storage.vectorPath);
    const fileName = filePath.split(/[/\\]/).pop() || "unknown";

    // 行数据全部存入 metadata JSON，不做列展开（兼容任意 Excel 列结构）
    const vectorInputs = chunkItems.map((item, i) => ({
      id: `${options.resourceId ?? "legacy"}-excel-${i + 1}`,
      vector: vectors[i],
      text: item.text,
      metadata: {
        source: "excel",
        resourceId: options.resourceId,
        fileName,
        rowIndex: item.rowIndex,
        rowIndexes: item.rowIndexes,
        chunkIndex: item.chunkIndex,
        totalChunks: item.totalChunks,
        embeddingProvider: embeddingProfile.provider,
        embeddingModel: embeddingProfile.model,
        embeddingDimension: embeddingProfile.dimension,
        embeddingSpaceId: embeddingProfile.embeddingSpaceId,
        ...rows[item.rowIndex],
      },
    }));

    // 6. 清空旧表 + 写入
    onProgress?.({ step: "write", message: `写入 ${vectorInputs.length} 条向量到 ${tableName}…` });
    if (clearFirst) {
      assertNotAborted(options.signal);
      await (vsMod as any).clearTable(tableName);
      await this.lexicalIndex.clear(tableName);
    }
    assertNotAborted(options.signal);
    await (vsMod as any).insertVectors(tableName, vectorInputs);
    await this.lexicalIndex.upsert(tableName, vectorInputs.map(function lexicalRecord(item) { return { ...item, score: 0 }; }));

    // 7. 返回结果
    onProgress?.({ step: "done", message: `✅ 完成！共 ${rows.length} 行 → ${vectorInputs.length} 条向量记录` });

    return {
      type: "excel",
      tableName,
      totalRows: rows.length,
      totalChunks: vectorInputs.length,
      columns,
      previewRows: rows.slice(0, 3),
    };
  }

  // ═══════════════════════════════════════════════
  //  Private: 文本入库（txt / md / docx）
  //  — 按扩展名提取纯文本 → 按标题切 section → 分块 → 向量化 → LanceDB
  // ═══════════════════════════════════════════════

  private async _ingestText(
    filePath: string,
    options: IngestOptions
  ): Promise<IngestResult> {
    const { tableName = "employee_test", clearFirst = false, chunkSize = 512, chunkOverlap = 128 } = options;
    const { onProgress } = options;
    const fileName = filePath.split(/[/\\]/).pop() || "unknown";
    const ext = path.extname(filePath).toLowerCase();

    // ── ① 读取文件 → 按扩展名提取纯文本
    onProgress?.({ step: "parse", message: `📄 读取文件: ${fileName}` });

    let fullText: string;
    if (ext === ".docx") {
      onProgress?.({ step: "parse", message: `📦 解析 docx: ${fileName}` });
      fullText = await extractTextDocument(readFileSync(filePath), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    } else {
      fullText = readFileSync(filePath, "utf-8");
    }

    if (!fullText || fullText.trim().length === 0) {
      onProgress?.({ step: "done", message: "⚠️ 文件内容为空" });
      return { type: "text", tableName, totalRows: 0, totalChunks: 0, columns: [], previewRows: [] };
    }

    onProgress?.({ step: "parse", message: `✅ 提取文本 ${fullText.length} 字符，开始分块…` });

    const source = ext === ".docx" ? "docx" : (ext === ".md" ? "md" : "txt");

    // ── ② 按标题切 section，每个 section 单独分块
    const sections = splitIntoSections(fullText);
    const chunkMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvY2h1bms=");

    type ChunkItem = { text: string; sectionIndex: number; chunkIndex: number; title: string };
    const allChunkItems: ChunkItem[] = [];
    let globalChunkIdx = 0;

    for (let si = 0; si < sections.length; si++) {
      const section = sections[si];
      const docTitle = section.title.slice(0, 200) || fileName;
      // 标题参与分块上下文（拼接在内容前）
      const sectionContent = section.title ? `${section.title}\n\n${section.content}` : section.content;
      if (!sectionContent.trim()) continue;

      const sectionChunks: string[] = (chunkMod as any).chunkText(sectionContent, chunkSize, chunkOverlap);
      for (let ci = 0; ci < sectionChunks.length; ci++) {
        allChunkItems.push({
          text: sectionChunks[ci],
          sectionIndex: si,
          chunkIndex: ci,
          title: docTitle,
        });
        onProgress?.({
          step: "chunk_item",
          message: `块 ${globalChunkIdx + 1} (标题: ${docTitle})`,
          chunkIndex: globalChunkIdx,
          totalChunks: -1, // 最终数量未知
          chunkText: sectionChunks[ci],
        });
        globalChunkIdx++;
      }
    }

    if (allChunkItems.length === 0) {
      onProgress?.({ step: "done", message: "⚠️ 分块后无内容" });
      return { type: "text", tableName, totalRows: 0, totalChunks: 0, columns: [], previewRows: [] };
    }

    // ── ③ 向量化（逐块调用云端文本 Embedding）
    onProgress?.({ step: "embed", message: `开始向量化 ${allChunkItems.length} 个文本块…`, total: allChunkItems.length });
    const embMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZW1iZWRkaW5ncw==");
    const embeddingProfile = (embMod as any).getEmbeddingProfile("text");
    const vectors: number[][] = [];
    for (let i = 0; i < allChunkItems.length; i++) {
      assertNotAborted(options.signal);
      vectors.push(await (embMod as any).embedText(allChunkItems[i].text, options.signal));
      if ((i + 1) % 5 === 0 || i === allChunkItems.length - 1) {
        onProgress?.({
          step: "embed",
          message: `向量化 ${i + 1}/${allChunkItems.length}…`,
          current: i + 1,
          total: allChunkItems.length,
        });
      }
    }

    // ── ④&⑤ 构建 metadata + 写入 LanceDB
    const vsMod = await loadVectorStore();
    await (vsMod as any).initVectorStore(this.storage.vectorPath);

    const totalChunks = allChunkItems.length;
    const vectorInputs = allChunkItems.map((item, i) => ({
      id: `text-${Date.now()}-${i}`,
      vector: vectors[i],
      text: item.text,
      metadata: {
        source,
        resourceId: options.resourceId,
        fileName,
        title: item.title,
        sectionIndex: item.sectionIndex,
        chunkIndex: item.chunkIndex,
        totalChunks,
        embeddingProvider: embeddingProfile.provider,
        embeddingModel: embeddingProfile.model,
        embeddingDimension: embeddingProfile.dimension,
        embeddingSpaceId: embeddingProfile.embeddingSpaceId,
        text: item.text,
      },
    }));

    onProgress?.({ step: "write", message: `写入 ${vectorInputs.length} 条向量到 ${tableName}…` });
    if (clearFirst) {
      assertNotAborted(options.signal);
      await (vsMod as any).clearTable(tableName);
      await this.lexicalIndex.clear(tableName);
    }
    assertNotAborted(options.signal);
    await (vsMod as any).insertVectors(tableName, vectorInputs);
    await this.lexicalIndex.upsert(tableName, vectorInputs.map(function lexicalRecord(item) { return { ...item, score: 0 }; }));

    onProgress?.({
      step: "done",
      message: `✅ 完成！${formatFileSize(fullText.length)} → ${allChunkItems.length} 块 → ${vectorInputs.length} 条向量记录`,
    });

    return {
      type: "text",
      tableName,
      totalRows: sections.length,
      totalChunks: vectorInputs.length,
      columns: ["chunkIndex", "totalChunks", "fileName", "title", "text"],
      previewRows: allChunkItems.slice(0, 3).map((item, i) => ({
        chunkIndex: i,
        totalChunks,
        fileName,
        title: item.title,
        text: item.text.length > 200 ? item.text.slice(0, 200) + "…" : item.text,
      })),
    };
  }

  // ═══════════════════════════════════════════════
  //  Private: PDF 入库（页级图文融合）
  //  — 按页提取文本 + 渲染页图 → DashScope 多模态向量化 → LanceDB

  //  added by clayw on 20260714
  // ═══════════════════════════════════════════════

  /** 图片复用页级 OCR、图文 Embedding、向量与关键词索引，作为独立正式资源保存。 */
  private async _ingestImage(filePath: string, options: IngestOptions): Promise<IngestResult> {
    const { resourceId, tableName, signal, onProgress } = options;
    if (!resourceId || !tableName) throw new RagError("RAG_STORAGE_INVALID");
    const pdfMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvcGRmLXByb2Nlc3Nvcg==");
    const storageMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZmlsZS1zdG9yYWdl");
    const embMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZW1iZWRkaW5ncw==");
    const embeddingProfile = embMod.getEmbeddingProfile("multimodal");
    const vsMod = await loadVectorStore() as typeof import("./lib/vector-store");
    const storedSourceFileName = `source-${createHash("sha256").update(resourceId).digest("hex").slice(0, 32)}.png`;
    const now = Date.now();
    const manifest: KnowledgeResourceManifest = { schemaVersion: 1, pipelineVersion: "rag-v2", resourceId, tableName, type: "image", status: "running", displayName: path.basename(options.displayName || filePath), recordCount: 0, pageCount: 1, storedSourceFileName, createdAt: now, updatedAt: now };
    await this.resourceStore.save(manifest);
    try {
      onProgress?.({ step: "parse", message: "正在解析图片" });
      const buffer: Buffer = await pdfMod.normalizeKnowledgeImage(readFileSync(filePath), signal);
      assertNotAborted(signal);
      const source = await storageMod.saveFile(buffer, storedSourceFileName, this.storage.sourcePath);
      const diagnostics = await pdfMod.preflightPdfRuntime(signal);
      const text: string = diagnostics.tesseract.available ? await pdfMod.ocrPdfPage(source.filePath, signal) : diagnostics.cloudOcrConfigured ? await pdfMod.ocrPdfPageWithCloud(buffer, signal) : "";
      assertNotAborted(signal);
      onProgress?.({ step: "embed", message: "正在生成图片向量" });
      const vector = await embMod.embedPage({ text: text.trim() || undefined, image: `data:image/png;base64,${buffer.toString("base64")}` }, signal);
      assertNotAborted(signal);
      const tableProfile: TableProfile = { tableName, resourceId, sourceType: "image", embeddingProvider: embeddingProfile.provider, embeddingModel: embeddingProfile.model, embeddingDimension: embeddingProfile.dimension, embeddingSpaceId: embeddingProfile.embeddingSpaceId, lexicalIndexVersion: LEXICAL_INDEX_VERSION, pipelineVersion: "rag-v2", schemaVersion: 1 };
      const item = { id: `${resourceId}-image`, text, vector, metadata: { ...tableProfile, source: "image", pageNumber: 1, pageText: text, hasText: Boolean(text.trim()), hasImage: true, modality: "ocr", fileName: manifest.displayName } };
      await vsMod.initVectorStore(this.storage.vectorPath);
      await vsMod.insertVectors(tableName, [item]);
      await this.lexicalIndex.upsert(tableName, [{ ...item, score: 0 }]);
      assertNotAborted(signal);
      await this.resourceStore.save({ ...manifest, status: "completed", recordCount: 1, tableProfile, updatedAt: Date.now() });
      return { type: "image", tableName, totalRows: 1, totalChunks: 1, columns: [], previewRows: [], resourceId, status: "completed" };
    } catch (error) {
      await vsMod.deleteKnowledgeResourceById(tableName, resourceId);
      await this.lexicalIndex.removeResource(tableName, resourceId);
      await storageMod.deleteStoredSource(storedSourceFileName, this.storage.sourcePath);
      await this.resourceStore.save({ ...manifest, status: signal?.aborted ? "cancelled" : "failed", updatedAt: Date.now() });
      throw error;
    }
  }

  /** PDF 入库主流程：一页文本和一页图片合并为同一条向量记录 */
  private async _ingestPdf(
    filePath: string,
    options: IngestOptions
  ): Promise<IngestResult> {
    if (!options.resourceId || !options.tableName) throw new RagError("RAG_STORAGE_INVALID");
    const { tableName, resourceId, clearFirst = false } = options;
    const { onProgress, signal } = options;
    const fileName = path.basename(options.displayName?.trim() || options.title?.trim() || filePath);
    const fallbackTitle = options.title?.trim() || fileName;
    const pdfBuffer = readFileSync(filePath);
    const pdfHash = createHash("sha256").update(pdfBuffer).digest("hex");
    const pdfId = pdfHash.slice(0, 32);
    const storedPdfFileName = `pdf-${pdfId}.pdf`;
    const previousManifest = await this.resourceStore.get(resourceId);
    const retryPages = previousManifest?.status === "partial" && previousManifest.failedPages?.length
      ? new Set(previousManifest.failedPages)
      : undefined;
    const now = Date.now();
    const baseManifest: KnowledgeResourceManifest = {
      schemaVersion: 1,
      pipelineVersion: "rag-v2",
      resourceId,
      displayName: fileName,
      type: "pdf",
      status: "running",
      tableName,
      recordCount: previousManifest?.recordCount ?? 0,
      failedPages: previousManifest?.failedPages,
      storedSourceFileName: storedPdfFileName,
      createdAt: previousManifest?.createdAt ?? now,
      updatedAt: now,
    };

    onProgress?.({ step: "parse_start", message: `📄 开始解析 PDF: ${fileName}` });

    const pdfMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvcGRmLXByb2Nlc3Nvcg==");
    const storageMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZmlsZS1zdG9yYWdl");
    await mkdir(this.storage.rootPath, { recursive: true });
    await this.resourceStore.save(baseManifest);
    try {
      assertNotAborted(signal);
      const diagnostics = await (pdfMod as any).preflightPdfRuntime(signal);
      await (storageMod as any).saveOriginalPdf(filePath, storedPdfFileName, this.storage.sourcePath);
      const parsed: { totalPages: number; pages: Array<PdfPageQualityInput & { pageNumber: number }> } = await (pdfMod as any).extractPdfText(filePath, signal);
      baseManifest.pageCount = parsed.totalPages;
      baseManifest.updatedAt = Date.now();
      await this.resourceStore.save(baseManifest);

      for (const page of parsed.pages) {
        onProgress?.({ step: "text_parse_page", message: `已提取第 ${page.pageNumber}/${parsed.totalPages} 页文本`, current: page.pageNumber, total: parsed.totalPages });
      }

      const targetPages = selectPdfIngestPages(parsed.pages, retryPages ? [...retryPages] : undefined);
      const pagesNeedingImages = targetPages
        .filter(function requiresImage(page) { return classifyPdfPage(page) !== "text"; })
        .map(function pageNumber(page) { return page.pageNumber; });
      const renderRoot = path.join(this.storage.tempPath, `${resourceId}-${Date.now()}`);
      let imagePages: { pageNumber: number; buffer: Buffer; filePath: string; width: number; height: number }[] = [];
      try {
        imagePages = await (pdfMod as any).renderPdfPages(filePath, pagesNeedingImages, renderRoot, signal);
        for (const page of imagePages) onProgress?.({ step: "image_render_page", message: `已渲染第 ${page.pageNumber}/${parsed.totalPages} 页图片`, current: page.pageNumber, total: parsed.totalPages });

        const textByPage = new Map(parsed.pages.map(function byPage(page) { return [page.pageNumber, page.text || ""] as const; }));
        const imageByPage = new Map(imagePages.map(function byPage(page) { return [page.pageNumber, page] as const; }));
        const embMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZW1iZWRkaW5ncw==");
        const embeddingProfile = (embMod as any).getEmbeddingProfile("multimodal");
        const vectorInputs: any[] = [];
        const failedPages: number[] = [];
        for (const page of targetPages) {
          const pageNumber = page.pageNumber;
          assertNotAborted(signal);
          try {
            const extractedText = textByPage.get(pageNumber) || "";
            const imagePage = imageByPage.get(pageNumber);
            let pageText = extractedText;
            let modality = classifyPdfPage(page);
            if (modality !== "text" && imagePage && diagnostics.tesseract.available) {
              const ocrText = await (pdfMod as any).ocrPdfPage(imagePage.filePath, signal);
              if (ocrText.trim()) {
                pageText = [extractedText.trim(), ocrText.trim()].filter(Boolean).join("\n");
                modality = extractedText.trim() ? "fused" : "ocr";
              }
            } else if (modality !== "text" && imagePage && diagnostics.cloudOcrConfigured) {
              const ocrText = await (pdfMod as any).ocrPdfPageWithCloud(imagePage.buffer, signal);
              pageText = [extractedText.trim(), ocrText.trim()].filter(Boolean).join("\n");
              modality = extractedText.trim() ? "fused" : "ocr";
            }
            const hasText = Boolean(pageText.trim());
            const hasImage = Boolean(imagePage);
            if (!hasText && !hasImage) throw new RagError("RAG_PDF_PAGE_EMPTY");
            const title = getPdfPageTitle(pageText, fallbackTitle);
            const previousPageText = textByPage.get(pageNumber - 1)?.trim().slice(0, 300) ?? "";
            const nextPageText = textByPage.get(pageNumber + 1)?.trim().slice(0, 300) ?? "";
            const adjacentSummary = [previousPageText ? `上一页摘要：${previousPageText}` : "", nextPageText ? `下一页摘要：${nextPageText}` : ""].filter(Boolean).join("\n");
            const vectorText = `文件：${fileName}\n页码：${pageNumber}/${parsed.totalPages}\n标题：${title}\n\n${pageText}${adjacentSummary ? `\n\n${adjacentSummary}` : ""}`;
            const vector: number[] = await (embMod as any).getOrCreateEmbedding(
              `${embeddingProfile.embeddingSpaceId}:${pdfHash}:${pageNumber}:${modality}`,
              () => (embMod as any).embedPage({ text: hasText ? vectorText : undefined, image: imagePage ? `data:image/png;base64,${imagePage.buffer.toString("base64")}` : undefined }, signal),
              this.storage.cachePath,
            );
            assertNotAborted(signal);
            onProgress?.({ step: "page_embed_item", message: `第 ${pageNumber}/${parsed.totalPages} 页向量生成完成`, current: pageNumber, total: parsed.totalPages });
            const metadata: PdfPageMetadata & Record<string, unknown> = {
              resourceId, pageNumber, totalPages: parsed.totalPages, source: "pdf", modality, fileName,
              storedPdfFileName, pageText, embeddingSpaceId: embeddingProfile.embeddingSpaceId, hasText, hasImage,
            };
            vectorInputs.push({
              id: `pdf-${pdfId}-page-${pageNumber}`,
              vector,
              text: vectorText,
              metadata: {
                ...metadata, pipelineVersion: "rag-v2", pdfId, title,
                embeddingProvider: embeddingProfile.provider, embeddingModel: embeddingProfile.model,
                embeddingDimension: embeddingProfile.dimension,
              },
            });
          } catch (error) {
            if (signal?.aborted) throw error;
            failedPages.push(pageNumber);
          }
        }
        if (!vectorInputs.length && failedPages.length > 0) throw new RagError("RAG_PDF_ALL_PAGES_FAILED");
        const vsMod = await loadVectorStore();
        await (vsMod as any).initVectorStore(this.storage.vectorPath);
        onProgress?.({ step: "write_pages", message: `写入 ${vectorInputs.length} 条 PDF 页级向量到 ${tableName}…` });
        assertNotAborted(signal);
        if (clearFirst) {
          await (vsMod as any).clearTable(tableName);
          await this.lexicalIndex.clear(tableName);
        }
        if (vectorInputs.length > 0) {
          await (vsMod as any).upsertVectors(tableName, vectorInputs);
          await this.lexicalIndex.upsert(tableName, vectorInputs.map(function lexicalRecord(item) { return { ...item, score: 0 }; }));
        }
        if (signal?.aborted) {
          await (vsMod as any).deleteKnowledgeResourceById(tableName, resourceId);
          assertNotAborted(signal);
        }
        const status: KnowledgeResourceStatus = failedPages.length ? "partial" : "completed";
        const tableProfile: TableProfile = {
          tableName,
          resourceId,
          sourceType: "pdf",
          embeddingProvider: embeddingProfile.provider,
          embeddingModel: embeddingProfile.model,
          embeddingDimension: embeddingProfile.dimension,
          embeddingSpaceId: embeddingProfile.embeddingSpaceId,
          lexicalIndexVersion: LEXICAL_INDEX_VERSION,
          pipelineVersion: "rag-v2",
          schemaVersion: 1,
        };
        const recordCount = retryPages ? (previousManifest?.recordCount ?? 0) + vectorInputs.length : vectorInputs.length;
        await this.resourceStore.save({ ...baseManifest, status, recordCount, failedPages, tableProfile, updatedAt: Date.now() });
        onProgress?.({ step: "done", message: `${status === "partial" ? "部分" : "全部"}完成：${vectorInputs.length}/${parsed.totalPages} 页` });
        return {
          type: "pdf", tableName, totalRows: recordCount, totalChunks: recordCount,
          columns: ["resourceId", "pageNumber", "totalPages", "fileName", "title", "pageText", "storedPdfFileName", "modality"],
          previewRows: vectorInputs.slice(0, 3).map(function preview(item) { return { pageNumber: item.metadata.pageNumber, totalPages: item.metadata.totalPages, fileName, title: item.metadata.title, modality: item.metadata.modality, pageText: String(item.metadata.pageText || "").slice(0, 200) }; }),
          resourceId, status, failedPages,
        };
      } finally {
        await (pdfMod as any).cleanupPdfRenderDirectory(renderRoot);
      }
    } catch (error) {
      const status: KnowledgeResourceStatus = signal?.aborted ? "cancelled" : "failed";
      if (previousManifest?.status === "partial") {
        await this.resourceStore.save({ ...previousManifest, updatedAt: Date.now() });
        throw error;
      }
      const vectorStore = await loadVectorStore();
      await (vectorStore as any).deleteKnowledgeResourceById(tableName, resourceId);
      await this.lexicalIndex.removeResource(tableName, resourceId);
      await this.resourceStore.save({ ...baseManifest, status, updatedAt: Date.now() });
      throw error;
    }
  }

  // ═══════════════════════════════════════════════
  //  搜索与问答
  // ═══════════════════════════════════════════════

  /**
   * 单表 RAG 搜索的唯一实现：向量化查询文本 → LanceDB 语义搜索 → 返回匹配行。
   * `searchAcrossTables()` 只编排并复用本方法，不会创建第二条 RAG 检索链路。
   */
  async search(query: string, topK = 5, tableName?: string): Promise<VectorOutput[]> {
    return this.withStorage(async () => {
      const targetTable = tableName ?? "employee_test";
      const vsMod = await loadVectorStore();
      await (vsMod as any).initVectorStore(this.storage.vectorPath);
      const embMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZW1iZWRkaW5ncw==");
      const vectorCache = createQueryVectorCache({ embedText: (embMod as any).embedText, embedMultimodal: (embMod as any).embedMultimodalText });
      return this._searchTableDense(query, topK, targetTable, vsMod as Record<string, any>, vectorCache);
    });
  }

  /** 使用已建立的查询向量缓存执行单表 Dense 检索。 */
  private async _searchTableDense(
    query: string,
    topK: number,
    tableName: string,
    vsMod: Record<string, any>,
    vectorCache: ReturnType<typeof createQueryVectorCache>,
  ): Promise<VectorOutput[]> {
    const manifest = (await this.resourceStore.list()).find(function matchesTable(resource) { return resource.tableName === tableName; });
    const stored = manifest?.tableProfile;
    if (!manifest) throw new RagError("RAG_VECTOR_SPACE_MISMATCH");
    const embeddingKind = manifest.type === "pdf" || manifest.type === "image" ? "multimodal" : "text";
    const embMod = await loadInternalModule<typeof import("./lib/embeddings")>("Li9pbnRlcm5hbC9saWIvZW1iZWRkaW5ncw==");
    const current = embMod.getEmbeddingProfile(embeddingKind);
    assertEmbeddingProfileCompatible(stored, current);
    const sampleMetadata: Record<string, unknown> | null = await vsMod.getTableSampleMetadata(tableName);
    const sampleProfile = resolveRetrievalEmbeddingProfile(sampleMetadata);
    if (sampleProfile.embeddingSpaceId !== current.embeddingSpaceId || sampleProfile.kind !== embeddingKind) {
      throw new RagError("RAG_VECTOR_SPACE_MISMATCH");
    }
    const requestedPdfPage = getRequestedPdfPage(query);
    if (isPdfPageTableMetadata(sampleMetadata) && requestedPdfPage !== null) {
      const exactPage = await vsMod.getPdfPage(tableName, requestedPdfPage);
      if (exactPage) return [exactPage];
    }
    const vector = await vectorCache.get(query, { kind: embeddingKind, embeddingSpaceId: current.embeddingSpaceId });
    return vsMod.searchVectorsWithFilter(tableName, vector, topK) as Promise<VectorOutput[]>;
  }

  /** 多表 RAG 编排：每表独立混合召回，再按表内名次轮询合并候选。 */
  async searchAcrossTables(query: string, topK = 5, tableName?: string): Promise<SearchAcrossTablesResult> {
    return this.withStorage(() => this._searchAcrossTables(query, topK, tableName));
  }

  /** 复用 P2 完整候选、视觉定位、Rerank 与 HyDE 链，供 Agent 的可选 rag_search 调用。 */
  async prepareRagSearch(
    question: string,
    topK = 5,
    tableName?: string,
    focusedPdfFileName?: string,
    focusedResourceId?: string,
    signal?: AbortSignal,
    rerankPolicy: RerankPolicy | undefined = this.defaultRerankPolicy,
  ): Promise<RagSearchResult> {
    return this.withStorage(async () => {
    const warnings: string[] = [];
    let scopedTableName = tableName;
    if (focusedResourceId) {
      const focused = await this.resourceStore.get(focusedResourceId);
      if (!focused || focused.type !== "pdf" || (focused.status !== "completed" && focused.status !== "partial")) {
        warnings.push("focused_resource_unavailable");
        return { evidence: [], results: [], sources: [], answerMode: "text", evidenceIds: [], visualEvidenceRefs: [], warnings };
      }
      scopedTableName = focused.tableName;
    }
    const prepared = await this._prepareAnswerResults(question, topK, scopedTableName, undefined, focusedPdfFileName, focusedResourceId, rerankPolicy, signal, warnings);
    const results = await this._validateEvidenceResults(prepared, warnings);
    const evidence = results.map(function toEvidence(result, index): RagEvidence {
      const sourceType = result.metadata.source === "pdf" || result.metadata.source === "excel" || result.metadata.source === "image" ? result.metadata.source : "text";
      const pageNumber = Number(result.metadata.pageNumber);
      return {
        evidenceId: result.id,
        resourceId: String(result.metadata.resourceId),
        sourceType,
        text: sourceType === "pdf" ? String(result.metadata.pageText ?? "") : result.text,
        sufficient: hasSufficientPrivateEvidence(question, result),
        ...(Number.isInteger(pageNumber) && pageNumber > 0 ? { pageNumber } : {}),
        retrievalRanks: { fused: index + 1 },
      };
    });
    const answerMode = results.some((result) => {
      const metadata = result.metadata;
      return (metadata.source === "image" || hasRenderablePdfPage(metadata)) && (!String(metadata.pageText ?? "").trim() || classifyQuery(question).requiresVision);
    }) ? "vision" : "text";
    if (answerMode === "vision") warnings.push("visual_evidence_requires_vision_analyze");
    return {
      evidence,
      results: cleanResults(results),
      sources: cleanSources(results),
      answerMode,
      evidenceIds: evidence.map((item) => item.evidenceId),
      visualEvidenceRefs: results.map(function visualReference(result) { return result.metadata.visualEvidenceRef; }).filter(function isReference(value): value is string { return typeof value === "string"; }),
      warnings: [...new Set(warnings)],
    };
    });
  }

  /** 构建一次受控多表候选池；HyDE 存在时只额外参与同表 Dense + RRF。 */
  private async _searchAcrossTables(
    query: string,
    topK: number,
    tableName?: string,
    hydeQuery?: string,
    signal?: AbortSignal,
  ): Promise<SearchAcrossTablesResult> {
    const vsMod = await loadVectorStore();
    const db = await (vsMod as any).initVectorStore(this.storage.vectorPath);
    const classification = classifyQuery(query);
    const manifests = await this.resourceStore.list();
    const tables = selectSearchTables({
      query,
      explicitTableName: tableName,
      manifests,
      fallbackTables: await db.tableNames(),
      preferredSources: classification.preferredSources,
    });
    const perTableLimit = Math.max(5, Math.min(topK, 10));
    const tableScores: Record<string, number> = {};
    const tableCandidates: { tableName: string; isPreferred: boolean; results: VectorOutput[] }[] = [];
    const embMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZW1iZWRkaW5ncw==");
    const vectorCache = createQueryVectorCache({ embedText: (query) => (embMod as any).embedText(query, signal), embedMultimodal: (query) => (embMod as any).embedMultimodalText(query, signal) });

    for (const currentTable of tables) {
      assertNotAborted(signal);
      try {
        const sampleMetadata: Record<string, unknown> | null = await (vsMod as any).getTableSampleMetadata(currentTable);
        const source = String(sampleMetadata?.source ?? "unknown");
        const isPreferred = classification.preferredSources.includes(source);
        const limit = tableName || isPreferred ? perTableLimit : Math.max(5, Math.ceil(perTableLimit / 2));
        const denseResults = await this._searchTableDense(query, limit, currentTable, vsMod as any, vectorCache);
        const hydeDenseResults = hydeQuery ? await this._searchTableDense(hydeQuery, limit, currentTable, vsMod as any, vectorCache) : undefined;
        let lexicalResults: VectorOutput[] = [];
        try {
          lexicalResults = await this.lexicalIndex.search(currentTable, query, limit);
        } catch (error) {
          if (!(error instanceof LexicalIndexUnavailableError)) throw error;
        }
        const results = hybridSearch({ denseResults, hydeDenseResults, lexicalResults, limit }).map((result) => ({
          ...result,
          metadata: { ...result.metadata, source: String(result.metadata.source ?? source), tableName: currentTable },
        }));
        tableScores[currentTable] = results[0]?.score ?? 0;
        tableCandidates.push({ tableName: currentTable, isPreferred, results });
      } catch (error) {
        throw toRagError(error, "RAG_SEARCH_FAILED");
      }
    }

    tableCandidates.sort((left, right) => Number(right.isPreferred) - Number(left.isPreferred));
    const allResults = mergeRoundRobinCandidates(tableCandidates.map((item) => item.results), 20);
    const selectedTable = allResults[0] ? String(allResults[0].metadata.tableName) : null;
    return { searchedTables: tables, selectedTable, tableScores, results: allResults.slice(0, 8), allResults };
  }

  /** 在最终回答前收敛候选；没有候选或精排判定无可用候选时只执行一次 HyDE 重试。 */
  private async _prepareAnswerResults(
    question: string,
    topK: number,
    tableName?: string,
    initialResults?: VectorOutput[],
    focusedPdfFileName?: string,
    focusedResourceId?: string,
    rerankPolicy: RerankPolicy | undefined = this.defaultRerankPolicy,
    signal?: AbortSignal,
    warnings: string[] = [],
  ): Promise<VectorOutput[]> {
    return this.withStorage(() => this._prepareAnswerResultsWithinStorage(question, topK, tableName, initialResults, focusedPdfFileName, focusedResourceId, rerankPolicy, signal, warnings));
  }

  /** 在已冻结的向量存储上下文中执行候选收敛。 */
  private async _prepareAnswerResultsWithinStorage(
    question: string,
    topK: number,
    tableName?: string,
    initialResults?: VectorOutput[],
    focusedPdfFileName?: string,
    focusedResourceId?: string,
    rerankPolicy: RerankPolicy | undefined = this.defaultRerankPolicy,
    signal?: AbortSignal,
    warnings: string[] = [],
  ): Promise<VectorOutput[]> {
    assertNotAborted(signal);
    const requiresVisionQuery = classifyQuery(question).requiresVision;
    const initialCandidates = initialResults ?? (await this._searchAcrossTables(question, topK, tableName, undefined, signal)).allResults;
    const exactPages = await this._getRequestedPdfPages(question, tableName, focusedPdfFileName, focusedResourceId);
    const requiresVision = requiresVisionQuery;
    const highlightedPages = exactPages;
    const firstCandidates = mergeVisionLocatedCandidates(initialCandidates, highlightedPages);
    const locatedIds = new Set(highlightedPages.map((page) => page.id));
    const firstPass = await rerankCandidates(
      question,
      firstCandidates,
      requiresVision ? await this._collectRerankVisionImages(firstCandidates, 5, locatedIds, signal) : [],
      requiresVision && highlightedPages.length > 0,
      rerankPolicy,
      this.rerankRuntime,
      signal,
    );
    warnings.push(...firstPass.outcome.warnings);
    if (firstCandidates.length > 0 && (!firstPass.completed || firstPass.hasUsableResults)) {
      return firstPass.results.slice(0, 8);
    }

    if (initialCandidates.length === 0) return [];
    const hydeQuery = await generateHydeQuery(question, requiresVisionQuery, signal);
    if (!hydeQuery) return firstPass.results.slice(0, 8);
    const retriedCandidates = (await this._searchAcrossTables(question, topK, tableName, hydeQuery, signal)).allResults;
    const retryCandidates = mergeVisionLocatedCandidates(retriedCandidates, highlightedPages);
    const retryPass = await rerankCandidates(
      question,
      retryCandidates,
      requiresVision ? await this._collectRerankVisionImages(retryCandidates, 5, locatedIds, signal) : [],
      requiresVision && highlightedPages.length > 0,
      rerankPolicy,
      this.rerankRuntime,
      signal,
    );
    warnings.push(...retryPass.outcome.warnings);
    return retryPass.results.slice(0, 8);
  }

  /** 只保留能回查当前 Workspace manifest 的证据；全部无效时返回空集触发拒答。 */
  private async _validateEvidenceResults(results: VectorOutput[], warnings: string[]): Promise<VectorOutput[]> {
    const manifests = await this.resourceStore.list();
    if (manifests.length === 0) {
      if (results.length > 0) warnings.push("evidence_manifest_unavailable");
      return [];
    }
    const valid = validateRagEvidenceResults(results, manifests);
    if (valid.length !== results.length) warnings.push("invalid_evidence_removed");
    if (results.length > 0 && valid.length === 0) warnings.push("insufficient_private_evidence");
    return valid;
  }

  /** 从持久关键词索引读取候选 PDF 页面，并可按会话继承的文件名收窄范围。 */
  private async _collectPdfPageCandidates(
    tableName?: string,
    focusedPdfFileName?: string,
    focusedResourceId?: string,
  ): Promise<VectorOutput[]> {
    const vsMod = await loadVectorStore();
    const db = await (vsMod as any).initVectorStore(this.storage.vectorPath);
    const manifests = await this.resourceStore.list();
    const tableNames = selectSearchTables({ query: "", explicitTableName: tableName, manifests: manifests.filter(function pdfOnly(resource) { return resource.type === "pdf"; }), fallbackTables: await db.tableNames(), preferredSources: ["pdf"] });
    const pageCandidates: VectorOutput[] = [];

    for (const currentTable of tableNames) {
      try {
        const metadata: Record<string, unknown> | null = await (vsMod as any).getTableSampleMetadata(currentTable);
        if (!isPdfPageTableMetadata(metadata)) continue;
        const pages = await this.lexicalIndex.listRecords(currentTable);
        pageCandidates.push(...pages
          .filter((page) => page.metadata.source === "pdf"
            && hasRenderablePdfPage(page.metadata)
            && (focusedResourceId ? page.metadata.resourceId === focusedResourceId : (!focusedPdfFileName || page.metadata.fileName === focusedPdfFileName)))
          .map((page) => ({ ...page, metadata: { ...page.metadata, tableName: currentTable } }))
        );
      } catch (error) {
        if (error instanceof LexicalIndexUnavailableError) continue;
        console.error(`[pdf-vision-locator] 读取表 ${currentTable} 失败：`, error);
      }
    }

    return pageCandidates;
  }

  /** 对明确页码问题优先保留对应页，避免混合检索或相邻页摘要覆盖精确证据。 */
  private async _getRequestedPdfPages(
    question: string,
    tableName?: string,
    focusedPdfFileName?: string,
    focusedResourceId?: string,
  ): Promise<VectorOutput[]> {
    const requestedPage = getRequestedPdfPage(question);
    if (requestedPage === null) return [];

    const pageCandidates = await this._collectPdfPageCandidates(tableName, focusedPdfFileName, focusedResourceId);
    if (requestedPage !== "last") {
      return pageCandidates.filter((page) => Number(page.metadata.pageNumber) === requestedPage);
    }

    const lastPages = new Map<string, VectorOutput>();
    for (const page of pageCandidates) {
      const fileName = String(page.metadata.fileName ?? page.id);
      const existing = lastPages.get(fileName);
      if (!existing || Number(page.metadata.pageNumber) > Number(existing.metadata.pageNumber)) {
        lastPages.set(fileName, page);
      }
    }
    return [...lastPages.values()];
  }

  /** 优先从 Workspace 原始 PDF 按需渲染候选页，旧页图只保留只读兼容。 */
  private async _collectRerankVisionImages(
    results: VectorOutput[],
    maxImageCount: number,
    priorityCandidateIds: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<RerankVisionImage[]> {
    const self = this;
    return collectRerankVisionImages(results, maxImageCount, priorityCandidateIds, this.storage.sourcePath, async function render(candidate) {
      const resourceId = candidate.metadata.resourceId;
      const pageNumber = Number(candidate.metadata.pageNumber);
      if (typeof resourceId !== "string" || !Number.isInteger(pageNumber) || pageNumber < 1) return undefined;
      const image = candidate.metadata.source === "image" ? await self.getResourcePreview(resourceId, signal) : await self.getPdfPageImage(resourceId, pageNumber, signal);
      return `data:${image.mimeType};base64,${image.buffer.toString("base64")}`;
    }, signal);
  }

  /** 智能问答 — 语义搜索 + LLM 后处理分析（支持历史对话上下文） */
  async ask(question: string, topK = 5, tableName?: string, history?: import("./types").ChatMessage[]): Promise<{ answer: string; sources: VectorOutput[] }> {
    // 1. 混合召回 → 多表候选池 → Rerank → 必要时单次 HyDE 重试
    const results = await this._prepareAnswerResults(question, topK, tableName);

    if (results.length === 0) {
      return { answer: "未找到匹配的数据，请尝试换一种描述。", sources: [] };
    }

    // 2. 格式化搜索结果数据供 LLM 分析
    const formattedData = results
      .map((r, i) => {
        const fields = Object.entries(r.metadata)
          .filter(([k]) => !isInternalMetaKey(k, String(r.metadata?.source || ""), false))
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        return `[记录${i + 1}][来源: ${String(r.metadata.source ?? "unknown")}][表: ${String(r.metadata.tableName ?? "unknown")}] ${fields}\n内容: ${getAnswerEvidenceText(r)}`;
      })
      .join("\n");

    // 3. 提取数据字段名（供 LLM 理解数据结构）
    const fieldNames = Array.from(
      new Set(
        results.flatMap((r) =>
          Object.keys(r.metadata).filter(
            (k) => !isInternalMetaKey(k, String(r.metadata?.source || ""), false)
          )
        )
      )
    );

    // 4. 构建 prompt（根据数据源类型自动选择输出风格）
    const outputStyle = detectOutputStyle(results);
    const systemPrompt = buildSystemPrompt(fieldNames, outputStyle);

    const imageLimit = getVisionImageLimit(question, history, topK, results);
    const visionImages = await collectVisionImages(results, imageLimit, this.storage.sourcePath);
    const imageNotice = visionImages.notice ? `\n\n${visionImages.notice}` : "";
    const userMessage = `用户问题：${question}\n\n搜索结果数据（共${results.length}条）：\n${formattedData}${imageNotice}`;

    // 5. 调用 LLM 分析
    try {
      const llmMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvbGxt");
      const answer: string = await (llmMod as any).askLLMWithImages(
        systemPrompt,
        userMessage,
        visionImages.dataUrls,
        undefined,
        history
      );
      return { answer, sources: cleanSources(results) };
    } catch (err) {
      // LLM 不可用时降级为纯搜索结果展示
      const fields = Object.entries(results[0].metadata)
        .filter(([k]) => !isInternalMetaKey(k, String(results[0].metadata?.source || ""), false))
        .map(([k]) => k)
        .join("、");
      return {
        answer: `⚠️ LLM 分析不可用（${err instanceof Error ? err.message : "未知错误"}），以下为原始搜索结果（共${results.length}条，字段：${fields}）：`,
        sources: cleanSources(results),
      };
    }
  }

  /**
   * 流式智能问答 — 语义搜索 + LLM 流式输出，直接返回 SSE Response
   *
   * ═══════════════════════════════════════════════════════════════
   * 流式输出原理（三次对话总结）
   * ═══════════════════════════════════════════════════════════════
   *
   * 【问题】"Content-Type: text/event-stream 是不是触发流式的核心？"
   *
   * 【答案】不是。流式是三个东西配合的结果：
   *
   *   ① ReadableStream       ← 可逐块写入数据的"管道"
   *      没有它，HTTP 响应只能一次性全部准备好再返回。
   *      有了它，就可以边生成边发。
   *
   *   ② controller.enqueue()  ← 往管道里不断塞数据块
   *      真正的流式驱动力。每调用一次，数据立刻推送到浏览器。
   *      LLM 每吐一个 token → for await 收到 → enqueue 塞进管道 → 浏览器收到。
   *      数据是逐块推送的，不是攒齐再发。
   *
   *   ③ text/event-stream     ← 告诉浏览器"这是流式响应"
   *      作用：
   *      - 告诉浏览器：数据会分多批到达，不要等全部收完再交给 JS
   *      - 告诉 DevTools：在 Network 面板显示流式时间线
   *      - 没有它，浏览器会把流式数据缓冲起来，等全部收完再一次性交给 fetch
   *      但它本身不是流式的原因——ReadableStream + enqueue 才是核心。
   *
   * 【F12 看到的瀑布流线】-- 位置：Network -> 请求 -> EventStream
   *   data: {"token":"根据"}  ← 第一批（毫秒级）
   *   data: {"token":"搜索"}  ← 第二批
   *   ...
   *   data: [DONE]            ← 结束
   *   每一条竖线就是一次 enqueue() 调用。
   *
   * ═══════════════════════════════════════════════════════════════
   *
   * 调用方（API route）只需 `return agent.askStream(...)` 即可。
   *
   * added by clayw on 20260709
   */
  askStream(
    question: string,
    topK = 5,
    tableName?: string,
    history?: import("./types").ChatMessage[],
    options: AskStreamOptions = {}
  ): Response {
    const includeSources = options.includeSources ?? true;
    const includeProcess = options.includeProcess ?? false;
    const self = this; // 捕获 this 供 ReadableStream 回调使用（内部 async start 的 this 指向 ReadableStream，不是 AgentFlow）

    // TextEncoder：将 JS 字符串编码为 Uint8Array（浏览器/Node 原生 API）
    // 因为 ReadableStream 只能传 Uint8Array，不能直接传字符串
    const encoder = new TextEncoder();

    // ═══ 核心 ①：ReadableStream ═══
    // 创建一个可逐块写入的"管道"。浏览器 fetch 会从这个管道逐块读取数据。
    // 没有 ReadableStream → 必须等所有数据都准备好才能返回 Response
    // 有 ReadableStream → 边生成边塞数据，浏览器端边收边展示
    const readable = new ReadableStream({
      // start() 在管道创建后立即执行，内部可以多次调用 controller.enqueue()
      // async 允许内部使用 await，这样就可以等 LLM 流式返回
      async start(controller) {
        // enqueue：将字符串编码后塞入管道（底层）
        // 格式化为 SSE 协议：每条数据以 "data: " 开头，以 "\n\n" 结尾
        const enqueue = (data: string) => {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        };
        // jsonEnq：将对象 JSON 序列化后调用 enqueue（上层封装）
        const jsonEnq = (obj: Record<string, unknown>) => {
          enqueue(JSON.stringify(obj));
        };

        try {
          // 1. 混合检索和精排（同步等待，非流式）
          if (includeProcess) jsonEnq({ process: { stage: "search", message: "正在检索知识库" } });
          const results = await self._prepareAnswerResults(
            question,
            topK,
            tableName,
            options.searchResults,
            options.focusedPdfFileName
          );

          if (results.length === 0) {
            // 没有结果 → 直接发一条消息，然后关闭管道
            jsonEnq({ token: "未找到匹配的数据，请尝试换一种描述。" });
            if (includeSources) jsonEnq({ sources: [] });
            enqueue("[DONE]"); // SSE 结束标记
            controller.close(); // 关闭管道，告诉浏览器"发完了"
            return;
          }

          // 2. 格式化搜索结果数据（组装给 LLM 的上下文）
          // LLM 需要看到搜索结果才能回答问题
          const formattedData = results
            .map((r, i) => {
              const fields = Object.entries(r.metadata)
                .filter(([k]) => !isInternalMetaKey(k, String(r.metadata?.source || ""), false))
                .map(([k, v]) => `${k}: ${v}`)
                .join(", ");
              return `[记录${i + 1}][来源: ${String(r.metadata.source ?? "unknown")}][表: ${String(r.metadata.tableName ?? "unknown")}] ${fields}\n内容: ${getAnswerEvidenceText(r)}`;
            })
            .join("\n");

          if (includeProcess) jsonEnq({ process: { stage: "context", message: "正在整理命中内容" } });

          const fieldNames = Array.from(
            new Set(
              results.flatMap((r) =>
                Object.keys(r.metadata).filter(
                  (k) => !isInternalMetaKey(k, String(r.metadata?.source || ""), false)
                )
              )
            )
          );

          // 3. 构建 prompt（根据数据源类型自动选择输出风格）
          // systemPrompt 告诉 LLM 它的角色和输出规范
          const outputStyle = detectOutputStyle(results);
          const systemPrompt = buildSystemPrompt(fieldNames, outputStyle);

          // userMessage 将搜索结果拼成文本喂给 LLM
          const imageLimit = getVisionImageLimit(question, history, topK, results);
          const visionImages = await collectVisionImages(results, imageLimit, self.storage.sourcePath);
          const imageNotice = visionImages.notice ? `\n\n${visionImages.notice}` : "";
          const userMessage = `用户问题：${question}\n\n搜索结果数据（共${results.length}条）：\n${formattedData}${imageNotice}`;

          // ═══ 核心 ②：LLM 流式调用 + controller.enqueue() ═══
          // askLLMStream 返回 AsyncGenerator，每次 yield 一个 token
          // for await 逐个接收 token，每收到一个就 enqueue 一次
          // 这样就实现了"LLM 每吐一个字 → 立刻推送到浏览器"
          try {
            if (includeProcess) jsonEnq({ process: { stage: "generate", message: "正在生成回答" } });
            const llmMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvbGxt");
            const stream: AsyncGenerator<string> = (llmMod as any).askLLMStreamWithImages(
              systemPrompt,
              userMessage,
              visionImages.dataUrls,
              undefined,
              history
            );
            for await (const token of stream) {
              // ═══ 核心 ③：enqueue 调用 ═══
              // 每次执行到这里，数据就立刻被推送到浏览器
              // F12 Network 面板看到的一条条 data: {...} 就是这里产生的
              jsonEnq({ token });
            }
            // LLM 流结束后，将搜索结果也推送给前端（用于展示来源）
            // 清理内部索引字段，只暴露用户可见字段
            if (includeSources) jsonEnq({ sources: cleanSources(results) });
          } catch {
            // LLM 不可用时的降级处理
            const fields = Object.entries(results[0].metadata)
              .filter(([k]) => !isInternalMetaKey(k, String(results[0].metadata?.source || ""), false))
              .map(([k]) => k)
              .join("、");
            jsonEnq({ token: `⚠️ LLM 分析不可用，以下为原始搜索结果（共${results.length}条，字段：${fields}）：` });
            if (includeSources) jsonEnq({ sources: cleanSources(results) });
          }

          // 发送 SSE 结束标记 + 关闭管道
          enqueue("[DONE]");
          controller.close();
        } catch (err) {
          const error = toRagError(err, "RAG_ANSWER_FAILED");
          jsonEnq({ error: error.message, code: error.code });
          controller.close();
        }
      },
    });

    // ═══ 核心 ③：Response + Content-Type: text/event-stream ═══
    // 将 ReadableStream 包装成 Response 返回
    // Content-Type: text/event-stream 告诉浏览器：
    //   "这个响应是流式的，数据会分多批到达，不要缓冲"
    // 没有这个 header → 浏览器会缓冲所有数据，等全部收完再一次性交给 JS
    // 有这个 header → 浏览器逐块交给 JS，fetch 的 reader.read() 每次读到一小块
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  /** 统一执行入口（供壳层 useRAG 调用） */
  async execute(prompt: string): Promise<string> {
    return `处理结果: ${prompt}`;
  }
}

// ═══════════════════════════════════════════════════
//  结果清理 + 输出风格自动检测
// ═══════════════════════════════════════════════════

/** 按每张表的内部名次轮询合并候选，并以归一化全文精确去重。 */
function mergeRoundRobinCandidates(tableResults: VectorOutput[][], limit: number): VectorOutput[] {
  const merged: VectorOutput[] = [];
  const seenTexts = new Set<string>();
  const maxLength = Math.max(0, ...tableResults.map((results) => results.length));
  for (let rank = 0; rank < maxLength && merged.length < limit; rank++) {
    for (const results of tableResults) {
      const candidate = results[rank];
      if (!candidate) continue;
      const normalizedText = candidate.text.replace(/\s+/g, " ").trim().toLowerCase();
      if (!normalizedText || seenTexts.has(normalizedText)) continue;
      seenTexts.add(normalizedText);
      merged.push(candidate);
      if (merged.length >= limit) break;
    }
  }
  return merged;
}

/** 将视觉定位页置于候选池前部，并按记录 ID 去重以保留文本召回结果。 */
function mergeVisionLocatedCandidates(
  initialCandidates: VectorOutput[],
  locatedPages: VectorOutput[]
): VectorOutput[] {
  const merged: VectorOutput[] = [];
  const seenIds = new Set<string>();
  for (const candidate of [...locatedPages, ...initialCandidates]) {
    if (!candidate.id || seenIds.has(candidate.id)) continue;
    seenIds.add(candidate.id);
    merged.push(candidate);
  }
  return merged;
}

/** 判断 PDF 页是否含有足以支撑文本检索的原始可提取文字。 */
function hasUsablePdfPageText(page: VectorOutput): boolean {
  if (page.metadata.source !== "pdf") return true;
  return page.metadata.hasText === true && page.metadata.modality !== "ocr";
}

/** 提取最终回答可引用的原始页内容，防止相邻页召回摘要造成来源页和答案不一致。 */
function getAnswerEvidenceText(candidate: VectorOutput): string {
  if (candidate.metadata.source !== "pdf") return candidate.text;
  const fileName = String(candidate.metadata.fileName ?? "未知文件");
  const pageNumber = String(candidate.metadata.pageNumber ?? "未知页");
  const title = String(candidate.metadata.title ?? "");
  const pageText = String(candidate.metadata.pageText ?? "").trim();
  return `文件：${fileName}\n页码：${pageNumber}\n标题：${title}\n\n${pageText}`;
}

/** 判断 metadata 字段是否属于内部索引字段 */
function isInternalMetaKey(key: string, source: string, forSources: boolean): boolean {
  if (source === "pdf" || source === "image") {
    const internalKeys = [
      "source",
      "rowIndex",
      "chunkIndex",
      "pageChunkIndex",
      "totalChunks",
      "sectionIndex",
      "pdfId",
      "totalPages",
      "imageHash",
      "imagePath",
      "imageFileName",
      "storedPdfFileName",
      "embeddingModel",
      "embeddingProvider",
      "embeddingDimension",
      "hasText",
      "hasImage",
    ];
    if (forSources) return [...internalKeys, "pageText"].includes(key);
    return internalKeys.includes(key);
  }
  if (forSources) {
    return ["source", "fileName", "rowIndex", "rowIndexes", "chunkIndex", "pageChunkIndex", "totalChunks", "title", "sectionIndex"].includes(key);
  }
  return ["source", "fileName", "rowIndex", "rowIndexes", "chunkIndex", "pageChunkIndex", "totalChunks", "title", "sectionIndex"].includes(key);
}

/** 判断目标表是否为 PDF 页级融合向量表 */
function isPdfPageTableMetadata(metadata: Record<string, unknown> | null): boolean {
  if (!metadata) return false;
  return metadata.source === "pdf"
    && (
      metadata.modality === "fused-page"
      || metadata.embeddingDimension === 1152
    );
}

/**
 * 从用户问题中提取明确指定的 PDF 页码。
 *
 * @param question 用户问题
 * @returns 指定页码、"last" 或 null（未指定）
 */
function getRequestedPdfPage(question: string): number | "last" | null {
  if (/(最后一页|末页)/.test(question)) return "last";
  const match = question.match(/第\s*(\d+)\s*页/);
  if (!match) return null;
  const pageNumber = Number(match[1]);
  return Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

/** 从页文本中提取一个短标题，提取不到时使用文件名兜底 */
function getPdfPageTitle(pageText: string, fallbackTitle: string): string {
  const heading = pageText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => Boolean(line) && line.length <= 80);
  return heading || fallbackTitle;
}

/** 从搜索结果中移除内部索引字段，只保留用户可见数据 */
function cleanSources(results: any[]): any[] {
  return results.map((r) => {
    const cleaned: Record<string, unknown> = {};
    const source = String(r.metadata?.source || "");
    for (const [k, v] of Object.entries(r.metadata ?? {})) {
      if (!isInternalMetaKey(k, source, true)) cleaned[k] = v;
    }
    return { ...r, metadata: cleaned };
  });
}

/** 清理 Agent Tool 的证据结果，保留页文本与 opaque visualEvidenceRef 但移除存储字段。 */
function cleanResults(results: VectorOutput[]): VectorOutput[] {
  return results.map(function clean(result) {
    const source = String(result.metadata?.source ?? "");
    const metadata = Object.fromEntries(Object.entries(result.metadata ?? {}).filter(function publicField(entry) {
      return !isInternalMetaKey(entry[0], source, false);
    }));
    return { ...result, metadata };
  });
}

/**
 * 根据追问意图决定本轮允许发送给视觉模型的 PDF 图片数量。
 *
 * 默认仅发送最高相关的 1 张页面图；只有存在历史对话且用户明确要求查看更多或对比页面时，
 * 才放宽至本轮已检索到的 topK 范围，避免普通问答意外增加视觉调用成本。
 *
 * @param question 当前用户问题
 * @param history 历史对话
 * @param topK 本轮检索上限
 * @returns 本轮可发送的页面图片数量
 */
function getVisionImageLimit(
  question: string,
  history: import("./types").ChatMessage[] | undefined,
  topK: number,
  results: VectorOutput[]
): number {
  const requiresVision = classifyQuery(question).requiresVision
    || results.some((result) => !hasUsablePdfPageText(result));
  if (!requiresVision) return 0;
  const requestsMorePages = /(更多(?:页|页面|图片)|其他(?:页|页面|图片)|全部图片|对比(?:页|页面|图片)?|再看)/.test(question);
  return history?.length && requestsMorePages ? Math.max(1, topK) : 1;
}

/**
 * 从检索结果中读取受控 PDF 页面图，供视觉模型理解图片内容。
 *
 * 图片必须由 file-storage 模块校验位于 RAG_FILE_STORAGE_PATH 内、类型受支持且体积合规；
 * 读取失败时保留文本问答降级，不向模型暴露本地绝对路径。
 *
 * @param results 已按相关度排序的检索结果
 * @param maxImageCount 本轮允许发送的图片数量
 * @returns 视觉图片 data URL 与可供模型理解的降级说明
 */
async function collectVisionImages(
  results: VectorOutput[],
  maxImageCount: number,
  storagePath: string,
): Promise<{ dataUrls: string[]; notice: string }> {
  const candidates = results.filter((result) => (
    result.metadata?.source === "pdf"
    && Boolean(getPdfImageFileName(result.metadata))
  )).slice(0, maxImageCount);

  if (candidates.length === 0) {
    return { dataUrls: [], notice: "" };
  }

  const storageMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZmlsZS1zdG9yYWdl");
  const dataUrls: string[] = [];
  let readFailed = false;
  for (const candidate of candidates) {
    try {
      const imageFileName = getPdfImageFileName(candidate.metadata);
      if (!imageFileName) continue;
      dataUrls.push(await (storageMod as any).readStoredImageByNameAsDataUrl(imageFileName, storagePath));
    } catch {
      readFailed = true;
    }
  }

  if (dataUrls.length === 0 && readFailed) {
    return {
      dataUrls,
      notice: "命中的 PDF 来源图片当前不可读取；请仅依据给定页文本回答，不要推断图片中看不到的内容。",
    };
  }
  return { dataUrls, notice: "" };
}

/** 读取最多五张候选页图，并保留候选 ID 与图片之间的明确对应关系供视觉精排使用。 */
async function collectRerankVisionImages(
  results: VectorOutput[],
  maxImageCount: number,
  priorityCandidateIds: ReadonlySet<string> = new Set(),
  storagePath?: string,
  renderStoredPdfPage?: (candidate: VectorOutput) => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<RerankVisionImage[]> {
  const candidates = results.filter((result) => (
    (result.metadata?.source === "image" || (result.metadata?.source === "pdf" && hasRenderablePdfPage(result.metadata)))
  ));
  if (candidates.length === 0) return [];

  // 视觉定位命中的页必须优先保留，剩余位置再照顾弱文本页，避免两次筛选后又丢失定位结果。
  const priorityCandidates = candidates.filter((candidate) => priorityCandidateIds.has(candidate.id));
  const remainingCandidates = candidates.filter((candidate) => !priorityCandidateIds.has(candidate.id));
  const sparseCandidates = remainingCandidates.filter(function needsVisualSupport(candidate) {
    return candidate.metadata.modality === "ocr" || candidate.metadata.modality === "fused" || candidate.metadata.hasText === false;
  });
  const sparseIds = new Set(sparseCandidates.map((candidate) => candidate.id));
  const remainingLimit = Math.max(0, maxImageCount - priorityCandidates.length);
  const sparseLimit = Math.min(sparseCandidates.length, Math.floor(remainingLimit / 2));
  const selectedCandidates = [
    ...priorityCandidates.slice(0, maxImageCount),
    ...remainingCandidates.filter((candidate) => !sparseIds.has(candidate.id)).slice(0, remainingLimit - sparseLimit),
    ...sparseCandidates.slice(0, sparseLimit),
  ];

  const storageMod = await loadInternalModule("Li9pbnRlcm5hbC9saWIvZmlsZS1zdG9yYWdl");
  const images: RerankVisionImage[] = [];
  for (const candidate of selectedCandidates) {
    try {
      assertNotAborted(signal);
      const rendered = await renderStoredPdfPage?.(candidate);
      if (rendered) {
        images.push({ candidateId: candidate.id, dataUrl: rendered });
        continue;
      }
      const imageFileName = getPdfImageFileName(candidate.metadata);
      if (!imageFileName) continue;
      images.push({
        candidateId: candidate.id,
        dataUrl: await (storageMod as any).readStoredImageByNameAsDataUrl(imageFileName, storagePath),
      });
    } catch {
      console.error("[rerank] 候选页图不可用");
    }
  }
  return images;
}

/** 判断 PDF 候选是否可由新原始文件链或旧页图链生成视觉输入。 */
function hasRenderablePdfPage(metadata: Record<string, unknown>): boolean {
  const pageNumber = Number(metadata.pageNumber);
  return Boolean(getPdfImageFileName(metadata))
    || (typeof metadata.resourceId === "string" && typeof metadata.storedPdfFileName === "string" && Number.isInteger(pageNumber) && pageNumber > 0);
}

/**
 * 获取 PDF 页图片的持久化文件名。
 *
 * 新记录不写永久页图；旧记录只将 imageFileName 或历史 imagePath 的基础文件名用于兼容读取，
 * 绝不使用或向外暴露旧绝对路径。新记录由 resourceId + pageNumber 按需渲染。
 *
 * @param metadata PDF 页 metadata
 * @returns 图片基础文件名；缺失时返回空字符串
 */
function getPdfImageFileName(metadata: Record<string, unknown>): string {
  const imageFileName = metadata.imageFileName;
  if (typeof imageFileName === "string" && imageFileName) return imageFileName;

  const legacyImagePath = metadata.imagePath;
  if (typeof legacyImagePath !== "string" || !legacyImagePath) return "";
  return path.basename(legacyImagePath);
}

/** 输出风格 */
type OutputStyle = "table" | "markdown";

/**
 * 根据搜索结果的 metadata.source 自动判定输出风格
 * - excel → "table"（结构化列数据，markdown 表格展示）
 * - text / docx / md → "markdown"（文档内容，自然 markdown 散文）
 */
function detectOutputStyle(results: any[]): OutputStyle {
  const source = results[0]?.metadata?.source as string | undefined;
  if (source === "excel") return "table";
  return "markdown";
}

/**
 * 根据输出风格构建系统提示词
 * - "table"：注入表格规则 + 示例，适合 Excel 结构化数据
 * - "markdown"：注入文档结构规则，适合文本文档
 */
function buildSystemPrompt(fieldNames: string[], style: OutputStyle): string {
  const base = `你是一个数据分析助手。请根据搜索结果数据，回答用户的问题。
当前数据包含的字段：${fieldNames.join("、")}。
规则：
1. 如果用户的问题是条件查询，请筛选出符合条件的数据记录并列出。
2. 如果用户问的是排序/聚合，请找出对应的记录并说明原因。
3. 先直接给出结论；默认使用简洁中文，避免复述问题、重复解释和无必要的铺垫。
4. 简单问题控制在 1 至 3 个短段或要点内；只有用户明确要求“详细/展开/对比”时才扩展说明。
5. 如果搜索结果中没有符合条件的数据，请如实说明。
6. 不要编造不存在的数据。
7. 如果消息中提供了 PDF 页面图片，必须结合图片和页文本回答；图片文字看不清时明确说明，不得伪造图片内容。
8. 搜索结果可能来自多个数据源（Excel、文本文档、PDF），每条均标注来源和表名；按问题选择相关来源并忽略明显无关的候选。
9. 若某一来源没有所需信息，只能说明“在该来源中未找到”，不能据此断言所有数据都没有。`;

  if (style === "table") {
    return `${base}
10. 【重要】只有需要比较多条结构化记录时才使用 Markdown 表格；单条或少量结果用一句话或列表即可。表格示例：
| 姓名 | 年龄 | 工资 | 部门 |
|------|------|------|------|
| 张三 | 28 | 12000 | 技术部 |
| 李四 | 32 | 8500 | 市场部 |`;
  }

  // markdown 风格：文档结构输出
  return `${base}
10. 使用简洁 Markdown：简单回答不要加标题；多个要点才使用列表；确有多个主题时再用标题。不要使用表格格式。`;
}

// ═══════════════════════════════════════════════════
//  文本入库辅助：按标题切分（用于 docx/md/txt 提取段落标题）
// ═══════════════════════════════════════════════════

/** 判断一行是否为独立标题（短行、无标点） */
function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^《[^》]+》$/.test(trimmed)) return true;
  if (trimmed.length > 20) return false;
  if (/[。，；：！？、.,;:!?]/.test(trimmed)) return false;
  return true;
}

/** 按标题把文本切分成多个 section */
function splitIntoSections(text: string): { title: string; content: string }[] {
  const lines = text.split("\n");
  const sections: { title: string; content: string }[] = [];
  let current = { title: "", content: "" };

  function flush() {
    const contentTrim = current.content.trim();
    if (current.title || contentTrim) {
      sections.push({ title: current.title.trim(), content: contentTrim });
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { current.content += "\n"; continue; }

    if (isHeadingLine(trimmed)) {
      if (!current.title && !current.content.trim()) {
        current.title = trimmed;
      } else {
        flush();
        current = { title: trimmed, content: "" };
      }
    } else {
      current.content += line + "\n";
    }
  }
  flush();

  if (sections.length === 0) sections.push({ title: "", content: text.trim() });
  return sections;
}

/**
 * 文件大小格式化 — 字节数转可读字符串
 *
 * @param bytes 字节数
 * @returns 可读的文件大小（如 "1.5 KB"、"3.2 MB"）
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 私有回答采用保守证据门：明确低精排分数拒绝，否则须有可读正文词项或匹配的图片名称。 */
export function hasSufficientPrivateEvidence(query: string, candidate: VectorOutput): boolean {
  const text = candidate.metadata.source === "pdf" ? String(candidate.metadata.pageText ?? "") : candidate.text;
  const readable = /[\p{L}\p{N}]/u.test(text) && !text.includes("\uFFFD");
  const relevant = candidate.metadata.rerankRelevant;
  if (typeof relevant === "boolean") return relevant && (readable || candidate.metadata.hasImage === true);
  const searchable = readable ? text : candidate.metadata.source === "image" ? String(candidate.metadata.fileName ?? "") : "";
  const terms = new Set(tokenizeLexicalText(searchable).filter(function meaningful(term) { return term.length >= 2; }));
  return tokenizeLexicalText(query).some(function matches(term) { return term.length >= 2 && terms.has(term); });
}
