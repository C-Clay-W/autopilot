/** r003 正式Kernel的重复观察/checkpoint约定与内部输入上下文回归。 */
import { expect, it, vi } from "vitest";
import { createAgentRuntime, type AgentCheckpoint } from "../../../src/internal/agent-runtime";
import { createAgentTextMessage, getAgentMessageText, validateAgentMessages } from "../../../src/internal/types/agent-message";
import type { AgentThreadsCapability } from "../../../src/runtime/application/thread-tool-binding";
/** 收集完整单段并返回私有checkpoint，隔离于真实Store。 */
async function segment(runtime: ReturnType<typeof createAgentRuntime>, checkpoint?: AgentCheckpoint) {
 const events = [];
 for await (const event of runtime.run({ turnId: "parent-turn", messages: [createAgentTextMessage("user", "观察子任务")], checkpoint, maxSteps: 1 })) events.push(event);
 const last = events.at(-1)!;
 expect(last.type).toBe("turn_limit_reached");
 return (last as any).checkpoint as AgentCheckpoint;
}
it.each([false, true])("r003 重复wait及checkpoint恢复不重投、失败保留pending=%s", async function checkpointAgreement(failFirst) {
 let calls = 0;
 const send = vi.fn(async function deliver() { if (failFirst && calls++ === 0) throw new Error("controlled"); return { messageId: "message", mode: "steer", deliverySeq: 1, deliveryStatus: "pending" }; });
 const capability = { send, wait: async function wait() { return { results: [{ threadId: "child", taskId: "task", cursor: "cursor", reason: "snapshot", pendingProgress: 0, summary: { turnId: "child-turn", turnStatus: "running" } }], timedOut: false }; } } as unknown as AgentThreadsCapability;
 let sample = 0;
 let instructions = "完成和阻塞再汇报";
 const runtime = createAgentRuntime({ threads: capability, modelSampler: { async sample(messages) { validateAgentMessages(messages); return { content: "", reasoningSummary: "观察", toolCalls: [{ id: `wait-${++sample}`, name: "wait_threads", input: { targets: [{ threadId: "child", taskId: "task" }], timeoutMs: 0, followUntilTerminal: true, reportingInstructions: instructions } }] }; } } });
 let checkpoint = await segment(runtime);
 expect(checkpoint.threadObservation?.targets[0].agreementPending).toBe(failFirst);
 checkpoint = await segment(runtime, checkpoint);
 expect(send).toHaveBeenCalledTimes(failFirst ? 2 : 1);
 expect(checkpoint.threadObservation?.targets[0].agreementPending).toBe(false);
 instructions = "每阶段汇报";
 await segment(runtime, checkpoint);
 expect(send).toHaveBeenCalledTimes(failFirst ? 3 : 2);
 expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ reportingAgreement: { taskId: "task", explicit: true }, content: "【本次任务汇报约定更新】\n每阶段汇报" }));
});
it("r003 内部约定作为有来源上下文消费，不触发用户写入意图且审计input事件保留", async function internalContext() {
 let drained = false;
 const sampled: string[][] = [];
 const runtime = createAgentRuntime({ inputInbox: { async drain() { if (drained) return []; drained = true; return [{ inputId: "agreement", content: "每次修改文件后汇报", origin: { kind: "thread", threadId: "parent", purpose: "reporting_agreement" as const } }]; } }, modelSampler: { async sample(messages) { sampled.push(messages.map(getAgentMessageText)); return { content: "已知悉", reasoningSummary: "说明", toolCalls: [] }; } } });
 const events = [];
 for await (const event of runtime.run({ turnId: "child", messages: [createAgentTextMessage("user", "简短确认")], maxSteps: 2 })) events.push(event);
 expect(events.at(-1)?.type).toBe("turn_completed");
 expect(events.some(function audit(e) { return e.type === "input_joined" && e.inputId === "agreement"; })).toBe(true);
 expect(sampled[0].join("\n")).toContain("协作内部上下文：汇报约定");
 expect((events.at(-1) as any).checkpoint.mutationGate.required).toBe(false);
});
