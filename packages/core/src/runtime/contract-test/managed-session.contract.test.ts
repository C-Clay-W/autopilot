/** 受管身份与 Thread 禁用边界：真实服务拒绝、工具装配及自由会话保留。 */
import { expect, it } from "vitest";
import { createMemoryPorts } from "../adapters/memory";
import { createAgentRuntime } from "../public/create-agent-runtime";

it("受管创建幂等、身份不可移除，Thread 入口拒绝且自由 Session 保留", async function checksManagedBoundary() {
  const ports = createMemoryPorts(process.cwd());
  const plain = createAgentRuntime({ ports });
  const free = await plain.sessions.create({});
  const managedExecution = { hostId: "host", requestId: "request", threadPolicy: "disabled" as const };
  const managed = await plain.sessions.create({ managedExecution });
  expect((await plain.sessions.create({ managedExecution })).id).toBe(managed.id);
  await expect(plain.sessions.save({ ...managed, managedExecution: undefined })).rejects.toMatchObject({ code: "SESSION_MODE_MISMATCH" });
  const context = { workspaceId: "workspace", stateRootId: "state", projectId: free.projectId!, allowedTools: [], modelCatalog: [], humanPrincipalId: "human", allowRootGroupBootstrap: true };
  const human = plain.threads.bind({ ...context, actor: { kind: "human", principalId: "human" } });
  await expect(human.enable({ protocolVersion: 1, rootThreadId: managed.id, requestId: "denied" })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
  const group = await human.enable({ protocolVersion: 1, rootThreadId: free.id, requestId: "free" });
  await expect(human.associate({ protocolVersion: 1, groupId: group.group.groupId, threadId: managed.id, requestId: "join" })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
  const agent = plain.threads.bind({ ...context, actor: { kind: "thread", threadId: managed.id, turnId: "fake" } });
  await expect(agent.groups({ protocolVersion: 1 })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { threads: context, workspaceRoot: process.cwd(), modelSampler: { async sample(_messages, tools) {
    expect(tools.some(function thread(tool) { return tool.function.name === "create_thread"; })).toBe(false);
    return { content: "done", reasoningSummary: "test", toolCalls: [], finishReason: "stop" };
  } } } });
  for (let i = 0; i < 2; i++) for await (const event of runtime.turns.start({ sessionId: managed.id, content: "test" })) void event;
  expect((await runtime.facts.snapshot({ sessionId: managed.id })).execution?.result).toBe("completed");
});
