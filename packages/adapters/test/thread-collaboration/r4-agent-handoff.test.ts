/** Agent 交接实际工具、策略、Node 写入与 Runner 快照链的定向验证。 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "../../../core/src/runtime/adapters/memory";
import { createAgentRuntime } from "../../../core/src/runtime/public/create-agent-runtime";
import { createThreadFacade } from "../../../core/src/runtime/application/thread-service";
import { createThreadDeliveryService } from "../../../core/src/runtime/application/thread-delivery-service";
import { createThreadsToolBinding } from "../../../core/src/runtime/application/thread-tool-binding";
import { createThreadTools } from "../../../core/src/internal/tools/builtins/thread-tools";
import { ToolExecutor } from "../../../core/src/internal/tools/tool-executor";
import { ToolRegistry } from "../../../core/src/internal/tools/tool-registry";
import { createNodeThreadHandoffWriter } from "../../src/node/thread-handoff";
import { createNodeHostMutationProtection } from "../../src/node/host-mutation-protection";
import { createNodeThreadRunner } from "../../src/node/thread-runner";
import type { ModelSampler } from "../../../core/src/internal/kernel/model-sampler";

/** 为本轮建立独立文件根，不使用真实用户工作区。 */
function workspace(): string {
  const base = path.resolve(process.cwd(), "../../.agent-tests/work-test/01a186ae-1e98-7583-9220-5379c798f563/r4-roots");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "handoff-"));
}

describe("R4 Agent 交接链", function handoff() {
  it("模型调用写入真实文件，Runner 消费已接受的快照", async function agentToRunner() {
    const rootDir = workspace();
    const ports = createMemoryPorts();
    ports.hostMutationProtection = createNodeHostMutationProtection({ workspaceRoot: rootDir, stateRoot: path.join(rootDir, "state") });
    let childId = ""; let targetInput = ""; let sourceCalls = 0;
    const sampler: ModelSampler = { async sample(messages) {
      sourceCalls++;
      if (sourceCalls === 1) return { content: "", toolCalls: [{ id: "send-handoff", name: "send_thread", input: { threadId: childId, mode: "run", content: "继续", handoff: { title: "标题", markdown: "原始摘要" } } }], reasoningSummary: "", finishReason: "tool_calls" };
      if (sourceCalls > 2) targetInput = JSON.stringify(messages);
      return { content: "完成", toolCalls: [], reasoningSummary: "", finishReason: "stop" };
    } };
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { workspaceRoot: rootDir, workspaceTrusted: true, permissionMode: "full_access", sandboxMode: "workspace-write", modelSampler: sampler, getRuntimeDefaults: function defaults() { return { threads: capability }; } } });
    const root = await runtime.sessions.create({ title: "root" });
    const capability = { workspaceId: "ws", stateRootId: "state", projectId: root.projectId!, allowedTools: ["send_thread"], modelCatalog: [], handoff: createNodeThreadHandoffWriter({ workspaceRoot: rootDir }) };
    const human = createThreadFacade(ports, { ...capability, actor: { kind: "human", principalId: "user" } });
    const { group } = await human.enable({ protocolVersion: 1, requestId: "enable", rootThreadId: root.id });
    childId = (await human.create({ protocolVersion: 1, groupId: group.groupId, parentThreadId: root.id, requestId: "child", title: "child" })).threadId;
    const events = [];
    for await (const event of runtime.turns.start({ sessionId: root.id, turnId: "source", content: "交接" })) events.push(event);
    const result = events.find(function sent(event) { return event.type === "tool_result" && event.callId === "send-handoff"; });
    expect(result?.type === "tool_result" && result.result.status).toBe("success");
    const message = (await human.messages({ protocolVersion: 1, groupId: group.groupId, threadId: childId })).items[0]!;
    const file = path.join(rootDir, message.handoff!.relativePath);
    expect(fs.readFileSync(file, "utf8")).toContain("原始摘要");
    fs.writeFileSync(file, "R4_MUTATED_FILE_SENTINEL");
    const sourceTurn = (await ports.turnStore.get("source"))!;
    const sourceSession = (await ports.sessionStore.get(root.id))!;
    await ports.turnStore.save({ ...sourceTurn, status: "running" });
    await ports.sessionStore.save({ ...sourceSession, status: "running", activeTurnId: "source" });
    const binding = createThreadsToolBinding(ports, capability, { threadId: root.id, turnId: "source" });
    const requestId = createHash("sha256").update(JSON.stringify(["send_thread", "send-handoff"])).digest("hex");
    const replay = { requestId, threadId: childId, mode: "run" as const, content: "继续", handoff: { title: "标题", markdown: "原始摘要" } };
    expect((await binding.send(replay)).messageId).toBe(message.messageId);
    expect(fs.readFileSync(file, "utf8")).toBe("R4_MUTATED_FILE_SENTINEL");
    fs.renameSync(file, `${file}.saved`);
    expect((await binding.send(replay)).messageId).toBe(message.messageId);
    expect(fs.existsSync(file)).toBe(false);
    await ports.turnStore.save(sourceTurn);
    await ports.sessionStore.save(sourceSession);
    const delivery = createThreadDeliveryService(ports, ports.threadStore, { workspaceId: "ws", stateRootId: "state", ownerId: "host" });
    const runner = createNodeThreadRunner({ delivery, runtime, ports, pollIntervalMs: 30 });
    await runner.start();
    try {
      for (let i = 0; i < 100 && !targetInput; i++) await new Promise<void>(function wait(resolve) { setTimeout(resolve, 25); });
      expect(targetInput).toContain("原始摘要");
      expect(targetInput).not.toContain("R4_MUTATED_FILE_SENTINEL");
    } finally { await runner.stop(); }
    expect((await ports.turnStore.get("source"))?.frozenRunConfig).not.toHaveProperty("threads");
    expect(await ports.sessionStore.get(root.id)).not.toHaveProperty("threads");
  }, 30000);

  it.each([["ask", "workspace-write", "approval_required"], ["full_access", "read-only", "error"]] as const)("%s / %s 遵守审批与只读门禁", async function policy(mode, sandboxMode, expected) {
    const rootDir = workspace(); const ports = createMemoryPorts(); let childId = ""; let calls = 0;
    const sampler: ModelSampler = { async sample() {
      if (calls++ === 0) return { content: "", toolCalls: [{ id: "policy-send", name: "send_thread", input: { threadId: childId, mode: "run", content: "继续", handoff: { title: "标题", markdown: "摘要" } } }], reasoningSummary: "", finishReason: "tool_calls" };
      return { content: "结束", toolCalls: [], reasoningSummary: "", finishReason: "stop" };
    } };
    const capability = { workspaceId: "ws", stateRootId: "state", projectId: "", allowedTools: ["send_thread"], modelCatalog: [] as never[], handoff: createNodeThreadHandoffWriter({ workspaceRoot: rootDir }) };
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { workspaceRoot: rootDir, workspaceTrusted: true, permissionMode: mode, sandboxMode, modelSampler: sampler, getRuntimeDefaults: function defaults() { return { threads: capability }; } } });
    const root = await runtime.sessions.create({ title: "root" });
    capability.projectId = root.projectId!;
    const human = createThreadFacade(ports, { ...capability, actor: { kind: "human", principalId: "user" } });
    const { group } = await human.enable({ protocolVersion: 1, requestId: "enable", rootThreadId: root.id });
    childId = (await human.create({ protocolVersion: 1, groupId: group.groupId, parentThreadId: root.id, requestId: "child" })).threadId;
    const events = [];
    for await (const event of runtime.turns.start({ sessionId: root.id, content: "交接" })) events.push(event);
    expect(events.some(function result(event) { return expected === "approval_required" ? event.type === "approval_required" : event.type === "tool_result" && event.result.status === expected; })).toBe(true);
    expect((await human.messages({ protocolVersion: 1, groupId: group.groupId, threadId: childId })).items).toHaveLength(0);
    expect(fs.existsSync(path.join(rootDir, ".autopilot"))).toBe(false);
  }, 30000);

  it("文件成功但消息提交中断时复用同一文件和消息身份", async function interruptedCommit() {
    const rootDir = workspace(); const ports = createMemoryPorts();
    const runtime = createAgentRuntime({ ports }); const root = await runtime.sessions.create({ title: "root" });
    const capability = { workspaceId: "ws", stateRootId: "state", projectId: root.projectId!, allowedTools: ["send_thread", "write_file"], modelCatalog: [], handoff: createNodeThreadHandoffWriter({ workspaceRoot: rootDir }) };
    const human = createThreadFacade(ports, { ...capability, actor: { kind: "human", principalId: "user" } });
    const { group } = await human.enable({ protocolVersion: 1, requestId: "enable", rootThreadId: root.id });
    const child = await human.create({ protocolVersion: 1, groupId: group.groupId, parentThreadId: root.id, requestId: "child" });
    await ports.turnStore.save({ id: "source", sessionId: root.id, status: "running", frozenRunConfig: {}, startedAt: ports.clock.now() });
    const session = (await ports.sessionStore.get(root.id))!;
    await ports.sessionStore.save({ ...session, status: "running", activeTurnId: "source" });
    const binding = createThreadsToolBinding(ports, capability, { threadId: root.id, turnId: "source" });
    const writeMessage = ports.threadStore.writeMessage.bind(ports.threadStore);
    let failed = false;
    ports.threadStore.writeMessage = async function failOnce(message) { if (!failed) { failed = true; throw new Error("commit interruption"); } return writeMessage(message); };
    const input = { requestId: "retry", threadId: child.threadId, mode: "run" as const, content: "继续", handoff: { title: "标题", markdown: "摘要" } };
    await expect(binding.send(input)).rejects.toMatchObject({ code: "THREADS_UNAVAILABLE" });
    expect(fs.readdirSync(path.join(rootDir, ".autopilot")).filter(function file(name) { return name.endsWith(".md"); })).toHaveLength(1);
    const first = await binding.send(input); const replay = await binding.send(input);
    expect(replay.messageId).toBe(first.messageId);
    expect((await human.messages({ protocolVersion: 1, groupId: group.groupId, threadId: child.threadId })).items).toHaveLength(1);
  }, 30000);

  it("真实文件写失败不接受消息，审批允许与拒绝按原执行器处理", async function writerFailureAndApproval() {
    const rootDir = workspace(); const ports = createMemoryPorts(); const runtime = createAgentRuntime({ ports });
    const root = await runtime.sessions.create({ title: "root" });
    const capability = { workspaceId: "ws", stateRootId: "state", projectId: root.projectId!, allowedTools: ["send_thread", "write_file"], modelCatalog: [], handoff: createNodeThreadHandoffWriter({ workspaceRoot: rootDir }) };
    const human = createThreadFacade(ports, { ...capability, actor: { kind: "human", principalId: "user" } });
    const { group } = await human.enable({ protocolVersion: 1, requestId: "enable", rootThreadId: root.id });
    const child = await human.create({ protocolVersion: 1, groupId: group.groupId, parentThreadId: root.id, requestId: "child" });
    await ports.turnStore.save({ id: "source", sessionId: root.id, status: "running", frozenRunConfig: {}, startedAt: ports.clock.now() });
    await ports.sessionStore.save({ ...(await ports.sessionStore.get(root.id))!, status: "running", activeTurnId: "source" });
    const binding = createThreadsToolBinding(ports, capability, { threadId: root.id, turnId: "source" });
    const registry = new ToolRegistry(); registry.register(createThreadTools(binding).sendThread);
    const executor = new ToolExecutor(registry, { workspaceRoot: rootDir, permissionMode: "ask", workspaceTrusted: true, sandbox: { mode: "workspace-write", port: ports.sandboxPort } });
    const input = { threadId: child.threadId, mode: "run", content: "继续", handoff: { title: "标题", markdown: "摘要" } };
    const denied = await executor.execute({ callId: "deny", toolName: "send_thread", input });
    if (denied.status !== "approval_required") throw new Error("未请求审批");
    const deniedResult = await executor.execute({ callId: "deny", toolName: "send_thread", input, approval: { approvalId: denied.approval.approvalId, decision: "deny" } });
    expect(deniedResult.status).toBe("denied");
    expect(fs.existsSync(path.join(rootDir, ".autopilot"))).toBe(false);
    const pending = await executor.execute({ callId: "allow", toolName: "send_thread", input });
    if (pending.status !== "approval_required") throw new Error("未请求审批");
    const allowed = await executor.execute({ callId: "allow", toolName: "send_thread", input, approval: { approvalId: pending.approval.approvalId, decision: "allow_once" } });
    expect(allowed.status).toBe("success");
    expect((await human.messages({ protocolVersion: 1, groupId: group.groupId, threadId: child.threadId })).items).toHaveLength(1);
    const protectedCall = "protected";
    const protectedRequest = createHash("sha256").update(JSON.stringify(["send_thread", protectedCall])).digest("hex");
    const protectedPath = path.join(rootDir, binding.handoffPath(protectedRequest));
    const protectedExecutor = new ToolExecutor(registry, { workspaceRoot: rootDir, permissionMode: "full_access", workspaceTrusted: true, hostMutationProtection: createNodeHostMutationProtection({ workspaceRoot: rootDir, stateRoot: path.join(rootDir, "state"), userSettingsPath: protectedPath }) });
    expect((await protectedExecutor.execute({ callId: protectedCall, toolName: "send_thread", input })).status).toBe("error");
    expect(fs.existsSync(protectedPath)).toBe(false);
    const badDir = workspace(); fs.writeFileSync(path.join(badDir, ".autopilot"), "not a directory");
    const bad = createThreadsToolBinding(ports, { ...capability, handoff: createNodeThreadHandoffWriter({ workspaceRoot: badDir }) }, { threadId: root.id, turnId: "source" });
    await expect(bad.send({ requestId: "bad", ...input, mode: "run" as const })).rejects.toMatchObject({ code: "THREAD_HANDOFF_WRITE_FAILED" });
    expect((await human.messages({ protocolVersion: 1, groupId: group.groupId, threadId: child.threadId })).items).toHaveLength(1);
  }, 30000);

  it("Agent 新建目标后可交接，缺少写文件能力时拒绝", async function newTargetAndWriteCeiling() {
    const rootDir = workspace(); const ports = createMemoryPorts(); let childId = ""; let step = 0;
    const sampler: ModelSampler = { async sample() {
      if (step++ === 0) return { content: "", toolCalls: [{ id: "create", name: "create_thread", input: { title: "新目标" } }], reasoningSummary: "", finishReason: "tool_calls" };
      if (step === 2) return { content: "", toolCalls: [{ id: "send", name: "send_thread", input: { threadId: childId, mode: "run", content: "继续", handoff: { title: "标题", markdown: "摘要" } } }], reasoningSummary: "", finishReason: "tool_calls" };
      return { content: "完成", toolCalls: [], reasoningSummary: "", finishReason: "stop" };
    } };
    const capability = { workspaceId: "ws", stateRootId: "state", projectId: "", allowedTools: ["send_thread", "create_thread", "write_file"], modelCatalog: [] as never[], handoff: createNodeThreadHandoffWriter({ workspaceRoot: rootDir }) };
    const runtime = createAgentRuntime({ ports, defaultRunConfig: { workspaceRoot: rootDir, workspaceTrusted: true, permissionMode: "full_access", sandboxMode: "workspace-write", modelSampler: sampler, getRuntimeDefaults: function defaults() { return { threads: capability }; } } });
    const root = await runtime.sessions.create({ title: "root" });
    capability.projectId = root.projectId!;
    const human = createThreadFacade(ports, { ...capability, actor: { kind: "human", principalId: "user" } });
    const { group } = await human.enable({ protocolVersion: 1, requestId: "enable", rootThreadId: root.id });
    for await (const event of runtime.turns.start({ sessionId: root.id, content: "创建并交接" })) {
      if (event.type === "tool_result" && event.callId === "create" && event.result.status === "success") childId = (event.result.output as { threadId: string }).threadId;
    }
    expect(childId).toBeTruthy();
    expect((await human.messages({ protocolVersion: 1, groupId: group.groupId, threadId: childId })).items[0]?.handoff).toBeTruthy();
    // 用已启用组成员的独立运行 Turn 验证 Skill/能力上限不由组授权代替。
    await ports.turnStore.save({ id: "limited", sessionId: root.id, status: "running", frozenRunConfig: {}, startedAt: ports.clock.now() });
    await ports.sessionStore.save({ ...(await ports.sessionStore.get(root.id))!, status: "running", activeTurnId: "limited" });
    const binding = createThreadsToolBinding(ports, capability, { threadId: root.id, turnId: "limited" });
    const registry = new ToolRegistry(); registry.register(createThreadTools(binding).sendThread);
    const executor = new ToolExecutor(registry, { workspaceRoot: rootDir, permissionMode: "full_access", workspaceTrusted: true, capabilityCeiling: { productMode: "work", allowedTools: ["send_thread"] } });
    const denied = await executor.execute({ callId: "limited-send", toolName: "send_thread", input: { threadId: childId, mode: "run", content: "继续", handoff: { title: "拒绝", markdown: "不得写入" } } });
    expect(denied.status).toBe("denied");
    const skillExecutor = new ToolExecutor(registry, { workspaceRoot: rootDir, permissionMode: "full_access", workspaceTrusted: true, allowedTools: ["send_thread"] });
    const skillDenied = await skillExecutor.execute({ callId: "skill-send", toolName: "send_thread", input: { threadId: childId, mode: "run", content: "继续", handoff: { title: "拒绝", markdown: "不得写入" } } });
    expect(skillDenied.status).toBe("denied");
    expect((await human.messages({ protocolVersion: 1, groupId: group.groupId, threadId: childId })).items).toHaveLength(1);
  }, 30000);
});
