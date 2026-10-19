/** RAG Stage 3 契约测试：manifest 原子存储、Workspace 隔离和资源 ID 防逃逸。 */
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createKnowledgeResourceStore, type KnowledgeResourceManifest } from "../../internal/knowledge-resource-store";
import { resolveRagStorage } from "../../internal/rag-storage";

const temporaryRoots: string[] = [];

/** 创建测试资源 manifest；tableName 须为 Core 派生的 rag_<32hex> 形状，list() 读取时会校验。 */
function fixture(resourceId: string, displayName: string): KnowledgeResourceManifest {
  return { schemaVersion: 1, pipelineVersion: "rag-v2", resourceId, displayName, type: "pdf", status: "completed", tableName: "rag_0123456789abcdef0123456789abcdef", recordCount: 1, pageCount: 1, storedSourceFileName: `pdf-${resourceId.slice(9)}.pdf`, createdAt: 1, updatedAt: 1 };
}

/** 清理本测试创建的临时 Workspace。 */
afterEach(async function cleanup() {
  await Promise.all(temporaryRoots.splice(0).map(function remove(root) { return rm(root, { recursive: true, force: true }); }));
});

describe("RAG Stage 3 contract", function ragStage3ContractSuite() {
  it("相同资源 ID 在两个 Workspace 中互不枚举", async function isolatesWorkspaces() {
    const rootA = await mkdtemp(path.join(os.tmpdir(), "rag-stage3-a-"));
    const rootB = await mkdtemp(path.join(os.tmpdir(), "rag-stage3-b-"));
    temporaryRoots.push(rootA, rootB);
    const id = "resource_0123456789abcdef0123456789abcdef";
    const storeA = createKnowledgeResourceStore(resolveRagStorage({ rootPath: rootA }).manifestPath);
    const storeB = createKnowledgeResourceStore(resolveRagStorage({ rootPath: rootB }).manifestPath);
    await storeA.save(fixture(id, "同名.pdf"));
    expect(await storeA.list()).toHaveLength(1);
    expect(await storeB.list()).toHaveLength(0);
  });

  it("manifest 是原子 JSON 且列表不包含物理根路径", async function writesSafeManifest() {
    const root = await mkdtemp(path.join(os.tmpdir(), "rag-stage3-manifest-"));
    temporaryRoots.push(root);
    const id = "resource_fedcba9876543210fedcba9876543210";
    const storage = resolveRagStorage({ rootPath: root });
    const store = createKnowledgeResourceStore(storage.manifestPath);
    await store.save(fixture(id, "安全.pdf"));
    const raw = await readFile(path.join(storage.manifestPath, `${id}.json`), "utf8");
    expect(JSON.parse(raw).resourceId).toBe(id);
    expect(raw).not.toContain(root);
    expect((await store.list())[0]).not.toHaveProperty("rootPath");
  });

  it("伪造 resourceId 无法逃逸 manifest 根", async function rejectsForgedResourceId() {
    const root = await mkdtemp(path.join(os.tmpdir(), "rag-stage3-id-"));
    temporaryRoots.push(root);
    const store = createKnowledgeResourceStore(root);
    await expect(store.get("../outside")).rejects.toMatchObject({ code: "RAG_RESOURCE_NOT_FOUND" });
    await expect(store.remove("resource_not-a-hash")).rejects.toMatchObject({ code: "RAG_RESOURCE_NOT_FOUND" });
  });
});
