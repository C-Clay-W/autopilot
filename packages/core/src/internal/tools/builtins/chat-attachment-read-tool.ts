/** Chat 临时文件读取工具：只接受当前 Session 的 opaque 引用，无路径、入库或审批能力。 */
import { z } from "zod";
import { chatOpaqueRefSchema, type ChatToolRuntime } from "../chat-tool-runtime";
import type { AgentToolDefinition } from "../types";

const schema = z.object({ attachmentRef: chatOpaqueRefSchema }).strict();

/** 复用当前 Turn 的授权和解析端口，结果仅保留有界文本与页图引用。 */
export function createChatAttachmentReadTool(chat: ChatToolRuntime): AgentToolDefinition<z.infer<typeof schema>, unknown> {
  return {
    name: "chat_attachment_read",
    description: "读取本会话临时文件的解析文本；只接受已提供的 attachmentRef。",
    inputSchema: schema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 1 }, retry: { safe: false }, timeout: { defaultMs: 30_000, maxMs: 30_000 } },
    /** 执行事件前拒绝伪造、过期及跨会话引用。 */
    validateInput(input, context) { return chat.authorize(input.attachmentRef, "document", context.signal); },
    /** 只读能力不进入审批。 */
    createActionFacts() { return { toolName: "chat_attachment_read", effect: "none", destructive: false, operation: "read", risk: "read_only" }; },
    /** 通过授权端口读取受控解析结果。 */
    execute(input, context) { return chat.readAttachment(input.attachmentRef, context.signal); },
    /** 不附加路径、宿主元数据或底层异常。 */
    serializeOutput(output) { return output; },
  };
}
