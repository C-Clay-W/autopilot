/** S0 受控问题提交三阶段取证，真实Route与Core，注入一次明确的宿主交接失败。 */
import { expect, it, vi } from "vitest";
import { createAgentRuntime, createMemoryPorts, AgentRuntimeError } from "@autopilot-agent/core";
import { GET as history } from "@/app/api/sessions/[id]/route";
import { POST as questions } from "@/app/api/sessions/[id]/questions/route";
import { POST as continueTurn } from "@/app/api/sessions/[id]/continue/route";
import { createWebTurnHost } from "@/lib/workspace-host/web-turn-host";
import { createWebTurnStream } from "@/lib/workspace-host/web-turn-stream";
import { runWithWorkspaceRequestContext } from "@/lib/workspace-host/web-workspace-session";
import type { WebWorkspaceContext } from "@/lib/workspace-host/web-workspace-host";
import { writeFile } from "node:fs/promises";
import { createWebThreadHost } from "@/lib/workspace-host/web-thread-host";

it("S0 问题已保存/交接拒绝/继续202/观察断开分别记录且同Turn最终完成", async function phaseBoundaries() {
  const ports = createMemoryPorts(process.cwd());
  let samples = 0;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(function wait(resolve) { release = resolve; });
  const resumed = new Promise<void>(function wait(resolve) { started = resolve; });
  const runtime = createAgentRuntime({ ports, enableUserQuestions: true, defaultRunConfig: { workspaceRoot: process.cwd(), modelSampler: { async sample() {
    samples++;
    if (samples === 1) return { content: "", toolCalls: [{ id: "ask-controlled", name: "ask_user_question", input: { questions: [{ id: "scope", header: "范围", question: "选择本次范围", options: [{ label: "小", description: "最小范围" }, { label: "全", description: "全部范围" }] }] } }], reasoningSummary: "controlled" };
    started();
    await gate;
    return { content: "done", toolCalls: [], reasoningSummary: "controlled" };
  } } } });
  const session = await runtime.sessions.create({ title: "controlled phases" });
  let requestId = "";
  let turnId = "";
  for await (const event of runtime.turns.start({ sessionId: session.id, content: "controlled" })) {
    if (event.type === "question_required") { requestId = event.requestId; turnId = event.turnId; }
  }
  expect(requestId).not.toBe("");
  const turnHost = createWebTurnHost({ runtime, ports });
  const context = { workspaceId: "controlled", workspaceRoot: process.cwd(), projectId: session.projectId, runtime, turnHost } as WebWorkspaceContext;
  const phases: Array<{ phase: string; at: number; status?: number; code?: string }> = [];
  /** 经受信Workspace上下文调用生产处理器，记录安全阶段及HTTP状态。 */
  async function call(handler: typeof questions, body: object) {
    return runWithWorkspaceRequestContext(context, function route() { return handler(new Request("http://localhost/api/workspaces/controlled/sessions/fixture", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: session.id }) }); });
  }
  try {
    const saved = await call(questions, { turnId, requestId, answers: [{ id: "scope", selected: ["小"] }] });
    expect(saved.status).toBe(200);
    phases.push({ phase: "questions_saved", at: Date.now(), status: saved.status });
    expect((await ports.checkpointStore.getLatest(session.id))?.status).toBe("awaiting_user_input");
    vi.spyOn(turnHost, "continue").mockImplementationOnce(function rejectDispatch() { throw new AgentRuntimeError("TURN_ALREADY_RUNNING", "TURN_ALREADY_RUNNING"); });
    const rejected = await call(continueTurn, { turnId, requestId });
    expect(rejected.status).toBe(409);
    phases.push({ phase: "continue_rejected", at: Date.now(), status: rejected.status, code: (await rejected.json()).code });
    expect(await runtime.questions.getAnswer({ sessionId: session.id, turnId, requestId })).toBeTruthy();
    const accepted = await call(continueTurn, { turnId, requestId });
    expect(accepted.status).toBe(202);
    phases.push({ phase: "continue_accepted", at: Date.now(), status: accepted.status });
    await resumed;
    const observer = new AbortController();
    const stream = createWebTurnStream({ ports, host: turnHost, sessionId: session.id, turnId, cursor: 0, signal: observer.signal });
    const reader = stream.getReader();
    expect((await reader.read()).done).toBe(false);
    observer.abort();
    await reader.cancel();
    phases.push({ phase: "observer_disconnected", at: Date.now() });
    release();
    expect(await turnHost.waitSettled(turnId)).toBe(true);
    expect((await ports.turnStore.get(turnId))?.status).toBe("completed");
    phases.push({ phase: "original_turn_completed", at: Date.now() });
    await writeFile("E:/autopilot-agent/.agent-tests/work-test/cli-core-web-refix-01a1a631/runs/r001/s0-controlled-phases.json", JSON.stringify({ sessionId: session.id, turnId, requestId, phases }, null, 2));
  } finally {
    release();
    vi.restoreAllMocks();
    await turnHost.stop();
  }
});

it("S2/S3 保留旧settled宿主记录时，新交接观察不被旧暂停结束，离线有界返回后原请求接手完成", async function oldSettledRecord() {
  const ports = createMemoryPorts(process.cwd());
  const seed = createAgentRuntime({ ports });
  const session = await seed.sessions.create({ title: "controlled handoff" });
  const capability = { workspaceId: "controlled", stateRootId: "state", projectId: session.projectId!, allowedTools: [], modelCatalog: [], humanPrincipalId: "user", executionHost: "web-work-v1" };
  let samples = 0;
  const runtime = createAgentRuntime({ ports, enableUserQuestions: true, defaultRunConfig: { workspaceRoot: process.cwd(), threads: capability, modelSampler: { async sample() {
    samples++;
    return samples === 1 ? { content: "", toolCalls: [{ id: "ask-settled", name: "ask_user_question", input: { questions: [{ id: "scope", header: "范围", question: "选择范围", options: [{ label: "小", description: "最小" }, { label: "全", description: "全部" }] }] } }], reasoningSummary: "controlled" } : { content: "done", toolCalls: [], reasoningSummary: "controlled" };
  } } } });
  const human = runtime.threads.bind({ ...capability, actor: { kind: "human", principalId: "user" } });
  await human.enable({ protocolVersion: 1, rootThreadId: session.id, requestId: "enable" });
  const turnHost = createWebTurnHost({ runtime, ports });
  const turnId = "controlled-settled-turn";
  turnHost.start({ sessionId: session.id, turnId, content: "controlled" });
  expect(await turnHost.waitSettled(turnId)).toBe(true);
  expect(turnHost.status(turnId)?.state).toBe("settled");
  const view = (await runtime.turns.getExecutionState({ sessionId: session.id, turnId }))!;
  const requestId = view.interaction!.requestId!;
  const context = { workspaceId: "controlled", workspaceRoot: process.cwd(), projectId: session.projectId, runtime, turnHost } as WebWorkspaceContext;
  /** 走正式问题/继续处理器，保留原Host的settled记录。 */
  async function call(handler: typeof questions, body: object) { return runWithWorkspaceRequestContext(context, function scoped() { return handler(new Request("http://localhost/api/workspaces/controlled/sessions/fixture", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: session.id }) }); }); }
  expect((await call(questions, { turnId, requestId, answers: [{ id: "scope", selected: [], custom: "private-answer-unique" }] })).status).toBe(200);
  const restored = await runWithWorkspaceRequestContext(context, function readHistory() { return history(new Request("http://localhost/api/workspaces/controlled/sessions/fixture"), { params: Promise.resolve({ id: session.id }) }); });
  expect(restored.status).toBe(200);
  const dto = await restored.json();
  expect(dto.agent).toMatchObject({ requestId, interactionState: "decided" });
  expect(dto.presentation.items.find(function original(item: { kind: string; requestId?: string }) { return item.kind === "user_question" && item.requestId === requestId; })?.state).toBe("answered");
  expect(JSON.stringify(dto)).not.toContain("private-answer-unique");
  const accepted = await call(continueTurn, { turnId, requestId });
  expect(accepted.status).toBe(202);
  expect((await accepted.json()).controlId).toEqual(expect.any(String));
  let offlineFinished = false;
  const offlineSignal = new AbortController();
  const offline = createWebTurnStream({ ports, host: turnHost, sessionId: session.id, turnId, cursor: 0, signal: offlineSignal.signal, pollIntervalMs: 50, maxWaitMs: 1000 });
  const offlineText = new Response(offline).text().then(function finished(text) { offlineFinished = true; return text; });
  const threadHost = createWebThreadHost({ workspaceId: "controlled", stateRootId: "state", projectId: session.projectId!, workspaceRoot: process.cwd(), runtime, ports, turnHost, capability });
  try {
    await new Promise(function wait(resolve) { setTimeout(resolve, 100); });
    expect(offlineFinished).toBe(false);
    const first = await offlineText;
    expect(first).not.toContain('"type":"turn_completed"');
    expect((await runtime.turns.getExecutionState({ sessionId: session.id, turnId }))?.interaction?.continuation?.state).toBe("pending");
    const observer = new AbortController();
    const observation = new Response(createWebTurnStream({ ports, host: turnHost, sessionId: session.id, turnId, cursor: 0, signal: observer.signal, pollIntervalMs: 50, maxWaitMs: 3000 })).text();
    threadHost.ensureStarted();
    const text = await observation;
    expect(text).toContain('"type":"turn_completed"');
    expect((await ports.turnStore.get(turnId))?.status).toBe("completed");
    expect((await ports.transcriptStore.getEvents(session.id)).filter(function result(item) { return item.event.type === "tool_result" && item.event.callId === "ask-settled"; })).toHaveLength(1);
  } finally { offlineSignal.abort(); await threadHost.stop(); await turnHost.stop(); }
});

