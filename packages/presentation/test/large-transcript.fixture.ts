/** Stage 6 大转录夹具：固定覆盖 500 答复、1000 ToolCall、100 组探索、200 Thinking 与 50 Job。 */
import type { AgentEvent, AgentEventEnvelope } from "@autopilot-agent/core";
import type { PresentationInput } from "../src/input.js";

const SESSION_ID = "session-large-transcript";
const TURN_ID = "turn-large-transcript";
const START_TIME = Date.parse("2026-08-24T08:00:00.000Z");

/** 使用递增序号生成稳定的 Runtime 信封，保证 History replay 可重复。 */
function runtimeInput(seq: number, event: AgentEvent): PresentationInput {
  const envelope: AgentEventEnvelope = {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    seq,
    timestamp: new Date(START_TIME + seq).toISOString(),
    event,
  };
  return { kind: "runtime_event", envelope };
}

/** 生成带安全 display facts 的完成工具输入，刻意不包含原始输出。 */
function completedToolInput(seq: number, callId: string, toolName: "read_file" | "run_command", target: string): PresentationInput {
  return runtimeInput(seq, {
    type: "tool_result",
    turnId: TURN_ID,
    stepId: `tool-step-${callId}`,
    callId,
    toolName,
    retryCount: 0,
    summary: "RAW_TOOL_SUMMARY_MUST_NOT_RENDER",
    result: {
      status: "success",
      callId,
      toolName,
      output: "RAW_TOOL_OUTPUT_MUST_NOT_RENDER",
      meta: { durationMs: 1, inputHash: `hash-${callId}` },
      display: {
        titleKey: toolName === "read_file" ? "tool.read.completed" : "tool.command.completed",
        target,
        summary: toolName === "read_file" ? "1 line" : "Exit 0",
      },
    },
  });
}

/** 创建 Stage 6 固定规模的长转录；100 个 read pair 之间插入 command，使 grouping 恰为 100 组。 */
export function createLargeTranscriptFixture(): PresentationInput[] {
  const inputs: PresentationInput[] = [runtimeInput(0, { type: "turn_started", turnId: TURN_ID, stepCount: 0 })];
  let seq = 1;

  for (let index = 0; index < 200; index += 1) {
    inputs.push(runtimeInput(seq, { type: "reasoning_summary", turnId: TURN_ID, stepId: `thinking-${index}`, summary: `分析摘要 ${index}` }));
    seq += 1;
  }
  for (let index = 0; index < 500; index += 1) {
    inputs.push(runtimeInput(seq, { type: "answer_delta", turnId: TURN_ID, stepId: `answer-${index}`, delta: `答复片段 ${index}` }));
    seq += 1;
  }
  for (let groupIndex = 0; groupIndex < 100; groupIndex += 1) {
    for (let readIndex = 0; readIndex < 2; readIndex += 1) {
      const callId = `read-${groupIndex}-${readIndex}`;
      inputs.push(runtimeInput(seq, { type: "tool_started", turnId: TURN_ID, stepId: `tool-step-${callId}`, callId, toolName: "read_file", summary: "RAW_TOOL_START_MUST_NOT_RENDER" }));
      seq += 1;
      inputs.push(completedToolInput(seq, callId, "read_file", `src/read-${groupIndex}-${readIndex}.ts`));
      seq += 1;
    }
    const callId = `command-break-${groupIndex}`;
    inputs.push(runtimeInput(seq, { type: "tool_started", turnId: TURN_ID, stepId: `tool-step-${callId}`, callId, toolName: "run_command", summary: "RAW_COMMAND_START_MUST_NOT_RENDER" }));
    seq += 1;
    inputs.push(completedToolInput(seq, callId, "run_command", "npm test"));
    seq += 1;
  }
  for (let index = 0; index < 700; index += 1) {
    const callId = `command-${index}`;
    inputs.push(runtimeInput(seq, { type: "tool_started", turnId: TURN_ID, stepId: `tool-step-${callId}`, callId, toolName: "run_command", summary: "RAW_COMMAND_START_MUST_NOT_RENDER" }));
    seq += 1;
    inputs.push(completedToolInput(seq, callId, "run_command", "npm test"));
    seq += 1;
  }
  inputs.push(runtimeInput(seq, { type: "turn_completed", turnId: TURN_ID, checkpoint: {} }));
  for (let index = 0; index < 50; index += 1) {
    inputs.push({ kind: "host_event", event: { kind: "job", job: { jobId: `job-${index}`, sessionId: SESSION_ID, revision: 1, state: "completed", controlState: "terminal", canStop: false, updatedAt: index, finishedAt: index, title: `后台任务 ${index}`, summary: "已完成" } } });
  }
  return inputs;
}
