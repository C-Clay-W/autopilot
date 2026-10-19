/** r002公开Runtime恢复回归：五写三读、持久暂停、取消后继续仍仅补读，不调用Provider或进程。 */
import { expect, it } from "vitest";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createAgentRuntime } from "../../src/runtime/public/create-agent-runtime";
import type { ModelSampler } from "../../src/internal/kernel/model-sampler";
import type { AgentLoopEvent } from "../../src/internal/agent-runtime";
import { getAgentMessageText } from "../../src/internal/types/agent-message";

/** 构造有限确定性采样序列，额外调用直接失败以避免隐藏循环。 */
function sequence(calls: Array<{ id: string; name: string; input: Record<string, unknown> }[]>): ModelSampler {
  let index = 0;
  return { sample: async function sample() {
    if (index >= calls.length) throw new Error("unexpected sample");
    const toolCalls = calls[index++];
    return { content: toolCalls.length ? "" : "修改完成", toolCalls, reasoningSummary: "fixture", finishReason: toolCalls.length ? "tool-call" : "stop" };
  } };
}

/** 收集公开Runtime事件流，不启动外部运行时。 */
async function collect(stream: AsyncIterable<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

it("公开Continue持久恢复五改三读，安全批次取消后仍禁止写入且不重放已完成call", async function durableVerification() {
  const fixtureRoot = path.resolve(process.cwd(), "../../.agent-tests/work-test/01a12aa2-f91a-71b0-bd75-476857deae9c/runs/r002/tester/fixtures");
  await mkdir(fixtureRoot, { recursive: true });
  const workspaceRoot = await mkdtemp(path.join(fixtureRoot, "verification-"));
  const ports = createMemoryPorts(workspaceRoot);
  const sessionId = "r002-durable";
  const turnId = "r002-verification";
  await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: 1, updatedAt: 1 });
  const config = { workspaceRoot, workspaceTrusted: true, permissionMode: "auto_approve" as const, maxSteps: 20 };
  const writes = Array.from({ length: 5 }, function write(_, index) { return { id: `write-${index}`, name: "write_file", input: { path: `file-${index}.txt`, content: `value-${index}` } }; });
  const reads = Array.from({ length: 3 }, function read(_, index) { return { id: `read-${index}`, name: "read_file", input: { path: `file-${index}.txt` } }; });
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { ...config, modelSampler: sequence([writes, reads, [], []]) } });
  const started = await collect(runtime.turns.start({ sessionId, turnId, content: "创建五个文件并读回验证。" }));
  expect(started.some(function paused(event) { return event.type === "turn_interrupted"; })).toBe(true);
  const paused = await ports.checkpointStore.getByTurn(sessionId, turnId);
  expect(paused).toMatchObject({ status: "interrupted_recoverable", interruptionReason: "write_verification" });
  expect([...paused!.mutationGate!.changedPaths].sort()).toEqual(writes.map(function filename(_, index) { return `file-${index}.txt`; }));
  expect([...paused!.mutationGate!.verifiedPaths].sort()).toEqual(reads.map(function filename(_, index) { return `file-${index}.txt`; }));
  expect(getAgentMessageText(paused!.messages.at(-1)!)).toContain('"file-3.txt"');
  expect(getAgentMessageText(paused!.messages.at(-1)!)).toContain('"file-4.txt"');
  expect(await runtime.turns.getRecoverableState({ sessionId, turnId })).toMatchObject({ recoverable: true, termination: { reason: "write_verification", recoverable: true } });
  const resumedRuntime = createAgentRuntime({ ports, defaultRunConfig: { ...config, modelSampler: sequence([[{ id: "read-3", name: "read_file", input: { path: "file-3.txt" } }], []]) } });
  const segment: AgentLoopEvent[] = [];
  for await (const event of resumedRuntime.turns.continue({ sessionId, turnId })) {
    segment.push(event);
    if (event.type === "tool_result" && event.callId === "read-3") await resumedRuntime.turns.cancel({ sessionId, turnId });
  }
  const cancelled = await ports.checkpointStore.getByTurn(sessionId, turnId);
  expect(cancelled?.mutationGate?.verificationOnly).toBe(true);
  expect(cancelled?.completedCallIds).toContain("read-3");
  const finalRuntime = createAgentRuntime({ ports, defaultRunConfig: { ...config, modelSampler: sequence([
    [{ id: "forbidden-write", name: "write_file", input: { path: "file-4.txt", content: "forbidden" } }],
    [{ id: "read-4", name: "read_file", input: { path: "file-4.txt" } }], [],
  ]) } });
  const finalEvents = await collect(finalRuntime.turns.continue({ sessionId, turnId }));
  expect(finalEvents).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_result", callId: "forbidden-write", result: expect.objectContaining({ status: "denied" }) }), expect.objectContaining({ type: "turn_completed" })]));
  expect(finalEvents.some(function repeated(event) { return event.type === "tool_started" && (event.callId.startsWith("write-") || event.callId === "read-3"); })).toBe(false);
  expect(await readFile(path.join(workspaceRoot, "file-4.txt"), "utf8")).toBe("value-4");
  expect((await ports.checkpointStore.getByTurn(sessionId, turnId))?.completedCallIds).toEqual(expect.arrayContaining([...writes, ...reads].map(function id(call) { return call.id; }).concat(["read-3", "read-4"])));
});

it("非验证恢复的写入审批拒绝仍终止且不采样替代工具", async function normalDenialCompletes() {
  const ports = createMemoryPorts(process.cwd());
  await ports.sessionStore.save({ id: "r002-denial", persistenceMode: "durable", status: "idle", createdAt: 1, updatedAt: 1 });
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { workspaceRoot: process.cwd(), workspaceTrusted: true, permissionMode: "ask", modelSampler: sequence([[{ id: "denied-write", name: "write_file", input: { path: "never-written-r002.txt", content: "must not write" } }]]) } });
  const initial = await collect(runtime.turns.start({ sessionId: "r002-denial", turnId: "r002-denial-turn", content: "创建文件" }));
  const approval = initial.find(function pending(event) { return event.type === "approval_required"; });
  if (approval?.type !== "approval_required") throw new Error("approval missing");
  const approvalId = approval.result.approval.approvalId;
  await runtime.approvals.submit({ sessionId: "r002-denial", turnId: "r002-denial-turn", approvalId, decision: "deny" });
  const resumed = await collect(runtime.turns.continue({ sessionId: "r002-denial", turnId: "r002-denial-turn", approval: { approvalId, decision: "deny" } }));
  expect(resumed).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_result", callId: "denied-write", result: expect.objectContaining({ status: "denied" }) }), expect.objectContaining({ type: "turn_completed" })]));
});
