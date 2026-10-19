/** Chat 知识组合服务：固定应用根，复用 canonical RAG，模型端口仅获得当前批次只读授权。 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import type { ChatCapability, ChatCapabilityBinding, ChatRagEvidenceBatch, RagEvidence, RAGAgent, RAGAgentOptions } from "@autopilot-agent/core";
import { NODE_CHAT_KNOWLEDGE_SPACE_ID, NodeChatError, type NodeChatStorage } from "@autopilot-agent/adapters";
import { loadCore } from "../core-loader";
import { withKnowledgeWriteLock, ingestKnowledgeUpload, type ValidatedKnowledgeUpload } from "../knowledge-service";

/** 只返回浏览器管理所需字段，不返回表名、路径、索引配置或源正文。 */
export function toChatResourceDto(resource: Awaited<ReturnType<RAGAgent["listResources"]>>[number]) {
  return { resourceId: resource.resourceId, displayName: resource.displayName, type: resource.type, status: resource.status, recordCount: resource.recordCount, pageCount: resource.pageCount, failedPages: resource.failedPages, createdAt: resource.createdAt, updatedAt: resource.updatedAt };
}

/** 创建惰性服务；普通 Chat、联网和 Work 不会因此读取知识根或 Rerank 凭据。 */
export function createChatKnowledgeService(storage: NodeChatStorage, hostSignal: AbortSignal, env: NodeJS.ProcessEnv = process.env, loadRagOptions?: () => Omit<RAGAgentOptions, "storage">) {
  const root = storage.paths.knowledgeRoot;
  /** 仅在用户管理或 rag Turn 时初始化固定根，拒绝知识目录链接。 */
  async function agent(frozenOptions: Omit<RAGAgentOptions, "storage"> | undefined = loadRagOptions?.()): Promise<RAGAgent> {
    if (hostSignal.aborted) throw new NodeChatError("CHAT_KNOWLEDGE_UNAVAILABLE");
    await mkdir(root, { recursive: true });
    if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== path.join(await realpath(storage.paths.root), "knowledge")) throw new NodeChatError("CHAT_KNOWLEDGE_UNAVAILABLE");
    return loadCore().createRAGAgent(frozenOptions ? { ...frozenOptions, storage: { rootPath: root } } : { storage: { rootPath: root }, rerank: {
      defaultPolicy: { enabled: Boolean(env.RERANK_BASE_URL && env.RERANK_API_KEY), baseUrl: env.RERANK_BASE_URL, textModel: env.RERANK_TEXT_MODEL, visionModel: env.RERANK_VISION_MODEL },
      /** 凭据只由受信进程环境按需提供，不进入证据或 HTTP。 */
      resolveApiKey() { return env.RERANK_API_KEY; },
    } });
  }
  /** 绑定持久 Chat rag 身份，Session 删除态立即撤销模型访问。 */
  async function active(binding: ChatCapabilityBinding): Promise<boolean> {
    const session = await storage.ports.sessionStore.get(binding.sessionId);
    return !hostSignal.aborted && binding.retrievalMode === "rag" && session?.productMode === "chat" && session.chatRetrievalMode === "rag" && !storage.attachments.isSessionDeleting(binding.sessionId);
  }
  /** 每次 loader 创建独立内存授权；历史、重启及其他 Session 无法重放旧 ref。 */
  async function loadKnowledge(binding: ChatCapabilityBinding): Promise<Pick<ChatCapability, "knowledge" | "authorizeRef" | "readImage">> {
    if (!await active(binding)) throw new NodeChatError("CHAT_KNOWLEDGE_UNAVAILABLE");
    const rag = await agent();
    const retrieval = rag.getRagCapability();
    let current: ChatRagEvidenceBatch | undefined;
    let versions = new Map<string, number>();
    const images = new Map<string, string>();
    /** 每个端口只接受 loader 固定的身份和当前宿主生命周期。 */
    async function belongs(input: ChatCapabilityBinding & { signal?: AbortSignal }): Promise<boolean> {
      return !input.signal?.aborted && input.sessionId === binding.sessionId && input.turnId === binding.turnId && input.retrievalMode === "rag" && await active(binding);
    }
    /** 复查整个证据批次的资源仍有效且未被重写，失败关闭访问。 */
    async function valid(): Promise<boolean> {
      if (!current) return false;
      const resources = await rag.listResources();
      return [...versions].every(function unchanged([id, version]) { return resources.some(function same(resource) { return resource.resourceId === id && resource.updatedAt === version && ["completed", "partial"].includes(resource.status); }); });
    }
    return {
      knowledge: {
        knowledgeSpaceId: NODE_CHAT_KNOWLEDGE_SPACE_ID,
        /** 只投影 canonical 已通过质量判断的本地证据，不回传向量 metadata。 */
        async prepareSearch(input) {
          if (!await belongs(input)) throw new NodeChatError("CHAT_KNOWLEDGE_UNAVAILABLE");
          current = undefined; images.clear(); versions = new Map();
          return withKnowledgeWriteLock(root, async function searchBoundKnowledge() {
            const result = await retrieval.prepareRagSearch!(input.query, input.topK, undefined, undefined, undefined, AbortSignal.any([input.signal ?? hostSignal, hostSignal])) as { evidence?: RagEvidence[]; visualEvidenceRefs?: string[] };
            if (!await belongs(input)) throw new NodeChatError("CHAT_KNOWLEDGE_UNAVAILABLE");
            const resources = await rag.listResources();
            const evidence: ChatRagEvidenceBatch["evidence"][number][] = [];
            for (const item of result.evidence ?? []) {
              const resource = resources.find(function matches(resource) { return resource.resourceId === item.resourceId && ["completed", "partial"].includes(resource.status); });
              if (!resource || item.sufficient !== true) continue;
              const canonicalRef = item.sourceType === "image" ? `rag-resource:${item.resourceId}:image` : item.sourceType === "pdf" && item.pageNumber ? `rag-resource:${item.resourceId}:page:${item.pageNumber}` : undefined;
              const visualEvidenceRef = canonicalRef && result.visualEvidenceRefs?.includes(canonicalRef) ? randomUUID() : undefined;
              if (visualEvidenceRef && canonicalRef) images.set(visualEvidenceRef, canonicalRef);
              versions.set(resource.resourceId, resource.updatedAt);
              const sourceLabel = path.basename(resource.displayName).replace(/[\r\n\t]/g, " ").slice(0, 200) + (item.sourceType === "pdf" && item.pageNumber ? ` · 第 ${item.pageNumber} 页` : "");
              const sourceImageUrl = item.sourceType === "image" ? `/api/chat/knowledge/${resource.resourceId}/preview` : item.sourceType === "pdf" && item.pageNumber ? `/api/chat/knowledge/${resource.resourceId}/preview/pages/${item.pageNumber}` : undefined;
              evidence.push({ id: randomUUID(), text: item.text.slice(0, 4_000), sufficient: true, sourceLabel, ...(sourceImageUrl ? { sourceImageUrl } : {}), ...(visualEvidenceRef ? { visualEvidenceRef } : {}) });
              if (evidence.length === 20) break;
            }
            current = { sessionId: binding.sessionId, turnId: binding.turnId, knowledgeSpaceId: NODE_CHAT_KNOWLEDGE_SPACE_ID, batchId: randomUUID(), evidence };
            return structuredClone(current);
          });
        },
        /** 比较受控批次全部字段，不能用真实 batchId 搭配伪造正文通过校验。 */
        async validateEvidence(input) {
          return await belongs(input) && JSON.stringify(input.batch) === JSON.stringify(current) && withKnowledgeWriteLock(root, valid);
        },
      },
      /** 视觉 ref 仅来自当前检索结果，跨批次或跨会话一律拒绝。 */
      async authorizeRef(input) {
        return input.kind === "image" && await belongs(input) && input.batchId === current?.batchId && images.has(input.ref) && withKnowledgeWriteLock(root, valid);
      },
      /** 读取和删除互斥；读取后仍复查会话和取消状态。 */
      async readImage(input) {
        return withKnowledgeWriteLock(root, async function readBoundImage() {
          if (!await belongs(input) || input.batchId !== current?.batchId || !images.has(input.ref) || !await valid()) throw new NodeChatError("CHAT_KNOWLEDGE_UNAVAILABLE");
          const result = await retrieval.readVisualEvidence!(images.get(input.ref)!, AbortSignal.any([input.signal ?? hostSignal, hostSignal]));
          if (!await belongs(input)) throw new NodeChatError("CHAT_KNOWLEDGE_UNAVAILABLE");
          return { bytes: new Uint8Array(Buffer.from(result.dataUrl.split(",")[1], "base64")), mimeType: result.mimeType };
        });
      },
    };
  }
  return {
    loadKnowledge,
    /** 独立管理面显式列资源，不改变任何 Session 的检索身份。 */
    async list() { return withKnowledgeWriteLock(root, async function list() { return (await (await agent()).listResources()).map(toChatResourceDto); }); },
    /** 用户上传共用原 staging/写队列，不写临时附件域。 */
    async ingest(upload: ValidatedKnowledgeUpload, signal: AbortSignal, onProgress: (event: unknown) => void) { const frozen = loadRagOptions?.(); await agent(frozen); return ingestKnowledgeUpload(root, upload, AbortSignal.any([signal, hostSignal]), onProgress, frozen); },
    /** 用户主动删除正式资源，Session/TTL 清理不调用此入口。 */
    async remove(id: string) { return withKnowledgeWriteLock(root, async function remove() { return (await agent()).deleteResource(id); }); },
    /** 预览由 Core 按资源身份解析，模型不会得到此管理端口。 */
    async preview(id: string, signal: AbortSignal, pageNumber?: number) { return withKnowledgeWriteLock(root, async function preview() { const rag = await agent(); const combinedSignal = AbortSignal.any([signal, hostSignal]); return pageNumber === undefined ? rag.getResourcePreview(id, combinedSignal) : rag.getPdfPageImage(id, pageNumber, combinedSignal); }); },
  };
}
