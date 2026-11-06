/** Work TurnHost 契约：POST 只提交意图、执行与页面无关、取消与收尾投影都有持久事实。 */
import { describe, expect, it } from "vitest";
import { createAgentRuntime, createMemoryPorts } from "@autopilot-agent/core";
import type { AgentEvent, AgentEventEnvelope, ModelSampler, RuntimePorts } from "@autopilot-agent/core";
import { getSessionMessages } from "@/lib/session-store";
import { createWebTurnHost } from "@/lib/workspace-host/web-turn-host";
import { createWebTurnStream } from "@/lib/workspace-host/web-turn-stream";
import { createWebQueuedTurnPreparer } from "@/lib/workspace-host/web-queued-turn";

/** 固定回答的采样器：Runner 真实驱动 Turn 时不触达网络。 */
const sampler: ModelSampler = {
  async sample() { return { content: "完成", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" }; },
};

/** 可被取消打断的慢采样器；abort 后立即抛错，Turn 由 Core 收敛为 interrupted。 */
function slowSampler(delayMs: number): ModelSampler {
  return {
    async sample(_messages, _tools, options) {
      // 采样前后都响应取消：重试到一半的采样也必须立即失败。
      if (options?.signal?.aborted) throw new Error("aborted");
      await new Promise<void>(function wait(resolve, reject) {
        const timer = setTimeout(resolve, delayMs);
        options?.signal?.addEventListener("abort", function abortSample() { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      });
      if (options?.signal?.aborted) throw new Error("aborted");
      return { content: "太慢", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" };
    },
  };
}

/** 首轮发起结构化提问、恢复后正常收尾的采样器；用于验证暂停 Turn 的同宿主续跑。 */
function questionSampler(): ModelSampler {
  let samples = 0;
  return {
    async sample() {
      samples += 1;
      if (samples > 1) return { content: "完成", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" };
      return {
        content: "",
        reasoningSummary: "需要确认范围",
        toolCalls: [{
          id: "ask-scope",
          name: "ask_user_question",
          input: { questions: [{ id: "scope", header: "范围", question: "本次应完成到哪个范围？", options: [{ label: "最小修复", description: "仅修复当前问题" }, { label: "完整实现", description: "完成本计划全部功能" }] }] },
        }],
      };
    },
  };
}

/** 首轮阻塞到取消、后续轮直接收尾的采样器；用于验证中断后的同一 Turn 能继续。 */
function interruptThenAnswerSampler(onSampling: () => void): ModelSampler {
  let samples = 0;
  return {
    async sample(_messages, _tools, options) {
      samples += 1;
      if (samples > 1) return { content: "继续完成", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" };
      onSampling();
      await new Promise<void>(function waitForAbort(_resolve, reject) {
        options?.signal?.addEventListener("abort", function rejectOnAbort() { reject(new Error("aborted")); }, { once: true });
      });
      return { content: "未被打断", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" };
    },
  };
}

/** 按调用序号返回不同回答的采样器；用于区分宿主连续执行的两轮。 */
function sequencedSampler(delayMs: number): ModelSampler {
  let samples = 0;
  return {
    async sample(_messages, _tools, options) {
      samples += 1;
      const round = samples;
      await new Promise<void>(function wait(resolve, reject) {
        const timer = setTimeout(resolve, delayMs);
        options?.signal?.addEventListener("abort", function abortSample() { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      });
      return { content: `第${round}轮`, toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" };
    },
  };
}

/** 排队装配所需的 Composition Root 替身：只提供 Skill/Context/附件投影，不触达 Provider。 */
function queuedCompositionRoot() {
  return {
    prepareTurnContext: async function prepare() { return undefined; },
    resolveSelectedSkills: async function skills() { return { skills: [], pinnedSkills: [], diagnostics: [] }; },
    createAttachmentInstruction: function attachment() { return undefined; },
    createSelectedSkillsInstruction: function selectedSkills() { return undefined; },
  } as unknown as Parameters<typeof createWebQueuedTurnPreparer>[0]["compositionRoot"];
}

/** 建立接管 Inbox.queue 的宿主；`onPrepare` 在领取成功、真正启动前触发，用于探测执行权。 */
function setupWithQueue(modelSampler: ModelSampler = sampler, options: { enableUserQuestions?: boolean; onPrepare?: (input: { sessionId: string }) => void } = {}) {
  const ports: RuntimePorts = createMemoryPorts();
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler }, enableUserQuestions: options.enableUserQuestions ?? false });
  const prepare = createWebQueuedTurnPreparer({ runtime, compositionRoot: queuedCompositionRoot() });
  const host = createWebTurnHost({
    runtime,
    ports,
    prepareQueuedTurn: async function prepareQueued(input) {
      options.onPrepare?.(input);
      return prepare(input);
    },
  });
  return { ports, runtime, host };
}

/** 有界等待宿主异步收尾，避免用固定 sleep 猜测调度时间。 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return true;
    await new Promise<void>(function tick(resolve) { setTimeout(resolve, 25); });
  }
  return false;
}

/** 建立内存 Runtime 与绑定它的 TurnHost；`enableUserQuestions` 打开结构化问答入口。 */
function setup(modelSampler: ModelSampler = sampler, enableUserQuestions = false) {
  const ports: RuntimePorts = createMemoryPorts();
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler }, enableUserQuestions });
  const host = createWebTurnHost({ runtime, ports });
  return { ports, runtime, host };
}

/** 读取 SSE 观察流的全部 data 事件（不含结束标记）。 */
async function readSseEvents(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const text = await new Response(stream).text();
  return text
    .split("\n\n")
    .filter(function dataOnly(line) { return line.startsWith("data: ") && !line.includes("[DONE]"); })
    .map(function parse(line) { return JSON.parse(line.slice(6)) as Record<string, unknown>; });
}

describe("Web TurnHost 执行", function webTurnHostContract() {
  it("start 接受意图后由宿主消费完整事件流，并持久化助手回答", async function startPersistsAnswer() {
    const f = setup();
    const session = await f.runtime.sessions.create({ title: "新对话" });
    const accepted = f.host.start({ sessionId: session.id, turnId: "turn-start", content: "任务" });
    expect(accepted.turnId).toBe("turn-start");
    expect(await f.host.waitSettled("turn-start", 5_000)).toBe(true);
    const messages = await getSessionMessages(f.runtime, session.id);
    const answer = messages.find(function assistant(message) { return message.role === "assistant" && message.turnId === "turn-start"; });
    expect(answer?.content).toBe("完成");
    expect(answer?.failure).toBeUndefined();
  });

  it("同一 Session 重复 start 被拒绝，取消会中止宿主执行", async function cancelStopsExecution() {
    const f = setup(slowSampler(400));
    const session = await f.runtime.sessions.create({ title: "新对话" });
    f.host.start({ sessionId: session.id, turnId: "turn-cancel", content: "任务" });
    expect(function duplicate() { return f.host.start({ sessionId: session.id, turnId: "turn-other", content: "第二个" }); })
      .toThrowError(/TURN_ALREADY_RUNNING/);
    expect(f.host.cancel({ sessionId: session.id, turnId: "turn-cancel" })).toBe(true);
    expect(await f.host.waitSettled("turn-cancel", 5_000)).toBe(true);
    // 被取消的 Turn 不写失败回答；执行在页面断开后仍由宿主收口。
    const messages = await getSessionMessages(f.runtime, session.id);
    expect(messages.some(function assistant(message) { return message.role === "assistant" && message.content === "太慢"; })).toBe(false);
  });

  it("等待回答的 Turn 在同一宿主内用原 turnId 继续，并拒绝并发 continue", async function resumesPausedTurn() {
    const f = setup(questionSampler(), true);
    const session = await f.runtime.sessions.create({ title: "新对话" });
    f.host.start({ sessionId: session.id, turnId: "turn-question", content: "请确认范围" });
    expect(await f.host.waitSettled("turn-question", 5_000)).toBe(true);
    // Core 发出问题后结束该执行段，宿主仍保留同一 Turn 的收尾记录。
    expect(f.host.status("turn-question")?.state).toBe("settled");
    const state = await f.runtime.turns.getState({ sessionId: session.id, turnId: "turn-question" });
    const asked = state.events.find(function question(envelope) { return envelope.event.type === "question_required"; });
    if (!asked) throw new Error("fixture 未进入等待回答");
    // 事件联合含 Omit 成员，判别式收窄失效；此处按已校验的类型取回 requestId。
    const requestId = (asked.event as Extract<AgentEvent, { type: "question_required" }>).requestId;
    await f.runtime.questions.submit({
      sessionId: session.id,
      turnId: "turn-question",
      requestId,
      answers: [{ id: "scope", selected: ["最小修复"] }],
    });

    f.host.continue({ sessionId: session.id, turnId: "turn-question", requestId });
    // 新执行段未结束前，同一 Turn 的重复 continue 仍按活动执行拒绝。
    expect(function duplicate() { return f.host.continue({ sessionId: session.id, turnId: "turn-question", requestId }); })
      .toThrowError(/TURN_ALREADY_RUNNING/);
    expect(await f.host.waitSettled("turn-question", 5_000)).toBe(true);
    const messages = await getSessionMessages(f.runtime, session.id);
    const answer = messages.find(function assistant(message) { return message.role === "assistant" && message.turnId === "turn-question"; });
    expect(answer?.content).toBe("完成");
    expect(answer?.failure).toBeUndefined();
  });

  it("中断后的同一 Turn 可在原宿主继续执行", async function resumesInterruptedTurn() {
    let sampling!: () => void;
    const started = new Promise<void>(function waitSampling(resolve) { sampling = resolve; });
    const f = setup(interruptThenAnswerSampler(sampling));
    const session = await f.runtime.sessions.create({ title: "新对话" });
    f.host.start({ sessionId: session.id, turnId: "turn-interrupt", content: "任务" });
    await started;
    expect(f.host.cancel({ sessionId: session.id, turnId: "turn-interrupt" })).toBe(true);
    expect(await f.host.waitSettled("turn-interrupt", 5_000)).toBe(true);
    expect(await f.runtime.turns.getRecoverableState({ sessionId: session.id, turnId: "turn-interrupt" }))
      .toMatchObject({ status: "interrupted_recoverable", recoverable: true });

    f.host.continue({ sessionId: session.id, turnId: "turn-interrupt" });
    expect(await f.host.waitSettled("turn-interrupt", 5_000)).toBe(true);
    const messages = await getSessionMessages(f.runtime, session.id);
    const answer = messages.find(function assistant(message) { return message.role === "assistant" && message.turnId === "turn-interrupt"; });
    expect(answer?.content).toBe("继续完成");
  });

  it("观察流重放持久事件并在宿主收尾后释放终态", async function streamReplaysAndHoldsTerminal() {
    const f = setup();
    const session = await f.runtime.sessions.create({ title: "新对话" });
    f.host.start({ sessionId: session.id, turnId: "turn-observe", content: "任务" });
    const events = await readSseEvents(createWebTurnStream({
      ports: f.ports,
      host: f.host,
      sessionId: session.id,
      turnId: "turn-observe",
      signal: new AbortController().signal,
      pollIntervalMs: 20,
    }));
    const types = events.map(function type(event) { return event.type; });
    expect(types).toContain("turn_started");
    expect(types[types.length - 1]).toBe("turn_completed");
    expect(events.every(function scoped(event) { return event.turnId === "turn-observe"; })).toBe(true);
  });

  it("未知 Turn 的观察立即结束，不长时间挂起", async function unknownTurnEnds() {
    const f = setup();
    const session = await f.runtime.sessions.create({ title: "新对话" });
    const events = await readSseEvents(createWebTurnStream({
      ports: f.ports,
      host: f.host,
      sessionId: session.id,
      turnId: "turn-missing",
      signal: new AbortController().signal,
      pollIntervalMs: 20,
    }));
    expect(events).toEqual([]);
  });

  it("recordSettledTurn 按持久事件补齐宿主驱动的回答，且不重复投影", async function settledProjection() {
    const f = setup();
    const session = await f.runtime.sessions.create({ title: "新对话" });
    // 模拟协作 Runner 的驱动方式：直接消费 turns.start，不经页面。
    for await (const _event of f.runtime.turns.start({ sessionId: session.id, turnId: "turn-runner", content: "任务" })) { void _event; }
    await f.host.recordSettledTurn({ sessionId: session.id, turnId: "turn-runner" });
    await f.host.recordSettledTurn({ sessionId: session.id, turnId: "turn-runner" });
    const messages = await getSessionMessages(f.runtime, session.id);
    const answers = messages.filter(function assistant(message) { return message.role === "assistant" && message.turnId === "turn-runner"; });
    expect(answers).toHaveLength(1);
    expect(answers[0]!.content).toBe("完成");
  });

  it("已被消费的 thread 输入按来源补成 Prompt 气泡", async function consumedInputBubble() {    const f = setup();
    const session = await f.runtime.sessions.create({ title: "新对话" });
    const input = await f.runtime.inbox.post({
      sessionId: session.id,
      clientMessageId: "cm-thread-1",
      delivery: "queue",
      content: "协作输入",
      origin: { kind: "thread", threadId: "session-source" },
    });
    await f.runtime.inbox.consume({ sessionId: session.id, inputId: input.inputId, turnId: "turn-consume" });
    const envelope: AgentEventEnvelope = {
      seq: 1,
      sessionId: session.id,
      turnId: "turn-consume",
      timestamp: new Date().toISOString(),
      event: { type: "input_consumed", turnId: "turn-consume", inputId: input.inputId } as never,
    };
    await f.ports.transcriptStore.append(session.id, envelope);
    await f.host.recordSettledTurn({ sessionId: session.id, turnId: "turn-consume" });
    const messages = await getSessionMessages(f.runtime, session.id);
    const bubbles = messages.filter(function bubble(message) { return message.clientRecordId === `input:${input.inputId}`; });
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({ role: "user", content: "协作输入", origin: { kind: "thread", threadId: "session-source" } });
  });
});

describe("Web TurnHost 队列调度", function webTurnHostQueue() {
  it("首轮完成后宿主独立领取排队输入并只执行一次", async function drainsQueueWithoutPage() {
    const f = setupWithQueue(sequencedSampler(120));
    const session = await f.runtime.sessions.create({ title: "新对话" });
    f.host.start({ sessionId: session.id, turnId: "turn-first", content: "第一轮" });
    const queued = await f.runtime.inbox.post({ sessionId: session.id, clientMessageId: "queue-message-1", delivery: "queue", content: "排队任务", attachments: [], selectedSkills: [] });
    expect(await f.host.waitSettled("turn-first", 5_000)).toBe(true);
    // 页面完全不参与：宿主在收尾后自行领取并执行第二轮。
    expect(await waitFor(async function secondAnswer() {
      const messages = await getSessionMessages(f.runtime, session.id);
      return messages.some(function answer(message) { return message.role === "assistant" && message.content === "第2轮"; });
    })).toBe(true);
    const messages = await getSessionMessages(f.runtime, session.id);
    expect(messages.filter(function answer(message) { return message.role === "assistant" && message.content === "第2轮"; })).toHaveLength(1);
    expect(messages.filter(function prompt(message) { return message.role === "user" && message.clientRecordId === `input:${queued.inputId}`; })).toHaveLength(1);
    const inputs = await f.runtime.inbox.list({ sessionId: session.id });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ inputId: queued.inputId, status: "consumed" });
  });

  it("宿主领取排队输入期间同 Session 的页面 start 仍被拒绝", async function drainHoldsSessionClaim() {
    let rejection: unknown;
    const f = setupWithQueue(sequencedSampler(60), {
      /** 领取成功后才触发：此刻执行权必须仍在本宿主手里。 */
      onPrepare: function probe(input) {
        try {
          f.host.start({ sessionId: input.sessionId, turnId: "turn-page", content: "页面新任务" });
        } catch (error) {
          rejection = error;
        }
      },
    });
    const session = await f.runtime.sessions.create({ title: "新对话" });
    f.host.start({ sessionId: session.id, turnId: "turn-first", content: "第一轮" });
    await f.runtime.inbox.post({ sessionId: session.id, clientMessageId: "queue-message-2", delivery: "queue", content: "排队任务", attachments: [], selectedSkills: [] });
    expect(await f.host.waitSettled("turn-first", 5_000)).toBe(true);
    expect(await waitFor(async function secondAnswer() {
      const messages = await getSessionMessages(f.runtime, session.id);
      return messages.some(function answer(message) { return message.role === "assistant" && message.content === "第2轮"; });
    })).toBe(true);
    expect(rejection).toMatchObject({ code: "TURN_ALREADY_RUNNING" });
  });

  it("等待回答的 Turn 不越过等待启动排队输入", async function queueWaitsForUserInput() {
    const f = setupWithQueue(questionSampler(), { enableUserQuestions: true });
    const session = await f.runtime.sessions.create({ title: "新对话" });
    f.host.start({ sessionId: session.id, turnId: "turn-question", content: "请确认范围" });
    const queued = await f.runtime.inbox.post({ sessionId: session.id, clientMessageId: "queue-message-3", delivery: "queue", content: "排队任务", attachments: [], selectedSkills: [] });
    expect(await f.host.waitSettled("turn-question", 5_000)).toBe(true);
    // 等待回答不属于成功完成：给宿主一个领取窗口后输入仍应 pending，且没有第二个 Turn。
    await new Promise<void>(function waitWindow(resolve) { setTimeout(resolve, 300); });
    const inputs = await f.runtime.inbox.list({ sessionId: session.id });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ inputId: queued.inputId, status: "pending" });
    expect(await f.ports.turnStore.list(session.id)).toHaveLength(1);
  });
});
