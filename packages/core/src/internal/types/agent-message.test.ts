/**
 * internal/types/agent-message.test.ts — V2 canonical 消息的角色、配对和脱敏契约测试。
 */

import { describe, expect, it } from "vitest";
import {
  CanonicalMessageError,
  scanAgentToolPairing,
  validateAgentMessages,
  type AgentMessage,
} from "./agent-message";
import { sanitizeAgentMessagesForExternal } from "../../runtime/protocol/sanitize-checkpoint";

/** 创建包含四类 block 的完整 V2 会话。 */
function createValidMessages(): AgentMessage[] {
  return [
    { role: "system", content: [{ type: "text", text: "system" }] },
    { role: "user", content: [{ type: "text", text: "读取文件" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "reasoning", text: "private" },
        { type: "tool-call", id: "call-1", name: "read_file", input: { path: "README.md" } },
        { type: "tool-call", id: "call-2", name: "read_file", input: { path: "package.json" } },
      ],
      adapterReplayState: { apiProtocol: "anthropic-messages", value: { signature: "private" } },
    },
    { role: "user", content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "ok" }], isError: false }] },
    { role: "user", content: [{ type: "tool-result", toolCallId: "call-2", content: [{ type: "text", text: "failed" }], isError: true }] },
  ];
}

/** 断言调用以稳定 canonical 错误失败。 */
function expectCanonicalFailure(callback: () => unknown): void {
  try {
    callback();
    throw new Error("预期 canonical 校验失败");
  } catch (error) {
    expect(error).toBeInstanceOf(CanonicalMessageError);
    expect((error as CanonicalMessageError).code).toBe("CANONICAL_MESSAGE_INVALID");
  }
}

describe("AgentMessage V2 canonical", function agentMessageSuite() {
  it("校验四类内容块、移除空文本并支持 JSON round-trip", function validatesAndNormalizesMessages() {
    const messages = createValidMessages();
    const roundTrip = JSON.parse(JSON.stringify(messages)) as AgentMessage[];
    const validated = validateAgentMessages(roundTrip);

    expect(validated[2].content.map(function getBlockType(block) { return block.type; })).toEqual(["reasoning", "tool-call", "tool-call"]);
    expect(validated[4].content[0]).toMatchObject({ type: "tool-result", toolCallId: "call-2", isError: true });
  });

  it("允许扫描末尾 pending call，但完整校验拒绝缺失结果", function distinguishesPendingCallsFromSendableHistory() {
    const messages = createValidMessages().slice(0, 3);

    expect(scanAgentToolPairing(messages).pendingCallIds).toEqual(["call-1", "call-2"]);
    expectCanonicalFailure(function rejectsPendingCalls() { validateAgentMessages(messages); });
  });

  it("拒绝非法角色、非对象输入、孤立和重复 ID", function rejectsInvalidCanonicalHistory() {
    expectCanonicalFailure(function rejectsRole() {
      validateAgentMessages([{ role: "system", content: [{ type: "tool-call", id: "call-1", name: "read_file", input: {} }] }]);
    });
    expectCanonicalFailure(function rejectsArrayInput() {
      validateAgentMessages([{ role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "read_file", input: [] as unknown as Record<string, unknown> }] }]);
    });
    expectCanonicalFailure(function rejectsEmptyResultId() {
      validateAgentMessages([{ role: "user", content: [{ type: "tool-result", toolCallId: "", content: [{ type: "text", text: "invalid" }], isError: true }] }]);
    });
    expectCanonicalFailure(function rejectsOrphanResult() {
      validateAgentMessages([{ role: "user", content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "orphan" }], isError: true }] }]);
    });
    expectCanonicalFailure(function rejectsDuplicateResult() {
      const messages = createValidMessages();
      messages.push({ role: "user", content: [{ type: "tool-result", toolCallId: "call-2", content: [{ type: "text", text: "duplicate" }], isError: true }] });
      validateAgentMessages(messages);
    });
  });

  it("对外脱敏会同时剥离 reasoning block 与 adapter replay state", function stripsPrivateReasoningAndReplayState() {
    const sanitized = sanitizeAgentMessagesForExternal(createValidMessages());

    expect(sanitized[2]).toEqual({ role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "read_file", input: { path: "README.md" } }, { type: "tool-call", id: "call-2", name: "read_file", input: { path: "package.json" } }] });
  });
});
