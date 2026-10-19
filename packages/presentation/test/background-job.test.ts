/** Stage2 Presentation Job 测试：验证 Tool 安全事实与 Host revision 状态不会混入 Runtime 身份。 */

import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope } from "@autopilot-agent/core";
import { createPresentationState } from "../src/model.js";
import { reducePresentationInput } from "../src/reducer.js";

/** 创建只携带安全 Job display facts 的 Runtime 工具结果信封。 */
function jobToolEnvelope(): AgentEventEnvelope {
  return {
    sessionId: "s1",
    turnId: "t1",
    seq: 1,
    timestamp: "2026-09-09T00:00:00.000Z",
    event: {
      type: "tool_result",
      turnId: "t1",
      stepId: "step-1",
      callId: "call-1",
      toolName: "start_background_job",
      retryCount: 0,
      summary: "RAW_SUMMARY_MUST_NOT_RENDER",
      result: {
        status: "success",
        callId: "call-1",
        toolName: "start_background_job",
        output: { program: "PRIVATE_PROGRAM", args: ["PRIVATE_ARG"] },
        meta: { durationMs: 1, inputHash: "hash" },
        display: { titleKey: "tool.job.start.completed", target: "powershell", summary: "job-1 · 当前状态：running", job: { action: "start", jobId: "job-1", programLabel: "powershell", observedStatus: "running" } },
      },
    },
  };
}

describe("Stage2 Presentation jobs", function suite() {
  it("只投影 ToolDisplayFacts 中的 Job 引用，不读取 raw output", function projectsSafeToolFacts() {
    const state = reducePresentationInput(createPresentationState(), { kind: "runtime_event", envelope: jobToolEnvelope() });
    const tool = state.items.find(function match(item) { return item.kind === "tool_call" && item.callId === "call-1"; });
    expect(tool).toMatchObject({ kind: "tool_call", titleKey: "tool.job.start.completed", target: "powershell", job: { action: "start", jobId: "job-1", programLabel: "powershell", observedStatus: "running" } });
    expect(JSON.stringify(tool)).not.toMatch(/PRIVATE_PROGRAM|PRIVATE_ARG|RAW_SUMMARY/);
  });

  it("Host Job 用 revision 拒绝迟到状态且不占 Runtime seq", function rejectsStaleHostState() {
    const initial = createPresentationState();
    const newer = reducePresentationInput(initial, { kind: "host_event", event: { kind: "job", job: { jobId: "job-1", sessionId: "s1", revision: 3, state: "stopping", controlState: "owned", canStop: true, updatedAt: 3 } } });
    const stale = reducePresentationInput(newer, { kind: "host_event", event: { kind: "job", job: { jobId: "job-1", sessionId: "s1", revision: 2, state: "running", controlState: "owned", canStop: true, updatedAt: 2 } } });
    expect(stale.items.find(function match(item) { return item.kind === "job" && item.jobId === "job-1"; })).toMatchObject({ revision: 3, state: "stopping" });
    expect(stale.lastSeqByTurn).toEqual({});
    const crossSession = reducePresentationInput(stale, { kind: "host_event", event: { kind: "job", job: { jobId: "job-1", sessionId: "s2", revision: 4, state: "completed", controlState: "terminal", canStop: false, updatedAt: 4, finishedAt: 4 } } });
    expect(crossSession).toEqual(stale);
    const bound = { ...initial, sessionId: "s1" };
    expect(reducePresentationInput(bound, { kind: "host_event", event: { kind: "job", job: { jobId: "new-foreign-id", sessionId: "s2", revision: 1, state: "running", controlState: "owned", canStop: true, updatedAt: 1 } } })).toEqual(bound);
  });
});
