/** repair-03 CLI：公开Controller对过期审批只委托原Core重签，不自动批准。 */
import { describe, expect, it } from "vitest";
import { createAgentRuntime, createMemoryPorts } from "@autopilot-agent/core";
import { createCliController } from "../../../src/controller.js";
import { createPlainRenderer } from "../../../src/renderer.js";

it("CLI过期awaiting_approval恢复原Turn重签，零新增模型采样/批准", async function expiredResume() {
  const ports = createMemoryPorts(process.cwd()); let samples = 0;
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { workspaceRoot: process.cwd(), workspaceTrusted: true, permissionMode: "ask", modelSampler: { async sample() { samples++; return { content: "", reasoningSummary: "fixture", toolCalls: [{ id: "write", name: "write_file", input: { path: "repair-03-cli-must-not-exist.txt", content: "fixture" } }], finishReason: "tool_calls" }; } } } });
  const session = await runtime.sessions.create({ title: "cli-expired" }); const input = { sessionId: session.id, turnId: "expired-turn" };
  for await (const _event of runtime.turns.start({ ...input, content: "fixture" })) { /* 完整收尾 */ }
  const events = await ports.transcriptStore.getEvents(session.id); const old = events.find(function approval(item) { return item.event.type === "approval_required"; })!;
  if (old.event.type !== "approval_required") throw new Error("missing approval");
  await ports.transcriptStore.append(session.id, { ...old, seq: events.at(-1)!.seq + 1, event: { ...old.event, result: { ...old.event.result, approval: { ...old.event.result.approval, expiresAt: new Date(Date.now() - 1000).toISOString() } } } });
  const controller = createCliController({ runtime, sessionId: session.id, renderer: createPlainRenderer("text") });
  const result = await controller.resume(); expect(result.kind).toBe("ok");
  const state = await runtime.turns.getRecoverableState(input); expect(state?.status).toBe("awaiting_approval"); expect(state?.approval?.approvalId).toBeTruthy(); expect(state?.approval?.approvalId).not.toBe(old.event.result.approval.approvalId);
  expect(samples).toBe(1); expect(await runtime.approvals.getDecision({ ...input, approvalId: state!.approval!.approvalId })).toBeNull();
});
