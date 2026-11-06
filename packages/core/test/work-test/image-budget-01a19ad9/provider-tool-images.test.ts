/** 两协议工具图片结构与多工具结果顺序，禁止编码回落到工具文本。 */
import { describe, expect, it } from "vitest";
import { createOpenAiChatCompletionsMessages } from "../../../src/runtime/provider/openai-chat-completions-adapter";
import { createAnthropicConversationMessages } from "../../../src/runtime/provider/anthropic-messages-adapter";
import type { AgentMessage } from "../../../src/internal/types/agent-message";

const reference = { type: "image-ref" as const, id: "00000000-0000-4000-8000-000000000001", sha256: "a".repeat(64), width: 1, height: 1 };
const data = { [reference.id]: { mimeType: "image/png" as const, data: "YWJj" } };
const profile = { apiProtocol: "openai-chat-completions" as const, assistantToolCallContent: "empty-string" as const, supportsReasoningContent: false, supportsUsageInStreaming: false };
const messages: AgentMessage[] = [
  { role: "user", content: [{ type: "text", text: "看截图" }] },
  { role: "assistant", content: [{ type: "tool-call", id: "a", name: "screenshot", input: {} }, { type: "tool-call", id: "b", name: "read", input: {} }] },
  { role: "user", content: [{ type: "tool-result", toolCallId: "a", content: [{ type: "text", text: "截图成功" }], images: [reference], isError: false }] },
  { role: "user", content: [{ type: "tool-result", toolCallId: "b", content: [{ type: "text", text: "读取成功" }], isError: false }] },
];

describe("工具图片协议", function suite() {
  it("Chat在整批tool结果后追加原生图片，工具文本不含base64", function chat() {
    const wire = createOpenAiChatCompletionsMessages(messages, profile, data);
    expect(wire.map(function role(message) { return message.role; })).toEqual(["user", "assistant", "tool", "tool", "user"]);
    expect(wire[2]).toMatchObject({ tool_call_id: "a", content: "截图成功" });
    expect(wire[3]).toMatchObject({ tool_call_id: "b", content: "读取成功" });
    expect(wire[4].content).toEqual([{ type: "text", text: "工具 a 返回的图片" }, { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } }]);
  });
  it("Anthropic在对应tool_result内发送image并维持批次聚合", function anthropic() {
    const wire = createAnthropicConversationMessages(messages, false, data);
    expect(wire).toHaveLength(3);
    expect(wire[2].content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "截图成功" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } }], is_error: false },
      { type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "读取成功" }], is_error: false },
    ]);
  });
  it("缺失图片字节不得退化成文本或伪造已看图", function missingData() {
    expect(function chat() { createOpenAiChatCompletionsMessages(messages, profile); }).toThrow("图片不可用");
    expect(function anthropic() { createAnthropicConversationMessages(messages); }).toThrow("图片不可用");
  });
});
