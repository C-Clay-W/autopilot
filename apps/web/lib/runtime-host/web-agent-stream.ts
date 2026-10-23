/** Web Agent SSE 流：把 Core Turn 事件映射为安全 SSE，并在 Core 终态 Session 写入后保存展示消息。 */
import type * as Core from "@autopilot-agent/core";
import { toWebAgentEventDto } from "./web-ui-dto";
import { registerActiveTurn, unregisterActiveTurn } from "@/lib/agent-turn-store";
import { getSessionMessages, getSessionMeta, updateSessionTitle } from "@/lib/session-store";
import { applyEvent, createEmptyProjection, persistAssistantMessage, type MessageProjection } from "@/lib/runtime-host/web-message-projection";
import { persistCompactionRecord, persistFailedCompactionRecord } from "@/lib/runtime-host/web-compaction-projection";
import { toWebTurnFailure, type WebTurnFailure } from "./web-turn-failure";
import { recordWebPerformanceDiagnostic } from "./web-performance-diagnostics";

/** 通过 Runtime TurnService 执行 start/continue，并桥接到 SSE 与 Web 消息投影。 */
export function createRuntimeAgentStream(input: {
  sessionId: string;
  turnId: string;
  runtime: Core.AgentRuntime;
  mode: "start" | "continue";
  content?: string;
  messages?: Core.AgentMessage[];
  /** 声明本 Turn 从 claimed queue 连续启动；Core 注入最近 Todo 快照。 */
  continuity?: { source: "claimed_queue" };
  runConfig?: Partial<Core.RunConfig>;
  requestSignal: AbortSignal;
  initialDiagnostics?: string[];
  contextBudget?: Core.ContextBudgetSnapshot;
  activeSkills?: Array<{ skillId: string; contentHash: string }>;
  /** continue 续跑时从同一 Turn 的历史事件恢复，避免只保存审批后的子片段。 */
  initialProjection?: MessageProjection;
  /** 同一 Turn 的 SSE 序号从持久 transcript 最大 seq 接续，供 Presentation reducer 安全去重。 */
  initialSeq?: number;
  approval?: { approvalId: string; decision: "allow" | "deny" };
  /** 用户问题恢复只传已持久化请求身份，Browser 绝不重传答案正文。 */
  requestId?: string;
  /** 排队 Turn 启动协调器的释放回调；仅在流真正收口后释放。 */
  onSettled?: () => void;
}) {
  const encoder = new TextEncoder();
  const controller = new AbortController();
  let streamOpen = true;
  registerActiveTurn(input.sessionId, input.turnId, controller);
  /** 父请求结束或宿主停止时复用同一 Core 取消树。 */
  function abortRequest(): void { controller.abort(); }
  input.requestSignal.addEventListener("abort", abortRequest, { once: true });
  if (input.requestSignal.aborted) controller.abort();

  return new ReadableStream<Uint8Array>({
    async start(streamController) {
      let sequence = input.initialSeq ?? 0;

      const send = (event: Record<string, unknown>) => {
        if (!streamOpen) return;
        const startedAt = performance.now();
        sequence++;
        const timestamp = new Date().toISOString();
        const safeEvent = toWebAgentEventDto({
          seq: sequence,
          sessionId: input.sessionId,
          turnId: input.turnId,
          timestamp,
          event: event as Core.AgentEvent,
        }, input.turnId);
        streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ sessionId: input.sessionId, timestamp, ...safeEvent })}\n\n`));
        recordWebPerformanceDiagnostic("sse_enqueue", typeof event.type === "string" ? event.type : "unknown", performance.now() - startedAt);
      };
      // Host 诊断不是 Runtime transcript 事件，不能占用同一 Turn 的 seq。
      const sendHost = (event: Record<string, unknown>) => {
        if (!streamOpen) return;
        const startedAt = performance.now();
        streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ sessionId: input.sessionId, timestamp: new Date().toISOString(), ...event, turnId: input.turnId })}\n\n`));
        recordWebPerformanceDiagnostic("sse_enqueue", typeof event.type === "string" ? event.type : "unknown", performance.now() - startedAt);
      };
      // 续跑从审批前的完整投影开始；异常终止时也用它保存已经发生的过程。
      let projection = input.initialProjection ?? createEmptyProjection();
      // Core 在终态事件 yield 后还会写回 Session 状态；回答必须等该写入结束再持久化，避免旧快照覆盖展示消息。
      let terminalAssistantContent: string | undefined;
      let terminalFailure: WebTurnFailure | undefined;
      let terminalEvent: Record<string, unknown> | undefined;
      let completedSuccessfully = false;

      try {
        // Host 诊断只携带诊断文本；Session Context usage 由 Core context_usage_updated 事件单独投影，不再附带 Node 项目预算。
        const diagnostics = [...new Set([...(input.contextBudget?.diagnostics ?? []), ...(input.initialDiagnostics ?? [])])];
        if (diagnostics.length) {
          sendHost({
            type: "context_diagnostic",
            diagnostics,
          });
        }

        const runtimeMessages = input.messages ?? [];
        const eventStream = input.mode === "start"
          ? input.runtime.turns.start({
            sessionId: input.sessionId,
            turnId: input.turnId,
            content: input.content,
            messages: runtimeMessages.length ? runtimeMessages : undefined,
            activeSkills: input.activeSkills,
            continuity: input.continuity,
            runConfig: input.runConfig,
            signal: controller.signal,
          })
          : input.runtime.turns.continue({
            sessionId: input.sessionId,
            turnId: input.turnId,
            approval: input.approval,
            requestId: input.requestId,
            signal: controller.signal,
          });

        for await (const event of eventStream) {
          if (event.type === "turn_failed") terminalFailure = toWebTurnFailure(event.error, event.errorCode);
          const browserEvent = event.type === "turn_failed" ? { ...event, error: terminalFailure!.message, failure: terminalFailure } : event as Record<string, unknown>;
          if (["turn_completed", "turn_failed", "turn_limit_reached", "turn_interrupted"].includes(event.type)) terminalEvent = browserEvent;
          else send(browserEvent);
          projection = applyEvent(projection, event);

          if (event.type === "context_compacted") {
            const history = await getSessionMessages(input.runtime, input.sessionId);
            await persistCompactionRecord(input.runtime, input.sessionId, {
              summary: event.summary,
              preTokens: event.preTokens,
              postTokens: event.postTokens,
              preservedFromIndex: event.preservedFromIndex,
            }, history, event.trigger);
          }
          if (event.type === "context_compact_failed") {
            const history = await getSessionMessages(input.runtime, input.sessionId);
            await persistFailedCompactionRecord(input.runtime, input.sessionId, history, event.trigger);
          }
          if (event.type === "turn_completed") {
            terminalAssistantContent = projection.answer;
            completedSuccessfully = true;
          }
          if (event.type === "turn_failed") {
            const answer = projection.answer.trim();
            terminalAssistantContent = answer;
          }
          if (event.type === "turn_limit_reached") {
            const limitHint = "⚠️ 任务达到最大执行步骤，已停止。回复\"继续任务\"可从 checkpoint 恢复续跑。";
            terminalAssistantContent = projection.answer.trim() ? `${projection.answer.trim()}\n\n${limitHint}` : limitHint;
          }
        }

        if (terminalAssistantContent !== undefined) {
          await persistAssistantMessage(input.runtime, input.sessionId, input.turnId, projection, terminalAssistantContent, terminalFailure);
          if (completedSuccessfully) {
            const meta = await getSessionMeta(input.runtime, input.sessionId);
            if (meta.title.startsWith("新对话")) await updateSessionTitle(input.runtime, input.sessionId, terminalAssistantContent.slice(0, 20) || "Agent 对话");
          }
        }

        // 终态消息先持久化，再通知浏览器刷新，避免快速失败的 History 先读到空投影。
        if (terminalEvent) send(terminalEvent);
        if (streamOpen) {
          streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
          streamController.close();
          streamOpen = false;
        }
      } catch (error) {
        const failure = toWebTurnFailure(error);
        if (!controller.signal.aborted) {
          await persistAssistantMessage(input.runtime, input.sessionId, input.turnId, projection, projection.answer.trim(), failure).catch(() => undefined);
        }
        sendHost({ type: "turn_failed", error: failure.message, failure });
        if (streamOpen) {
          streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
          streamController.close();
          streamOpen = false;
        }
      } finally {
        input.requestSignal.removeEventListener("abort", abortRequest);
        unregisterActiveTurn(input.sessionId, input.turnId, controller);
        input.onSettled?.();
      }
    },
    cancel() { streamOpen = false; controller.abort(); },
  });
}
