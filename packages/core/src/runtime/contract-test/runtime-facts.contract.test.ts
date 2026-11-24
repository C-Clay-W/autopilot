/** 验证 H1 白名单、稳定身份及过滤页/快照交接，不调用 Provider。 */
import { expect, it } from "vitest";
import { createMemoryPorts } from "../adapters/memory";
import { createRuntimeFacts, projectRuntimeFact } from "../application/runtime-facts";
import { createAgentRuntime } from "../public/create-agent-runtime";
import { scanAgentToolPairing } from "../../internal/types/agent-message";

it("并行只读批次首项申请文件集审批时保持原调用顺序并发布有效等待", async function preservesParallelApprovalBoundary() {
  const ports = createMemoryPorts(process.cwd());
  let samples = 0;
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { workspaceRoot: process.cwd(), workspaceTrusted: true, permissionMode: "ask", modelSampler: { async sample() {
    samples++;
    return samples === 1 ? { content: "", reasoningSummary: "test", finishReason: "tool_calls", toolCalls: [
      { id: "todo-approval", name: "todo_write", input: { todos: [{ content: "制作网页", activeForm: "制作网页", status: "in_progress" }], fileTargets: [{ path: "todolist/index.html", operation: "create" }, { path: "todolist/app.js", operation: "create" }] } },
      { id: "glob-result", name: "glob_files", input: { pattern: "**", path: "todolist" } },
    ] } : { content: "done", reasoningSummary: "test", finishReason: "stop", toolCalls: [] };
  } } } });
  const session = await runtime.sessions.create({});
  for await (const event of runtime.turns.start({ sessionId: session.id, content: "test parallel approval" })) void event;
  const snapshot = await runtime.facts.snapshot({ sessionId: session.id });
  expect(snapshot.execution?.waiting).toBe("approval");
  expect(snapshot.execution?.interaction?.state).toBe("pending");
  const checkpoint = (await ports.checkpointStore.getLatest(session.id))!;
  expect(scanAgentToolPairing(checkpoint.messages).pendingCallIds).toEqual(["todo-approval", "glob-result"]);
  expect(checkpoint.completedCallIds).not.toContain("glob-result");
  const approvalId = snapshot.execution!.interaction!.approvalId!;
  await runtime.approvals.submit({ sessionId: session.id, turnId: checkpoint.turnId, approvalId, decision: "allow_once" });
  for await (const event of runtime.turns.continue({ sessionId: session.id, turnId: checkpoint.turnId, approval: { approvalId, decision: "allow" } })) void event;
  expect((await runtime.facts.snapshot({ sessionId: session.id })).execution?.result).toBe("completed");
  const events = await ports.transcriptStore.getEvents(session.id);
  expect(events.filter(function globResult(envelope) { return envelope.event.type === "tool_result" && envelope.event.callId === "glob-result"; })).toHaveLength(1);
});

it("facts 保持原生身份、隐藏正文且过滤页继续推进游标", async function checksSafeFacts() {
  const ports = createMemoryPorts();
  await ports.sessionStore.save({ id: "s", persistenceMode: "durable", status: "idle", createdAt: 0, updatedAt: 0 });
  const event = { sessionId: "s", turnId: "t", seq: 1, timestamp: "2026-11-13T00:00:00Z", event: { type: "tool_started" as const, turnId: "t", stepId: "step", callId: "call", toolName: "private", summary: "SECRET" } };
  expect(projectRuntimeFact(event)).toEqual(projectRuntimeFact(structuredClone(event)));
  expect(JSON.stringify(projectRuntimeFact(event))).not.toContain("SECRET");
  expect(JSON.stringify(projectRuntimeFact(event))).not.toContain("private");
  await ports.transcriptStore.append("s", { ...event, event: { type: "answer_delta", turnId: "t", stepId: "step", delta: "SECRET" } });
  const facts = createRuntimeFacts(ports);
  const first = await facts.read({ sessionId: "s", limit: 1 });
  expect(first.items).toEqual([]);
  await ports.transcriptStore.append("s", { ...event, seq: 2 });
  const next = await facts.read({ sessionId: "s", limit: 1, cursor: first.cursor });
  expect(next.items[0].sequence).toBe(2);
  const snapshot = await facts.snapshot({ sessionId: "s" });
  await ports.transcriptStore.append("s", { ...event, seq: 3 });
  expect((await facts.read({ sessionId: "s", limit: 1, cursor: snapshot.cursor })).items[0].sequence).toBe(3);
  await ports.transcriptStore.deleteBySession("s");
  await expect(facts.read({ sessionId: "s", limit: 1, cursor: snapshot.cursor })).rejects.toThrow("CURSOR_EXPIRED");
});

it("facts 读取正式 Session 的完成、审批等待与拒绝失败", async function checksRealLifecycle() {
  const ports = createMemoryPorts(process.cwd());
  ports.sandboxPort = { async status() { return { platform: "macos", backend: "fake", enforcement: "full" }; }, async setup() { throw new Error("not used"); }, async prepare(request) { return { executionId: request.commandId, executable: request.program, args: [...request.args], env: {}, enforcement: "full" }; }, async release() {}, async shutdown() {} };
  let approval = false;
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { workspaceRoot: process.cwd(), workspaceTrusted: true, permissionMode: "ask", modelSampler: { async sample() {
    return approval ? { content: "", reasoningSummary: "test", finishReason: "tool_calls", toolCalls: [{ id: "call", name: "run_command", input: { program: "node", args: ["--version"], cwd: ".", timeoutMs: 5000 } }] } : { content: "done", reasoningSummary: "test", finishReason: "stop", toolCalls: [] };
  } } } });
  const session = await runtime.sessions.create({});
  for await (const event of runtime.turns.start({ sessionId: session.id, content: "test" })) void event;
  expect((await runtime.facts.snapshot({ sessionId: session.id })).execution?.result).toBe("completed");
  approval = true;
  for await (const event of runtime.turns.start({ sessionId: session.id, content: "test approval" })) void event;
  const snapshot = await runtime.facts.snapshot({ sessionId: session.id });
  expect(snapshot.execution?.waiting, JSON.stringify(await ports.transcriptStore.getEvents(session.id))).toBe("approval");
  const turnId = snapshot.execution!.turnId;
  const approvalId = snapshot.execution!.interaction!.approvalId!;
  await runtime.approvals.submit({ sessionId: session.id, turnId, approvalId, decision: "deny" });
  expect((await runtime.facts.snapshot({ sessionId: session.id })).execution?.interaction?.state).toBe("decided");
  for await (const event of runtime.turns.continue({ sessionId: session.id, turnId, approval: { approvalId, decision: "deny" } })) void event;
  expect((await runtime.facts.snapshot({ sessionId: session.id })).execution?.result).toBe("failed");
  // 拒绝后的新 Turn 只接收新采样，不恢复或重试旧命令。
  approval = false;
  const handoffEvents = [];
  for await (const event of runtime.turns.start({ sessionId: session.id, content: "尊重拒绝，仅报告当前结果，不执行原命令" })) handoffEvents.push(event);
  expect(handoffEvents.some(function oldCommand(event) { return event.type === "tool_started" && event.toolName === "run_command"; })).toBe(false);
  expect((await runtime.facts.snapshot({ sessionId: session.id })).execution?.result).toBe("completed");
});
