/** Web Presentation 逐帧合并器：只合并连续 delta，不改变 SSE 事件顺序或边界语义。 */

import { recordWebPerformanceDiagnostic } from "@/lib/runtime-host/web-performance-diagnostics";

export type WebPresentationDelta = Record<string, unknown>;

export interface WebPresentationFrameBatcher {
  enqueue(event: WebPresentationDelta): boolean;
  flush(): void;
  cancel(): void;
}

interface WebPresentationFrameBatcherOptions {
  onFlush: (events: WebPresentationDelta[]) => void;
  schedule: (callback: () => void) => unknown;
  cancelSchedule: (handle: unknown) => void;
}

/** 判断事件是否可以在同一浏览器帧内合并。 */
export function isWebPresentationDelta(event: WebPresentationDelta): boolean {
  return (event.type === "answer_delta" || event.type === "reasoning_delta") && typeof event.turnId === "string";
}

/** 创建按 Turn 聚合的 Presentation 帧队列；非 delta 事件由调用方先 flush。 */
export function createWebPresentationFrameBatcher(options: WebPresentationFrameBatcherOptions): WebPresentationFrameBatcher {
  let pending: WebPresentationDelta[] = [];
  let pendingTurnId: string | undefined;
  let scheduledHandle: unknown = undefined;

  /** 清空当前帧并交给宿主一次性提交。 */
  function flushPending(): void {
    const events = pending;
    pending = [];
    pendingTurnId = undefined;
    if (events.length > 0) {
      const startedAt = performance.now();
      options.onFlush(events);
      recordWebPerformanceDiagnostic("presentation_dispatch", "frame", performance.now() - startedAt);
    }
  }

  /** 取消尚未执行的浏览器帧回调并立即提交已收集事件。 */
  function flush(): void {
    if (scheduledHandle !== undefined) {
      options.cancelSchedule(scheduledHandle);
      scheduledHandle = undefined;
    }
    flushPending();
  }

  /** 把连续同一 Turn 的 delta 排入下一帧；切换 Turn 时先完成上一帧。 */
  function enqueue(event: WebPresentationDelta): boolean {
    if (!isWebPresentationDelta(event)) return false;
    const turnId = event.turnId as string;
    if (pendingTurnId && pendingTurnId !== turnId) flush();
    pendingTurnId = turnId;
    pending.push(event);
    if (scheduledHandle === undefined) {
      scheduledHandle = options.schedule(function flushScheduledFrame() {
        scheduledHandle = undefined;
        flushPending();
      });
    }
    return true;
  }

  /** 丢弃尚未提交的事件；Session 切换或组件卸载时使用。 */
  function cancel(): void {
    if (scheduledHandle !== undefined) {
      options.cancelSchedule(scheduledHandle);
      scheduledHandle = undefined;
    }
    pending = [];
    pendingTurnId = undefined;
  }

  return { enqueue, flush, cancel };
}
