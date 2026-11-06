/** 缓存与文件读取优化的离线行为回归；仅使用任务临时工作区及假采样器。 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentRuntime } from "../../src/internal/agent-runtime";
import { createReadFileTool } from "../../src/internal/tools/builtins/read-file-tool";
import { createWriteFileTool } from "../../src/internal/tools/builtins/write-file-tool";
import { createEditFileTool } from "../../src/internal/tools/builtins/edit-file-tool";
import type { ToolExecutionContext } from "../../src/internal/tools/types";
import type { AgentMessage } from "../../src/internal/types/agent-message";
import { createAgentTextMessage, getAgentMessageText } from "../../src/internal/types/agent-message";
import { createAnthropicMessagesRequest } from "../../src/runtime/provider/anthropic-messages-adapter";
import { createTurnConversationBuilder } from "../../src/runtime/application/turn/turn-conversation-builder";
import { createAgentToolResultMessage } from "../../src/internal/types/agent-message";
import { estimateMessageTokens } from "../../src/internal/kernel/compact";
import { compactMessages } from "../../src/internal/kernel/compact";

const readbackFault = vi.hoisted(function fault() { return { enabled: false }; });
vi.mock("node:fs/promises", async function mockReadback(importOriginal) {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: async function readFile(...args: Parameters<typeof actual.readFile>) {
    if (readbackFault.enabled && String(args[0]).endsWith("corrupt.txt")) return Buffer.from("unexpected disk bytes");
    return actual.readFile(...args as [never, never]);
  } };
});

/** 生成成功工具结果，格式与真实调度器模型投影一致。 */
function readMessage(output: unknown): AgentMessage {
  return { role: "user", content: [{ type: "tool-result", toolCallId: "read", isError: false, content: [{ type: "text", text: JSON.stringify({ status: "success", output }) }] }] };
}

/** 为每个文件场景建立隔离的临时目录，不读真实用户状态。 */
async function fileContext() {
  const fixtures = path.resolve("../../.agent-tests/work-test/cache-read-01a19f3e/runs/r001/fixtures");
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, "ap-cache-read-"));
  const visible: AgentMessage[] = [];
  const context = { workspaceRoot: root, fileReadStates: new Map(), getVisibleMessages: function getVisibleMessages() { return visible; } } as ToolExecutionContext;
  return { root, visible, context };
}

describe("缓存/读取批准契约", function suite() {
  it("三轮相同快照前缀稳定，真实指令更新只替换快照", async function contextStability() {
    let messages: AgentMessage[] = [createAgentTextMessage("user", "one")];
    const prefixes: string[] = [];
    for (let turn = 0; turn < 4; turn++) {
      let captured: AgentMessage[] = [];
      const runtime = createAgentRuntime({ context: { instructions: [{ path: "AGENTS.md", content: turn === 3 ? "changed" : "same", contentHash: "hash" }], memories: [{ memoryId: "m", category: "project", content: "frozen memory", updatedAt: "2026-11-03", confidence: 1 }], budget: { estimatedTokens: 0, sections: {}, diagnostics: [], compactNeeded: false } }, skills: { catalog: [{ skillId: "s", name: "s", qualifiedName: "project:s", source: "project", description: "skill directory entry", modelInvocable: true }], async discoverSkills() { return []; } } as never, modelSampler: { async sample(input) { captured = input; return { content: "answer", toolCalls: [], reasoningSummary: "" }; } } });
      for await (const event of runtime.run({ turnId: `turn-${turn}`, messages })) if (event.type === "turn_completed") messages = event.checkpoint.messages;
      const firstUser = captured.findIndex(function user(message) { return message.role === "user"; });
      prefixes.push(JSON.stringify(captured.slice(0, firstUser)));
      expect(JSON.stringify(captured).match(/skill directory entry/g)).toHaveLength(1);
      expect(JSON.stringify(captured).match(/frozen memory/g)).toHaveLength(1);
      expect(captured.filter(function snapshot(message) { return getAgentMessageText(message).startsWith("【宿主上下文快照】"); })).toHaveLength(1);
      messages.push(createAgentTextMessage("user", "next"));
    }
    expect(prefixes[1]).toBe(prefixes[0]); expect(prefixes[2]).toBe(prefixes[0]); expect(prefixes[3]).not.toBe(prefixes[0]);
  });

  it("跨Turn重建保留已验证reasoning和协议replay", async function replay() {
    const assistant: AgentMessage = { role: "assistant", content: [{ type: "reasoning", text: "thought" }, { type: "text", text: "answer" }], adapterReplayState: { apiProtocol: "anthropic-messages", value: [{ type: "thinking", thinking: "thought", signature: "sig" }, { type: "text", text: "answer" }] } };
    const history = [createAgentTextMessage("system", "rules"), createAgentTextMessage("user", "old"), assistant];
    const builder = createTurnConversationBuilder({ checkpointStore: { async getByTurn() { return { turnId: "old", messageSchemaVersion: 2, messages: history }; } } } as never);
    const rebuilt = await builder.buildCanonicalSessionMessages({ id: "old", sessionId: "s" } as never, [createAgentTextMessage("user", "next")]);
    expect(rebuilt[2]).toEqual(assistant);
    expect(createAnthropicMessagesRequest("m", rebuilt, [], {}, 100).messages[1].content).toEqual(assistant.adapterReplayState!.value);
  });

  it("动态system留在尾部且Anthropic使用合法user提醒", function reminders() {
    const history = [createAgentTextMessage("system", "stable safety"), createAgentTextMessage("user", "task"), createAgentTextMessage("assistant", "answer")];
    const first = createAnthropicMessagesRequest("m", history, [], {}, 100);
    const second = createAnthropicMessagesRequest("m", [...history, createAgentTextMessage("system", "runtime todo")], [], {}, 100);
    expect(second.system).toEqual(first.system);
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(second.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("runtime todo") });
    const unsigned = createAnthropicMessagesRequest("m", [...history, { role: "assistant", content: [{ type: "reasoning", text: "old other protocol reasoning" }, { type: "text", text: "public" }] }], [], {}, 100);
    expect(JSON.stringify(unsigned.messages)).not.toContain("other protocol reasoning");
  });

  it("摘要采样原样复用消息和tools前缀并拒绝工具响应", async function summaryPrefix() {
    const messages = [createAgentTextMessage("system", "rules"), createAgentTextMessage("user", "old"), createAgentTextMessage("assistant", "answer"), createAgentTextMessage("user", "latest")];
    const tools = [{ type: "function" as const, function: { name: "read_file", description: "read", parameters: {} } }];
    let calls = 0;
    const input = { messages, tools, trigger: "manual" as const, preserveRecentTurns: 1, targetTokens: 10000 };
    await compactMessages({ ...input, sampler: { async sample(actual, actualTools) { calls++; expect(actual.slice(0, messages.length)).toEqual(messages); expect(actualTools).toEqual(tools); expect(getAgentMessageText(actual.at(-1)!)).toContain("压缩器"); return { content: "summary", toolCalls: [], reasoningSummary: "" }; } } });
    expect(calls).toBe(1);
    await expect(compactMessages({ ...input, sampler: { async sample() { return { content: "summary", toolCalls: [{ id: "no", name: "read_file", input: {} }], reasoningSummary: "" }; } } })).rejects.toThrow("不允许工具调用");
  });

  it("默认2000行，同版本同范围只在旧正文可见时去重", async function readDedup() {
    const { root, visible, context } = await fileContext();
    await writeFile(path.join(root, "file.txt"), Array.from({ length: 2100 }, function line(_, index) { return `line ${index + 1}`; }).join("\n"));
    const tool = createReadFileTool(); const input = tool.inputSchema.parse({ path: "file.txt" });
    const first = await tool.execute(input, context); expect(first.endLine).toBe(2000); expect(first.isCompleteRead).toBe(false);
    visible.push(readMessage(first));
    const duplicate = await tool.execute(input, context); expect(duplicate.unchanged).toBe(true); expect(duplicate.content).toBeUndefined();
    expect((await tool.execute({ ...input, offset: 2001 }, context)).content).toContain("line 2100");
    visible.length = 0; expect((await tool.execute(input, context)).content).toBe(first.content);
    visible.push(readMessage(first)); await writeFile(path.join(root, "file.txt"), "new version");
    expect((await tool.execute(input, context)).content).toBe("new version");
    expect(context.fileReadStates?.get("file.txt")?.observedRanges).toEqual([{ startLine: 1, endLine: 1 }]);
  });

  it("无mutation store写入也读回真实字节，后续edit保留防陈旧", async function headlessWrite() {
    const { root, context } = await fileContext();
    const created = await createWriteFileTool().execute({ path: "file.txt", content: "one\ntwo" }, context);
    expect(created.diskVerified).toBe(true); expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("one\ntwo");
    const edited = await createEditFileTool().execute({ path: "file.txt", oldString: "two", newString: "three", replaceAll: false }, context);
    expect(edited.diskVerified).toBe(true);
    await writeFile(path.join(root, "file.txt"), "external");
    await expect(createEditFileTool().execute({ path: "file.txt", oldString: "three", newString: "four", replaceAll: false }, context)).rejects.toThrow("变化");
  });
  it("完整工具结果在估算预算内，中文和JSON转义按完整行续读", async function tokenEnvelope() {
    const { root, context } = await fileContext();
    const lines = Array.from({ length: 2000 }, function line() { return '中文汉字"\\'.repeat(20); });
    await writeFile(path.join(root, "large.txt"), lines.join("\n"));
    const tool = createReadFileTool();
    const output = await tool.execute(tool.inputSchema.parse({ path: "large.txt" }), context);
    expect(output.budgetTruncated).toBe(true); expect(output.sha256).toBeNull(); expect(output.isCompleteRead).toBe(false);
    expect(output.nextOffset).toBe(Number(output.endLine) + 1);
    const actualEstimate = estimateMessageTokens([createAgentToolResultMessage({ toolCallId: "read_file", text: JSON.stringify({ status: "success", output }), isError: false })]);
    expect(actualEstimate).toBeLessThanOrEqual(25_000);
    expect((output.content as string).split("\n").every(function complete(line) { return line === lines[0]; })).toBe(true);
    const next = await tool.execute(tool.inputSchema.parse({ path: "large.txt", offset: output.nextOffset }), context);
    expect(next.startLine).toBe(output.nextOffset);
  });

  it("写后实际字节不符时拒绝成功且不建立预期hash观察事实", async function rejectsWrongDiskBytes() {
    const { context } = await fileContext();
    readbackFault.enabled = true;
    try {
      await expect(createWriteFileTool().execute({ path: "corrupt.txt", content: "expected" }, context)).rejects.toThrow("校验失败");
      expect(context.fileReadStates?.has("corrupt.txt")).toBe(false);
    } finally { readbackFault.enabled = false; }
  });

  it("旧pending验证只接受绑定版本的完整范围，局部一行不能提前结束", async function pendingVerification() {
    const { root } = await fileContext();
    const content = "one\ntwo\nthree";
    await writeFile(path.join(root, "old.txt"), content);
    const sha256 = createHash("sha256").update(content).digest("hex");
    let samples = 0;
    let visibleAfterPartial: string[] = [];
    const runtime = createAgentRuntime({ workspaceRoot: root, permissionMode: "auto_approve", workspaceTrusted: true, modelSampler: { async sample(_messages, tools) {
      samples++;
      if (samples === 1) return { content: "", toolCalls: [{ id: "partial", name: "read_file", input: { path: "old.txt", limit: 1 } }], reasoningSummary: "" };
      if (samples === 2) return { content: "premature", toolCalls: [], reasoningSummary: "" };
      visibleAfterPartial = tools.map(function name(tool) { return tool.function.name; });
      if (samples === 3) return { content: "", toolCalls: [{ id: "rest", name: "read_file", input: { path: "old.txt", offset: 2, limit: 2 } }], reasoningSummary: "" };
      return { content: "verified", toolCalls: [], reasoningSummary: "" };
    } } });
    const events = [];
    for await (const event of runtime.run({ checkpoint: { turnId: "old-pending", status: "interrupted_recoverable", interruptionReason: "write_verification", stepCount: 0, messages: [createAgentTextMessage("user", "continue")], completedCallIds: [], fileReadStates: [{ path: "old.txt", sha256, mtimeMs: 0, observedRanges: [{ startLine: 1, endLine: 3 }] }], mutationGate: { required: true, strong: false, changedPaths: ["old.txt"], verifiedPaths: [], recoveryAttempts: 0, verificationOnly: true } } })) events.push(event);
    expect(visibleAfterPartial).toEqual(["read_file"]);
    expect(samples).toBe(4);
    expect(events.filter(function complete(event) { return event.type === "turn_completed"; })).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("turn_completed");
  });

  it("旧pending版本失配保持暂停，不能靠新版本读回消除原约束", async function stalePendingVersion() {
    const { root } = await fileContext();
    await writeFile(path.join(root, "old.txt"), "external replacement");
    const originalSha = createHash("sha256").update("original write").digest("hex");
    let samples = 0;
    const runtime = createAgentRuntime({ workspaceRoot: root, permissionMode: "auto_approve", workspaceTrusted: true, modelSampler: { async sample() {
      samples++;
      if (samples === 1) return { content: "", toolCalls: [{ id: "read-new", name: "read_file", input: { path: "old.txt" } }], reasoningSummary: "" };
      return { content: "finished", toolCalls: [], reasoningSummary: "" };
    } } });
    const events = [];
    for await (const event of runtime.run({ checkpoint: { turnId: "stale-pending", status: "interrupted_recoverable", interruptionReason: "write_verification", stepCount: 0, messages: [createAgentTextMessage("user", "continue")], completedCallIds: [], fileReadStates: [{ path: "old.txt", sha256: originalSha, mtimeMs: 0, observedRanges: [] }], mutationGate: { required: true, changedPaths: ["old.txt"], verifiedPaths: [], recoveryAttempts: 1, verificationOnly: true } } })) events.push(event);
    const last = events.at(-1);
    expect(last?.type).toBe("turn_interrupted");
    if (last?.type !== "turn_interrupted") throw new Error("missing pause");
    expect(last.checkpoint.mutationGate?.verificationTargets?.[0].sha256).toBe(originalSha);
    expect(last.checkpoint.mutationGate?.verifiedPaths).toEqual([]);
  });

  it("摘要取消不返回成功或修改原历史", async function cancelledSummary() {
    const controller = new AbortController();
    const messages = [createAgentTextMessage("user", "old"), createAgentTextMessage("assistant", "answer"), createAgentTextMessage("user", "next")];
    await expect(compactMessages({ messages, trigger: "manual", preserveRecentTurns: 1, targetTokens: 10000, signal: controller.signal, sampler: { async sample() { controller.abort(); return { content: "summary", toolCalls: [], reasoningSummary: "" }; } } })).rejects.toThrow();
    expect(messages).toHaveLength(3);
  });

  it("窗口不足时只裁去保留尾部，最小完整历史仍超限则采样前失败", async function boundedSummaryPrefix() {
    const messages = [createAgentTextMessage("system", "rules"), createAgentTextMessage("user", "old"), createAgentTextMessage("assistant", "answer"), createAgentTextMessage("user", "甲".repeat(900))];
    const input = { messages, trigger: "manual" as const, preserveRecentTurns: 1, targetTokens: 5000, contextWindowTokens: 1000 };
    let calls = 0;
    const sampler = { async sample(actual: AgentMessage[]) { calls++; expect(actual.slice(0, 3)).toEqual(messages.slice(0, 3)); expect(actual).toHaveLength(4); return { content: "summary", toolCalls: [], reasoningSummary: "" }; } };
    const result = await compactMessages({ ...input, sampler });
    expect(calls).toBe(1); expect(result.messages.at(-1)).toEqual(messages.at(-1));
    const impossible = [messages[0], createAgentTextMessage("user", "乙".repeat(2000)), ...messages.slice(2)];
    await expect(compactMessages({ ...input, messages: impossible, sampler })).rejects.toThrow("最小历史前缀");
    expect(calls).toBe(1); expect(impossible).toHaveLength(4);
  });

  it("摘要图片沿用宿主校验和图片预算，引用不被伪造为视觉事实", async function summaryImage() {
    const bytes = Buffer.from("fixture immutable bytes");
    const image = { id: "00000000-0000-0000-0000-000000000001", sha256: createHash("sha256").update(bytes).digest("hex"), width: 1, height: 1, bytes: bytes.length, mimeType: "image/png" };
    const messages: AgentMessage[] = [{ role: "user", content: [{ type: "image-ref", id: image.id, sha256: image.sha256, width: 1, height: 1 }] }, createAgentTextMessage("assistant", "observed answer"), createAgentTextMessage("user", "next")];
    const input = { messages, trigger: "manual" as const, preserveRecentTurns: 1, targetTokens: 10000, sessionId: "s", sessionImageStore: { async read() { return { image, bytes }; } } as never };
    await compactMessages({ ...input, supportsImageInput: true, sampler: { async sample(actual, _tools, options) { expect(actual[0]).toEqual(messages[0]); expect(options.imageData?.[image.id].data).toBe(bytes.toString("base64")); return { content: "summary", toolCalls: [], reasoningSummary: "" }; } } });
    await compactMessages({ ...input, supportsImageInput: false, sampler: { async sample(actual, _tools, options) { expect(getAgentMessageText(actual[0])).toContain("未观察图片"); expect(options.imageData).toEqual({}); return { content: "summary", toolCalls: [], reasoningSummary: "" }; } } });
  });

  it("连续Chat Turn身份与联网指引不累积，旧重复system自动归一", async function chatPrefix() {
    let messages: AgentMessage[] = [createAgentTextMessage("system", "【产品身份】old Chat"), createAgentTextMessage("system", "受控联网策略：old"), createAgentTextMessage("system", "受控联网策略：old duplicate"), createAgentTextMessage("user", "task")];
    const prefixes: string[] = [];
    for (let turn = 0; turn < 3; turn++) {
      let sampled: AgentMessage[] = [];
      const runtime = createAgentRuntime({ capabilityCeiling: { productMode: "chat", chatRetrievalMode: "web" }, web: { search: {} } as never, modelSampler: { async sample(input) { sampled = input; return { content: "answer", toolCalls: [], reasoningSummary: "" }; } } });
      for await (const event of runtime.run({ turnId: `chat-${turn}`, messages })) if (event.type === "turn_completed") messages = event.checkpoint.messages;
      const prefix = sampled.filter(function system(message) { return message.role === "system"; }).map(getAgentMessageText);
      expect(prefix.filter(function identity(text) { return text.startsWith("【产品身份】"); })).toHaveLength(1);
      expect(prefix.filter(function web(text) { return text.startsWith("受控联网策略："); })).toHaveLength(1);
      prefixes.push(JSON.stringify(prefix));
      messages.push(createAgentTextMessage("user", "next"));
    }
    expect(prefixes[1]).toBe(prefixes[0]); expect(prefixes[2]).toBe(prefixes[0]);
  });

});
