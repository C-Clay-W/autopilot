/**
 * RAG Stage 4 契约测试：验证持久关键词索引、资源预路由、向量复用与 RRF 热路径。
 */
import path from "node:path";
import os from "node:os";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { VectorOutput } from "../../internal/types";
import type { KnowledgeResourceManifest } from "../../internal/knowledge-resource-store";
import { createLexicalIndex, LexicalIndexUnavailableError } from "../../internal/lib/lexical-index";
import { createQueryVectorCache, resolveRetrievalEmbeddingProfile, selectSearchTables } from "../../internal/lib/retrieval-planner";
import { hybridSearch } from "../../internal/lib/hybrid-search";
import { closeVectorStore, insertVectors, withVectorStorePath } from "../../internal/lib/vector-store";

const temporaryRoots: string[] = [];

/** 创建一条不含真实业务数据的检索记录。 */
function record(id: string, text: string, resourceId = "resource_0123456789abcdef0123456789abcdef"): VectorOutput {
  return { id, text, score: 0, metadata: { resourceId, source: "text" } };
}

/** 创建用于预路由测试的安全资源 manifest。 */
function manifest(index: number, type: "pdf" | "text" | "excel", displayName: string): KnowledgeResourceManifest {
  const suffix = index.toString(16).padStart(32, "0");
  return { schemaVersion: 1, pipelineVersion: "rag-v2", resourceId: `resource_${suffix}`, displayName, type, status: "completed", tableName: `table_${index}`, recordCount: 1, createdAt: index, updatedAt: index };
}

/** 清理本测试创建的临时索引目录。 */
afterEach(async function cleanup() {
  await Promise.all(temporaryRoots.splice(0).map(function remove(root) { return rm(root, { recursive: true, force: true }); }));
});

describe("RAG Stage 4 contract", function ragStage4ContractSuite() {
  it("关键词索引支持增量写入、重启读取和资源删除", async function persistsAndDeletesLexicalRecords() {
    const root = await mkdtemp(path.join(os.tmpdir(), "rag-stage4-lexical-"));
    temporaryRoots.push(root);
    const first = createLexicalIndex(root);
    const resourceA = "resource_0123456789abcdef0123456789abcdef";
    const resourceB = "resource_fedcba9876543210fedcba9876543210";
    await first.upsert("text", [record("a", "中文检索持久索引", resourceA), record("b", "English retrieval index", resourceB)]);
    expect((await createLexicalIndex(root).search("text", "持久索引", 5)).map(function id(item) { return item.id; })).toEqual(["a"]);
    await first.removeResource("text", resourceA);
    expect(await createLexicalIndex(root).search("text", "持久索引", 5)).toEqual([]);
    expect((await createLexicalIndex(root).search("text", "retrieval", 5))[0]?.id).toBe("b");
  });

  it("损坏索引只通过显式修复回调重建", async function rebuildsCorruptedIndexExplicitly() {
    const root = await mkdtemp(path.join(os.tmpdir(), "rag-stage4-rebuild-"));
    temporaryRoots.push(root);
    const index = createLexicalIndex(root);
    await index.upsert("text", [record("a", "可恢复关键词")]);
    const fileName = (await readdir(root)).find(function indexJson(name) { return name.endsWith(".json"); });
    expect(fileName).toBeTruthy();
    await writeFile(path.join(root, fileName!), "{broken", "utf8");
    await expect(index.search("text", "可恢复", 5)).rejects.toBeInstanceOf(LexicalIndexUnavailableError);
    let loaderCalls = 0;
    await index.rebuild("text", async function loadVectorSnapshot() { loaderCalls += 1; return [record("a", "可恢复关键词")]; });
    expect(loaderCalls).toBe(1);
    expect((await index.search("text", "可恢复", 5))[0]?.id).toBe("a");
  });

  it("同一 query 在同一 embeddingSpaceId 只生成一次向量", async function reusesVectorsByEmbeddingSpace() {
    let textCalls = 0;
    let multimodalCalls = 0;
    const cache = createQueryVectorCache({
      embedText: async function embedText() { textCalls += 1; return [1, 0]; },
      embedMultimodal: async function embedMultimodal() { multimodalCalls += 1; return [0, 1]; },
    });
    const textProfile = resolveRetrievalEmbeddingProfile({ embeddingProvider: "cloud-text", embeddingSpaceId: "text:model:2:raw:v1" });
    const pdfProfile = resolveRetrievalEmbeddingProfile({ source: "pdf", embeddingProvider: "dashscope-multimodal", embeddingSpaceId: "vl:model:2:normalized:v1" });
    await Promise.all([cache.get("同一问题", textProfile), cache.get("同一问题", textProfile), cache.get("同一问题", pdfProfile)]);
    expect({ textCalls, multimodalCalls }).toEqual({ textCalls: 1, multimodalCalls: 1 });
  });

  it("同维同 Provider 但不同 embeddingSpaceId 禁止混写", async function rejectsMixedEmbeddingSpaces() {
    const root = await mkdtemp(path.join(os.tmpdir(), "rag-stage4-vector-space-"));
    temporaryRoots.push(root);
    try {
      await withVectorStorePath(root, async function writeFirstSpace() {
        await insertVectors("documents", [{ id: "a", vector: [1, 0], text: "A", metadata: { embeddingProvider: "fixture", embeddingSpaceId: "fixture:model-a:2:raw:v1" } }]);
      });
      await expect(withVectorStorePath(root, async function writeSecondSpace() {
        return insertVectors("documents", [{ id: "b", vector: [0, 1], text: "B", metadata: { embeddingProvider: "fixture", embeddingSpaceId: "fixture:model-b:2:raw:v1" } }]);
      })).rejects.toMatchObject({ code: "RAG_VECTOR_SPACE_MISMATCH" });
    } finally {
      await closeVectorStore();
    }
  });

  it("manifest 预路由有界、尊重显式表并排除数据库回退表", function routesDocumentTables() {
    const resources = Array.from({ length: 12 }, function create(_, index) { return manifest(index + 1, index === 10 ? "pdf" : "text", index === 10 ? "目标图表.pdf" : `文档-${index}.txt`); });
    const selected = selectSearchTables({ query: "目标图表", manifests: resources, fallbackTables: ["mysql_snapshot", "legacy_text"], preferredSources: ["pdf"] });
    expect(selected).toHaveLength(8);
    expect(selected[0]).toBe("table_11");
    expect(selectSearchTables({ query: "任意", explicitTableName: "trusted_table", manifests: [], fallbackTables: [], preferredSources: [] })).toEqual(["trusted_table"]);
    expect(selectSearchTables({ query: "任意", manifests: [], fallbackTables: ["mysql_snapshot", "legacy_text"], preferredSources: [] })).toEqual(["legacy_text"]);
    expect(selectSearchTables({ query: "任意", manifests: [{ ...manifest(20, "text", "失败.txt"), status: "failed" }], fallbackTables: ["legacy_text"], preferredSources: [] })).toEqual([]);
  });

  it("Dense 与关键词候选只按名次 RRF 融合", function fusesRanksWithoutRawScoreComparison() {
    const lexical = [{ ...record("lexical", "精确词"), score: 999 }];
    const dense = [{ ...record("dense", "语义词"), score: -999 }, { ...record("lexical", "精确词"), score: -1000 }];
    const results = hybridSearch({ lexicalResults: lexical, denseResults: dense, limit: 5 });
    expect(results[0].id).toBe("lexical");
    expect(results[0].score).toBeLessThan(1);
  });

  it("普通多表查询源码不再调用 LanceDB 全表正文读取", function excludesFullTableReadsFromSearchPath() {
    const source = readFileSync(path.resolve(__dirname, "../../internal/agent-flow.ts"), "utf8");
    const searchPath = source.slice(source.indexOf("private async _searchAcrossTables"), source.indexOf("private async _prepareAnswerResults"));
    expect(searchPath).not.toContain("listVectorTextRecords");
    expect(source.match(/\.listVectorTextRecords\(/g)).toHaveLength(1);
    const vectorStoreSource = readFileSync(path.resolve(__dirname, "../../internal/lib/vector-store.ts"), "utf8");
    expect(vectorStoreSource).not.toMatch(/\.nprobes\(|\.createIndex\(/);
  });
});
