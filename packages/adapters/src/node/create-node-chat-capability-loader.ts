/** Chat 只读能力装配：临时附件来自独立 Store，RAG 仅在绑定知识根时初始化，不扫描 Workspace。 */
import { NodeChatError, createNodeIdentityError, toNodeBoundaryError } from "./node-errors";
import type { ChatCapability, ChatCapabilityBinding, ChatKnowledgeCapability, VisionAnalyzer } from "@autopilot-agent/core";
import { ensureChatDirectory } from "./chat-state";
import type { NodeChatStorage } from "./create-node-chat-storage";

/** 固定应用级知识空间身份，实际检索仍由宿主 canonical RAG pipeline 提供。 */
export const NODE_CHAT_KNOWLEDGE_SPACE_ID = "chat-knowledge-v1";

/** 只注入受信只读解析/视觉与检索端口，模型无法提供这些对象。 */
export interface NodeChatCapabilityLoaderOptions {
  storage: NodeChatStorage;
  visionAnalyzer?: VisionAnalyzer;
  loadKnowledge?: (input: ChatCapabilityBinding & { knowledgeRoot: string; knowledgeSpaceId: string }) => Promise<Pick<ChatCapability, "knowledge" | "authorizeRef" | "readImage">>;
}

/** 返回可直接赋给 Core RunConfig.chatLoader 的函数；调用时复查持久化模式。 */
export function createNodeChatCapabilityLoader(options: NodeChatCapabilityLoaderOptions) {
  /** 只给当前模式装配所属数据域，缺失能力不触发跨域回退。 */
  return async function loadChat(binding: ChatCapabilityBinding): Promise<ChatCapability> {
    try {
      const { storage } = options;
      const session = await storage.ports.sessionStore.get(binding.sessionId);
      if (session?.productMode !== "chat" || session.chatRetrievalMode !== binding.retrievalMode) throw createNodeIdentityError("SESSION_MODE_MISMATCH");
      if (storage.attachments.isSessionDeleting(binding.sessionId)) throw new NodeChatError("CHAT_SESSION_DELETING");
      if (binding.retrievalMode === "rag") {
        if (!options.loadKnowledge) return {};
        ensureChatDirectory(storage.paths.root, storage.paths.knowledgeRoot);
        const loaded = await options.loadKnowledge({ ...binding, knowledgeRoot: storage.paths.knowledgeRoot, knowledgeSpaceId: NODE_CHAT_KNOWLEDGE_SPACE_ID });
        const knowledge: ChatKnowledgeCapability | undefined = loaded.knowledge;
        if (knowledge && knowledge.knowledgeSpaceId !== NODE_CHAT_KNOWLEDGE_SPACE_ID) throw new NodeChatError("CHAT_KNOWLEDGE_UNAVAILABLE");
        return { knowledge, authorizeRef: loaded.authorizeRef, readImage: loaded.readImage, visionAnalyzer: options.visionAnalyzer };
      }
      const attachments = await storage.attachments.list(binding.sessionId);
      return {
        /** 目录只含授权字段，实际引用仍由 Core 的冻结交集和 Store 复查约束。 */
        attachments: attachments.map(function grant(item) { return { ref: item.ref, displayName: item.displayName, sessionId: item.sessionId, kind: item.kind, expiresAt: item.expiresAt }; }),
        visionAnalyzer: options.visionAnalyzer,
        /** 调用身份必须与本次 loader 绑定一致，不能通过端口对象切换 Session。 */
        async authorizeRef(input) { return input.sessionId === binding.sessionId && input.turnId === binding.turnId && input.retrievalMode === binding.retrievalMode && storage.attachments.authorizeRef(binding.sessionId, input.ref, input.kind); },
        /** 文档解析结果仅读取本会话临时 Store。 */
        async readAttachment(input) {
          if (input.sessionId !== binding.sessionId || input.turnId !== binding.turnId || input.retrievalMode !== binding.retrievalMode) throw new NodeChatError("CHAT_ATTACHMENT_UNAVAILABLE");
          return storage.attachments.readAttachment(binding.sessionId, input.attachmentRef, input.signal);
        },
        /** 图片字节读取也独立复查身份，避免仅依赖调用前的 authorizeRef。 */
        async readImage(input) {
          if (input.sessionId !== binding.sessionId || input.turnId !== binding.turnId || input.retrievalMode !== binding.retrievalMode || !await storage.attachments.authorizeRef(binding.sessionId, input.ref, "image")) throw new NodeChatError("CHAT_ATTACHMENT_UNAVAILABLE");
          return storage.attachments.readBytes(binding.sessionId, input.ref, input.signal);
        },
      };
    } catch (error) { throw toNodeBoundaryError(error, binding.retrievalMode === "rag" ? "CHAT_KNOWLEDGE_UNAVAILABLE" : "CHAT_ATTACHMENT_UNAVAILABLE"); }
  };
}
