/**
 * web-turn-stream.ts — Work Turn 的只读观察流
 *
 * 执行由 `WebTurnHost` 持有；本模块只按持久 transcript 重放并续读事件，
 * 因此页面关闭、刷新或换标签只断开观察，不会取消 Turn。
 * 终态事件在宿主完成展示消息持久化后才下发，避免 History 读到空投影。
 */

import type { AgentEventEnvelope } from "@autopilot-agent/core";
import type { RuntimePorts } from "@autopilot-agent/core";
import { toWebAgentEventDto } from "@/lib/runtime-host/web-ui-dto";
import { isTerminalTurnEvent, type WebTurnHost } from "./web-turn-host";

/** 观察流的装配参数；全部来自受信 Workspace 上下文。 */
export interface CreateWebTurnStreamInput {
  ports: RuntimePorts;
  /** 本宿主执行的 Turn 才有状态；协作 Runner 或重启后的 Turn 只按持久事件观察。 */
  host?: WebTurnHost;
  sessionId: string;
  turnId: string;
  /** 已确认的最后一个 seq；缺省从头重放。 */
  cursor?: number;
  /** 浏览器断开时只结束观察。 */
  signal: AbortSignal;
  pollIntervalMs?: number;
  /** 单次观察的最长时间；执行本身不受影响。 */
  maxWaitMs?: number;
  heartbeatMs?: number;
}

/** 创建 SSE 观察流；任何路径都只关闭本次连接。 */
export function createWebTurnStream(input: CreateWebTurnStreamInput): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pollIntervalMs = Math.max(50, input.pollIntervalMs ?? 200);
  const maxWaitMs = Math.max(1_000, input.maxWaitMs ?? 30 * 60 * 1_000);
  const heartbeatMs = Math.max(1_000, input.heartbeatMs ?? 15_000);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor = Math.max(0, input.cursor ?? 0);
      let diagnosticsSent = false;
      let lastHeartbeatAt = Date.now();
      let terminal: AgentEventEnvelope | undefined;
      let paused = false;
      let interaction: { approvalId?: string; requestId?: string } | undefined;
      const startedAt = Date.now();

      /** 写入一条 SSE data 行；连接已关闭时由 catch 统一收口。 */
      function send(payload: Record<string, unknown>): void {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ sessionId: input.sessionId, timestamp: new Date().toISOString(), turnId: input.turnId, ...payload })}\n\n`));
      }

      /** 写入一条注释心跳，浏览器忽略非 data 行。 */
      function heartbeat(): void {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }

      /** 结束观察；不触碰 Turn 或宿主执行。 */
      function finish(): void {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }

      try {
        while (!input.signal.aborted) {
          const record = input.host?.status(input.turnId);
          // 启动诊断属于 Host 事实，不占用 Runtime seq，只投影一次。
          if (!diagnosticsSent && record?.diagnostics.length) {
            send({ type: "context_diagnostic", diagnostics: record.diagnostics });
            diagnosticsSent = true;
          }

          const envelopes = await input.ports.transcriptStore.getEvents(input.sessionId);
          const pending = envelopes
            .filter(function sameTurn(envelope) { return envelope.turnId === input.turnId && envelope.seq > cursor; })
            .sort(function bySeq(left, right) { return left.seq - right.seq; });
          for (const envelope of pending) {
            cursor = envelope.seq;
            // 同Turn恢复会重放旧暂停/终态，新的执行段启动后只跟随当前边界。
            if (envelope.event.type === "turn_started") { paused = false; terminal = undefined; interaction = undefined; }
            if (envelope.event.type === "question_required") interaction = { requestId: envelope.event.requestId };
            if (envelope.event.type === "approval_required") interaction = { approvalId: envelope.event.result.approval.approvalId };
            if (envelope.event.type === "turn_paused") paused = true;
            if (isTerminalTurnEvent(envelope.event.type)) {
              // 宿主仍在本进程执行时，等它写完展示消息再释放前端。
              terminal = envelope;
              continue;
            }
            send(toWebAgentEventDto(envelope, input.turnId));
          }

          let handoffPending = false;
          if (terminal || paused || record?.state === "settled") {
            for (const groupId of await input.ports.threadStore.listGroups()) {
              const control = await input.ports.threadStore.readControl(groupId);
              if (control?.group.enabled && control.controls.some(function pending(item) { return item.kind === "continue_interaction" && item.threadId === input.sessionId && item.expectedTurnId === input.turnId && ["pending", "claimed", "executing"].includes(item.status) && (!paused || !interaction || item.requestId === interaction.requestId && item.approvalId === interaction.approvalId); })) handoffPending = true;
            }
          }
          const settled = !handoffPending && (record === undefined || record.state === "settled");
          if (terminal && settled) {
            send(toWebAgentEventDto(terminal, input.turnId));
            finish();
            return;
          }

          if (settled && paused) { finish(); return; }

          if (record?.state === "settled" && !handoffPending) {
            // 没有 Turn 事件（启动前失败）时补发安全失败提示，不伪造已执行。
            if (!terminal && record.failure) {
              send({ type: "turn_failed", error: record.failure.message, failure: record.failure });
            }
            finish();
            return;
          }

          // 宿主与本进程 Runner 都不持有、且持久层也没有该 Turn：观察目标不存在，直接结束。
          if (!record && !pending.length && !terminal && cursor === 0 && !(await input.ports.turnStore.get(input.turnId))) {
            finish();
            return;
          }

          if (Date.now() - lastHeartbeatAt >= heartbeatMs) {
            heartbeat();
            lastHeartbeatAt = Date.now();
          }
          if (Date.now() - startedAt > maxWaitMs) {
            finish();
            return;
          }
          await new Promise<void>(function waitTick(resolve) { setTimeout(resolve, pollIntervalMs); });
        }
        finish();
      } catch {
        // 客户端断开或流已关闭：只结束观察，不修改 Turn。
        try { controller.close(); } catch { /* 已关闭 */ }
      }
    },
    cancel() {
      // 观察者离开不代表取消任务；这里不做任何执行侧动作。
    },
  });
}
