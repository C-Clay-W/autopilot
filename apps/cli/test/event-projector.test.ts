/** CLI 事件投影契约测试：覆盖本地 seq、重复事件、模型边界和敏感字段脱敏。 */

import type { AgentEvent } from "@autopilot-agent/core";
import { describe, expect, it } from "vitest";
import { createCliEventProjector, createInitialCliProjection, reduceCliEvent } from "../src/event-projector.js";
import { createPlainRenderer } from "../src/renderer.js";
import type { CliEventEnvelope } from "../src/types.js";

/** 将测试用的最小对象视为公开 AgentEvent，避免依赖 Core private 类型。 */
function asEvent(value: unknown): AgentEvent {
  return value as AgentEvent;
}

/** 构造最小合法 checkpoint，测试只关心状态和 activeSkills 身份。 */
function checkpoint(turnId: string, status: string = "completed"): Record<string, unknown> {
  return {
    turnId,
    status,
    stepCount: 1,
    messages: [{ role: "user", content: "private message" }],
    completedCallIds: [],
    lease: { leaseId: "private", ownerId: "private", heartbeatAt: 1, safeBoundarySeq: 1 },
    activeSkills: [{ skillId: "repo:demo", contentHash: "hash-1" }],
  };
}

describe("CLI event projector", function eventProjectorSuite() {
  it("复用未变技能身份，新增事件仍保留旧历史快照", function sharesUnchangedSkills() {
    const initial = createInitialCliProjection();
    const envelope: CliEventEnvelope = { seq: 1, sessionId: "s1", turnId: "t1", timestamp: "2026-10-12T00:00:00.000Z", event: asEvent({ type: "reasoning_delta", turnId: "t1", stepId: "step1", delta: "private" }) };
    const hidden = reduceCliEvent(initial, envelope);
    expect(hidden.events).toHaveLength(1);
    expect(hidden.activeSkills).toBe(initial.activeSkills);
    const visible = reduceCliEvent(hidden, { ...envelope, seq: 2, event: asEvent({ type: "answer_delta", turnId: "t1", stepId: "step1", delta: "hello" }) });
    expect(initial.events).toHaveLength(0);
    expect(hidden.events).toHaveLength(1);
    expect(visible.events).toHaveLength(2);
    expect(reduceCliEvent(visible, { ...envelope, seq: 2 })).toBe(visible);
  });
  it("同一 (turnId, seq) 重复信封不重复渲染", function deduplicatesEnvelope() {
    const event = asEvent({ type: "answer_delta", turnId: "turn-1", stepId: "step-1", delta: "hello" });
    const envelope: CliEventEnvelope = { seq: 1, sessionId: "session-1", turnId: "turn-1", timestamp: "2026-08-04T00:00:00.000Z", event };
    const first = reduceCliEvent(createInitialCliProjection(), envelope);
    const second = reduceCliEvent(first, envelope);
    expect(first.answer).toBe("hello");
    expect(second.answer).toBe("hello");
    expect(second.events).toHaveLength(1);
  });

  it("continue 阶段复用 projector 时本地 seq 不重置、不丢失事件", function keepsLocalSequenceAcrossContinue() {
    const projector = createCliEventProjector({ sessionId: "session-1", now: function fixedNow() { return new Date("2026-08-04T00:00:00.000Z"); } });
    const first = projector.project(asEvent({ type: "answer_delta", turnId: "turn-1", stepId: "step-1", delta: "a" }));
    const second = projector.project(asEvent({ type: "answer_delta", turnId: "turn-1", stepId: "step-2", delta: "b" }));
    expect(first.envelope.seq).toBe(1);
    expect(second.envelope.seq).toBe(2);
    expect(second.projection.answer).toBe("ab");
  });

  it("终态状态行只显示白名单原因、恢复状态与匹配预算", function projectsSafeTerminationFacts() {
    const projector = createCliEventProjector({ sessionId: "session-terminal" });
    projector.project(asEvent({
      type: "turn_interrupted",
      turnId: "turn-budget",
      termination: { reason: "runtime_budget", recoverable: true, budget: { used: 1_001, limit: 1_000, unit: "ms" } },
      checkpoint: {
        turnId: "turn-budget",
        status: "interrupted_recoverable",
        stepCount: 1,
        messages: [{ role: "user", content: "PRIVATE_MESSAGE" }],
        completedCallIds: [],
        runtimeBudget: { startedAt: 10, totalTokens: 12 },
        usageAnchor: { usage: { contextTokens: 12 }, messageCount: 1, toolSignature: "PRIVATE_USAGE" },
      },
    }));
    const event = projector.getProjection().events.at(-1)!;
    const text = createPlainRenderer("text").render(event);
    const jsonl = createPlainRenderer("jsonl").render(event);

    expect(event).toMatchObject({
      type: "status",
      status: "interrupted_recoverable",
      termination: { reason: "runtime_budget", recoverable: true, budget: { used: 1_001, limit: 1_000, unit: "ms" } },
    });
    expect(projector.getProjection().recoverable).toBe(true);
    expect(text).toContain("执行时长达到上限 · 可继续 · 1001/1000 ms");
    expect(JSON.parse(jsonl)).toMatchObject({ termination: { reason: "runtime_budget", recoverable: true } });
    for (const rendered of [JSON.stringify(event), text, jsonl]) {
      expect(rendered).not.toContain("PRIVATE_MESSAGE");
      expect(rendered).not.toContain("PRIVATE_USAGE");
      expect(rendered).not.toContain("runtimeBudget");
      expect(rendered).not.toContain("usageAnchor");
    }
  });

  it("不输出 raw reasoning、冻结输入、hash、preview 或绝对受控路径", function redactsSensitiveEventFields() {
    const projector = createCliEventProjector({ sessionId: "session-1" });
    projector.project(asEvent({ type: "reasoning_delta", turnId: "turn-1", stepId: "step-1", delta: "RAW_REASONING" }));
    projector.project(asEvent({
      type: "approval_required",
      turnId: "turn-1",
      stepId: "step-1",
      callId: "private-call",
      toolName: "edit_file",
      result: {
        status: "approval_required",
        callId: "private-call",
        toolName: "edit_file",
        approval: {
          approvalId: "approval-1",
          callId: "private-call",
          toolName: "edit_file",
          normalizedInputHash: "private-hash",
          reason: "修改 C:/workspace/secret.txt",
          risk: "write",
          preview: { path: "C:/workspace/secret.txt", content: "private" },
          expiresAt: "2026-08-04T00:00:00.000Z",
        },
      },
    }));
    const projection = projector.getProjection();
    const json = JSON.stringify(projection.events);
    expect(json).not.toContain("RAW_REASONING");
    expect(json).not.toContain("private-hash");
    expect(json).not.toContain("secret.txt");
    expect(json).not.toContain("preview");
    expect(projection.pendingApproval).toMatchObject({ approvalId: "approval-1", toolName: "edit_file", allowedDecisions: ["deny"] });
  });

  it("模型恢复只输出稳定错误码，checkpoint 只传播 activeSkills 身份", function projectsRecoveryAndSkills() {
    const projector = createCliEventProjector({ sessionId: "session-1" });
    projector.project(asEvent({ type: "model_recovery", turnId: "turn-1", stepId: "step-1", reason: "MODEL_OUTPUT_LIMIT", attempt: 1, maxAttempts: 3 }));
    projector.project(asEvent({ type: "turn_completed", turnId: "turn-1", checkpoint: checkpoint("turn-1") }));
    const projection = projector.getProjection();
    expect(projection.activeSkills).toEqual([{ skillId: "repo:demo", contentHash: "hash-1" }]);
    expect(JSON.stringify(projection.events)).toContain("MODEL_OUTPUT_LIMIT");
    expect(JSON.stringify(projection.events)).not.toContain("private message");
    expect(JSON.stringify(projection.events)).not.toContain("leaseId");
  });

  it("仅透传固定安全失败原因，不暴露附带的供应商原文、路径或凭据", function projectsSafeTurnFailureReason() {
    const safeReason = "修改任务未完成写后验证，不能标记为完成";
    const safeProjector = createCliEventProjector({ sessionId: "session-failure-safe" });
    safeProjector.project(asEvent({ type: "turn_started", turnId: "turn-safe", stepCount: 0 }));
    safeProjector.project(asEvent({ type: "turn_failed", turnId: "turn-safe", error: safeReason, checkpoint: checkpoint("turn-safe", "failed") }));
    const safeEvents = safeProjector.getProjection().events;
    const safeEvent = safeEvents[safeEvents.length - 1];

    expect(safeEvent).toMatchObject({ type: "status", status: "failed", reason: safeReason });
    expect(createPlainRenderer("text").render(safeEvent!)).toContain(safeReason);
    expect(JSON.parse(createPlainRenderer("jsonl").render(safeEvent!))).toMatchObject({ reason: safeReason });

    const unsafeProjector = createCliEventProjector({ sessionId: "session-failure-unsafe" });
    unsafeProjector.project(asEvent({ type: "turn_started", turnId: "turn-unsafe", stepCount: 0 }));
    unsafeProjector.project(asEvent({
      type: "turn_failed",
      turnId: "turn-unsafe",
      error: `${safeReason} | PRIVATE_PROVIDER_BODY at C:\\workspace\\private.ts token=sk-private`,
      checkpoint: checkpoint("turn-unsafe", "failed"),
    }));
    const unsafeEvents = unsafeProjector.getProjection().events;
    const unsafeEvent = unsafeEvents[unsafeEvents.length - 1];
    const unsafeJson = JSON.stringify(unsafeEvents);
    const unsafeText = createPlainRenderer("text").render(unsafeEvent!);
    const unsafeJsonl = createPlainRenderer("jsonl").render(unsafeEvent!);

    expect(unsafeEvent).toMatchObject({ type: "status", status: "failed", code: "RUNTIME_ERROR" });
    expect(unsafeEvent?.reason).toBeUndefined();
    expect(unsafeJson).not.toContain("PRIVATE_PROVIDER_BODY");
    expect(unsafeJson).not.toContain("private.ts");
    expect(unsafeJson).not.toContain("sk-private");
    expect(unsafeText).not.toContain("PRIVATE_PROVIDER_BODY");
    expect(unsafeText).not.toContain("private.ts");
    expect(unsafeText).not.toContain("sk-private");
    expect(unsafeJsonl).not.toContain("PRIVATE_PROVIDER_BODY");
    expect(unsafeJsonl).not.toContain("private.ts");
    expect(unsafeJsonl).not.toContain("sk-private");

    const unknownProjector = createCliEventProjector({ sessionId: "session-failure-unknown" });
    unknownProjector.project(asEvent({ type: "turn_started", turnId: "turn-unknown", stepCount: 0 }));
    unknownProjector.project(asEvent({
      type: "turn_failed",
      turnId: "turn-unknown",
      error: "UNKNOWN_PROVIDER_FAILURE api_key=sk-unknown at C:\\workspace\\unknown.ts",
      checkpoint: checkpoint("turn-unknown", "failed"),
    }));
    const unknownEvent = unknownProjector.getProjection().events.at(-1)!;
    const unknownText = createPlainRenderer("text").render(unknownEvent);
    const unknownJsonl = createPlainRenderer("jsonl").render(unknownEvent);

    expect(unknownEvent).toMatchObject({ type: "status", status: "failed", code: "RUNTIME_ERROR" });
    expect(unknownEvent.reason).toBeUndefined();
    for (const rendered of [unknownText, unknownJsonl]) {
      expect(rendered).not.toContain("UNKNOWN_PROVIDER_FAILURE");
      expect(rendered).not.toContain("api_key");
      expect(rendered).not.toContain("sk-unknown");
      expect(rendered).not.toContain("unknown.ts");
    }
  });

  it("只投影成功 edit_file 的最终相对路径 diff，不暴露工具 output", function projectsFinalEditDiff() {
    const projector = createCliEventProjector({ sessionId: "session-1" });
    projector.project(asEvent({
      type: "tool_result",
      turnId: "turn-1",
      stepId: "step-1",
      callId: "call-1",
      toolName: "edit_file",
      retryCount: 0,
      summary: "Edited src/app.ts (1 changes)",
      diff: "RAW_LEGACY_DIFF_MUST_NOT_RENDER",
      result: { status: "success", callId: "call-1", toolName: "edit_file", output: { path: "src/app.ts", private: "must-not-leak" }, meta: {}, display: { titleKey: "tool.edit.completed", target: "src/app.ts", summary: "Edited src/app.ts (1 changes)", diff: { text: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new" } } },
    }));
    const event = projector.getProjection().events[0];

    expect(event).toMatchObject({ type: "tool_result", diff: expect.stringContaining("+new") });
    expect(JSON.stringify(event)).not.toContain("must-not-leak");
    expect(JSON.stringify(event)).not.toContain("RAW_LEGACY_DIFF_MUST_NOT_RENDER");
  });

  it("将 Tool callId 与安全 display facts 送入共享 Presentation，不读取旧 summary", function reducesPresentationFacts() {
    const projector = createCliEventProjector({ sessionId: "session-1" });
    projector.project(asEvent({ type: "tool_started", turnId: "turn-1", stepId: "step-1", callId: "call-read-1", toolName: "read_file", summary: "RAW_START_SUMMARY" }));
    projector.project(asEvent({ type: "tool_result", turnId: "turn-1", stepId: "step-1", callId: "call-read-1", toolName: "read_file", retryCount: 0, summary: "RAW_RESULT_SUMMARY", result: { status: "success", callId: "call-read-1", toolName: "read_file", output: "RAW_OUTPUT", meta: { durationMs: 1, inputHash: "hash" }, display: { titleKey: "tool.read.completed", target: "src/index.ts", summary: "18 lines" } } }));
    const projection = projector.getProjection();
    const tool = projection.presentation.items.find(function findTool(item) { return item.kind === "tool_call"; });

    expect(projection.events[0]).toMatchObject({ type: "tool_started", callId: "call-read-1" });
    expect(tool).toMatchObject({ callId: "call-read-1", target: "src/index.ts", resultSummary: "18 lines" });
    expect(JSON.stringify(projection.presentation)).not.toContain("RAW_");
  });

  it("text 与 JSONL Renderer 只消费同一份安全事件", function rendersEquivalentSemantics() {
    const projector = createCliEventProjector();
    projector.project(asEvent({ type: "answer_delta", turnId: "turn-1", stepId: "step-1", delta: "hello" }));
    const event = projector.getProjection().events[0];
    expect(event).toBeDefined();
    if (!event) return;
    const text = createPlainRenderer("text").render(event);
    const jsonl = createPlainRenderer("jsonl").render(event);
    expect(text).toContain("hello");
    expect(JSON.parse(jsonl)).toMatchObject({ type: "answer_delta", delta: "hello" });
    expect(text).not.toMatch(/\u001b\[/u);
  });
});
