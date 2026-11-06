/** r010回归：动态宿主装配的Work协作工具经过审批恢复仍可用，冻结配置不漂移。 */
import { expect, it } from "vitest";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";
import { createAgentRuntime } from "../../../src/runtime/public/create-agent-runtime";
import { createSessionService } from "../../../src/runtime/application/session-service";

it.each([true, false])("审批continue只恢复原冻结的动态协作能力：threadsEnabled=%s", async function keepsHostedThreads(enabled) {
  const ports = createMemoryPorts(process.cwd());
  ports.sandboxPort = { async status() { return { platform: "macos", backend: "fake", enforcement: "full" }; }, async setup() { throw Error("unused"); }, async prepare(input) { return { executionId: input.commandId, executable: input.program, args: [...input.args], env: {}, enforcement: "full" }; }, async release() {}, async shutdown() {} };
  const session = await createSessionService(ports).create({ title: "合成恢复" });
  let samples = 0;
  const toolSets: string[][] = [];
  const capability = { workspaceId: "w", stateRootId: "state", projectId: session.projectId!, humanPrincipalId: "user", allowedTools: ["run_command", "create_thread", "wait_threads", "read_progress", "report_progress"], modelCatalog: [] };
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { workspaceRoot: process.cwd(), permissionMode: "ask", maxSteps: 8, getRuntimeDefaults: function defaults() { return { threads: capability }; }, modelSampler: { async sample(_messages, tools) {
    toolSets.push(tools.map(function name(tool) { return tool.function.name; }));
    samples++;
    return samples === 1 ? { content: "", toolCalls: [{ id: "command", name: "run_command", input: { program: "node", args: ["-e", "process.stdout.write('synthetic-ok')"], cwd: ".", timeoutMs: 5000 } }], reasoningSummary: "合成审批" } : { content: "done", toolCalls: [], reasoningSummary: "完成" };
  } } } });
  const initial = [];
  for await (const event of runtime.turns.start({ sessionId: session.id, content: "合成测试" })) initial.push(event);
  const approval = initial.find(function approval(event) { return event.type === "approval_required"; });
  expect(approval?.type).toBe("approval_required");
  if (approval?.type !== "approval_required") throw Error("missing approval");
  const before = (await ports.turnStore.getLatest(session.id))!;
  if (!enabled) {
    before.frozenRunConfig.threadsEnabled = false;
    await ports.turnStore.save(before);
  }
  await runtime.approvals.submit({ sessionId: session.id, turnId: approval.turnId, approvalId: approval.result.approval.approvalId, decision: "allow_once" });
  const resumed = [];
  for await (const event of runtime.turns.continue({ sessionId: session.id, turnId: approval.turnId, approval: { approvalId: approval.result.approval.approvalId, decision: "allow" } })) resumed.push(event);
  expect(samples).toBe(2);
  expect(toolSets[0]).toEqual(expect.arrayContaining(["wait_threads", "read_progress", "report_progress"]));
  if (enabled) expect(toolSets[1]).toEqual(expect.arrayContaining(["wait_threads", "read_progress", "report_progress"]));
  else expect(toolSets[1]).not.toEqual(expect.arrayContaining(["wait_threads", "read_progress", "report_progress"]));
  expect(resumed.some(function completed(event) { return event.type === "turn_completed"; })).toBe(true);
  expect((await ports.turnStore.getLatest(session.id))?.frozenRunConfig).toEqual(before?.frozenRunConfig);
});

it("同Turn第二次审批结束后Session和Turn必须与checkpoint一致", async function repeatedApprovalState() {
  const ports = createMemoryPorts(process.cwd());
  ports.sandboxPort = { async status() { return { platform: "macos", backend: "fake", enforcement: "full" }; }, async setup() { throw Error("unused"); }, async prepare(input) { return { executionId: input.commandId, executable: input.program, args: [...input.args], env: {}, enforcement: "full" }; }, async release() {}, async shutdown() {} };
  const session = await createSessionService(ports).create({ title: "重复审批" });
  let samples = 0;
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { workspaceRoot: process.cwd(), permissionMode: "ask", maxSteps: 8, modelSampler: { async sample() { samples++; return { content: "", toolCalls: [{ id: `command-${samples}`, name: "run_command", input: { program: "node", args: ["-e", `process.stdout.write('step-${samples}')`], cwd: ".", timeoutMs: 5000 } }], reasoningSummary: "下一次审批" }; } } } });
  const initial = [];
  for await (const event of runtime.turns.start({ sessionId: session.id, content: "连续命令" })) initial.push(event);
  const approval = initial.find(function approval(event) { return event.type === "approval_required"; });
  if (approval?.type !== "approval_required") throw Error("missing approval");
  await runtime.approvals.submit({ sessionId: session.id, turnId: approval.turnId, approvalId: approval.result.approval.approvalId, decision: "allow_once" });
  const resumed = [];
  for await (const event of runtime.turns.continue({ sessionId: session.id, turnId: approval.turnId, approval: { approvalId: approval.result.approval.approvalId, decision: "allow" } })) resumed.push(event);
  expect(resumed.at(-1)?.type).toBe("turn_paused");
  expect((await ports.checkpointStore.getLatest(session.id))?.status).toBe("awaiting_approval");
  expect((await ports.turnStore.getLatest(session.id))?.status).toBe("waiting_approval");
  expect((await ports.sessionStore.get(session.id))?.status).toBe("waiting_approval");
});
