/**
 * RAG Stage 0 脱敏契约夹具：冻结资源、证据、来源策略与数据库检索的最小跨层形状。
 */

/** 返回 Stage 0 使用的合成资源契约，不读取真实文档或数据库。 */
export function createRagStage0ContractFixture() {
  return {
    storage: {
      ragRoot: "<stateRoot>/rag",
      directories: ["lancedb", "files", "resources", "lexical", "cache/embeddings", "cache/rendered-pages", "ingest", "temp"],
    },
    resource: {
      schemaVersion: 1,
      resourceId: "resource_fixture_01",
      sourceType: "pdf",
      displayName: "通用产品手册.pdf",
      contentHash: "fixture-content-hash",
      pipelineVersion: "rag-pipeline-v1",
      status: "completed",
      physicalTables: ["resource_fixture_01_text"],
      storedSourceFileName: "pdf-fixture-content-hash.pdf",
      totalUnits: 2,
      succeededUnits: 2,
      failedUnits: [],
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
    },
    tableProfile: {
      tableName: "resource_fixture_01_text",
      resourceId: "resource_fixture_01",
      sourceType: "pdf",
      embeddingProvider: "fixture-provider",
      embeddingModel: "fixture-embedding-model",
      embeddingDimension: 4,
      embeddingSpaceId: "fixture-provider:fixture-embedding-model:4:normalized:v1",
      lexicalIndexVersion: "fixture-lexical-v1",
      pipelineVersion: "rag-pipeline-v1",
      schemaVersion: 1,
    },
    pdfPage: {
      resourceId: "resource_fixture_01",
      pageNumber: 1,
      totalPages: 2,
      displayName: "通用产品手册.pdf",
      storedPdfFileName: "pdf-fixture-content-hash.pdf",
      routeMode: "text",
      textSource: "pymupdf",
      pageContentHash: "fixture-page-hash",
      pipelineVersion: "rag-pipeline-v1",
      embeddingSpaceId: "fixture-provider:fixture-embedding-model:4:normalized:v1",
      hasUsableText: true,
      hasVisualEvidence: false,
    },
    ragSourcePolicy: { focusedResourceId: "resource_fixture_01", allowCloudVision: false },
    databaseSearchPolicy: { enabled: true },
    evidence: {
      evidenceId: "evidence_fixture_01",
      resourceId: "resource_fixture_01",
      sourceType: "pdf",
      text: "这是不含真实业务信息的合成证据。",
      pageNumber: 1,
      retrievalRanks: { dense: 1, lexical: 2, fused: 1 },
    },
    rerankOutcome: {
      status: "skipped",
      role: "text",
      model: "fixture-rerank-model",
      results: [{ evidenceId: "evidence_fixture_01", rank: 1 }],
      warnings: [],
    },
    databaseRequest: { kind: "sql", sql: "SELECT category, COUNT(*) AS total FROM fixture_items GROUP BY category" },
    databaseResult: {
      kind: "sql",
      columns: ["category", "total"],
      rows: [{ category: "fixture", total: 2 }],
      involvedTables: ["fixture_items"],
      truncated: false,
      snapshotStatus: "current",
    },
  } as const;
}

/** 返回 Stage 0 的合成样本目录；二进制解析样本在 Stage 2 才接入生产处理链。 */
export function createRagStage0SampleCatalog() {
  return [
    { id: "zh-text-pdf", type: "pdf", traits: ["zh", "text"] },
    { id: "en-text-pdf", type: "pdf", traits: ["en", "text"] },
    { id: "scan-pdf", type: "pdf", traits: ["scan", "ocr"] },
    { id: "mixed-table-pdf", type: "pdf", traits: ["text", "image", "table"] },
    { id: "broken-pdf", type: "pdf", traits: ["broken"] },
    { id: "encrypted-pdf", type: "pdf", traits: ["encrypted"] },
    { id: "plain-text", type: "text", traits: ["txt", "markdown", "docx"] },
    { id: "sheet", type: "excel", traits: ["filter", "aggregate"] },
    { id: "database", type: "database", traits: ["filter", "aggregate", "join"] },
  ] as const;
}
