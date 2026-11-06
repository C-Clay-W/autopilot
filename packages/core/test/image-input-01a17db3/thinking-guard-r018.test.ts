/** 验证视觉回退历史和正常签名回放的 thinking 请求策略。 */
import { describe, expect, it } from "vitest";
import { createAnthropicMessagesRequest } from "../../src/runtime/provider/anthropic-messages-adapter";
import type { AgentMessage } from "../../src/internal/types/agent-message";

const call = { type: "tool-call" as const, id: "call-1", name: "vision_analyze", input: {} };
const result = { type: "tool-result" as const, toolCallId: "call-1", content: [{ type: "text" as const, text: "ok" }], isError: false };
const prefix: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "看图" }] }];

describe("thinking 兼容回放", function thinkingReplay() {
  it("合成工具调用历史持续关闭 thinking", function synthetic() {
    const messages: AgentMessage[] = [...prefix, { role: "assistant", content: [call] }, { role: "user", content: [result] }];
    expect(createAnthropicMessagesRequest("test", messages, [], { thinking: "enabled" }, 100).thinking).toEqual({ type: "disabled" });
    const later: AgentMessage[] = [...messages, { role: "assistant", content: [{ type: "text", text: "完成" }] }, { role: "user", content: [{ type: "text", text: "继续" }] }];
    expect(createAnthropicMessagesRequest("test", later, [], { thinking: "enabled" }, 100).thinking).toEqual({ type: "disabled" });
  });
  it("签名 replay 保持启用 thinking", function signedReplay() {
    const messages: AgentMessage[] = [...prefix, { role: "assistant", content: [{ type: "reasoning", text: "思考" }, call], adapterReplayState: { apiProtocol: "anthropic-messages", value: [{ type: "thinking", thinking: "思考", signature: "signature" }, { type: "tool_use", id: call.id, name: call.name, input: call.input }] } }, { role: "user", content: [result] }];
    expect(createAnthropicMessagesRequest("test", messages, [], { thinking: "enabled" }, 100).thinking).toEqual({ type: "adaptive" });
  });
});
