/** r002权限继承回归：新目标只承接有效权限偏好，重试及显式目标配置保持原样。 */
import { expect, it } from "vitest";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";
import { createSessionService } from "../../../src/runtime/application/session-service";
import { createThreadService } from "../../../src/runtime/application/thread-service";
import { createThreadTools } from "../../../src/internal/tools/builtins/thread-tools";
import type { AgentThreadsCapability } from "../../../src/runtime/application/thread-tool-binding";

/** 独立内存组不启动模型，Session/Turn事实均由fixture创建。 */
async function fixture() {
  const ports = createMemoryPorts(); const sessions = createSessionService(ports);
  const root = await sessions.create({ title: "主会话" });
  const context = { workspaceId: "workspace", stateRootId: "state", projectId: root.projectId!, actor: { kind: "human" as const, principalId: "owner" }, allowedTools: [], modelCatalog: [] };
  const service = createThreadService(ports, ports.threadStore, context);
  const group = (await service.enable({ requestId: "enable", rootThreadId: root.id })).group;
  return { ports, sessions, root, context, service, groupId: group.groupId };
}

it("新目标仅继承已选permissionMode，父配置变化/重试不覆盖目标显式偏好", async function inheritSelectedMode() {
  const f = await fixture();
  await f.sessions.setDefaultRunConfig(f.root.id, { permissionMode: "auto_approve", maxSteps: 10, maxTotalTokens: 123 });
  const input = { groupId: f.groupId, requestId: "new", parentThreadId: f.root.id, title: "委派目标" };
  const child = await f.service.create(input);
  expect((await f.sessions.get(child.threadId))!.defaultRunConfig).toEqual({ permissionMode: "auto_approve" });
  await f.sessions.setDefaultRunConfig(f.root.id, { permissionMode: "ask" });
  await f.sessions.setDefaultRunConfig(child.threadId, { permissionMode: "full_access" });
  expect(await f.service.create(input)).toEqual(child);
  expect((await f.sessions.get(child.threadId))!.defaultRunConfig?.permissionMode).toBe("full_access");
  await f.sessions.rename(child.threadId, "人工改名后的目标");
  expect((await f.service.listThreads({ groupId: f.groupId })).items.find(function target(item) { return item.threadId === child.threadId; })?.title).toBe("人工改名后的目标");
  const second = await f.service.create({ ...input, requestId: "next" });
  expect((await f.sessions.get(second.threadId))!.defaultRunConfig?.permissionMode).toBe("ask");
});

it("Session未选偏好时回退精确发起Turn frozen权限，不复制Trust或冻结参数", async function frozenPreference() {
  const f = await fixture();
  await f.ports.turnStore.save({ id: "source-turn", sessionId: f.root.id, status: "running", startedAt: 1, schemaVersion: 2, frozenRunConfig: { permissionMode: "auto_approve", workspaceTrusted: true, maxSteps: 9 } });
  const service = createThreadService(f.ports, f.ports.threadStore, { ...f.context, actor: { kind: "thread", threadId: f.root.id, turnId: "source-turn" } });
  const child = await service.create({ groupId: f.groupId, requestId: "frozen-new", parentThreadId: f.root.id });
  expect((await f.sessions.get(child.threadId))!.defaultRunConfig).toEqual({ permissionMode: "auto_approve" });
});

it("协作普通工具目标摘要用可读标题，机器参数仍保留精确ID", async function readableTarget() {
  const threadId = "773573f5-3c1b-4b0e-bf60-545fef06c7ff";
  const tools = createThreadTools({ list: async function list() { return { items: [{ threadId, title: "风扇宣传页" }] }; } } as unknown as AgentThreadsCapability);
  const facts = await tools.sendThread.createActionFacts({ threadId, mode: "notify", content: "查看进展" }, { permissionMode: "ask" });
  expect(facts.resource).toBe("风扇宣传页"); expect(facts.requiresApproval).toBe(false);
  const fallback = createThreadTools({ list: async function list() { return { items: [{ threadId, title: threadId }] }; } } as unknown as AgentThreadsCapability);
  expect((await fallback.readThread.createActionFacts({ threadId }, { permissionMode: "ask" })).resource).toBe("协作会话");
});
