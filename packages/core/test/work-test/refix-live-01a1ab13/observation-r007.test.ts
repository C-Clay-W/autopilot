/** r007超时观察同步快照、有进展才唤醒及普通观察中性文案回归。 */
import { expect, it, vi } from "vitest";
import { createAgentRuntime } from "../../../src/internal/agent-runtime";
import { createAgentTextMessage, validateAgentMessages } from "../../../src/internal/types/agent-message";

it.each(["running", "approval", "progress", "completed"])("r007 timeout携带%s新事实不丢弃，重复无变化保持静默", async function timeoutSnapshot(outcome) {
 let waits = 0; let samples = 0; const received: string[] = [];
 const readProgress = vi.fn(async function read() { return { items: [{ kind: "milestone", summary: "阶段完成", progressSeq: 1 }], cursor: "progress-1" }; });
 const summary = outcome === "approval" ? { turnId: "child-turn", turnStatus: "waiting_approval", waiting: "approval", interactionState: "pending", attentionKind: "approval" } : { turnId: "child-turn", turnStatus: outcome === "completed" ? "completed" : "running", execution: outcome === "completed" ? "inactive" : "active" };
 const capability: any = { readProgress, send: vi.fn(), wait: vi.fn(async function wait(input: any) {
   waits++;
   if (waits <= 3) { expect(samples).toBe(1); expect(input.targets[0].cursor).toBe("old"); return { results: [{ threadId: "child", taskId: "task", cursor: "old", pendingProgress: 0, reason: "timeout", summary: { turnId: "child-turn", turnStatus: "unconfirmed" } }], timedOut: true }; }
   return { results: [{ threadId: "child", taskId: "task", cursor: outcome === "progress" ? "old" : "new", pendingProgress: waits === 4 && outcome === "progress" ? 1 : 0, reason: "timeout", summary }], timedOut: waits === 4 };
 }) };
 const runtime = createAgentRuntime({ threads: capability, modelSampler: { async sample(messages) {
   validateAgentMessages(messages); samples++; received.push(JSON.stringify(messages));
   if (samples === 2) {
    expect(waits).toBe(4); expect(received[1]).toContain(JSON.stringify({ timedOut: true }).slice(1, -1).replaceAll('"', '\\"'));
    if (outcome === "progress") expect(received[1]).toContain("阶段完成");
    else expect(received[1]).toContain(summary.turnStatus);
    if (outcome !== "completed") return { content: "", reasoningSummary: "结束测试观察", toolCalls: [{ id: "stop", name: "wait_threads", input: { targets: [{ threadId: "child", taskId: "task" }], timeoutMs: 0, followUntilTerminal: false } }] };
   }
   return { content: "正在观察", reasoningSummary: "观察", toolCalls: [] };
 } } });
 const checkpoint: any = { turnId: "parent", status: "interrupted", stepCount: 0, messages: [createAgentTextMessage("user", "观察任务")], completedCallIds: [], threadObservation: { targets: [{ threadId: "child", taskId: "task", turnId: "child-turn", turnStatus: "unconfirmed", cursor: "old", agreementPending: false }] } };
 const events = [];
 for await (const event of runtime.run({ turnId: "parent", checkpoint, messages: checkpoint.messages, maxSteps: 4 })) events.push(event);
 expect(events.at(-1)?.type, (events.at(-1) as any)?.error).toBe("turn_completed");
 expect(samples).toBe(outcome === "completed" ? 2 : 3);
 expect(readProgress).toHaveBeenCalledTimes(outcome === "progress" ? 1 : 0);
 expect(capability.send).not.toHaveBeenCalled();
 expect(JSON.stringify(events.filter(function reasoning(event) { return event.type === "reasoning_summary"; }))).not.toContain("等待审批期间");
 expect(events.filter(function result(event) { return event.type === "tool_result" && event.callId.startsWith("observe-"); })).toHaveLength(1);
});
