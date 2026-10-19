/** Web Host 消息投影回归测试：确保审批续跑不会丢失暂停前的时间线和 diff。 */
import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentEventEnvelope, AgentRuntime, Session } from "@autopilot-agent/core";
import { persistKnowledgeIngestMessage, persistKnowledgeUploadMessage, projectEvents } from "@/lib/runtime-host/web-message-projection";

/** 将测试事件包装成 Runtime transcript 的事件信封。 */
function envelope(seq: number, event: Record<string, unknown>): AgentEventEnvelope {
  return {
    seq,
    sessionId: "session-test",
    turnId: "turn-test",
    timestamp: new Date(seq).toISOString(),
    event: event as unknown as AgentEvent,
  };
}

describe("web message projection", () => {
  it("重建审批前后的连续过程、最终回答和编辑 diff", () => {
    const projection = projectEvents([
      envelope(1, { type: "turn_started", turnId: "turn-test", stepCount: 0 }),
      envelope(2, { type: "reasoning_summary", turnId: "turn-test", stepId: "step-1", summary: "正在理解任务" }),
      envelope(3, { type: "answer_delta", turnId: "turn-test", stepId: "step-1", delta: "先写入页面骨架。" }),
      envelope(4, { type: "answer_reset", turnId: "turn-test", stepId: "step-1" }),
      envelope(5, { type: "tool_started", turnId: "turn-test", stepId: "step-1", callId: "call-1", toolName: "edit_file", summary: "正在编辑页面" }),
      envelope(6, { type: "approval_required", turnId: "turn-test", stepId: "step-1", callId: "call-1", toolName: "edit_file", result: { status: "approval_required", toolName: "edit_file", approval: { approvalId: "approval-1", reason: "需要编辑文件" } } }),
      envelope(7, { type: "reasoning_summary", turnId: "turn-test", stepId: "step-2", summary: "正在根据审批继续执行" }),
      envelope(8, { type: "tool_result", turnId: "turn-test", stepId: "step-2", callId: "call-1", toolName: "edit_file", summary: "编辑成功", diff: "+<html></html>", result: { status: "success", output: { path: "promo.html", replacements: 1 } } }),
      envelope(9, { type: "answer_delta", turnId: "turn-test", stepId: "step-2", delta: "页面已完成，并已验证。" }),
    ]);

    expect(projection.turnSegments).toEqual([
      expect.objectContaining({
        content: "先写入页面骨架。",
        processSteps: [
          expect.objectContaining({ message: "任务已启动，正在理解指令" }),
          expect.objectContaining({ message: "正在理解任务" }),
        ],
      }),
    ]);
    expect(projection.processSteps.map((step) => step.message)).toEqual([
      "编辑成功",
      "正在根据审批继续执行",
    ]);
    expect(projection.answer).toBe("页面已完成，并已验证。");
    expect(projection.editDiffs).toEqual([
      expect.objectContaining({ filePath: "promo.html", diff: "+<html></html>" }),
    ]);
  });

  it("answer_discard 丢弃明确无效候选，避免重试结果拼接成双份", () => {
    const projection = projectEvents([
      envelope(1, { type: "answer_delta", turnId: "turn-test", stepId: "step-1", delta: "过程回答保留。" }),
      envelope(2, { type: "answer_discard", turnId: "turn-test", stepId: "step-1" }),
      envelope(3, { type: "answer_delta", turnId: "turn-test", stepId: "step-2", delta: "最终回答只保留一份。" }),
    ]);

    expect(projection.turnSegments).toEqual([]);
    expect(projection.answer).toBe("最终回答只保留一份。");
  });

  it("按稳定事件身份去重并按 seq 重放乱序 transcript", () => {
    const first = envelope(1, { type: "answer_delta", turnId: "turn-test", stepId: "step-1", delta: "明白了" });
    const second = envelope(2, { type: "answer_delta", turnId: "turn-test", stepId: "step-1", delta: "，继续处理。" });
    const projection = projectEvents([second, first, first, envelope(3, { type: "turn_completed", turnId: "turn-test", checkpoint: { status: "completed" } })]);

    expect(projection.answer).toBe("明白了，继续处理。");
  });

  it("将知识上传和结果卡片写入 Session 展示历史", async function persistsKnowledgeHistory() {
    const session: Session = {
      id: "session-test",
      projectId: "project-test",
      persistenceMode: "durable",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
      presentation: { messages: [] },
    };
    const runtime = {
      sessions: {
        get: async function getSession() { return session; },
        save: async function saveSession() {},
      },
    } as unknown as AgentRuntime;

    await persistKnowledgeUploadMessage(runtime, session.id, "knowledge-1", { name: "测试.pdf", size: 1024 });
    await persistKnowledgeIngestMessage(runtime, session.id, "knowledge-1", { name: "测试.pdf", status: "completed", contentCount: 7 });

    const messages = session.presentation?.messages as unknown as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", clientRecordId: "knowledge-1", knowledgeFiles: [{ name: "测试.pdf", size: 1024 }] });
    expect(messages[1]).toMatchObject({ role: "assistant", clientRecordId: "knowledge-1", knowledgeIngestItems: [{ name: "测试.pdf", status: "completed", contentCount: 7 }] });
  });
});
