/**
 * web-turn-host.ts — Web 普通 Work 的统一执行宿主
 *
 * 页面 POST 只提交意图并立即返回；真正的 `turns.start/continue` 由本宿主消费完整事件流，
 * 持久化展示消息、标题与压缩记录，页面丢弃的观察连接不会中止执行。
 * 同一 Session 只有这一条 Work 执行入口；Chat 仍由 `/api/chat/sessions` 自己的链路处理。
 */

import type { AgentEvent, AgentEventEnvelope, AgentMessage, AgentRuntime, ContextBudgetSnapshot, InboxInput, RunConfig, RuntimePorts } from "@autopilot-agent/core";
import { randomUUID } from "node:crypto";
import { appendMessage, getSessionMessages, getSessionMeta, updateSessionTitle, type SessionMessage } from "@/lib/session-store";
import { registerActiveTurn, unregisterActiveTurn } from "@/lib/agent-turn-store";
import { applyEvent, createEmptyProjection, persistAssistantMessage, projectEvents, type MessageProjection } from "@/lib/runtime-host/web-message-projection";
import { persistCompactionRecord, persistFailedCompactionRecord } from "@/lib/runtime-host/web-compaction-projection";
import { toWebTurnFailure, type WebTurnFailure } from "@/lib/runtime-host/web-turn-failure";

/** Turn 进入的终态；流端点据此决定何时结束观察。 */
export type WebTurnState = "running" | "settled";

/** 单个 Turn 的宿主侧观察事实；不写入 Runtime transcript。 */
export interface WebTurnRecord {
  sessionId: string;
  turnId: string;
  state: WebTurnState;
  /** 启动前已知的上下文诊断；只在本次观察开始时投影一次。 */
  diagnostics: string[];
  /** 执行或启动失败的安全摘要；`turn_failed` 由流端点补发。 */
  failure?: WebTurnFailure;
}

/** 页面提交的 start 意图；正文与附件已在 Route 中完成校验与投影。 */
export interface WebTurnStartRequest {
  sessionId: string;
  turnId: string;
  content: string;
  messages?: AgentMessage[];
  continuity?: { source: "claimed_queue" };
  runConfig?: Partial<RunConfig>;
  contextBudget?: ContextBudgetSnapshot;
  initialDiagnostics?: string[];
  activeSkills?: Array<{ skillId: string; contentHash: string }>;
  /** 队列启动锁等宿主持有的收尾回调；只在真正结束本次执行后释放。 */
  onSettled?: () => void;
}

/** 页面提交的 continue 意图；审批与问题身份必须已在 Route 侧校验。 */
export interface WebTurnContinueRequest {
  sessionId: string;
  turnId: string;
  approval?: { approvalId: string; decision: "allow" | "deny" };
  requestId?: string;
  /** continue 从审批前的完整投影继续，避免只保存审批后的片段。 */
  initialProjection?: MessageProjection;
  onSettled?: () => void;
}

/** 排队输入的 Turn 启动请求装配；由受信宿主注入，缺省时宿主不自动消费队列。 */
export type WebQueuedTurnPreparer = (input: { sessionId: string; turnId: string; input: InboxInput }) => Promise<Omit<WebTurnStartRequest, "sessionId" | "turnId">>;

/** 宿主构造参数；`prepareQueuedTurn` 缺省表示该宿主不接管 Inbox.queue 调度。 */
export interface CreateWebTurnHostOptions {
  runtime: AgentRuntime;
  ports: RuntimePorts;
  prepareQueuedTurn?: WebQueuedTurnPreparer;
}

/** 受信 Workspace 宿主持有的普通 Work 执行入口。 */
export interface WebTurnHost {
  /** 绑定协作 Runner 的唯一 owner 索引；执行入口统一登记。 */
  bindExecutionOwner(register: (input: { threadId: string; turnId: string; cancel(): void }) => { activate(): void; release(): void }): void;
  /** 接受 start 意图并异步执行；已有活动 Turn 时抛 `TURN_ALREADY_RUNNING`。 */
  start(input: WebTurnStartRequest): { turnId: string };
  /** 接受 continue 意图并异步执行；同一 Session 已有执行时拒绝。 */
  continue(input: WebTurnContinueRequest): { turnId: string };
  /** 取消本宿主持有的执行；返回是否实际发出了 abort。 */
  cancel(input: { sessionId: string; turnId: string }): boolean;
  /** 只读查询 Turn 的宿主侧状态；未知 Turn 返回 undefined。 */
  status(turnId: string): WebTurnRecord | undefined;
  /** 等待宿主完成该 Turn 的持久化；超时返回 false，不改变执行。 */
  waitSettled(turnId: string, timeoutMs?: number): Promise<boolean>;
  /** 停止本宿主全部执行；只取消自己持有的 Turn。 */
  stop(): Promise<string[]>;
  /** thread 来源 Prompt 的展示投影；按稳定消息身份去重，正文不能伪造来源。 */
  recordThreadPrompt(input: { sessionId: string; content: string; fromThreadId: string; messageId: string; handoffDisplay?: { title: string; instruction: string; summary: string } }): Promise<void>;
  /** 宿主驱动的 Turn 收尾后按持久事件补齐展示消息与来源 Prompt。 */
  recordSettledTurn(input: { sessionId: string; turnId: string }): Promise<void>;
}

/** 终态事件类型；与 Web SSE 客户端约定一致。 */
const TERMINAL_EVENT_TYPES = ["turn_completed", "turn_failed", "turn_limit_reached", "turn_interrupted"];

/** 判断事件是否为 Turn 终态。 */
export function isTerminalTurnEvent(type: string): boolean {
  return TERMINAL_EVENT_TYPES.includes(type);
}

/** 创建普通 Work 执行宿主；构造只建立内存索引，不启动任何轮询。 */
export function createWebTurnHost(options: CreateWebTurnHostOptions): WebTurnHost {
  const runtime = options.runtime;
  const ports = options.ports;
  const prepareQueuedTurn = options.prepareQueuedTurn;
  const records = new Map<string, WebTurnRecord>();
  const controllers = new Map<string, AbortController>();
  const activeSessions = new Set<string>();
  let registerExecution: ((input: { threadId: string; turnId: string; cancel(): void }) => { activate(): void; release(): void }) | undefined;

  /** 只登记本宿主可见的安全诊断，不写入 Runtime transcript。 */
  function diagnosticsOf(input: { contextBudget?: ContextBudgetSnapshot; initialDiagnostics?: string[] }): string[] {
    return [...new Set([...(input.contextBudget?.diagnostics ?? []), ...(input.initialDiagnostics ?? [])])];
  }

  /** 标记 Turn 已收尾并唤醒等待者；重复调用保持终态。 */
  function settle(turnId: string, failure?: WebTurnFailure): void {
    const record = records.get(turnId);
    if (record) records.set(turnId, { ...record, state: "settled", ...(failure ? { failure } : {}) });
    const controller = controllers.get(turnId);
    if (record) unregisterActiveTurn(record.sessionId, turnId, controller);
    controllers.delete(turnId);
  }

  /** 同一 Session 只允许本宿主一个执行；跨宿主双启动仍由 Core 单 Session lease 拒绝。 */
  function claimSession(sessionId: string): void {
    if (activeSessions.has(sessionId)) throw Object.assign(new Error("TURN_ALREADY_RUNNING"), { code: "TURN_ALREADY_RUNNING" });
    activeSessions.add(sessionId);
  }

  /** 执行 start/continue 并消费完整事件流；页面连接与执行生命周期无关。 */
  async function execute(input: {
    sessionId: string;
    turnId: string;
    mode: "start" | "continue";
    start?: WebTurnStartRequest;
    continuation?: WebTurnContinueRequest;
    controller: AbortController;
    owner?: { activate(): void; release(): void };
  }): Promise<void> {
    const { sessionId, turnId, controller } = input;
    let projection = input.continuation?.initialProjection ?? createEmptyProjection();
    let terminalAssistantContent: string | undefined;
    let terminalFailure: WebTurnFailure | undefined;
    let completedSuccessfully = false;
    try {
      const stream = input.mode === "start"
        ? runtime.turns.start({
          sessionId,
          turnId,
          content: input.start!.content,
          messages: input.start!.messages?.length ? input.start!.messages : undefined,
          activeSkills: input.start!.activeSkills,
          continuity: input.start!.continuity,
          runConfig: input.start!.runConfig,
          signal: controller.signal,
        })
        : runtime.turns.continue({
          sessionId,
          turnId,
          approval: input.continuation!.approval,
          requestId: input.continuation!.requestId,
          signal: controller.signal,
        });
      for await (const event of stream) {
        // 事件由取得 lease 的执行协调器发出；终态之后不能再控制该执行段。
        if (isTerminalTurnEvent(event.type) || event.type === "question_required" || event.type === "approval_required") input.owner?.release();
        else input.owner?.activate();
        projection = applyEvent(projection, event);
        if (event.type === "context_compacted") {
          const history = await getSessionMessages(runtime, sessionId);
          await persistCompactionRecord(runtime, sessionId, {
            summary: event.summary,
            preTokens: event.preTokens,
            postTokens: event.postTokens,
            preservedFromIndex: event.preservedFromIndex,
          }, history, event.trigger);
        }
        if (event.type === "context_compact_failed") {
          const history = await getSessionMessages(runtime, sessionId);
          await persistFailedCompactionRecord(runtime, sessionId, history, event.trigger);
        }
        if (event.type === "turn_completed") {
          terminalAssistantContent = projection.answer;
          completedSuccessfully = true;
        }
        if (event.type === "turn_failed") {
          terminalFailure = toWebTurnFailure(event.error, event.errorCode, {
            feedbackId: (event as { feedbackId?: unknown }).feedbackId,
            failureStage: (event as { failureStage?: unknown }).failureStage,
            providerHttpStatus: (event as { providerHttpStatus?: unknown }).providerHttpStatus,
            providerFailureReason: (event as { providerFailureReason?: unknown }).providerFailureReason,
            providerFailureDetail: (event as { providerFailureDetail?: unknown }).providerFailureDetail,
          });
          terminalAssistantContent = projection.answer.trim();
        }
        if (event.type === "turn_limit_reached") {
          const limitHint = "⚠️ 任务达到最大执行步骤，已停止。回复\"继续任务\"可从 checkpoint 恢复续跑。";
          terminalAssistantContent = projection.answer.trim() ? `${projection.answer.trim()}\n\n${limitHint}` : limitHint;
        }
      }
      // Core 在终态事件之后还会写回 Session；先等事件流结束再持久化回答，避免旧快照覆盖。
      if (terminalAssistantContent !== undefined) {
        await persistAssistantMessage(runtime, sessionId, turnId, projection, terminalAssistantContent, terminalFailure);
        if (completedSuccessfully) {
          const meta = await getSessionMeta(runtime, sessionId);
          if (meta.title.startsWith("新对话")) await updateSessionTitle(runtime, sessionId, terminalAssistantContent.slice(0, 20) || "Agent 对话");
        }
      }
      settle(turnId, terminalFailure);
    } catch (error) {
      const failure = toWebTurnFailure(error, undefined, { failureStage: "web_stream" });
      // 用户主动停止不写失败回答；其他启动/执行异常保留可解释的安全失败提示。
      if (!controller.signal.aborted) {
        await persistAssistantMessage(runtime, sessionId, turnId, projection, projection.answer.trim(), failure).catch(() => undefined);
      }
      settle(turnId, failure);
    } finally {
      input.owner?.release();
      activeSessions.delete(sessionId);
      input.start?.onSettled?.();
      input.continuation?.onSettled?.();
      // 只有成功完成才继续排队输入：审批/问答/中断/失败保持原恢复语义，不越过等待。
      if (completedSuccessfully) void drainQueuedTurn(sessionId);
    }
  }

  /** 登记并启动一次异步执行；重复 start 与并发 continue 拒绝，同 Session 已收尾 Turn 允许 continue 开启新执行段。 */
  function launch(input: {
    sessionId: string;
    turnId: string;
    mode: "start" | "continue";
    start?: WebTurnStartRequest;
    continuation?: WebTurnContinueRequest;
  }): { turnId: string } {
    // 问答/审批/中断/上限都会让 Core 结束当前执行段，宿主仍保留该 Turn 的收尾记录；
    // 归属相同的 continue 是在原 Turn 上开新执行段，不是重复 start，因此只有这类请求可以复用记录。
    const existing = records.get(input.turnId);
    const resumingSettledTurn = input.mode === "continue" && existing?.sessionId === input.sessionId && existing.state === "settled";
    if (existing && !resumingSettledTurn) throw Object.assign(new Error("TURN_ALREADY_RUNNING"), { code: "TURN_ALREADY_RUNNING" });
    claimSession(input.sessionId);
    try { return startExecution(input); }
    catch (error) { activeSessions.delete(input.sessionId); throw error; }
  }

  /** 在已持有该 Session 执行权时登记控制器与记录并异步执行；执行权由调用方持有。 */
  function startExecution(input: {
    sessionId: string;
    turnId: string;
    mode: "start" | "continue";
    start?: WebTurnStartRequest;
    continuation?: WebTurnContinueRequest;
  }): { turnId: string } {
    const controller = new AbortController();
    const owner = registerExecution?.({ threadId: input.sessionId, turnId: input.turnId, cancel: function cancelOwnedExecution() { controller.abort(); } });
    controllers.set(input.turnId, controller);
    // 复用进程内取消索引：cancel Route 与删除会话仍能立即广播 AbortSignal。
    registerActiveTurn(input.sessionId, input.turnId, controller);
    records.set(input.turnId, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      state: "running",
      diagnostics: input.mode === "start"
        ? diagnosticsOf({ contextBudget: input.start!.contextBudget, initialDiagnostics: input.start!.initialDiagnostics })
        : [],
    });
    void execute({ ...input, controller, owner }).catch(function ignoreExecutionError(error) {
      // execute 已记录失败；这里只防止未处理的 rejection。
      settle(input.turnId, toWebTurnFailure(error, undefined, { failureStage: "web_stream" }));
    });
    return { turnId: input.turnId };
  }

  /** 上一轮成功后领取下一条排队输入并启动；领取与启动共用本宿主执行权，保证同一 Session 只有一条执行链。 */
  async function drainQueuedTurn(sessionId: string): Promise<void> {
    if (!prepareQueuedTurn) return;
    // 先占住执行权再领取：占不到说明已有执行段，输入留给该执行段收尾后再领，不会出现双启动。
    try {
      claimSession(sessionId);
    } catch {
      return;
    }
    let claimed: InboxInput | null = null;
    let started = false;
    try {
      claimed = await runtime.inbox.claimNext({ sessionId });
      if (!claimed) return;
      const turnId = randomUUID();
      const prepared = await prepareQueuedTurn({ sessionId, turnId, input: claimed });
      startExecution({ sessionId, turnId, mode: "start", start: { sessionId, turnId, ...prepared } });
      started = true;
    } catch {
      // 装配失败不留下永久 claimed：取消该输入，由用户重新提交；执行权在 finally 释放。
      if (claimed) await runtime.inbox.cancel(claimed.inputId).catch(function ignoreCancel() { return false; });
    } finally {
      if (!started) activeSessions.delete(sessionId);
    }
  }

  /** 按稳定 clientRecordId 判断展示消息是否已经写入，避免重复气泡。 */
  async function hasRecordedMessage(sessionId: string, clientRecordId: string): Promise<boolean> {
    const messages = await getSessionMessages(runtime, sessionId);
    return messages.some(function match(message) { return message.clientRecordId === clientRecordId; });
  }

  /** 读取指定 Turn 的持久事件；只读 transcript，不触发恢复或执行。 */
  async function readTurnEvents(sessionId: string, turnId: string): Promise<AgentEventEnvelope[]> {
    const events = await ports.transcriptStore.getEvents(sessionId);
    return events.filter(function sameTurn(envelope) { return envelope.turnId === turnId; });
  }

  /** 把 Turn 内已被消费的 thread 来源输入补成带来源的 Prompt 气泡。 */
  async function recordConsumedThreadInputs(sessionId: string, turnId: string, envelopes: AgentEventEnvelope[]): Promise<void> {
    const consumed = envelopes
      .filter(function consumedEvent(envelope) { return envelope.event.type === "input_consumed"; })
      .map(function inputId(envelope) { return (envelope.event as { inputId?: unknown }).inputId; })
      .filter(function valid(inputId): inputId is string { return typeof inputId === "string" && Boolean(inputId); });
    if (!consumed.length) return;
    const inputs = await runtime.inbox.list({ sessionId });
    for (const inputId of consumed) {
      const input = inputs.find(function match(item) { return item.inputId === inputId; });
      if (!input || input.origin?.kind !== "thread") continue;
      const clientRecordId = `input:${inputId}`;
      if (await hasRecordedMessage(sessionId, clientRecordId)) continue;
      await appendMessage(runtime, sessionId, {
        role: "user",
        content: input.content,
        origin: { kind: "thread", threadId: input.origin.threadId },
        clientRecordId,
      });
    }
    void turnId;
  }

  return {
    bindExecutionOwner(register) { registerExecution = register; },
    start(input) {
      return launch({ sessionId: input.sessionId, turnId: input.turnId, mode: "start", start: input });
    },

    continue(input) {
      return launch({ sessionId: input.sessionId, turnId: input.turnId, mode: "continue", continuation: input });
    },

    cancel(input) {
      const controller = controllers.get(input.turnId);
      const record = records.get(input.turnId);
      if (!controller || record?.sessionId !== input.sessionId) return false;
      controller.abort();
      return true;
    },

    status(turnId) {
      return records.get(turnId);
    },

    async waitSettled(turnId, timeoutMs = 60_000) {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (Date.now() <= deadline) {
        if (records.get(turnId)?.state !== "running") return true;
        await new Promise<void>(function waitTick(resolve) { setTimeout(resolve, 25); });
      }
      return records.get(turnId)?.state !== "running";
    },

    async stop() {
      const turnIds = [...controllers.keys()];
      for (const turnId of turnIds) controllers.get(turnId)?.abort();
      return turnIds;
    },

    async recordThreadPrompt(input) {
      const clientRecordId = `thread:${input.messageId}`;
      if (await hasRecordedMessage(input.sessionId, clientRecordId)) return;
      await appendMessage(runtime, input.sessionId, {
        role: "user",
        content: input.handoffDisplay ? `# Handoff：${input.handoffDisplay.title}\n\n${input.handoffDisplay.instruction}` : input.content,
        ...(input.handoffDisplay ? { handoffDisplay: input.handoffDisplay } : {}),
        origin: { kind: "thread", threadId: input.fromThreadId },
        clientRecordId,
      });
    },

    async recordSettledTurn(input) {
      const envelopes = await readTurnEvents(input.sessionId, input.turnId);
      if (!envelopes.length) return;
      const messages = await getSessionMessages(runtime, input.sessionId);
      // 已被本宿主或之前的收尾投影写过的 Turn 不重复写气泡。
      if (messages.some(function assistant(message) { return message.role === "assistant" && message.turnId === input.turnId; })) return;
      const projection = projectEvents(envelopes);
      const terminalFailure = envelopes
        .map(function eventOf(envelope) { return envelope.event; })
        .find(function failed(event): event is Extract<AgentEvent, { type: "turn_failed" }> { return event.type === "turn_failed"; });
      const failure = terminalFailure
        ? toWebTurnFailure(terminalFailure.error, terminalFailure.errorCode, {
          feedbackId: (terminalFailure as { feedbackId?: unknown }).feedbackId,
          failureStage: (terminalFailure as { failureStage?: unknown }).failureStage,
        })
        : undefined;
      await appendMessage(runtime, input.sessionId, {
        role: "assistant",
        turnId: input.turnId,
        content: projection.answer.trim(),
        ...(failure ? { failure } : {}),
        sources: projection.sources.length ? projection.sources : undefined,
        editDiffs: projection.editDiffs.length ? projection.editDiffs : undefined,
        processSteps: projection.processSteps.length ? projection.processSteps : undefined,
        turnSegments: projection.turnSegments.length ? projection.turnSegments : undefined,
      });
      await recordConsumedThreadInputs(input.sessionId, input.turnId, envelopes);
    },
  };
}

/** 展示层可复用的安全消息类型；来源标签只读取 `origin`。 */
export type WebTurnProjectionMessage = SessionMessage;
