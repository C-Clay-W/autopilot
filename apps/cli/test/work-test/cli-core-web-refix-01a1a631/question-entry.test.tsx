/** S3 正常CLI Workspace输入历史问题，Core验证答案，兼容宿主继续原Turn。 */
import { createElement } from "react";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { expect, it } from "vitest";
import { createAgentRuntime, createMemoryPorts } from "@autopilot-agent/core";
import { createCliController } from "../../../src/controller.js";
import { createPlainRenderer } from "../../../src/renderer.js";
import { createCliSessionManager } from "../../../src/tui/session-manager.js";
import { CliSessionWorkspace } from "../../../src/tui/session-workspace.js";
import { createWebThreadHost } from "../../../../web/lib/workspace-host/web-thread-host";

/** 等待真实Ink输入订阅及受控异步存储。 */
async function frame() { await new Promise(function wait(resolve) { setTimeout(resolve, 40); }); }
/** 有界等待，不重复发送按键。 */
async function until(probe: () => Promise<boolean>) { for (let attempt = 0; attempt < 80; attempt++) { if (await probe()) return; await frame(); } throw new Error("controlled CLI question timeout"); }

/** 旧Web结构化问题保留在原Session，CLI仅装配纯文本能力。 */
async function fixture(followup = false) {
  const evidence = path.resolve("E:/autopilot-agent/.agent-tests/work-test/cli-core-web-refix-01a1a631/runs/r001/s23-cli-workspaces");
  await mkdir(evidence, { recursive: true });
  const workspaceRoot = await mkdtemp(path.join(evidence, "question-"));
  await writeFile(path.join(workspaceRoot, "context.txt"), "must-not-be-expanded");
  const ports = createMemoryPorts(workspaceRoot);
  const seed = createAgentRuntime({ ports });
  const session = await seed.sessions.create({ title: "历史问题" });
  const capability = { workspaceId: "workspace", stateRootId: "state", projectId: session.projectId!, allowedTools: [], modelCatalog: [], humanPrincipalId: "user" };
  let samples = 0;
  const web = createAgentRuntime({ ports, enableUserQuestions: true, defaultRunConfig: { workspaceRoot, threads: { ...capability, executionHost: "web-work-v1" }, modelSampler: { async sample() { samples++; return samples === 1 || followup && samples === 2 ? { content: "", toolCalls: [{ id: samples === 1 ? "historical-question" : "followup-question", name: "ask_user_question", input: { questions: [
    { id: "scope", header: "第一题", question: "选择范围", options: [{ label: "小", description: "最小" }, { label: "全", description: "全部" }] },
    { id: "target", header: "第二题", question: "选择名称或补充", options: [{ label: "默认", description: "默认名称" }, { label: "示例", description: "示例名称" }] },
  ] } }], reasoningSummary: "controlled" } : { content: "done", toolCalls: [], reasoningSummary: "controlled" }; } } } });
  const group = await web.threads.bind({ ...capability, executionHost: "web-work-v1", actor: { kind: "human", principalId: "user" } }).enable({ protocolVersion: 1, rootThreadId: session.id, requestId: "enable" });
  for await (const _event of web.turns.start({ sessionId: session.id, content: "controlled" })) { /* 真实Core生成原问题。 */ }
  const cli = createAgentRuntime({ ports, defaultRunConfig: { threads: { ...capability, executionHost: "cli-work-v1" } } });
  /** 每个目标只创建原Controller，Manager查询权威Core状态。 */
  function controller(id: string) { return createCliController({ runtime: cli, sessionId: id, renderer: createPlainRenderer("text") }); }
  const manager = createCliSessionManager({ runtime: cli, projectId: session.projectId!, initialSession: (await ports.sessionStore.get(session.id))!, initialController: controller(session.id), createController: controller,
    readSummary: async function summary(id) { const view = await cli.turns.getExecutionState({ sessionId: id }); return { status: view?.status, currentTurnId: view?.turnId, executionView: view }; },
    readRelations: async function relations() { return []; },
    readEventPage: async function events(id) { return { items: await ports.transcriptStore.getEvents(id), cursor: "end" }; },
  });
  await manager.refresh();
  await manager.select(session.id);
  manager.selected().viewState.initialStarted = true;
  const terminal = Object.assign(new EventEmitter(), { columns: 100, rows: 28 });
  const view = render(createElement(CliSessionWorkspace, { manager, workspaceRoot, terminalSizeSource: terminal, renderMode: "inline", useColor: false, screenReader: false, reducedMotion: true, closeWhenIdle: false, onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: function cancel() {}, onEof: function eof() {}, onAppExit: function exit() {} }));
  const webHost = createWebThreadHost({ workspaceId: "workspace", stateRootId: "state", projectId: session.projectId!, workspaceRoot, runtime: web, ports, capability: { ...capability, executionHost: "web-work-v1" } });
  return { ports, session, cli, web, groupId: group.group.groupId, manager, view, webHost };
}

it("S3 正式Workspace逐题选项/自定义保存，CLI显示答案已保存，Web原Turn仅继续一次", async function normalQuestionInput() {
  const f = await fixture();
  try {
    await frame();
    expect(f.view.lastFrame()).toContain("等待回答");
    f.view.stdin.write("1"); await frame(); f.view.stdin.write("\r");
    await until(async function next() { return f.manager.selected().store.getSnapshot().transcript.some(function notice(item) { return item.kind === "notice" && item.message.includes("第二题"); }); });
    f.view.stdin.write("@context.txt"); await frame(); f.view.stdin.write("\r");
    await until(async function saved() { return (await f.cli.turns.getExecutionState({ sessionId: f.session.id }))?.interaction?.state === "decided"; });
    const saved = (await f.cli.turns.getExecutionState({ sessionId: f.session.id }))!;
    expect(JSON.stringify(saved)).not.toContain("must-not-be-expanded");
    expect(saved.interaction?.continuation?.state).toBe("pending");
    const record = await f.ports.userQuestionStore.getRequest({ sessionId: f.session.id, turnId: saved.turnId, requestId: saved.interaction!.requestId! });
    expect(record?.answer?.answers).toEqual([{ id: "scope", selected: ["小"] }, { id: "target", selected: [], custom: "@context.txt" }]);
    await f.manager.refresh(); await frame();
    expect(f.view.lastFrame()).toContain("答案已保存");
    expect(f.view.lastFrame()).not.toContain("审批决定已保存");
    f.webHost.ensureStarted();
    await until(async function completed() { return (await f.ports.turnStore.get(saved.turnId))?.status === "completed"; });
    expect((await f.ports.transcriptStore.getEvents(f.session.id)).filter(function result(item) { return item.event.type === "tool_result" && item.event.callId === "historical-question"; })).toHaveLength(1);
  } finally { f.view.unmount(); await f.webHost.stop(); await f.manager.stop(); }
});

it("S3 历史已保存答案重开Controller后/resume复用原请求，不重交答案", async function resumesSavedQuestion() {
  const f = await fixture();
  try {
    const original = (await f.cli.turns.getExecutionState({ sessionId: f.session.id }))!;
    await f.cli.questions.submit({ sessionId: f.session.id, turnId: original.turnId, requestId: original.interaction!.requestId!, answers: [{ id: "scope", selected: ["小"] }, { id: "target", selected: [], custom: "controlled" }] });
    const reopened = createCliController({ runtime: f.cli, sessionId: f.session.id, renderer: createPlainRenderer("text") });
    const result = await reopened.resume();
    expect(result.lines.join("\n")).toContain("答案已保存");
    const control = (await f.ports.threadStore.readControl(f.groupId))!.controls[0];
    expect(control.requestId).toBe(original.interaction!.requestId);
    f.webHost.ensureStarted();
    await until(async function completed() { return (await f.ports.turnStore.get(original.turnId))?.status === "completed"; });
  } finally { f.view.unmount(); await f.webHost.stop(); await f.manager.stop(); }
});

it("S3 纯数字自定义答案通过显式其他前缀保留原值", async function numericCustomAnswer() {
  const f = await fixture();
  try {
    const controller = f.manager.selected().controller;
    expect((await controller.dispatch({ type: "submit_prompt", content: "1" })).kind).toBe("ok");
    expect((await controller.dispatch({ type: "submit_prompt", content: "其他 1" })).kind).toBe("ok");
    const view = (await f.cli.turns.getExecutionState({ sessionId: f.session.id }))!;
    const stored = await f.ports.userQuestionStore.getRequest({ sessionId: f.session.id, turnId: view.turnId, requestId: view.interaction!.requestId! });
    expect(stored?.answer?.answers[1]).toEqual({ id: "target", selected: [], custom: "1" });
  } finally { f.view.unmount(); await f.webHost.stop(); await f.manager.stop(); }
});

it("S3 Core拒绝无效答案后重新显示首题，同一请求可校准重答", async function invalidAnswerRetry() {
  const f = await fixture();
  try {
    const controller = f.manager.selected().controller;
    await controller.dispatch({ type: "submit_prompt", content: "1" });
    const failed = await controller.dispatch({ type: "submit_prompt", content: "x".repeat(2001) });
    expect(failed.kind).toBe("error");
    expect(failed.lines.join("\n")).toContain("第一题");
    expect((await f.cli.turns.getExecutionState({ sessionId: f.session.id }))?.interaction?.state).toBe("pending");
    await controller.dispatch({ type: "submit_prompt", content: "2" });
    expect((await controller.dispatch({ type: "submit_prompt", content: "retry" })).kind).toBe("ok");
    const view = (await f.cli.turns.getExecutionState({ sessionId: f.session.id }))!;
    const stored = await f.ports.userQuestionStore.getRequest({ sessionId: f.session.id, turnId: view.turnId, requestId: view.interaction!.requestId! });
    expect(stored?.answer?.answers).toEqual([{ id: "scope", selected: ["全"] }, { id: "target", selected: [], custom: "retry" }]);
  } finally { f.view.unmount(); await f.webHost.stop(); await f.manager.stop(); }
});

it("S3 同Turn问题已换代，旧输入身份不能回答新请求", async function rejectsLateQuestionInput() {
  const f = await fixture(true);
  try {
    const original = (await f.cli.turns.getExecutionState({ sessionId: f.session.id }))!;
    expect(f.manager.selected().controller.getProjection().questionRequestId).toBe(original.interaction!.requestId);
    await f.web.questions.submit({ sessionId: f.session.id, turnId: original.turnId, requestId: original.interaction!.requestId!, answers: [{ id: "scope", selected: ["小"] }, { id: "target", selected: ["默认"] }] });
    for await (const _event of f.web.turns.continue({ sessionId: f.session.id, turnId: original.turnId, requestId: original.interaction!.requestId })) { /* 兼容宿主推进到真实新问题。 */ }
    const next = (await f.cli.turns.getExecutionState({ sessionId: f.session.id }))!;
    expect(next.interaction!.requestId).not.toBe(original.interaction!.requestId);
    expect((await f.manager.selected().controller.dispatch({ type: "submit_prompt", content: "1" })).kind).toBe("error");
    const stored = await f.ports.userQuestionStore.getRequest({ sessionId: f.session.id, turnId: next.turnId, requestId: next.interaction!.requestId! });
    expect(stored?.answer).toBeUndefined();
  } finally { f.view.unmount(); await f.webHost.stop(); await f.manager.stop(); }
});

it("S3 旧分页兼容路径消费真实question_required并保留精确请求身份", async function legacyQuestionEvent() {
  const f = await fixture();
  const parent = await f.cli.sessions.create({ projectId: f.session.projectId, title: "observer" });
  const original = (await f.cli.turns.getExecutionState({ sessionId: f.session.id }))!;
  /** 旧适配器只提供元数据和事件分页，控制器仍复用当前Core查询。 */
  function controller(id: string) { return createCliController({ runtime: f.cli, sessionId: id, renderer: createPlainRenderer("text") }); }
  const manager = createCliSessionManager({ runtime: f.cli, projectId: f.session.projectId!, initialSession: parent, initialController: controller(parent.id), createController: controller,
    readSummary: async function summary() { return { status: "idle" as const }; },
    readRelations: async function relations() { return [{ threadId: f.session.id, parentThreadId: parent.id, title: "historical", status: "waiting_user_input" as const, activeTurnId: original.turnId }]; },
    readEventPage: async function page(id) { return { items: await f.ports.transcriptStore.getEvents(id), cursor: "end" }; },
  });
  try {
    await manager.refresh();
    const child = manager.related()[0];
    expect(child.controller.getProjection().questionRequestId).toBe(original.interaction!.requestId);
    expect(child.controller.getProjection().status).toBe("waiting_user_input");
  } finally { await manager.stop(); f.view.unmount(); await f.webHost.stop(); await f.manager.stop(); }
});

