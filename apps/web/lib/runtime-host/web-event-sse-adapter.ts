/**
 * runtime-host/web-event-sse-adapter.ts — AgentEvent → SSE 流映射
 *
 * Phase 4 新增：把 Core Runtime 输出的 AgentEventEnvelope 映射为 Web 前端期望的
 * `data: { seq, turnId, ...event }\n\n` 格式，并追加 `data: [DONE]` 结束标记。
 */

import type { AgentEventEnvelope } from "@autopilot-agent/core";
import { toWebAgentEventDto } from "./web-ui-dto";

export interface SseLineOptions {
  /** 当前 turn 标识；会注入到每条 SSE 事件。 */
  turnId: string;
  /** 起始 seq；默认为 0。 */
  initialSeq?: number;
}

/** 把单个 AgentEventEnvelope 映射为 SSE data: 行。 */
export function envelopeToSseLine(envelope: AgentEventEnvelope, turnId: string): string {
  const payload = toWebAgentEventDto(envelope, turnId);
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 把异步事件流映射为 SSE 字符串流生成器。 */
export async function* toSseLines(
  envelopes: AsyncIterable<AgentEventEnvelope>,
  options: SseLineOptions,
): AsyncGenerator<string> {
  const { turnId } = options;
  for await (const envelope of envelopes) {
    yield envelopeToSseLine(envelope, turnId);
  }
  yield "data: [DONE]\n\n";
}

/** 把 SSE 字符串编码为 Uint8Array ReadableStream；供 Next.js Response 使用。 */
export function encodeSseStream(lines: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const line of lines) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      } catch (error) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "turn_failed", error: "任务执行失败，请稍后重新发送；如果持续失败，请检查模型配置。" })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
}
