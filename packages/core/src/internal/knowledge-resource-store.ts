/**
 * Workspace 级知识资源 manifest 存储。
 *
 * 每个资源使用一个原子 JSON manifest；列表只读取 manifest，不扫描向量正文。
 */
import path from "node:path";
import { mkdir, lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RagError } from "./rag-error";

/** 资源可持久化的稳定状态。 */
export type KnowledgeResourceStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled" | "deleting";

/** Workspace 内单个知识资源的安全 manifest。 */
export interface KnowledgeResourceManifest {
  schemaVersion: 1;
  pipelineVersion: "rag-v2";
  resourceId: string;
  displayName: string;
  type: "excel" | "text" | "pdf" | "image";
  status: KnowledgeResourceStatus;
  tableName: string;
  tableProfile?: TableProfile;
  recordCount: number;
  pageCount?: number;
  failedPages?: number[];
  storedSourceFileName?: string;
  createdAt: number;
  updatedAt: number;
}

/** 物理向量表与其向量空间、关键词索引之间的冻结关系。 */
export interface TableProfile {
  tableName: string;
  resourceId: string;
  sourceType: "pdf" | "text" | "excel" | "image";
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimension: number;
  embeddingSpaceId: string;
  lexicalIndexVersion: "lexical-v1";
  pipelineVersion: "rag-v2";
  schemaVersion: 1;
}

/** PDF 页级向量记录的稳定 metadata；展示名与存储名均不承担资源授权。 */
export interface PdfPageMetadata {
  resourceId: string;
  pageNumber: number;
  totalPages: number;
  source: "pdf";
  modality: "text" | "fused" | "ocr";
  fileName: string;
  storedPdfFileName: string;
  pageText: string;
  embeddingSpaceId: string;
  hasText: boolean;
  hasImage: boolean;
}

/** 进入 Agent 的文档证据契约；数据库结构化结果不得复用此形状。 */
export interface RagEvidence {
  evidenceId: string;
  resourceId: string;
  sourceType: "pdf" | "text" | "excel" | "image";
  text: string;
  /** canonical 检索的保守质量判断；缺失时 Chat 不将其当作充分证据。 */
  sufficient?: boolean;
  pageNumber?: number;
  retrievalRanks?: { dense?: number; lexical?: number; fused: number };
}

/** 生成 Workspace 内随机且不透明的资源 ID，禁止从内容或文件名反推身份。 */
export function createKnowledgeResourceId(): string {
  return `resource_${randomBytes(16).toString("hex")}`;
}

/** 仅由 Core 从资源身份与完整向量空间派生物理表名。 */
export function deriveKnowledgeTableName(resourceId: string, embeddingSpaceId: string): string {
  if (!isKnowledgeResourceId(resourceId) || !embeddingSpaceId.trim()) throw new RagError("RAG_STORAGE_INVALID");
  const digest = createHash("sha256").update(`${resourceId}\u0000${embeddingSpaceId}`).digest("hex").slice(0, 32);
  return `rag_${digest}`;
}

/** 校验浏览器可见资源 ID，禁止路径与任意文件名进入存储解析。 */
export function isKnowledgeResourceId(value: string): boolean {
  return /^resource_[a-f0-9]{32}$/.test(value);
}

/** 创建只访问指定 manifest 根目录的资源存储。 */
export function createKnowledgeResourceStore(manifestRoot: string) {
  const absoluteRoot = path.resolve(manifestRoot);

  /** 返回已校验资源的 manifest 路径。 */
  function manifestFile(resourceId: string): string {
    if (!isKnowledgeResourceId(resourceId)) throw new RagError("RAG_RESOURCE_NOT_FOUND");
    return path.join(absoluteRoot, `${resourceId}.json`);
  }

  /** 原子写入 manifest，避免中断留下半份 JSON。 */
  async function save(manifest: KnowledgeResourceManifest): Promise<void> {
    await mkdir(absoluteRoot, { recursive: true });
    const target = manifestFile(manifest.resourceId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  }

  /** 缺失 manifest 返回 undefined；损坏或链接明确报存储错误，不能伪装为空库。 */
  async function get(resourceId: string): Promise<KnowledgeResourceManifest | undefined> {
    try {
      const target = manifestFile(resourceId);
      if (!(await lstat(target)).isFile()) throw new RagError("RAG_STORAGE_INVALID");
      const manifest = JSON.parse(await readFile(target, "utf8")) as KnowledgeResourceManifest;
      if (!manifest || manifest.resourceId !== resourceId || manifest.schemaVersion !== 1 || manifest.pipelineVersion !== "rag-v2" || !["excel", "text", "pdf", "image"].includes(manifest.type) || !["queued", "running", "completed", "partial", "failed", "cancelled", "deleting"].includes(manifest.status) || !/^rag_[a-f0-9]{32}$/.test(manifest.tableName)) throw new RagError("RAG_STORAGE_INVALID");
      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) throw new RagError("RAG_STORAGE_INVALID", undefined, error);
      throw error;
    }
  }

  /** 枚举当前 Workspace manifest，不读取向量或来源正文。 */
  async function list(): Promise<KnowledgeResourceManifest[]> {
    let entries: string[];
    try {
      entries = await readdir(absoluteRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const resources = await Promise.all(entries
      .filter(function isManifest(name) { return /^resource_[a-f0-9]{32}\.json$/.test(name); })
      .map(function readManifest(name) { return get(name.slice(0, -5)); }));
    return resources
      .filter(function exists(item): item is KnowledgeResourceManifest { return Boolean(item); })
      .sort(function newestFirst(left, right) { return right.updatedAt - left.updatedAt; });
  }

  /** 删除一个 manifest；业务层必须先完成向量与来源清理。 */
  async function remove(resourceId: string): Promise<void> {
    await rm(manifestFile(resourceId), { force: true });
  }

  return { save, get, list, remove };
}
