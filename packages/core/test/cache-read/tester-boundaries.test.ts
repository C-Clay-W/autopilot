/** 独立验证缓存读取的跨Runtime组合边界；仅用合成状态和本任务夹具。 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentRuntime, type AgentCheckpoint, type AgentLoopEvent } from "../../src/internal/agent-runtime";
import { createAgentTextMessage, getAgentMessageText, validateAgentMessages, type AgentMessage } from "../../src/internal/types/agent-message";
import { createTurnConversationBuilder } from "../../src/runtime/application/turn/turn-conversation-builder";
import { createTurnCompactionCoordinator } from "../../src/runtime/application/turn/turn-compaction-coordinator";
import { createAnthropicMessagesRequest } from "../../src/runtime/provider/anthropic-messages-adapter";

/** 为黑盒文件调用创建本任务独占目录。 */
async function fixture() {
  const root = path.resolve("../../.agent-tests/work-test/cache-read-01a19f3e/runs/r001/tester-fixtures");
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, "boundary-"));
}

/** 收集有限Runtime事件，保留真实工具结果和终态。 */
async function collect(runtime: ReturnType<typeof createAgentRuntime>, input: Parameters<typeof runtime.run>[0]) {
  const events: AgentLoopEvent[] = [];
  for await (const event of runtime.run(input)) events.push(event);
  return events;
}

/** 只接受带checkpoint的预期终态，防止失败被测试误认成功。 */
function checkpoint(events: AgentLoopEvent[], type: AgentLoopEvent["type"]) {
  const last = events.at(-1);
  expect(last?.type).toBe(type);
  if (!last || !("checkpoint" in last) || !last.checkpoint) throw new Error("missing checkpoint");
  return last.checkpoint;
}

/** 返回实际调度投影的成功读取正文。 */
function readOutputs(events: AgentLoopEvent[]) {
  return events.flatMap(function output(event) {
    return event.type === "tool_result" && event.toolName === "read_file" && event.result.status === "success" ? [event.result.output as Record<string, unknown>] : [];
  });
}

describe("独立组合边界", function suite() {
  it("连续Runtime经canonical重建后wire前缀稳定且保留签名工具配对", async function wireAcrossTurns() {
    const workspaceRoot = await fixture();
    await writeFile(path.join(workspaceRoot, "sample.txt"), "fixture body");
    let previous: AgentCheckpoint | undefined;
    const prefixes: unknown[] = [];
    for (let turn = 0; turn < 3; turn++) {
      const builder = createTurnConversationBuilder({ checkpointStore: { async getByTurn() { return { ...previous, messageSchemaVersion: 2 }; } } } as never);
      const messages = await builder.buildCanonicalSessionMessages(previous ? { id: previous.turnId, sessionId: "synthetic" } as never : undefined, [createAgentTextMessage("user", `turn ${turn}`)]);
      let samples = 0;
      const runtime = createAgentRuntime({ workspaceRoot, permissionMode: "auto_approve", workspaceTrusted: true,
        context: { instructions: [{ path: "AGENTS.md", content: turn === 2 ? "changed-rules" : "stable-rules", contentHash: "fixture" }], memories: [], budget: { estimatedTokens: 0, sections: {}, diagnostics: [], compactNeeded: false } },
        skills: { catalog: [{ skillId: "s", name: "s", qualifiedName: "project:s", source: "project", description: "unique-skill-marker", modelInvocable: true }], async discoverSkills() { return []; } } as never,
        modelSampler: { async sample(actual, tools) {
          const wire = createAnthropicMessagesRequest("synthetic", actual, tools, {}, 100);
          if (samples++ === 0) prefixes.push(wire.system);
          expect(JSON.stringify(wire.system).match(/unique-skill-marker/g)).toHaveLength(1);
          if (turn > 0) {
            expect(JSON.stringify(wire.messages)).toContain('"signature":"signed-fixture"');
            expect(JSON.stringify(wire.messages)).toContain('"tool_use_id":"signed-read"');
          }
          if (turn === 0 && samples === 1) return { content: "", reasoningContent: "signed thought", reasoningSummary: "", toolCalls: [{ id: "signed-read", name: "read_file", input: { path: "sample.txt" } }], adapterReplayState: { apiProtocol: "anthropic-messages" as const, value: [{ type: "thinking", thinking: "signed thought", signature: "signed-fixture" }, { type: "tool_use", id: "signed-read", name: "read_file", input: { path: "sample.txt" } }] } };
          return { content: "confirmed", reasoningSummary: "", toolCalls: [] };
        } } });
      previous = checkpoint(await collect(runtime, { turnId: `wire-${turn}`, messages }), "turn_completed");
      validateAgentMessages(previous.messages);
    }
    expect(prefixes[1]).toEqual(prefixes[0]);
    expect(prefixes[2]).not.toEqual(prefixes[0]);
  });

  it("真实read回灌去重后裁剪恢复和外部换版不沿用旧观察范围", async function readRecovery() {
    const workspaceRoot = await fixture();
    const file = path.join(workspaceRoot, "range.txt");
    await writeFile(file, "a\nb\nc\nd\ne\nf");
    let samples = 0;
    const runtime = createAgentRuntime({ workspaceRoot, modelSampler: { async sample() {
      samples++;
      return samples <= 2 ? { content: "", reasoningSummary: "", toolCalls: [{ id: `read-${samples}`, name: "read_file", input: { path: "range.txt", limit: 3 } }] } : { content: "done", reasoningSummary: "", toolCalls: [] };
    } } });
    const first = await collect(runtime, { turnId: "dedup", messages: [createAgentTextMessage("user", "inspect")] });
    const firstOutput = readOutputs(first);
    expect(firstOutput).toHaveLength(2);
    expect(firstOutput[0].content).toBe("a\nb\nc");
    expect(firstOutput[1].unchanged).toBe(true);
    const saved = JSON.parse(JSON.stringify(checkpoint(first, "turn_completed"))) as AgentCheckpoint;
    // 模拟压缩/历史裁剪后的实际可见投影，保留持久read state而移除旧正文。
    saved.messages = [createAgentTextMessage("system", "已压缩历史摘要：检查过文件"), createAgentTextMessage("user", "continue")];
    saved.status = "interrupted_recoverable";
    let resumedSamples = 0;
    const resumed = createAgentRuntime({ workspaceRoot, permissionMode: "auto_approve", workspaceTrusted: true, modelSampler: { async sample() {
      resumedSamples++;
      if (resumedSamples === 1) return { content: "", reasoningSummary: "", toolCalls: [{ id: "reread", name: "read_file", input: { path: "range.txt", limit: 3 } }] };
      if (resumedSamples === 2) {
        await writeFile(file, "A\nB\nC\nD\nE\nF");
        return { content: "", reasoningSummary: "", toolCalls: [{ id: "new-range", name: "read_file", input: { path: "range.txt", offset: 4, limit: 3 } }] };
      }
      if (resumedSamples === 3) return { content: "", reasoningSummary: "", toolCalls: [{ id: "unseen-edit", name: "edit_file", input: { path: "range.txt", oldString: "B", newString: "changed" } }] };
      return { content: "stopped unseen edit", reasoningSummary: "", toolCalls: [] };
    } } });
    const events = await collect(resumed, { checkpoint: saved });
    expect(readOutputs(events)[0].content).toBe("a\nb\nc");
    expect(readOutputs(events)[1].content).toBe("D\nE\nF");
    expect(events.find(function edit(event) { return event.type === "tool_result" && event.toolName === "edit_file"; })).toMatchObject({ result: { status: "error" } });
    expect(checkpoint(events, "turn_completed").fileReadStates?.[0].observedRanges).toEqual([{ startLine: 4, endLine: 6 }]);
    expect(await readFile(file, "utf8")).toBe("A\nB\nC\nD\nE\nF");
  });

  it("旧pending局部验证跨真实恢复仍绑定原版本且不能放行外部替换", async function pendingAcrossResume() {
    const workspaceRoot = await fixture();
    const file = path.join(workspaceRoot, "pending.txt");
    const original = "one\ntwo\nthree";
    await writeFile(file, original);
    const sha256 = createHash("sha256").update(original).digest("hex");
    const pending: AgentCheckpoint = { turnId: "pending", status: "interrupted_recoverable", stepCount: 0, messages: [createAgentTextMessage("user", "verify pending write")], completedCallIds: [], fileReadStates: [{ path: "pending.txt", sha256, mtimeMs: 0, observedRanges: [{ startLine: 1, endLine: 3 }] }], mutationGate: { required: true, changedPaths: ["pending.txt"], verifiedPaths: [], recoveryAttempts: 0, verificationOnly: true } };
    const runtime = createAgentRuntime({ workspaceRoot, modelSampler: { async sample() { return { content: "", reasoningSummary: "", toolCalls: [{ id: "part", name: "read_file", input: { path: "pending.txt", limit: 1 } }] }; } } });
    const partial = checkpoint(await collect(runtime, { checkpoint: pending, maxSteps: 1 }), "turn_limit_reached");
    expect(partial.mutationGate?.verificationTargets).toEqual([{ path: "pending.txt", sha256, observedRanges: [{ startLine: 1, endLine: 1 }] }]);
    await writeFile(file, "external\ntwo\nthree");
    let samples = 0;
    const resumed = createAgentRuntime({ workspaceRoot, modelSampler: { async sample() {
      samples++;
      return samples === 1 ? { content: "", reasoningSummary: "", toolCalls: [{ id: "rest", name: "read_file", input: { path: "pending.txt", offset: 2, limit: 2 } }] } : { content: "premature complete", reasoningSummary: "", toolCalls: [] };
    } } });
    const events = await collect(resumed, { checkpoint: JSON.parse(JSON.stringify(partial)), maxSteps: 2 });
    expect(events.some(function completed(event) { return event.type === "turn_completed"; })).toBe(false);
    const last = events.at(-1);
    if (!last || !("checkpoint" in last) || !last.checkpoint) throw new Error("missing retained pending");
    expect(last.checkpoint.mutationGate?.verificationTargets?.[0].sha256).toBe(sha256);
    expect(last.checkpoint.mutationGate?.verifiedPaths).toEqual([]);
  });

  it("真实checkpoint tools和配对前缀用于摘要，窗口失败不保存新投影", async function summarySnapshot() {
    const workspaceRoot = await fixture();
    await writeFile(path.join(workspaceRoot, "sample.txt"), "sample");
    let samples = 0;
    const runtime = createAgentRuntime({ workspaceRoot, modelSampler: { async sample() {
      return ++samples === 1 ? { content: "", reasoningSummary: "", toolCalls: [{ id: "summary-read", name: "read_file", input: { path: "sample.txt" } }] } : { content: "observed sample", reasoningSummary: "", toolCalls: [] };
    } } });
    const original = checkpoint(await collect(runtime, { turnId: "summary", messages: [createAgentTextMessage("user", "inspect")] }), "turn_completed");
    original.messages.push(createAgentTextMessage("user", "latest task"));
    expect(original.samplingTools?.length).toBeGreaterThan(0);
    let stored = original;
    let saves = 0;
    const turn = { id: "summary", sessionId: "synthetic", frozenRunConfig: {}, frozenProviderConfig: { contextWindowTokens: 100_000 } };
    const coordinator = createTurnCompactionCoordinator({ turnStore: { async get() { return turn; } }, checkpointStore: { async getLatest() { return stored; }, async save(_session: string, value: AgentCheckpoint) { saves++; stored = value; } }, sessionStore: { async get() { return { persistenceMode: "ephemeral" }; } }, transcriptStore: { async getEvents() { return []; } }, eventSink: { async write() {} }, clock: { now() { return 0; }, timestamp() { return new Date(0).toISOString(); } } } as never, {}, { isActive() { return false; }, hasFresh() { return false; } } as never, {} as never);
    let summarySamples = 0;
    const sampler = { async sample(actual: AgentMessage[], tools: unknown) {
      summarySamples++;
      expect(actual.slice(0, original.messages.length)).toEqual(original.messages);
      expect(tools).toEqual(original.samplingTools);
      validateAgentMessages(actual);
      expect(getAgentMessageText(actual.at(-1)!)).toContain("压缩器");
      createAnthropicMessagesRequest("synthetic", actual, tools as never, {}, 100);
      return { content: "summary", reasoningSummary: "", toolCalls: [] };
    } };
    await coordinator.compact({ sessionId: "synthetic", turnId: "summary", trigger: "manual", preserveRecentTurns: 1, targetTokens: 10_000, sampler });
    expect(saves).toBe(1);
    stored = original;
    const before = JSON.stringify(stored);
    turn.frozenProviderConfig.contextWindowTokens = 100;
    await expect(coordinator.compact({ sessionId: "synthetic", turnId: "summary", trigger: "manual", preserveRecentTurns: 1, targetTokens: 10_000, sampler })).rejects.toThrow("最小历史前缀");
    expect(summarySamples).toBe(1);
    expect(saves).toBe(1);
    expect(JSON.stringify(stored)).toBe(before);
  });
});
