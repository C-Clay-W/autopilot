/**
 * runtime/provider/provider-message-fixtures.ts — Provider 协议基线共用会话夹具。
 *
 * 本文件只固化 Stage 0 的 V1 canonical 输入，不承载生产序列化或校验逻辑。
 */

/** Stage 0 专用 V1 durable fixture；不得作为 Runtime 或 Adapter 输入类型导出。 */
interface LegacyAgentMessageFixture {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  toolCallId?: string;
  toolName?: string;
  reasoningContent?: string;
}

/** 创建单工具调用及其成功结果的 V1 会话。 */
export function createSingleToolConversation(): LegacyAgentMessageFixture[] {
  return [
    { role: "system", content: "system" },
    { role: "user", content: "读取 README" },
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", input: { path: "README.md" } }] },
    { role: "tool", toolCallId: "call-1", toolName: "read_file", content: '{"status":"success","path":"README.md"}' },
  ];
}

/** 创建同批双工具调用及成功、失败混合结果的 V1 会话。 */
export function createParallelToolResultConversation(): LegacyAgentMessageFixture[] {
  return [
    { role: "system", content: "system" },
    { role: "user", content: "读取两个文件" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-1", name: "read_file", input: { path: "README.md" } },
        { id: "call-2", name: "read_file", input: { path: "package.json" } },
      ],
    },
    { role: "tool", toolCallId: "call-1", toolName: "read_file", content: '{"status":"success","path":"README.md"}' },
    { role: "tool", toolCallId: "call-2", toolName: "read_file", content: '{"status":"error","code":"FS_NOT_FOUND"}' },
  ];
}

/** 创建工具结果后紧跟普通用户消息的 V1 会话。 */
export function createAdjacentUserConversation(): LegacyAgentMessageFixture[] {
  return [...createSingleToolConversation(), { role: "user", content: "继续分析结果" }];
}

/** 创建工具结果后在安全点投递 steer 文本的 V1 会话。 */
export function createToolResultThenSteerConversation(): LegacyAgentMessageFixture[] {
  return [...createSingleToolConversation(), { role: "user", content: "请改为简要总结" }];
}

/** 创建缺失工具结果 ID 的 V1 非法历史夹具。 */
export function createMissingToolResultIdConversation(): LegacyAgentMessageFixture[] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", input: { path: "README.md" } }] },
    { role: "tool", toolName: "read_file", content: '{"status":"error"}' },
  ];
}

/** 创建重复工具结果 ID 的 V1 非法历史夹具。 */
export function createDuplicateToolResultIdConversation(): LegacyAgentMessageFixture[] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", input: { path: "README.md" } }] },
    { role: "tool", toolCallId: "call-1", toolName: "read_file", content: '{"status":"success"}' },
    { role: "tool", toolCallId: "call-1", toolName: "read_file", content: '{"status":"error"}' },
  ];
}
