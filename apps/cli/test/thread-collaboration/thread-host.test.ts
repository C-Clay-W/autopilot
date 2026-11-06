/** CLI 常驻协作宿主契约：用内存 Ports 与真实 Runner 验证组发现、驱动与停机事实。 */
import { LOCAL_HUMAN_PRINCIPAL_ID } from "@autopilot-agent/adapters";
import { createAgentRuntime, createMemoryPorts, type ModelSampler, type ThreadFacade } from "@autopilot-agent/core";
import { describe, expect, it } from "vitest";
import { createCliThreadHost } from "../../src/thread-host.js";

/** 测试工作区根；内存适配器只做身份比较，不读写磁盘。 */
const WORKSPACE_ROOT = "/tmp/cli-thread-workspace";

/** 确定性 mock 采样器；不访问真实 Provider。 */
function sampler(content = "完成"): ModelSampler {
  return {
    async sample(_messages, _tools, _options, onDelta) {
      if (onDelta) for (const char of content) onDelta(char);
      return { content, toolCalls: [], reasoningSummary: "mock", finishReason: "stop" };
    },
  };
}

/** 轮询直到条件成立；超时明确失败，不静默当作通过。 */
async function until<T>(probe: () => Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise(function tick(resolve) { setTimeout(resolve, 20); });
  }
  throw new Error("condition timeout");
}

/** 建立内存 Runtime 与人类协作入口；不创建真实 Turn。 */
async function setup() {
  const ports = createMemoryPorts(WORKSPACE_ROOT);
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler: sampler("已完成") } });
  const project = await runtime.projects.create({ name: "workspace", workspaceRoot: WORKSPACE_ROOT });
  const root = await runtime.sessions.create({ projectId: project.id, title: "root" });
  const human: ThreadFacade = runtime.threads.bind({
    workspaceId: "w",
    stateRootId: "root-id",
    projectId: project.id,
    allowedTools: [],
    modelCatalog: [],
    actor: { kind: "human", principalId: LOCAL_HUMAN_PRINCIPAL_ID },
  });
  return { ports, runtime, human, root };
}

describe("CLI 常驻协作宿主", function cliThreadHostSuite() {
  it("没有已启用组时不启动执行轮询", async function staysIdleWithoutGroups() {
    const { ports, runtime } = await setup();
    const host = createCliThreadHost({ workspaceId: "w", stateRootId: "root-id", runtime, ports, discoverIntervalMs: 20 });
    host.start();
    await new Promise<void>(function waitForDiscovery(resolve) { setTimeout(resolve, 60); });
    expect(host.isRunning()).toBe(false);
    await expect(host.stop()).resolves.toBeUndefined();
  });

  it("发现组后驱动 run 投递，停机报告不假称任务完成", async function drivesDeliveryAndStops() {
    const { ports, runtime, human, root } = await setup();
    const { group } = await human.enable({ protocolVersion: 1, requestId: "enable", rootThreadId: root.id });
    const child = await human.create({ protocolVersion: 1, groupId: group.groupId, parentThreadId: root.id, requestId: "child", title: "child" });
    const host = createCliThreadHost({ workspaceId: "w", stateRootId: "root-id", runtime, ports, discoverIntervalMs: 20 });
    host.start();
    try {
      await until(async function running() { return host.isRunning(); });
      const sent = await human.send({ protocolVersion: 1, groupId: group.groupId, threadId: child.threadId, requestId: "run", mode: "run", content: "执行任务" });
      const status = await until(async function delivered() {
        const current = await human.messageStatus({ protocolVersion: 1, groupId: group.groupId, threadId: child.threadId, messageId: sent.messageId });
        return current.deliveryStatus === "delivered" ? current : undefined;
      });
      expect(status.execution?.status).toBe("completed");
      // 执行事实来自真实 Turn，不由回执推断。
      const turns = await ports.turnStore.list(child.threadId);
      expect(turns).toHaveLength(1);
      expect(turns[0].status).toBe("completed");
    } finally {
      const report = await host.stop();
      expect(report?.stopped).toBe(true);
      expect(report?.unconfirmedTurnIds).toEqual([]);
      expect(host.isRunning()).toBe(false);
    }
  }, 60_000);
});
