/**
 * RAG Stage 0 契约测试：验证脱敏夹具覆盖计划冻结的身份、终态、证据与 Tool 分工。
 */

import { describe, expect, it } from "vitest";
import { createKnowledgeResourceId, deriveKnowledgeTableName } from "../../internal/knowledge-resource-store";
import { createCompiledRagStage0ContractFixture, createCompiledRagStage0SampleCatalog } from "./rag-stage0-contract-fixtures";

describe("RAG Stage 0 contract", function ragStage0ContractSuite() {
  it("资源身份不依赖展示文件名且只使用稳定终态", function validatesResourceIdentityAndStatus() {
    const fixture = createCompiledRagStage0ContractFixture();
    expect(fixture.resource.resourceId).not.toBe(fixture.resource.displayName);
    expect(fixture.resource.storedSourceFileName).not.toContain("/");
    expect(fixture.resource.storedSourceFileName).not.toContain("\\");
    expect(["queued", "running", "completed", "partial", "failed", "cancelled", "deleting"]).toContain(fixture.resource.status);
    expect(fixture.pdfPage.resourceId).toBe(fixture.resource.resourceId);
    expect(fixture.tableProfile.embeddingSpaceId).toContain(String(fixture.tableProfile.embeddingDimension));
    const firstId = createKnowledgeResourceId();
    const secondId = createKnowledgeResourceId();
    expect(firstId).toMatch(/^resource_[a-f0-9]{32}$/);
    expect(secondId).not.toBe(firstId);
    expect(deriveKnowledgeTableName(firstId, fixture.tableProfile.embeddingSpaceId)).toMatch(/^rag_[a-f0-9]{32}$/);
  });

  it("文档证据与数据库结果保持独立契约", function separatesDocumentAndDatabaseResults() {
    const fixture = createCompiledRagStage0ContractFixture();
    expect(fixture.evidence.sourceType).toBe("pdf");
    expect(fixture.evidence.evidenceId).toBe(fixture.rerankOutcome.results[0].evidenceId);
    expect(fixture.databaseRequest.kind).toBe("sql");
    expect(fixture.databaseResult.kind).toBe("sql");
    expect(fixture.databaseResult).not.toHaveProperty("evidenceId");
    expect(fixture.databaseSearchPolicy).toEqual({ enabled: true });
  });

  it("样本目录覆盖文档、失败输入与数据库筛选聚合", function coversStage0Samples() {
    const catalog = createCompiledRagStage0SampleCatalog();
    expect(catalog.filter((item) => item.type === "pdf")).toHaveLength(6);
    expect(catalog.some((item) => (item.traits as readonly string[]).includes("broken"))).toBe(true);
    expect(catalog.some((item) => (item.traits as readonly string[]).includes("aggregate"))).toBe(true);
  });

  it("夹具使用通用文档与合成数据表", function usesSyntheticFixtureIdentifiers() {
    const fixture = createCompiledRagStage0ContractFixture();
    expect(fixture.resource.displayName).toBe("通用产品手册.pdf");
    expect(fixture.pdfPage.fileName).toBe(fixture.resource.displayName);
    expect(fixture.databaseRequest.sql).toBe("SELECT COUNT(*) FROM fixture_items");
    expect(fixture.databaseResult.involvedTables).toEqual(["fixture_items"]);
  });
});
