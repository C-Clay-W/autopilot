/**
 * RAG Stage 0 可编译契约夹具：为 Core 定向测试提供最小脱敏对象。
 */
import type { DatabaseSearchPolicy, DatabaseSearchRequest, DatabaseSearchResult, RagSourcePolicy } from "../../internal/database-search";
import type { KnowledgeResourceManifest, PdfPageMetadata, RagEvidence, TableProfile } from "../../internal/knowledge-resource-store";
import type { RerankOutcome } from "../../internal/lib/rerank";
import type { RagStorageOptions } from "../../internal/rag-storage";

const resourceId = "resource_0123456789abcdef0123456789abcdef";
const tableName = "rag_0123456789abcdef0123456789abcdef";

/** 返回不读取真实文档或数据库的最小冻结契约。 */
export function createCompiledRagStage0ContractFixture() {
  return {
    storage: { rootPath: "<stateRoot>/rag" } satisfies RagStorageOptions,
    resource: { schemaVersion: 1, pipelineVersion: "rag-v2", resourceId, displayName: "通用产品手册.pdf", type: "pdf", status: "completed", tableName, recordCount: 1, pageCount: 1, storedSourceFileName: "pdf-0123456789abcdef0123456789abcdef.pdf", createdAt: 1, updatedAt: 1 } satisfies KnowledgeResourceManifest,
    pdfPage: { resourceId, pageNumber: 1, totalPages: 1, source: "pdf", modality: "text", fileName: "通用产品手册.pdf", storedPdfFileName: "pdf-0123456789abcdef0123456789abcdef.pdf", pageText: "合成证据", embeddingSpaceId: "fixture:model:4:normalized:v1", hasText: true, hasImage: false } satisfies PdfPageMetadata,
    tableProfile: { tableName, resourceId, sourceType: "pdf", embeddingProvider: "fixture", embeddingModel: "model", embeddingDimension: 4, embeddingSpaceId: "fixture:model:4:normalized:v1", lexicalIndexVersion: "lexical-v1", pipelineVersion: "rag-v2", schemaVersion: 1 } satisfies TableProfile,
    ragSourcePolicy: { focusedResourceId: resourceId, allowCloudVision: false } satisfies RagSourcePolicy,
    evidence: { evidenceId: "evidence_fixture_01", resourceId, sourceType: "pdf", text: "合成证据", pageNumber: 1, retrievalRanks: { fused: 1 } } satisfies RagEvidence,
    rerankOutcome: { status: "skipped", role: "text", model: "fixture-rerank", results: [{ evidenceId: "evidence_fixture_01", rank: 1 }], warnings: [] } satisfies RerankOutcome,
    databaseSearchPolicy: { enabled: true } satisfies DatabaseSearchPolicy,
    databaseRequest: { kind: "sql", sql: "SELECT COUNT(*) FROM fixture_items" } satisfies DatabaseSearchRequest,
    databaseResult: { kind: "sql", columns: ["total"], rows: [{ total: 2 }], involvedTables: ["fixture_items"], truncated: false, snapshotStatus: "current" } satisfies DatabaseSearchResult,
  } as const;
}

/** 返回 Stage 0 约定的合成样本标签。 */
export function createCompiledRagStage0SampleCatalog() {
  return [
    { type: "pdf", traits: ["zh", "text"] },
    { type: "pdf", traits: ["en", "text"] },
    { type: "pdf", traits: ["scan", "ocr"] },
    { type: "pdf", traits: ["image", "table"] },
    { type: "pdf", traits: ["broken"] },
    { type: "pdf", traits: ["encrypted"] },
    { type: "text", traits: ["txt", "markdown", "docx"] },
    { type: "excel", traits: ["filter", "aggregate"] },
    { type: "database", traits: ["filter", "aggregate", "join"] },
  ] as const;
}
