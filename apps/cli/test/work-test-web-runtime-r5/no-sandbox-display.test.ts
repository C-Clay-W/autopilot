/**
 * R5 CLI 出口定向测试（web-runtime-20261016-investigation CR R5）：
 * Plain/JSONL 公开 approval_required 事件携带 constraint；text 出口区分无沙箱批准并显示
 * 工作目录；tool_result 出口显示结构化诊断与未隔离标注。
 */
import { describe, expect, it } from "vitest";
import { createCliEventProjector } from "../../src/event-projector.js";
import { createPlainRenderer } from "../../src/renderer.js";
import type { AgentEvent } from "@autopilot-agent/core";

/** 将测试用的最小对象视为公开 AgentEvent，避免依赖 Core private 类型。 */
function asEvent(value: unknown): AgentEvent {
  return value as AgentEvent;
}

describe("R5 CLI 无沙箱批准与执行方式出口", () => {
  it("approval_required 公开事件透传 constraint 与 cwd，text/jsonl 均区分无沙箱批准", () => {
    const projector = createCliEventProjector({ sessionId: "r5-approval" });
    projector.project(asEvent({
      type: "approval_required",
      turnId: "turn-r5",
      stepId: "step-1",
      callId: "call-r5",
      toolName: "run_command",
      result: {
        status: "approval_required",
        callId: "call-r5",
        toolName: "run_command",
        approval: {
          approvalId: "approval-r5",
          callId: "call-r5",
          toolName: "run_command",
          normalizedInputHash: "hash-r5",
          reason: "需要用户审批",
          risk: "unknown",
          preview: { program: "node" },
          expiresAt: "2099-01-01T00:00:00.000Z",
          constraint: "no-sandbox-exec:v1",
          display: { operation: "command", effect: "external", destructive: false, allowedDecisions: ["allow_once", "deny"], cwd: "C:/workspace/demo" },
        },
      },
    }));
    const event = projector.getProjection().events.at(-1)!;
    expect(event).toMatchObject({ type: "approval_required", constraint: "no-sandbox-exec:v1" });
    const text = createPlainRenderer("text").render(event);
    const jsonl = JSON.parse(createPlainRenderer("jsonl").render(event));
    expect(text).toContain("无沙箱直接执行，仅本次有效");
    expect(text).toContain("C:/workspace/demo");
    expect(jsonl.constraint).toBe("no-sandbox-exec:v1");
    expect(jsonl.display.cwd).toBe("C:/workspace/demo");
  });

  it("普通命令批准不显示无沙箱标注", () => {
    const projector = createCliEventProjector({ sessionId: "r5-normal" });
    projector.project(asEvent({
      type: "approval_required",
      turnId: "turn-r5n",
      stepId: "step-1",
      callId: "call-r5n",
      toolName: "run_command",
      result: {
        status: "approval_required",
        callId: "call-r5n",
        toolName: "run_command",
        approval: {
          approvalId: "approval-r5n",
          callId: "call-r5n",
          toolName: "run_command",
          normalizedInputHash: "hash-r5n",
          reason: "需要用户审批",
          risk: "write",
          preview: { program: "node" },
          expiresAt: "2099-01-01T00:00:00.000Z",
          // 普通精确命令约束（当前版本）；据不外 day-to-day 区分有无沙箱的关键字段仍是 constraint。
          constraint: "cmd:v2",
        },
      },
    }));
    const event = projector.getProjection().events.at(-1)!;
    expect(createPlainRenderer("text").render(event)).not.toContain("无沙箱直接执行");
  });

  it("tool_result 文本出口显示未隔离标注与结构化诊断", () => {
    const projector = createCliEventProjector({ sessionId: "r5-tool" });
    projector.project(asEvent({
      type: "tool_result",
      turnId: "turn-r5t",
      stepId: "step-1",
      callId: "call-r5t",
      toolName: "run_command",
      result: {
        status: "success",
        callId: "call-r5t",
        toolName: "run_command",
        output: {},
        meta: { durationMs: 5, inputHash: "hash-r5t" },
        display: { titleKey: "tool.command.completed", executionMode: "unisolated", diagnostics: ["provision 未完成：测试模拟"] },
      },
    }));
    const event = projector.getProjection().events.at(-1)!;
    const text = createPlainRenderer("text").render(event);
    expect(text).toContain("未隔离：宿主直接执行");
    expect(text).toContain("诊断：provision 未完成：测试模拟");
    // JSONL 保留结构化事实，不拼接进扁平字段。
    const jsonl = JSON.parse(createPlainRenderer("jsonl").render(event));
    expect(jsonl.display.executionMode).toBe("unisolated");
    expect(text).not.toContain("sandboxed");
  });
});
