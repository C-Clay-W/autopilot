/** Work 预览权威事实提取定向测试：只认成功工具结果，jobId 只取自宿主核验后的成功明细。 */

import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentEventEnvelope } from "@autopilot-agent/core";
import { extractWorkPreviewToolFacts } from "@/lib/workspace-host/work-preview-facts";

/** 构造最小 transcript 信封；只提供事实提取需要的字段。 */
function envelope(seq: number, turnId: string, event: Record<string, unknown>): AgentEventEnvelope {
  return {
    seq,
    sessionId: "session-a",
    turnId,
    timestamp: `2026-10-21T08:00:0${seq}.000Z`,
    event: event as AgentEvent,
  };
}

/** 宿主成功交付的 open_preview 安全明细。 */
const DETAIL = {
  kind: "open_preview",
  previewId: "pvw-1",
  hostLabel: "127.0.0.1:5199",
  copyUrl: "http://127.0.0.1:5199/",
  openWhen: "after_turn",
  state: "prepared",
};

/** 构造成功的 open_preview 工具结果信封。 */
function successResult(seq: number, turnId: string, callId: string, detail: unknown = DETAIL, toolName = "open_preview"): AgentEventEnvelope {
  return envelope(seq, turnId, {
    type: "tool_result",
    turnId,
    stepId: "step-1",
    callId,
    toolName,
    result: { status: "success", callId, toolName, output: { previewId: "pvw-1", state: "prepared", openWhen: "after_turn" }, display: { titleKey: "tool.open_preview.completed", detail } },
  });
}

describe("extractWorkPreviewToolFacts", function suite() {
  it("只从成功工具结果提取安全事实", function readsSuccessfulFact() {
    const facts = extractWorkPreviewToolFacts([successResult(1, "turn-1", "call-1")]);
    expect(facts).toEqual([{
      previewId: "pvw-1",
      turnId: "turn-1",
      callId: "call-1",
      copyUrl: "http://127.0.0.1:5199/",
      hostLabel: "127.0.0.1:5199",
      openWhen: "after_turn",
    }]);
  });

  it("jobId 只取自成功明细中的宿主核验结果，审批事件不再作为来源", function readsJobIdFromDetail() {
    const detailWithJob = { ...DETAIL, jobId: "job-1" };
    const events = [
      // 免审批路径（full_access/命中持久授权）没有 approval_required 事件，绑定仍随成功明细保留。
      envelope(1, "turn-1", { type: "approval_required", turnId: "turn-1", stepId: "step-1", callId: "call-1", toolName: "open_preview", result: { status: "approval_required", callId: "call-1", toolName: "open_preview", approval: { preview: { url: "http://127.0.0.1:5199/", jobId: "job-9", openWhen: "after_turn" } } } }),
      successResult(2, "turn-1", "call-1", detailWithJob),
      successResult(3, "turn-1", "call-2", DETAIL),
    ];
    const facts = extractWorkPreviewToolFacts(events);
    expect(facts[0]?.jobId).toBe("job-1");
    expect(facts[1]?.jobId).toBeUndefined();
  });

  it("失败结果、其他工具与非 open_preview 明细都不生成事实", function ignoresUnqualifiedEvents() {
    const failed = envelope(1, "turn-1", { type: "tool_result", turnId: "turn-1", stepId: "step-1", callId: "call-1", toolName: "open_preview", result: { status: "error", callId: "call-1", toolName: "open_preview", error: { code: "PREVIEW_NOT_READY" }, display: { detail: DETAIL } } });
    const otherTool = successResult(2, "turn-1", "call-2", DETAIL, "web_fetch");
    const otherDetail = successResult(3, "turn-1", "call-3", { kind: "web_fetch", host: "example.com", contentType: "text/html", truncated: false });
    expect(extractWorkPreviewToolFacts([failed, otherTool, otherDetail])).toEqual([]);
  });

  it("多条成功事实按 Turn 顺序保留各自身份", function keepsEachTurnIdentity() {
    const facts = extractWorkPreviewToolFacts([
      successResult(1, "turn-1", "call-1"),
      successResult(2, "turn-2", "call-2", { ...DETAIL, previewId: "pvw-2" }),
    ]);
    expect(facts.map(function identity(fact) { return `${fact.turnId}:${fact.callId}:${fact.previewId}`; })).toEqual(["turn-1:call-1:pvw-1", "turn-2:call-2:pvw-2"]);
  });
});
