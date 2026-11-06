/** Web修复回归，覆盖受信输入展示与真实只读观察流。 */
import { expect, it } from "vitest";
import { createAgentRuntime, createMemoryPorts, createThreadFacade, createThreadDeliveryService } from "@autopilot-agent/core";
import { createPresentationState, type ToolCallItem, type TimelineItem } from "@autopilot-agent/presentation";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { restoreWebInputPresentation } from "@/lib/runtime-host/web-input-presentation";
import { createWebTurnStream } from "@/lib/workspace-host/web-turn-stream";
import { restoreWebThreadPrompts } from "@/lib/runtime-host/web-thread-presentation";
import { groupWebObservations } from "@/app/chat/web-observation-groups";
import TurnPresentation from "@/app/chat/components/TurnPresentation";
import { GET } from "@/app/api/sessions/[id]/route";
import { runWithWorkspaceRequestContext } from "@/lib/workspace-host/web-workspace-session";
import { createWebThreadHost } from "@/lib/workspace-host/web-thread-host";

it("Thread steer恢复保留来源，用户主动输入无标签", function inputOrigin() {
  const common = { sessionId: "s", turnId: "t", delivery: "steer", content: "同样正文", status: "consumed", attachments: [], selectedSkills: [], createdAt: 1 };
  const state = restoreWebInputPresentation(createPresentationState(), [], [
    { ...common, inputId: "thread", clientMessageId: "thread", origin: { kind: "thread", threadId: "source" } },
    { ...common, inputId: "human", clientMessageId: "human" },
  ] as never);
  expect(state.items.find(function thread(item) { return item.kind === "input_notice" && item.inputId === "thread"; })).toHaveProperty("origin", { kind: "thread", threadId: "source" });
  expect(state.items.find(function human(item) { return item.kind === "input_notice" && item.inputId === "human"; })).not.toHaveProperty("origin");
  const html = renderToStaticMarkup(createElement(TurnPresentation, { state, turnId: "t", showThinking: true } as never));
  expect(html.split("Sent by Autopilot from another thread")).toHaveLength(2);
});

it("无本地Host记录的等待审批观察流主动结束", async function approvalStreamSettles() {
  const ports = createMemoryPorts();
  await ports.turnStore.save({ id: "t", sessionId: "s", status: "waiting_approval", frozenRunConfig: {}, startedAt: 1 });
  await ports.transcriptStore.append("s", { sessionId: "s", turnId: "t", seq: 1, timestamp: new Date().toISOString(), event: { type: "turn_paused", turnId: "t", reason: "approval_required" } } as never);
  const startedAt = Date.now();
  const text = await new Response(createWebTurnStream({ ports, sessionId: "s", turnId: "t", signal: new AbortController().signal, maxWaitMs: 1000, pollIntervalMs: 50 })).text();
  expect(text).toContain("[DONE]");
  expect(Date.now() - startedAt).toBeLessThan(500);
});

it("同Turn恢复重放旧暂停后仍跟随新执行段终态", async function resumedStreamIgnoresOldPause() {
  const ports = createMemoryPorts();
  await ports.turnStore.save({ id: "t", sessionId: "s", status: "running", frozenRunConfig: {}, startedAt: 1 });
  for (const [index, type] of ["turn_paused", "turn_started"].entries()) await ports.transcriptStore.append("s", { sessionId: "s", turnId: "t", seq: index + 1, timestamp: new Date().toISOString(), event: { type, turnId: "t", stepCount: 1 } } as never);
  const completion = new Promise<void>(function finish(resolve) { setTimeout(function terminal() { void ports.transcriptStore.append("s", { sessionId: "s", turnId: "t", seq: 3, timestamp: new Date().toISOString(), event: { type: "turn_completed", turnId: "t" } } as never).then(resolve); }, 80); });
  const output = await new Response(createWebTurnStream({ ports, sessionId: "s", turnId: "t", signal: new AbortController().signal, maxWaitMs: 1000, pollIntervalMs: 50 })).text();
  await completion;
  expect(output).toContain("turn_completed");
});

it("已有现场首run按持久messageId与真实Turn补回，历史重复读取只生成一次", async function durablePrompt() {
  const ports = createMemoryPorts();
  const runtime = createAgentRuntime({ ports });
  const root = await runtime.sessions.create({ title: "来源" });
  const context = { workspaceId: "ws", stateRootId: "state", projectId: root.projectId!, modelCatalog: [], allowedTools: [], executionHost: "web-work-v1" };
  const human = createThreadFacade(ports, { ...context, actor: { kind: "human", principalId: "local" } });
  const group = await human.enable({ protocolVersion: 1, rootThreadId: root.id, requestId: "enable" });
  const groupId = group.group.groupId;
  const child = await human.create({ protocolVersion: 1, groupId, parentThreadId: root.id, requestId: "child" });
  await ports.sessionStore.save({ ...(await ports.sessionStore.get(root.id))!, status: "running", activeTurnId: "parent-turn" });
  await ports.turnStore.save({ id: "parent-turn", sessionId: root.id, status: "running", startedAt: 1, frozenRunConfig: {} });
  const sender = createThreadFacade(ports, { ...context, actor: { kind: "thread", threadId: root.id, turnId: "parent-turn" } });
  const sent = await sender.send({ protocolVersion: 1, groupId, threadId: child.threadId, requestId: "prompt", mode: "run", content: "首条真实Prompt" });
  const delivery = createThreadDeliveryService(ports, ports.threadStore, { workspaceId: "ws", stateRootId: "state", executionHost: "web-work-v1", ownerId: "web-owner" });
  const [claimed] = await delivery.claimDeliveries({ activeThreads: [] });
  expect(await restoreWebThreadPrompts(ports, child.threadId, [])).toEqual([]);
  const turnId = claimed.delivery.reservedTurnId!;
  await ports.turnStore.save({ id: turnId, sessionId: child.threadId, status: "running", startedAt: 1000, frozenRunConfig: {} });
  const first = await restoreWebThreadPrompts(ports, child.threadId, []);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ clientRecordId: `thread:${sent.messageId}`, turnId, content: "首条真实Prompt", origin: { kind: "thread", threadId: root.id }, createdAt: 1000 });
  expect(await restoreWebThreadPrompts(ports, child.threadId, first)).toEqual(first);
  expect(await restoreWebThreadPrompts(ports, child.threadId, [...first, { ...first[0], id: "old-duplicate" }])).toHaveLength(1);
  const webContext = { workspaceId: "ws", projectId: root.projectId, runtime, compositionRoot: { getRuntimePorts: function samePorts() { return ports; } } };
  const response = await runWithWorkspaceRequestContext(webContext as never, function history() { return GET(new Request("http://localhost/api/workspaces/ws/sessions/child"), { params: Promise.resolve({ id: child.threadId }) }); });
  expect(response.status).toBe(200);
  expect((await response.json()).messages.filter(function prompt(message: { clientRecordId?: string }) { return message.clientRecordId === `thread:${sent.messageId}`; })).toHaveLength(1);
});

/** 构造只带安全观察事实的完成调用，不读取任何工具raw output。 */
function observation(index: number, key = "target-task", phase = "running"): ToolCallItem {
  return { id: `tool:${index}`, kind: "tool_call", callId: `${index}`, turnId: "t", toolName: "wait_threads", profileKey: "other", category: "read", state: "completed", titleKey: "tool.thread.read.completed", observation: { key, phase, lines: ["execution=active"] } };
}

it("连续混合工具从首调用归并，正文输入及失败保留边界", function observationBoundaries() {
  const initial = [observation(1), observation(2), observation(3)];
  expect(groupWebObservations(initial.slice(0, 2))).toHaveLength(1);
  const group = groupWebObservations(initial)[0];
  expect(group).toMatchObject({ kind: "web_tool_activity", toolCallIds: ["1", "2", "3"] });
  expect(groupWebObservations([...initial, { ...observation(4), toolName: "send_thread", observation: undefined }, observation(5, "other-task", "new-phase")])[0]).toMatchObject({ id: group.id, toolCallIds: ["1", "2", "3", "4", "5"] });
  const boundaries: TimelineItem[] = [
    { id: "reply", kind: "assistant_answer", channel: "process", turnId: "t", stepId: "s", content: "阶段回复" },
    { id: "input", kind: "input_notice", turnId: "t", inputId: "i", state: "consumed", content: "引导" },
    { ...observation(11), state: "failed" },
    { ...observation(12), state: "awaiting_approval" },
  ];
  for (const boundary of boundaries) {
    const result = groupWebObservations([...initial, boundary, observation(13)]);
    expect(result).toHaveLength(3);
    expect(result[1]).toBe(boundary);
    expect(result[2]).toMatchObject({ kind: "web_tool_activity", toolCallIds: ["13"] });
  }
});

it("匹配Web Runner沿同一Runtime冻结父子预览能力", async function sameWebCapabilities() {
  const ports = createMemoryPorts();
  const preview = {} as never;
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { workPreview: preview, workPreviewLoader: async function load() { return preview; }, modelSampler: { async sample() { return { content: "完成", toolCalls: [], finishReason: "stop" }; } } } });
  const root = await runtime.sessions.create({ title: "父" });
  const capability = { workspaceId: "ws", stateRootId: "state", projectId: root.projectId!, allowedTools: [], modelCatalog: [], executionHost: "web-work-v1" };
  const host = createWebThreadHost({ ...capability, workspaceRoot: process.cwd(), runtime, ports, capability });
  try {
    const facade = host.facade();
    const enabled = await facade.enable({ protocolVersion: 1, rootThreadId: root.id, requestId: "enable" });
    const groupId = enabled.group.groupId;
    const child = await facade.create({ protocolVersion: 1, groupId, parentThreadId: root.id, requestId: "child" });
    for await (const event of runtime.turns.start({ sessionId: root.id, turnId: "parent", content: "父任务" })) { /* 完整消费真实内存Turn。 */ }
    await facade.send({ protocolVersion: 1, groupId, threadId: child.threadId, requestId: "run", mode: "run", content: "子任务" });
    host.ensureStarted();
    let childTurn = await ports.turnStore.getLatest(child.threadId);
    for (let attempt = 0; attempt < 100 && childTurn?.status !== "completed"; attempt += 1) {
      await new Promise<void>(function wait(resolve) { setTimeout(resolve, 20); });
      childTurn = await ports.turnStore.getLatest(child.threadId);
    }
    expect(childTurn?.status).toBe("completed");
    expect(childTurn?.frozenRunConfig.workPreviewEnabled).toBe(true);
    expect((await ports.turnStore.get("parent"))?.frozenRunConfig.workPreviewEnabled).toBe(true);
  } finally { await host.stop(); }
});
