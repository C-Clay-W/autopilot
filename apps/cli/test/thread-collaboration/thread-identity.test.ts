/**
 * 本机身份跨入口契约：Web 与 CLI 共用同一人类 principal 时读写同一组，
 * 不同主体或工作区仍被拒绝，同键重试保持原幂等语义。
 */
import { LOCAL_HUMAN_PRINCIPAL_ID } from "@autopilot-agent/adapters";
import { createAgentRuntime, createMemoryPorts, type AgentRuntime, type ModelSampler } from "@autopilot-agent/core";
import { describe, expect, it } from "vitest";

/** 测试工作区根；内存适配器只做身份比较，不读写磁盘。 */
const WORKSPACE_ROOT = "/tmp/cli-thread-identity";

/** 确定性 mock 采样器；本用例不启动 Turn。 */
const sampler: ModelSampler = {
  async sample() { return { content: "未使用", toolCalls: [], reasoningSummary: "mock", finishReason: "stop" }; },
};

/** 建立 Project/根会话，并由“Web 入口”启用协作组。 */
async function setup() {
  const ports = createMemoryPorts(WORKSPACE_ROOT);
  const runtime: AgentRuntime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler: sampler } });
  const project = await runtime.projects.create({ name: "workspace", workspaceRoot: WORKSPACE_ROOT });
  const root = await runtime.sessions.create({ projectId: project.id, title: "root" });
  const base = { stateRootId: "root-id", projectId: project.id, allowedTools: [], modelCatalog: [] };

  /** 按给定入口身份绑定协作 Facade；principal 由宿主注入，不接受请求自报。 */
  function bind(workspaceId: string, principalId: string) {
    return runtime.threads.bind({ ...base, workspaceId, actor: { kind: "human", principalId } });
  }
  const web = bind("workspace", LOCAL_HUMAN_PRINCIPAL_ID);
  const { group } = await web.enable({ protocolVersion: 1, requestId: "enable", rootThreadId: root.id });
  return { runtime, project, root, web, cli: bind("workspace", LOCAL_HUMAN_PRINCIPAL_ID), groupId: group.groupId };
}

describe("本机身份跨入口", function localPrincipalSuite() {
  it("Web 建的组可由 CLI 读取与投递，同键重试不重复", async function sharesGroupAcrossHosts() {
    const f = await setup();
    expect((await f.cli.list({ protocolVersion: 1, groupId: f.groupId })).items.map(function id(item) { return item.threadId; })).toEqual([f.root.id]);
    expect((await f.cli.readState({ protocolVersion: 1, groupId: f.groupId })).revision).toBe(0);

    const first = await f.cli.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, requestId: "retry-1", mode: "notify", content: "来自 CLI 的通知" });
    const replay = await f.web.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, requestId: "retry-1", mode: "notify", content: "来自 CLI 的通知" });
    expect(replay.messageId).toBe(first.messageId);
    expect(replay.deliverySeq).toBe(first.deliverySeq);
    // 同键不同内容仍冲突，不覆盖原消息。
    await expect(f.web.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, requestId: "retry-1", mode: "notify", content: "不同内容" })).rejects.toMatchObject({ code: "THREAD_REQUEST_CONFLICT" });
    expect((await f.cli.messages({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id })).items).toHaveLength(1);
  });

  it("不同主体或不同工作区不能借用本机组", async function rejectsOtherPrincipals() {
    const f = await setup();
    const otherPrincipal = f.runtime.threads.bind({
      workspaceId: "workspace",
      stateRootId: "root-id",
      projectId: f.project.id,
      allowedTools: [],
      modelCatalog: [],
      actor: { kind: "human", principalId: "another-user" },
    });
    await expect(otherPrincipal.list({ protocolVersion: 1, groupId: f.groupId })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
    await expect(otherPrincipal.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.root.id, requestId: "x", mode: "notify", content: "越权" })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });

    const otherWorkspace = f.runtime.threads.bind({
      workspaceId: "other-workspace",
      stateRootId: "root-id",
      projectId: f.project.id,
      allowedTools: [],
      modelCatalog: [],
      actor: { kind: "human", principalId: LOCAL_HUMAN_PRINCIPAL_ID },
    });
    await expect(otherWorkspace.list({ protocolVersion: 1, groupId: f.groupId })).rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
  });
});
