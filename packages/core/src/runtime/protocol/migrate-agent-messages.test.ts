/**
 * runtime/protocol/migrate-agent-messages.test.ts — V1 durable 消息迁移与失败保留契约测试。
 */

import { describe, expect, it } from "vitest";
import { migrateAgentMessages } from "./migrate-agent-messages";

describe("V1 durable message migration", function migrationSuite() {
  it("按原顺序迁移文本、reasoning、tool call 与 success/error tool result", function migratesValidV1Messages() {
    const result = migrateAgentMessages({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "读取文件" },
        { role: "assistant", content: "", reasoningContent: "private", toolCalls: [{ id: "call-1", name: "read_file", input: { path: "README.md" } }, { id: "call-2", name: "read_file", input: { path: "package.json" } }] },
        { role: "tool", toolCallId: "call-1", toolName: "read_file", content: '{"status":"success","output":"ok"}' },
        { role: "tool", toolCallId: "call-2", toolName: "read_file", content: "unparseable legacy result" },
      ],
    });

    expect(result).toMatchObject({ ok: true, messageSchemaVersion: 2 });
    if (!result.ok) return;
    expect(result.messages[2].content.map(function getType(block) { return block.type; })).toEqual(["reasoning", "tool-call", "tool-call"]);
    expect(result.messages[3].content[0]).toMatchObject({ toolCallId: "call-1", isError: false });
    expect(result.messages[4].content[0]).toMatchObject({ toolCallId: "call-2", isError: true });
    expect(migrateAgentMessages({ messageSchemaVersion: 2, messages: result.messages })).toEqual(result);
  });

  it("对合法 V2 输入幂等迁移", function keepsV2MessagesStable() {
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "world" }] },
    ];
    const result = migrateAgentMessages({ messageSchemaVersion: 2, messages });

    expect(result).toEqual({ ok: true, messageSchemaVersion: 2, messages });
  });

  it("拒绝损坏 ID 并保留原始 durable 记录", function preservesInvalidLegacyRecord() {
    const messages = [
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", input: { path: "README.md" } }] },
      { role: "tool", toolCallId: "call-1", toolName: "read_file", content: '{"status":"success"}' },
      { role: "tool", toolCallId: "call-1", toolName: "read_file", content: '{"status":"error"}' },
    ];
    const result = migrateAgentMessages({ messages });

    expect(result).toMatchObject({ ok: false, code: "CANONICAL_MESSAGE_INVALID" });
    if (result.ok) return;
    expect(result.originalMessages).toBe(messages);
  });

  it("对损坏 V2 历史 fail closed", function rejectsInvalidV2Messages() {
    const messages = [{ role: "user", content: [{ type: "tool-result", toolCallId: "orphan", content: [{ type: "text", text: "invalid" }], isError: true }] }];
    const result = migrateAgentMessages({ messageSchemaVersion: 2, messages });

    expect(result).toMatchObject({ ok: false, code: "CANONICAL_MESSAGE_INVALID", originalMessages: messages });
  });
});
