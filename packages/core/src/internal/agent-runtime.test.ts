/**
 * Agent Runtime 的 mutation gate 回归测试：明确否定写入时不得强制执行文件修改。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentTextMessage, getAgentMessageText, type AgentMessage } from "./types/agent-message";
import { migrateAgentMessages } from "../runtime/protocol/migrate-agent-messages";
import { AgentSampleError } from "./lib/llm";
import type { AgentModelToolDefinition, AgentSampleResult } from "./lib/llm";
import type { ModelSampler } from "./kernel/model-sampler";
import * as runtimeLimits from "../runtime/config/runtime-limits";

const mocks = vi.hoisted(function createAgentRuntimeMocks() {
  return {
    sample: vi.fn(),
  };
});

import { createAgentRuntime, type RagCapability } from "./agent-runtime";

/** 为 Runtime 注入 V2 ModelSampler，避免测试依赖已删除的 Chat wire 入口。 */
function createTestRuntime(options: Parameters<typeof createAgentRuntime>[0] = {}) {
  const modelSampler: ModelSampler = { sample: mocks.sample };
  return createAgentRuntime({ ...options, modelSampler });
}

/** 收集一次受控 Agent turn 的全部事件，避免连接真实模型。 */
async function collectEvents(messages: unknown[]) {
  const events = [];
  const runtime = createTestRuntime();
  const migrated = migrateAgentMessages({ messages });
  if (!migrated.ok) throw new Error(migrated.message);
  for await (const event of runtime.run({ turnId: "mutation-gate-test", messages: migrated.messages })) events.push(event);
  return events;
}

/** 构造只返回自然语言答复的受控模型采样结果。 */
function mockPlainAnswer(content: string) {
  mocks.sample.mockImplementation(async function mockedSample(
    _messages: AgentMessage[],
    _tools: AgentModelToolDefinition[],
    _options: Parameters<ModelSampler["sample"]>[2],
    onContentDelta?: (delta: string) => void,
  ): Promise<AgentSampleResult> {
    onContentDelta?.(content);
    return { content, toolCalls: [], reasoningSummary: "" };
  });
}

/** 构造一个带工具调用的受控采样结果，用于覆盖跨 Runtime checkpoint 恢复。 */
function mockToolCall(name: string, input: Record<string, unknown>, id: string): void {
  mocks.sample.mockImplementationOnce(async function mockedToolCall(): Promise<AgentSampleResult> {
    return { content: "", toolCalls: [{ id, name, input }], reasoningSummary: "" };
  });
}

describe("Agent Runtime mutation gate", function mutationGateSuite() {
  it("首轮系统提示词固定声明 Autopilot 产品身份", async function declaresAutopilotIdentity() {
    mockPlainAnswer("我是 Autopilot。");

    await collectEvents([{ role: "user", content: "你是谁？" }]);
    const sampledMessages = mocks.sample.mock.calls.at(-1)?.[0] as AgentMessage[];
    const systemPrompt = sampledMessages.filter(function selectSystem(message) { return message.role === "system"; }).map(getAgentMessageText).join("\n");

    expect(systemPrompt).toContain("你的产品身份是 Autopilot");
    expect(systemPrompt).toContain("底层模型供应商不改变 Autopilot 的产品身份");
    expect(systemPrompt).toContain("任何 write_file 或 edit_file 成功后，必须立即");
    expect(systemPrompt).toContain("Todo 使用策略");
    expect(systemPrompt).toContain("只读不等于简单：多阶段只读分析也应建表");
    expect(systemPrompt).toContain("难以判断时使用 todo_write");
    expect(systemPrompt).toContain("简单问答或纯对话时跳过");
    expect(systemPrompt).toContain("start 成功只表示任务已启动");
    expect(systemPrompt).toContain("声称完成前必须用 read_background_job 重读真实终态");
    expect(systemPrompt).toContain("新一轮继续后台任务时先 list_background_jobs/read_background_job");
  });

  it("不会把明确否定的只读指令误判为写入任务", async function negatedReadOnlyTask() {
    mockPlainAnswer("已完成只读检查。");

    const events = await collectEvents([{ role: "user", content: "请只使用 glob_files 查找 0730-readonly-fixture.md，再使用 read_file 读取它并简要说明。不要修改、创建、删除任何文件，也不要调用 run_command。" }]);
    const completed = events.find(function findCompletion(event) { return event.type === "turn_completed"; });

    expect(events.some(function hasDiscard(event) { return event.type === "answer_discard"; })).toBe(false);
    expect(events.some(function hasFailure(event) { return event.type === "turn_failed"; })).toBe(false);
    expect(completed?.type).toBe("turn_completed");
    expect(completed?.type === "turn_completed" && completed.checkpoint.mutationGate?.required).toBe(false);
  });

  it("不会把只读 Skill 分析误判为必须写入工作区", async function readOnlySkillAnalysis() {
    mockPlainAnswer("Skill 发现和调用结果正确。没有修改文件。");

    const events = await collectEvents([{ role: "user", content: "请只读分析当前工作区的 Skill 发现和调用结果，不修改任何文件。" }]);
    const completed = events.find(function findCompletion(event) { return event.type === "turn_completed"; });

    expect(events.some(function hasFailure(event) { return event.type === "turn_failed"; })).toBe(false);
    expect(completed?.type).toBe("turn_completed");
    expect(completed?.type === "turn_completed" && completed.checkpoint.mutationGate?.required).toBe(false);
  });

  it("历史控制台创建叙述加明确不改代码声明时不撤回答案", async function historicalConsoleActionWithReadOnlyDeclaration() {
    mockPlainAnswer("数据库创建过程与只读结论已说明。");

    const events = await collectEvents([{ role: "user", content: "我在 Neon 官网控制台创建了一个数据库……这次不改代码。" }]);
    const completed = events.find(function findCompletion(event) { return event.type === "turn_completed"; });

    expect(events.some(function hasDiscard(event) { return event.type === "answer_discard"; })).toBe(false);
    expect(events.some(function hasFailure(event) { return event.type === "turn_failed"; })).toBe(false);
    expect(completed?.type).toBe("turn_completed");
    expect(completed?.type === "turn_completed" && completed.checkpoint.mutationGate?.required).toBe(false);
  });

  it("混合写入指令未产生真实写入时按模型终答", async function mixedMutationTaskWithoutWrite() {
    mockPlainAnswer("已完成。");

    const events = await collectEvents([{ role: "user", content: "不要修改旧文件，但请创建新报告。" }]);
    const completed = events.find(function findCompletion(event) { return event.type === "turn_completed"; });

    expect(events.some(function hasDiscard(event) { return event.type === "answer_discard"; })).toBe(false);
    expect(events.some(function hasFailure(event) { return event.type === "turn_failed"; })).toBe(false);
    expect(completed?.type).toBe("turn_completed");
    expect(completed?.type === "turn_completed" && completed.checkpoint.mutationGate?.required).toBe(false);
  });

  it("明确写入任务但模型零工具调用时不由宿主语义门禁撤回答案", async function explicitWriteIntentWithoutToolCallCompletes() {
    mockPlainAnswer("已经把小球改成蓝色了。");

    const events = await collectEvents([{ role: "user", content: "请把 red-ball-drag.html 里小球的颜色改成蓝色。" }]);
    const completed = events.find(function findCompletion(event) { return event.type === "turn_completed"; });

    expect(events.some(function hasDiscard(event) { return event.type === "answer_discard"; })).toBe(false);
    expect(events.some(function hasFailure(event) { return event.type === "turn_failed"; })).toBe(false);
    expect(completed?.type).toBe("turn_completed");
    expect(completed?.type === "turn_completed" && completed.checkpoint.mutationGate?.required).toBe(false);
  });

  it("不会把生成报告类只读任务误判为写入任务", async function readOnlyReportTask() {
    mockPlainAnswer("已完成只读报告。");

    const events = await collectEvents([{ role: "user", content: "请随机读取当前工作区的 3 个 HTML 文件，生成一份详细报告：每个文件列出 title、核心功能、交互行为、外部依赖和潜在风险。使用 Markdown 表格，内容尽量完整并持续输出，不要修改文件。" }]);
    const completed = events.find(function findCompletion(event) { return event.type === "turn_completed"; });

    expect(events.some(function hasDiscard(event) { return event.type === "answer_discard"; })).toBe(false);
    expect(events.some(function hasFailure(event) { return event.type === "turn_failed"; })).toBe(false);
    expect(completed?.type).toBe("turn_completed");
    expect(completed?.type === "turn_completed" && completed.checkpoint.mutationGate?.required).toBe(false);
  });

  it("生成文件要求但模型未调用写入工具时按模型终答", async function generatedFileRequestWithoutWriteCompletes() {
    mockPlainAnswer("已完成。");

    const events = await collectEvents([{ role: "user", content: "请在工作区生成一个 hello.html 文件，内容是简单页面。" }]);
    const completed = events.find(function findCompletion(event) { return event.type === "turn_completed"; });

    expect(events.some(function hasFailure(event) { return event.type === "turn_failed"; })).toBe(false);
    expect(events.some(function hasDiscard(event) { return event.type === "answer_discard"; })).toBe(false);
    expect(completed?.type).toBe("turn_completed");
    expect(completed?.type === "turn_completed" && completed.checkpoint.mutationGate?.required).toBe(false);
  });

  it("写入后未读回验证不宣称完成而进入待验证暂停", async function unverifiedWritePauses() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-unverified-"));
    const fixturePath = path.join(workspaceRoot, "fixture.txt");
    await writeFile(fixturePath, "before\n", "utf8");
    mocks.sample.mockReset();
    mockToolCall("read_file", { path: "fixture.txt", limit: 100 }, "read-before-edit");
    mockToolCall("edit_file", { path: "fixture.txt", oldString: "before", newString: "after" }, "edit-unverified");
    mockPlainAnswer("修改完成。");

    try {
      const events = [];
      const runtime = createTestRuntime({ workspaceRoot, permissionMode: "auto_approve", workspaceTrusted: true });
      for await (const event of runtime.run({ turnId: "unverified-write-test", messages: [createAgentTextMessage("user", "请修改 fixture.txt 的内容。")] })) events.push(event);
      const paused = events.find(function findPause(event) { return event.type === "turn_interrupted"; });
      expect(paused).toMatchObject({ checkpoint: { status: "interrupted_recoverable", interruptionReason: "write_verification" } });
      expect(events.some(function completed(event) { return event.type === "turn_completed"; })).toBe(false);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("Agent Runtime context overflow", function contextOverflowSuite() {
  it("将供应商 context overflow 交给宿主 reactive compact，且不进入普通输出恢复重试", async function delegatesReactiveCompact() {
    mocks.sample.mockReset();
    mocks.sample.mockRejectedValueOnce(new AgentSampleError("context overflow", "CONTEXT_OVERFLOW"));

    const events = await collectEvents([{ role: "user", content: "请回答一个简短问题。" }]);
    const overflow = events.find(function findOverflow(event) { return event.type === "context_overflow"; });

    expect(overflow?.type).toBe("context_overflow");
    expect(events.some(function hasRecovery(event) { return event.type === "model_recovery"; })).toBe(false);
    expect(events.some(function hasFailure(event) { return event.type === "turn_failed"; })).toBe(false);
    expect(mocks.sample).toHaveBeenCalledTimes(1);
  });
});

describe("Agent Runtime active Skills", function activeSkillsSuite() {
  it("首轮传入的 Skill 投影会写入完成 checkpoint", async function persistsInitialActiveSkills() {
    mockPlainAnswer("已完成。");
    const runtime = createTestRuntime();
    const events = [];
    const activeSkills = [{ skillId: "skill-0730", contentHash: "hash-0730" }];

    for await (const event of runtime.run({ turnId: "active-skills-test", messages: [createAgentTextMessage("user", "请简短确认。")], activeSkills })) events.push(event);

    const completed = events.find(function findCompletion(event) { return event.type === "turn_completed"; });
    expect(completed?.type === "turn_completed" && completed.checkpoint.activeSkills).toEqual(activeSkills);
  });
});

describe("Agent Runtime approval resume", function approvalResumeSuite() {
  it("恢复审批时保留 read_file 观察状态，并继续执行冻结的 edit_file", async function preservesFileReadState() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-approval-"));
    const fixturePath = path.join(workspaceRoot, "fixture.txt");
    await writeFile(fixturePath, "before\n", "utf8");
    mocks.sample.mockReset();
    mockToolCall("read_file", { path: "fixture.txt", limit: 100 }, "read-1");
    mockToolCall("edit_file", { path: "fixture.txt", oldString: "before", newString: "after" }, "edit-1");

    try {
      const initialEvents = [];
      const initialRuntime = createTestRuntime({ workspaceRoot, validateApproval: async function validateApproval() { return true; } });
      for await (const event of initialRuntime.run({ turnId: "approval-resume-test", messages: [createAgentTextMessage("user", "请修改 fixture.txt，并在修改后读取验证。")] })) initialEvents.push(event);
      const paused = initialEvents.find(function findPause(event) { return event.type === "turn_paused"; });

      expect(paused?.type).toBe("turn_paused");
      expect(paused?.type === "turn_paused" && paused.checkpoint.fileReadStates).toEqual([expect.objectContaining({ path: "fixture.txt", observedRanges: [{ startLine: 1, endLine: 2 }] })]);

      mockToolCall("read_file", { path: "fixture.txt", limit: 100 }, "verify-1");
      mockPlainAnswer("修改并验证完成。");
      const resumedEvents = [];
      const resumedRuntime = createTestRuntime({ workspaceRoot, validateApproval: async function validateApproval() { return true; } });
      if (paused?.type !== "turn_paused") throw new Error("approval checkpoint missing");
      for await (const event of resumedRuntime.run({ checkpoint: paused.checkpoint, approval: { approvalId: "approval-1", decision: "allow_once" } })) resumedEvents.push(event);

      expect(resumedEvents.some(function hasEditResult(event) { return event.type === "tool_result" && event.toolName === "edit_file" && event.result.status === "success"; })).toBe(true);
      expect(resumedEvents.some(function hasCompletion(event) { return event.type === "turn_completed"; })).toBe(true);
      expect(await readFile(fixturePath, "utf8")).toBe("after\n");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("Agent Runtime limit resume", function limitResumeSuite() {
  it("从达到上限的 checkpoint 恢复时给予新的步骤预算，且不重放已完成工具", async function resumesWithNewStepBudget() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-limit-"));
    const fixturePath = path.join(workspaceRoot, "fixture.txt");
    await writeFile(fixturePath, "LIMIT_CONTINUE_0730\n", "utf8");
    mocks.sample.mockReset();
    mockToolCall("read_file", { path: "fixture.txt", limit: 100 }, "read-1");

    try {
      const initialEvents = [];
      const initialRuntime = createTestRuntime({ workspaceRoot });
      for await (const event of initialRuntime.run({ turnId: "limit-resume-test", maxSteps: 1, messages: [createAgentTextMessage("user", "请读取 fixture.txt。")] })) initialEvents.push(event);
      const limited = initialEvents.find(function findLimit(event) { return event.type === "turn_limit_reached"; });

      expect(limited?.type).toBe("turn_limit_reached");
      expect(limited?.type === "turn_limit_reached" && limited.checkpoint.stepCount).toBe(1);
      expect(initialEvents.filter(function hasReadResult(event) { return event.type === "tool_result" && event.toolName === "read_file"; })).toHaveLength(1);

      mockPlainAnswer("读取完成：LIMIT_CONTINUE_0730。");
      const resumedEvents = [];
      const resumedRuntime = createTestRuntime({ workspaceRoot });
      if (limited?.type !== "turn_limit_reached") throw new Error("limit checkpoint missing");
      for await (const event of resumedRuntime.run({ checkpoint: limited.checkpoint, maxSteps: 1 })) resumedEvents.push(event);

      const completed = resumedEvents.find(function findCompletion(event) { return event.type === "turn_completed"; });
      expect(resumedEvents.some(function repeatsRead(event) { return event.type === "tool_started" && event.toolName === "read_file"; })).toBe(false);
      expect(completed?.type).toBe("turn_completed");
      expect(completed?.type === "turn_completed" && completed.checkpoint.stepCount).toBe(1);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("未显式配置 maxSteps 时超过旧默认步数仍可完成", async function continuesPastLegacyDefaultStepCount() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-unbounded-"));
    const fixturePath = path.join(workspaceRoot, "fixture.txt");
    const readCount = 21;
    await writeFile(fixturePath, "UNBOUNDED_STEP_FIXTURE\n", "utf8");
    mocks.sample.mockReset();
    let sampleCount = 0;
    mocks.sample.mockImplementation(async function mockedLongChainSample(): Promise<AgentSampleResult> {
      sampleCount += 1;
      if (sampleCount <= readCount) return { content: "", toolCalls: [{ id: `read-${sampleCount}`, name: "read_file", input: { path: "fixture.txt", offset: sampleCount, limit: 1 } }], reasoningSummary: "" };
      return { content: "读取完成。", toolCalls: [], reasoningSummary: "" };
    });

    try {
      const events = [];
      const runtime = createTestRuntime({ workspaceRoot, permissionMode: "auto_approve", workspaceTrusted: true });
      for await (const event of runtime.run({ turnId: "unbounded-step-test", messages: [createAgentTextMessage("user", "请持续读取 fixture.txt 并完成任务。")] })) events.push(event);

      expect(events.some(function hasLimit(event) { return event.type === "turn_limit_reached"; })).toBe(false);
      expect(events.filter(function hasReadResult(event) { return event.type === "tool_result" && event.toolName === "read_file"; })).toHaveLength(readCount);
      expect(events.some(function hasCompletion(event) { return event.type === "turn_completed"; })).toBe(true);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("恢复时不重新解析已冻结的 maxSteps", async function keepsFrozenStepLimitAcrossRecovery() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-frozen-limit-"));
    await writeFile(path.join(workspaceRoot, "fixture.txt"), "FROZEN_LIMIT_FIXTURE\n", "utf8");
    mocks.sample.mockReset();
    let sampleCount = 0;
    mocks.sample.mockImplementation(async function mockedFrozenLimitSample(): Promise<AgentSampleResult> {
      sampleCount += 1;
      if (sampleCount <= 2) return { content: "", toolCalls: [{ id: `frozen-read-${sampleCount}`, name: "read_file", input: { path: "fixture.txt", offset: sampleCount, limit: 1 } }], reasoningSummary: "读取" };
      return { content: "读取完成。", toolCalls: [], reasoningSummary: "完成" };
    });
    const resolver = vi.spyOn(runtimeLimits, "resolveAgentRuntimeLimits").mockImplementation(function shouldNotResolveFrozenLimits() {
      throw new Error("已冻结的 Runtime 不应再次解析运行限制");
    });

    try {
      const events = [];
      const runtime = createTestRuntime({ workspaceRoot, permissionMode: "auto_approve", workspaceTrusted: true });
      for await (const event of runtime.run({ turnId: "frozen-limit-test", messages: [createAgentTextMessage("user", "持续读取 fixture.txt。")], runtimeLimitsResolved: true, maxSteps: undefined, maxToolRetries: 5 })) events.push(event);

      expect(events.filter(function countReadResults(event) { return event.type === "tool_result" && event.toolName === "read_file"; })).toHaveLength(2);
      expect(events.some(function hasLimit(event) { return event.type === "turn_limit_reached"; })).toBe(false);
      expect(events.some(function hasCompletion(event) { return event.type === "turn_completed"; })).toBe(true);
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      resolver.mockRestore();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("真实 edit_file 写入并读回验证后正常完成", async function verifiedWriteCompletes() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-verified-"));
    const fixturePath = path.join(workspaceRoot, "fixture.txt");
    await writeFile(fixturePath, "before\n", "utf8");
    mocks.sample.mockReset();
    mockToolCall("read_file", { path: "fixture.txt", limit: 100 }, "read-before-verified-edit");
    mockToolCall("edit_file", { path: "fixture.txt", oldString: "before", newString: "after" }, "edit-verified");
    mockToolCall("read_file", { path: "fixture.txt", limit: 100 }, "read-after-verified-edit");
    mockPlainAnswer("修改完成。");

    try {
      const events = [];
      const runtime = createTestRuntime({ workspaceRoot, permissionMode: "auto_approve", workspaceTrusted: true });
      for await (const event of runtime.run({ turnId: "verified-write-test", messages: [createAgentTextMessage("user", "请修改 fixture.txt 的内容。")] })) events.push(event);
      const completed = events.find(function findCompletion(event) { return event.type === "turn_completed"; });

      expect(events.some(function hasFailure(event) { return event.type === "turn_failed"; })).toBe(false);
      expect(completed?.type).toBe("turn_completed");
      expect(completed?.type === "turn_completed" && completed.checkpoint.mutationGate?.required).toBe(true);
      expect(completed?.type === "turn_completed" && completed.checkpoint.mutationGate?.changedPaths).toContain("fixture.txt");
      expect(completed?.type === "turn_completed" && completed.checkpoint.mutationGate?.verifiedPaths).toContain("fixture.txt");
      expect(await readFile(fixturePath, "utf8")).toBe("after\n");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("同一路径再次写入撤销验证，有限纠正后可恢复且继续只允许读回", async function repeatedWriteInvalidatesVerification() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-repeated-write-"));
    const fixturePath = path.join(workspaceRoot, "fixture.txt");
    await writeFile(fixturePath, "before\n", "utf8");
    mocks.sample.mockReset();
    mockToolCall("read_file", { path: "fixture.txt", limit: 100 }, "read-before-repeat");
    mockToolCall("edit_file", { path: "fixture.txt", oldString: "before", newString: "after" }, "edit-first");
    mockToolCall("read_file", { path: "fixture.txt", limit: 100 }, "read-first-write");
    mockToolCall("edit_file", { path: "fixture.txt", oldString: "after", newString: "again" }, "edit-second");
    mockPlainAnswer("修改完成。");

    try {
      const events = [];
      const runtime = createTestRuntime({ workspaceRoot, permissionMode: "auto_approve", workspaceTrusted: true });
      for await (const event of runtime.run({ turnId: "repeated-write-test", messages: [createAgentTextMessage("user", "请修改 fixture.txt 的内容。再检查一次。")] })) events.push(event);
      const failed = events.find(function findPause(event) { return event.type === "turn_interrupted"; });

      expect(events.filter(function countDiscard(event) { return event.type === "answer_discard"; })).toHaveLength(2);
      expect(failed?.type).toBe("turn_interrupted");
      if (failed?.type !== "turn_interrupted") throw new Error("verification checkpoint missing");
      expect(failed.checkpoint).toMatchObject({ status: "interrupted_recoverable", interruptionReason: "write_verification" });
      expect(failed.checkpoint.mutationGate?.changedPaths).toContain("fixture.txt");
      expect(failed.checkpoint.mutationGate?.verifiedPaths).not.toContain("fixture.txt");
      expect(failed.checkpoint.mutationGate?.recoveryAttempts).toBe(1);
      expect(getAgentMessageText(failed.checkpoint.messages.at(-1)!)).toContain('"fixture.txt"');
      mocks.sample.mockReset();
      mockToolCall("edit_file", { path: "fixture.txt", oldString: "again", newString: "forbidden" }, "resume-write-forbidden");
      mockToolCall("read_file", { path: "fixture.txt", limit: 100 }, "resume-verify");
      mockPlainAnswer("验证完成。");
      const resumed = [];
      for await (const event of runtime.run({ checkpoint: failed.checkpoint })) resumed.push(event);
      expect(resumed).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_result", callId: "resume-write-forbidden", result: expect.objectContaining({ status: "denied" }) })]));
      const completed = resumed.find(function findCompletion(event) { return event.type === "turn_completed"; });
      expect(completed?.type).toBe("turn_completed");
      expect(completed?.type === "turn_completed" && completed.checkpoint.completedCallIds).toEqual(expect.arrayContaining(["edit-first", "edit-second", "resume-verify"]));
      expect(await readFile(fixturePath, "utf8")).toBe("again\n");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("Agent Runtime Stage 2 safety guardrails", function safetyGuardrailSuite() {
  it("不同工具参数取得进展时不会误触发重复调用暂停", async function doesNotPauseForProgress() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-progress-"));
    await writeFile(path.join(workspaceRoot, "one.txt"), "one\n", "utf8");
    await writeFile(path.join(workspaceRoot, "two.txt"), "two\n", "utf8");
    mocks.sample.mockReset();
    let sampleCount = 0;
    mocks.sample.mockImplementation(async function mockedProgressSample(): Promise<AgentSampleResult> {
      sampleCount += 1;
      if (sampleCount === 1) return { content: "", toolCalls: [{ id: "progress-1", name: "read_file", input: { path: "one.txt", limit: 100 } }], reasoningSummary: "读取第一份事实" };
      if (sampleCount === 2) return { content: "", toolCalls: [{ id: "progress-2", name: "read_file", input: { path: "two.txt", limit: 100 } }], reasoningSummary: "读取第二份事实" };
      return { content: "已完成。", toolCalls: [], reasoningSummary: "完成" };
    });

    try {
      const events = [];
      const runtime = createTestRuntime({ workspaceRoot, permissionMode: "auto_approve", workspaceTrusted: true });
      for await (const event of runtime.run({ turnId: "progress-guardrail-test", messages: [createAgentTextMessage("user", "读取两份文件并完成任务。")] })) events.push(event);

      expect(events.some(function hasRepeatedPause(event) { return event.type === "turn_interrupted" && event.checkpoint.interruptionReason === "repeated_tool_calls"; })).toBe(false);
      expect(events.filter(function hasReadResult(event) { return event.type === "tool_result" && event.toolName === "read_file"; })).toHaveLength(2);
      expect(events.some(function hasCompletion(event) { return event.type === "turn_completed"; })).toBe(true);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("连续相同工具调用按 3/5/8 阈值提醒并进入可恢复暂停", async function pausesRepeatedCalls() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-repeat-"));
    await writeFile(path.join(workspaceRoot, "repeat.txt"), "same\n", "utf8");
    mocks.sample.mockReset();
    let sampleCount = 0;
    mocks.sample.mockImplementation(async function mockedRepeatSample(): Promise<AgentSampleResult> {
      sampleCount += 1;
      return { content: "", toolCalls: [{ id: `repeat-${sampleCount}`, name: "read_file", input: { path: "repeat.txt", limit: 100 } }], reasoningSummary: "重复读取" };
    });

    try {
      const events = [];
      const runtime = createTestRuntime({ workspaceRoot, permissionMode: "auto_approve", workspaceTrusted: true });
      for await (const event of runtime.run({ turnId: "repeat-guardrail-test", messages: [createAgentTextMessage("user", "持续读取并核对结果。")]})) events.push(event);

      const interrupted = events.find(function findRepeatedPause(event) { return event.type === "turn_interrupted" && event.checkpoint.interruptionReason === "repeated_tool_calls"; });
      expect(interrupted?.type).toBe("turn_interrupted");
      expect(interrupted?.type === "turn_interrupted" && interrupted.checkpoint.status).toBe("interrupted_recoverable");
      expect(events.filter(function countReadResults(event) { return event.type === "tool_result" && event.toolName === "read_file"; })).toHaveLength(8);
      const sampledMessages = mocks.sample.mock.calls.map(function getMessages(call) { return call[0] as AgentMessage[]; });
      expect(sampledMessages[3]?.some(function hasReminder(message) { return getAgentMessageText(message).includes("提醒：检测到工具调用与结果连续重复"); })).toBe(true);
      expect(sampledMessages[5]?.some(function hasStrongReminder(message) { return getAgentMessageText(message).includes("强提醒：工具调用与结果连续重复"); })).toBe(true);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("默认不因多次低水位 usage 累加误停", async function keepsStableLowWaterRunning() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-low-water-"));
    const lines = Array.from({ length: 50 }, function createBudgetLine(_unused, index) { return `line-${index + 1}`; });
    await writeFile(path.join(workspaceRoot, "budget.txt"), lines.join("\n"), "utf8");
    mocks.sample.mockReset();
    let sampleCount = 0;
    mocks.sample.mockImplementation(async function mockedLowWaterSample(): Promise<AgentSampleResult> {
      sampleCount += 1;
      if (sampleCount <= 50) {
        return {
          content: "",
          toolCalls: [{ id: `low-water-read-${sampleCount}`, name: "read_file", input: { path: "budget.txt", limit: sampleCount } }],
          reasoningSummary: "读取下一行",
          usage: { inputTokens: 45_000, outputTokens: 0, contextTokens: 45_000 },
        };
      }
      return { content: "低水位长链已完成。", toolCalls: [], reasoningSummary: "完成" };
    });

    try {
      const events = [];
      const runtime = createTestRuntime({ workspaceRoot, permissionMode: "auto_approve", workspaceTrusted: true });
      for await (const event of runtime.run({
        turnId: "token-low-water-test",
        runtimeLimitsResolved: true,
        maxToolRetries: 5,
        messages: [createAgentTextMessage("user", "持续进行 50 次小步读取。")],
      })) events.push(event);

      const completed = events.find(function findCompletion(event) { return event.type === "turn_completed"; });
      expect(sampleCount).toBe(51);
      expect(events.filter(function countReads(event) { return event.type === "tool_result" && event.toolName === "read_file"; })).toHaveLength(50);
      expect(events.some(function hasTokenPause(event) { return event.type === "turn_interrupted" && event.checkpoint.interruptionReason === "token_budget"; })).toBe(false);
      expect(completed?.type).toBe("turn_completed");
      expect(completed?.type === "turn_completed" && completed.checkpoint.runtimeBudget?.totalTokens).toBe(2_250_000);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("显式累计 token 上限耗尽后写入不可继续终态", async function endsTurnWhenExplicitTokenBudgetIsExhausted() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-token-budget-"));
    await writeFile(path.join(workspaceRoot, "budget.txt"), "budget\n", "utf8");
    mocks.sample.mockReset();
    mocks.sample.mockImplementationOnce(async function firstBudgetSample(): Promise<AgentSampleResult> {
      return { content: "", toolCalls: [{ id: "budget-read", name: "read_file", input: { path: "budget.txt", limit: 100 } }], reasoningSummary: "读取", usage: { inputTokens: 3, outputTokens: 2, contextTokens: 5 } };
    });

    try {
      const firstEvents = [];
      const runtime = createTestRuntime({ workspaceRoot, permissionMode: "auto_approve", workspaceTrusted: true });
      for await (const event of runtime.run({ turnId: "token-budget-test", maxTotalTokens: 5, messages: [createAgentTextMessage("user", "读取预算文件并完成。")]})) firstEvents.push(event);
      const failed = firstEvents.find(function findTokenFailure(event) { return event.type === "turn_failed" && event.checkpoint.status === "failed"; });

      expect(failed?.type).toBe("turn_failed");
      expect(firstEvents.filter(function countReads(event) { return event.type === "tool_result" && event.toolName === "read_file"; })).toHaveLength(1);
      expect(firstEvents.some(function hasLimit(event) { return event.type === "turn_limit_reached"; })).toBe(false);
      expect(firstEvents.some(function hasRecoverableTokenPause(event) { return event.type === "turn_interrupted" && event.checkpoint.interruptionReason === "token_budget"; })).toBe(false);
      expect(failed?.type === "turn_failed" && failed.checkpoint.runtimeBudget?.totalTokens).toBe(5);
      expect(failed?.type === "turn_failed" && failed.checkpoint.safetyBudgetVersion).toBe(2);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("重复提交同一 Todo 快照不会清零重复调用护栏", async function countsUnchangedTodoWritesAsRepetition() {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-todo-repeat-"));
    await writeFile(path.join(workspaceRoot, "todo.txt"), "todo\n", "utf8");
    mocks.sample.mockReset();
    let sampleCount = 0;
    const todos = [{ content: "保持当前进度", activeForm: "正在保持当前进度", status: "in_progress" as const }];
    mocks.sample.mockImplementation(async function mockedUnchangedTodoSample(): Promise<AgentSampleResult> {
      sampleCount += 1;
      return { content: "", toolCalls: [{ id: `todo-repeat-${sampleCount}`, name: "todo_write", input: { todos } }], reasoningSummary: "重复提交 Todo" };
    });

    try {
      const events = [];
      const runtime = createTestRuntime({ workspaceRoot, permissionMode: "auto_approve", workspaceTrusted: true });
      for await (const event of runtime.run({ turnId: "todo-repeat-test", messages: [createAgentTextMessage("user", "持续维护当前任务进度。")], runtimeLimitsResolved: true, maxToolRetries: 5 })) events.push(event);

      const interrupted = events.find(function findRepeatedPause(event) { return event.type === "turn_interrupted" && event.checkpoint.interruptionReason === "repeated_tool_calls"; });
      expect(interrupted?.type).toBe("turn_interrupted");
      expect(events.filter(function countTodoResults(event) { return event.type === "tool_result" && event.toolName === "todo_write"; })).toHaveLength(9);
      expect(events.filter(function countTodoUpdates(event) { return event.type === "todo_updated"; })).toHaveLength(9);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("Agent Runtime Stage 3 compact continuity", function compactContinuitySuite() {
  it("auto compact 后保持同一 Turn、Todo 快照和已完成工具事实", async function continuesAfterAutoCompact() {
    mocks.sample.mockReset();
    let sampleCount = 0;
    let compacted = false;
    const todos = [{ content: "验证压缩后的任务状态", activeForm: "正在验证压缩后的任务状态", status: "in_progress" as const }];
    mocks.sample.mockImplementation(async function mockedCompactSample(): Promise<AgentSampleResult> {
      sampleCount += 1;
      if (sampleCount === 1) return { content: "", toolCalls: [{ id: "compact-todo", name: "todo_write", input: { todos } }], reasoningSummary: "建立任务状态", usage: { inputTokens: 4, outputTokens: 1, contextTokens: 5 } };
      return { content: "压缩后已完成。", toolCalls: [], reasoningSummary: "完成", usage: { inputTokens: 4, outputTokens: 2, contextTokens: 6 } };
    });
    const runtime = createTestRuntime({
      contextCompaction: {
        shouldCompact(input) {
          return !compacted && input.messages.some(function hasTodoResult(message) { return message.role === "user" && message.content.some(function isTodoResult(block) { return block.type === "tool-result" && block.toolCallId === "compact-todo"; }); });
        },
        async compact() {
          compacted = true;
          return { outcome: "changed", summary: "已保留任务进度", messages: [createAgentTextMessage("system", "已压缩历史摘要：任务继续")], preTokens: 100, postTokens: 20, preservedFromIndex: 2 };
        },
      },
    });

    const events = [];
    for await (const event of runtime.run({ turnId: "auto-compact-continuity-test", messages: [createAgentTextMessage("user", "执行一个需要压缩的任务。")]})) events.push(event);
    const compactedEvent = events.find(function findCompacted(event) { return event.type === "context_compacted" && event.trigger === "auto"; });
    const completed = events.find(function findCompleted(event) { return event.type === "turn_completed"; });
    const secondMessages = mocks.sample.mock.calls[1]?.[0] as AgentMessage[];

    expect(compactedEvent?.type).toBe("context_compacted");
    expect(completed?.type).toBe("turn_completed");
    expect(events.filter(function countTodoStarts(event) { return event.type === "tool_started" && event.toolName === "todo_write"; })).toHaveLength(1);
    expect(completed?.type === "turn_completed" && completed.checkpoint.completedCallIds).toContain("compact-todo");
    expect(completed?.type === "turn_completed" && completed.checkpoint.todoSnapshot?.todos).toEqual(todos);
    expect(secondMessages.some(function hasTodoReminder(message) { return message.role === "system" && getAgentMessageText(message).includes("【Todo 快照】"); })).toBe(true);
    expect(events.every(function sameTurn(event) { return event.turnId === "auto-compact-continuity-test"; })).toBe(true);
  });
});

describe("Agent Runtime RAG capability boundary", function ragBoundarySuite() {
  it("只在注入有效视觉能力时注册 vision_analyze", function conditionallyRegistersVisionTool() {
    const definitions = createAgentRuntime({ visionAnalyzer: { async analyze() { return "fixture"; } } }).getToolDefinitions();
    expect(definitions.map(function getToolName(definition) { return definition.name; })).toContain("vision_analyze");
  });

  it("未注入 RAG 时只注册非 RAG 开发工具", function registersOnlyDevelopmentToolsWithoutRag() {
    const definitions = createAgentRuntime().getToolDefinitions();

    expect(definitions.map(function getToolName(definition) { return definition.name; })).toEqual([
      "glob_files",
      "grep_files",
      "read_file",
      "edit_file",
      "write_file",
      "run_command",
      "todo_write",
    ]);
  });

  it("显式注入旧 RAG 参数也不能恢复 Work 的私有检索工具", function rejectsLegacyRagCapability() {
    const ragCapability: RagCapability = {
      search: async function search() { return []; },
      searchAcrossTables: async function searchAcrossTables() { return { results: [] }; },
      prepareRagSearch: async function prepareRagSearch() { return { results: [] }; },
    };
    const definitions = createAgentRuntime({ rag: ragCapability }).getToolDefinitions();

    expect(definitions.map(function getToolName(definition) { return definition.name; })).toEqual([
      "glob_files",
      "grep_files",
      "read_file",
      "edit_file",
      "write_file",
      "run_command",
      "todo_write",
    ]);
  });
});
