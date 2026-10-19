/** Session 产品身份与工具能力上限；模式来自持久化实体，权限配置只能取交集。 */
import { AgentRuntimeError } from "../protocol/error-code";

export type ProductMode = "chat" | "work";
export type ChatRetrievalMode = "none" | "web" | "rag";

/** 可持久化的非敏感权限快照；Work 缺少列表表示保留既有工具集合。 */
export interface CapabilityCeiling {
  readonly productMode: ProductMode;
  readonly chatRetrievalMode?: ChatRetrievalMode;
  readonly allowedTools?: readonly string[];
}

/** 仅此封闭集合可进入 Chat；能力是否存在还须由受信宿主进一步缩小。 */
const chatTools = {
  none: ["chat_attachment_read", "chat_vision_analyze"],
  web: ["web_search", "web_fetch", "chat_attachment_read", "chat_vision_analyze"],
  rag: ["rag_search", "chat_vision_analyze"],
} as const;

/** 验证 Session 身份；旧记录只在这个兼容读取边界按 Work 解释，不落盘迁移。 */
export function readSessionIdentity(session: { productMode?: ProductMode; chatRetrievalMode?: ChatRetrievalMode; projectId?: string }): CapabilityCeiling {
  if (session.productMode === undefined && session.chatRetrievalMode === undefined) return { productMode: "work" };
  if (session.productMode === "chat" && session.projectId === undefined && Object.prototype.hasOwnProperty.call(chatTools, session.chatRetrievalMode ?? "")) {
    const mode = session.chatRetrievalMode!;
    return { productMode: "chat", chatRetrievalMode: mode, allowedTools: [...chatTools[mode]] };
  }
  if (session.productMode === "work" && session.chatRetrievalMode === undefined && typeof session.projectId === "string" && session.projectId.trim()) return { productMode: "work" };
  throw new AgentRuntimeError("SESSION_MODE_MISMATCH", "Session 产品模式与归属不匹配");
}

/** 先检查封闭产品矩阵，再检查冻结列表；未知 Chat 工具始终默认拒绝。 */
export function isToolWithinCeiling(ceiling: CapabilityCeiling | undefined, toolName: string): boolean {
  if (!ceiling || ceiling.productMode === "work") {
    return toolName !== "rag_search" && toolName !== "lancedb_query" && toolName !== "chat_attachment_read" && toolName !== "chat_vision_analyze"
      && (!ceiling?.allowedTools || ceiling.allowedTools.includes(toolName));
  }
  const mode = ceiling.chatRetrievalMode;
  return ceiling.productMode === "chat" && mode !== undefined && Object.prototype.hasOwnProperty.call(chatTools, mode)
    && (chatTools[mode] as readonly string[]).includes(toolName)
    && ceiling.allowedTools !== undefined && ceiling.allowedTools.includes(toolName);
}

/** 复制并交集化工具列表；限制项只能收紧，非法列表不降级成无限制。 */
export function restrictCapabilityCeiling(identity: CapabilityCeiling, ...restrictions: Array<readonly string[] | undefined>): CapabilityCeiling {
  let allowed = identity.allowedTools ? [...identity.allowedTools] : undefined;
  for (const restriction of restrictions) {
    if (restriction === undefined) continue;
    /** 逐项检查工具名类型，非法列表不能解释为不受限。 */
    if (!Array.isArray(restriction) || restriction.some((name) => typeof name !== "string")) {
      throw new AgentRuntimeError("INVALID_RUN_CONFIG", "工具能力上限必须是工具名列表");
    }
    /** 保留限制共同允许的名称，首次列表同时去重。 */
    allowed = allowed ? allowed.filter((name) => restriction.includes(name)) : [...new Set(restriction)];
  }
  /** 最后再次应用产品矩阵，过滤伪造的越权名称。 */
  return { ...identity, ...(allowed ? { allowedTools: allowed.filter((name) => isToolWithinCeiling(identity, name)) } : {}) };
}
