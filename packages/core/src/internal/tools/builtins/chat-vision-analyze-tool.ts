/** Chat 专用视觉工具：只解析附件或本轮 RAG 视觉引用，使用受信视觉能力且无需审批。 */
import { z } from "zod";
import { chatOpaqueRefSchema, type ChatToolRuntime } from "../chat-tool-runtime";
import type { AgentToolDefinition } from "../types";

const schema = z.object({ attachmentRef: chatOpaqueRefSchema.optional(), visualEvidenceRef: chatOpaqueRefSchema.optional(), prompt: z.string().trim().min(1).max(4_000) }).strict().refine(
  /** 两类引用必须二选一，不能夹带路径或 URL。 */
  function singleRef(input) { return Number(Boolean(input.attachmentRef)) + Number(Boolean(input.visualEvidenceRef)) === 1; },
);

/** 创建只服务 Chat 的视觉工具，引用授权和图片预算集中在当前 Turn 管理。 */
export function createChatVisionAnalyzeTool(chat: ChatToolRuntime): AgentToolDefinition<z.infer<typeof schema>, unknown> {
  return {
    name: "chat_vision_analyze",
    description: "分析本会话图片或本轮 rag_search 产生的 visualEvidenceRef，只描述图片证据。",
    inputSchema: schema,
    isAvailable: chat.hasImageReferences,
    metadata: { effect: "external", destructive: false, concurrency: { max: 1, resourceKey: "chat:vision" }, retry: { safe: false }, timeout: { defaultMs: 60_000, maxMs: 60_000 } },
    /** 执行事件前校验来源类型与授权，不接受跨检索域引用。 */
    validateInput(input, context) {
      const ref = chat.retrievalMode === "rag" ? input.visualEvidenceRef : input.attachmentRef;
      return chat.authorize(ref ?? "", "image", context.signal);
    },
    /** 外部视觉调用受 capability 约束，无模型写权限也无人工审批。 */
    createActionFacts() { return { toolName: "chat_vision_analyze", effect: "external", destructive: false, operation: "analyze", risk: "read_only" }; },
    /** 仅将已授权图像发往冻结的视觉 Provider。 */
    execute(input, context) { return chat.analyze((input.attachmentRef ?? input.visualEvidenceRef)!, input.prompt, context.signal); },
    /** 返回观察文字与 opaque ref，绝不返回字节或 data URL。 */
    serializeOutput(output) { return output; },
  };
}
