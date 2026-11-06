/** r006 Kernel待审批计数和安全诊断白名单回归，使用内存执行段。 */
import { expect, it } from "vitest";
import { createAgentRuntime } from "../../../src/internal/agent-runtime";
import { createAgentTextMessage } from "../../../src/internal/types/agent-message";
import { sanitizeContinuationFailure } from "../../../src/runtime/domain/thread-collaboration";

it.each(["pending", "decided", "unconfirmed"])("r006 Kernel仅pending计审批：%s", async function approvalCount(interactionState) {
 const runtime = createAgentRuntime({ modelSampler: { async sample() { return { content: "继续观察", reasoningSummary: "观察", toolCalls: [] }; } } });
 const checkpoint: any = { turnId: "parent", status: "interrupted", stepCount: 0, messages: [createAgentTextMessage("user", "观察子任务")], completedCallIds: [], threadObservation: { targets: [{ threadId: "child", taskId: "task", turnStatus: "waiting_approval", interactionState, continuationState: interactionState === "decided" ? "failed" : undefined, agreementPending: false }] } };
 const events = [];
 for await (const event of runtime.run({ turnId: "parent", checkpoint, messages: checkpoint.messages, maxSteps: 1 })) { events.push(event); if (event.type === "thread_wait") break; }
 expect(events.find(function wait(event) { return event.type === "thread_wait"; })).toMatchObject({ approvals: interactionState === "pending" ? 1 : 0, pending: 1 });
});
it("r006 安全投影封闭未知码和附加字段，保留原异常不输出", function diagnosticWhitelist() {
 expect(sanitizeContinuationFailure({ stage: "continue", started: false, category: "os", code: "C:/secret", message: "SECRET" } as any)).toEqual({ stage: "continue", started: false, category: "unknown", code: "CONTINUE_UNKNOWN" });
 expect(sanitizeContinuationFailure({ stage: "made_up", started: false, code: "EPERM" } as any)).toBeUndefined();
});
