/**
 * rag_search 工具：仅接受绑定 Chat 身份的检索端口，底层由宿主复用 canonical RAG 实现。
 */
import type { ChatToolRuntime } from "../chat-tool-runtime";
import { z } from "zod";
import type { AgentToolDefinition } from "../types";

const ragSearchSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  topK: z.number().int().min(1).max(20).default(5),
}).strict();

/** 创建只读 RAG 检索工具，不复制 Embedding、PDF 页码或单表 search 实现。 */
export function createRagSearchTool(chat: ChatToolRuntime): AgentToolDefinition<z.infer<typeof ragSearchSchema>, Record<string, unknown>> {
  return {
    name: "rag_search",
    description: "在应用级 Chat Knowledge Space 检索本地证据，无证据时不得补写事实。",
    inputSchema: ragSearchSchema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 1, resourceKey: "rag:search" }, retry: { safe: true } },
    createActionFacts: () => ({ toolName: "rag_search", effect: "none", destructive: false, operation: "search", risk: "read_only" }),
    async execute(input, context) {
      return chat.search(input.query, input.topK, context.signal);
    },
    serializeOutput(output) { return output; },
  };
}
