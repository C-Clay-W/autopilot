/** Chat 宿主的只读端口：仅通过绑定 Session/Turn 的 opaque 引用访问临时附件与独立知识证据。 */
import type { ChatRetrievalMode } from "../domain/product-mode";
import type { VisionAnalyzer } from "../provider/vision-analyzer";

/** 每次端口调用都携带 Core 派生身份；Host 必须复查归属、有效期、删除态与证据批次。 */
export interface ChatCapabilityBinding {
  sessionId: string;
  turnId: string;
  retrievalMode: ChatRetrievalMode;
}

/** Host 为当前输入签发的临时附件授权，原始路径永不进入 Core。 */
export interface ChatAttachmentGrant {
  ref: string;
  /** 仅供模型识别附件的显示名，不参与授权，也不作为路径使用。 */
  displayName?: string;
  sessionId: string;
  kind: "document" | "image";
  expiresAt: number;
}

/** 通过本地证据门的候选；sufficient 必须来自受信检索链，不能来自模型或客户端。 */
export interface ChatRagEvidence {
  id: string;
  text: string;
  sufficient: boolean;
  /** 受信宿主提供的可读来源名称及可选页码，不包含路径或内部标识。 */
  sourceLabel?: string;
  /** 宿主生成的站内来源图片预览地址；展示用途，不授予模型读取权限。 */
  sourceImageUrl?: string;
  visualEvidenceRef?: string;
}

/** 只包含当前 Knowledge Space、本 Session 与本 Turn 的证据批次。 */
export interface ChatRagEvidenceBatch {
  sessionId: string;
  turnId: string;
  knowledgeSpaceId: string;
  batchId: string;
  evidence: readonly ChatRagEvidence[];
}

/** 独立 Chat Knowledge Space 的适配端口；实现须复用现有 RAG pipeline。 */
export interface ChatKnowledgeCapability {
  readonly knowledgeSpaceId: string;
  /** 复用受控检索链取得绑定当前会话与知识空间的证据批次。 */
  prepareSearch(input: ChatCapabilityBinding & { query: string; topK: number; signal?: AbortSignal }): Promise<ChatRagEvidenceBatch>;
  /** 复查资源/批次仍有效；恢复时不把历史消息中的 ref 自动当作授权。 */
  validateEvidence(input: ChatCapabilityBinding & { batch: ChatRagEvidenceBatch; signal?: AbortSignal }): Promise<boolean>;
}

/** 进程内能力集合；无文件、入库、数据库、命令或 Web 旁路。 */
export interface ChatCapability {
  readonly attachments?: readonly ChatAttachmentGrant[];
  /** 在读取前校验当前 Session 的附件或当前批次的视觉引用，撤销/过期返回 false。 */
  authorizeRef?(input: ChatCapabilityBinding & { ref: string; kind: "document" | "image"; batchId?: string; signal?: AbortSignal }): Promise<boolean>;
  /** 按文档引用读取有界解析文本和派生页图授权。 */
  readAttachment?(input: ChatCapabilityBinding & { attachmentRef: string; signal?: AbortSignal }): Promise<{ text: string; pageImages?: readonly ChatAttachmentGrant[] }>;
  /** 按图片引用返回字节与 MIME，供 Core 继续校验。 */
  readImage?(input: ChatCapabilityBinding & { ref: string; batchId?: string; signal?: AbortSignal }): Promise<{ bytes: Uint8Array; mimeType: string }>;
  readonly visionAnalyzer?: VisionAnalyzer;
  readonly knowledge?: ChatKnowledgeCapability;
}
