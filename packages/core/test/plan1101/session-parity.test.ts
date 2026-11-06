/** Plan1101 S1：验证普通会话能力、可信创建来源及恢复冻结边界，不调用真实 Provider。 */
import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createSessionService } from "../../src/runtime/application/session-service";
import { createThreadService } from "../../src/runtime/application/thread-service";
import { createThreadsToolBinding } from "../../src/runtime/application/thread-tool-binding";
import { resolveTurnCapabilities } from "../../src/runtime/application/turn/turn-capability-ceiling";

/** 保存精确活动身份，模拟已由 Runtime 启动的真实会话。 */
async function activate(ports: ReturnType<typeof createMemoryPorts>, sessionId: string, turnId: string) {
  const session = await ports.sessionStore.get(sessionId);
  await ports.turnStore.save({ id: turnId, sessionId, status: "running", frozenRunConfig: {}, startedAt: ports.clock.now() });
  await ports.sessionStore.save({ ...session!, status: "running", activeTurnId: turnId });
}

/** 创建同域内存宿主；通信组不承载普通工具权限。 */
async function setup() {
  const ports = createMemoryPorts();
  const sessions = createSessionService(ports);
  const a = await sessions.create({ title: "A" });
  const capability = { workspaceId: "workspace", stateRootId: "state", projectId: a.projectId!, allowedTools: ["read_file", "create_thread"], modelCatalog: [], humanPrincipalId: "user" };
  return { ports, sessions, a, capability };
}

describe("Plan1101 普通会话", function parity() {
  it("A→B→C 保留真实来源且停用组后创建新范围，不复活旧组", async function nestedCreation() {
    const f = await setup();
    await activate(f.ports, f.a.id, "a-turn");
    const a = createThreadsToolBinding(f.ports, f.capability, { threadId: f.a.id, turnId: "a-turn" });
    const b = await a.create({ requestId: "b" });
    expect(await a.create({ requestId: "b" })).toEqual(b);
    const storedB = (await f.sessions.get(b.threadId))!;
    expect(storedB.creationSource).toEqual({ actor: { kind: "thread", threadId: f.a.id, turnId: "a-turn" }, requestId: "b" });
    expect(storedB.collaborationAllowedTools).toBeUndefined();
    await activate(f.ports, b.threadId, "b-turn");
    const human = createThreadService(f.ports, f.ports.threadStore, { ...f.capability, actor: { kind: "human", principalId: "user" } });
    await human.disable({ groupId: b.groupId, requestId: "disable" });
    const bb = createThreadsToolBinding(f.ports, f.capability, { threadId: b.threadId, turnId: "b-turn" });
    const c = await bb.create({ requestId: "c" });
    expect(c.groupId).not.toBe(b.groupId);
    expect((await f.ports.threadStore.readControl(b.groupId))?.group.enabled).toBe(false);
    expect((await f.sessions.get(c.threadId))?.creationSource?.actor).toEqual({ kind: "thread", threadId: b.threadId, turnId: "b-turn" });
    await expect(f.sessions.save({ ...storedB, creationSource: { actor: { kind: "human", principalId: "user" }, requestId: "forged" } })).rejects.toMatchObject({ code: "SESSION_MODE_MISMATCH" });
  });

  it("同条件能力与权限相同，恢复不追加原来未装配的协作能力", async function capabilities() {
    const f = await setup();
    const human = createThreadService(f.ports, f.ports.threadStore, { ...f.capability, actor: { kind: "human", principalId: "user" } });
    const group = await human.enable({ requestId: "enable", rootThreadId: f.a.id });
    const created = await human.create({ groupId: group.group.groupId, parentThreadId: f.a.id, requestId: "create" });
    const b = (await f.sessions.get(created.threadId))!;
    expect(b.creationSource?.actor).toEqual({ kind: "human", principalId: "user" });
    const runtimeDefault = { permissionMode: "auto_approve" as const, toolAllowlist: ["read_file", "write_file", "create_thread"], threads: f.capability };
    const ordinary = await resolveTurnCapabilities({ session: f.a, turnId: "a", runtimeDefault, frozen: {}, now: 1 });
    const thread = await resolveTurnCapabilities({ session: b, turnId: "b", runtimeDefault, frozen: {}, now: 1 });
    expect(thread.capabilities.permissionMode).toBe(ordinary.capabilities.permissionMode);
    expect(thread.frozen.capabilityCeiling).toEqual(ordinary.frozen.capabilityCeiling);
    const restored = await resolveTurnCapabilities({ session: b, turnId: "old", runtimeDefault, frozen: { permissionMode: "ask", capabilityCeiling: { productMode: "work", allowedTools: ["read_file"] } }, continuing: true, now: 2 });
    expect(restored.capabilities.threads).toBeUndefined();
    expect(restored.frozen.capabilityCeiling?.allowedTools).toEqual(["read_file"]);
    expect(restored.frozen.permissionMode).toBe("ask");
  });
});
