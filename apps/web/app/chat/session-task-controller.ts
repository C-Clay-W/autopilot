/**
 * session-task-controller.ts — 单个 Web Session 的 SSE 与异步请求控制器。
 *
 * 控制器只绑定创建时的 sessionId；它不读取当前 URL，也不写 Core 终态，
 * 仅把安全 SSE 事件交给所属 Session 的页面投影回调。
 */

import { recordWebPerformanceDiagnostic } from "@/lib/runtime-host/web-performance-diagnostics";

/** 单条已解析 SSE 事件交给所属 Session 的回调。 */
export type SessionTaskEventHandler = (messageId: string, data: Record<string, unknown>) => void;

/** 单次 SSE 消费的收口结果；terminal_seen/reconciled 表示终态已明确，页面无需 History fallback。 */
export type SessionTaskStreamOutcome = "terminal_seen" | "reconciled" | "ended_without_terminal";

/** SSE 空闲时用于核对当前 Turn 是否已在服务端进入终态。 */
export interface SessionTaskConsumeOptions {
  idleTimeoutMs?: number;
  getTerminalSnapshot?(turnId: string): Promise<SessionTaskTerminalSnapshot | null>;
  applyTerminalSnapshot?(turnId: string, snapshot: SessionTaskTerminalSnapshot): Promise<boolean>;
}

/** History 终态校准所需的最小安全投影。 */
export interface SessionTaskTerminalSnapshot {
  meta?: { runtimeStatus?: string };
  presentation?: {
    turnSummary?: {
      turnId?: string;
      state?: string;
    };
  };
}

/** 单 Session controller 的最小接口。 */
export interface SessionTaskController {
  readonly sessionId: string;
  createAbortController(): AbortController;
  beginHistoryRequest(): number;
  isLatestHistoryRequest(requestVersion: number): boolean;
  consume(response: Response, messageId: string, options?: SessionTaskConsumeOptions): Promise<SessionTaskStreamOutcome>;
}

/** 仅在服务端 Summary 与当前流的 Turn 完全匹配时确认终态，避免旧 History 提前结束新请求。 */
export function hasDurableTerminalTurn(snapshot: SessionTaskTerminalSnapshot, turnId: string): boolean {
  const status = snapshot.meta?.runtimeStatus;
  if (status === "running" || status === "waiting_approval" || status === "waiting_user_input") return false;
  const summary = snapshot.presentation?.turnSummary;
  return summary?.turnId === turnId
    && (summary.state === "completed" || summary.state === "failed" || summary.state === "interrupted" || summary.state === "limit_reached");
}

/** 创建只服务目标 Session 的 transport controller。 */
export function createSessionTaskController(sessionId: string, onEvent: SessionTaskEventHandler): SessionTaskController {
  let historyRequestVersion = 0;

  /** 创建属于本次目标请求的取消控制器。 */
  function createAbortController(): AbortController {
    return new AbortController();
  }

  /** 递增目标 Session 的 History 请求代次。 */
  function beginHistoryRequest(): number {
    historyRequestVersion += 1;
    return historyRequestVersion;
  }

  /** 判断异步 History 响应是否仍是本 Session 的最新请求。 */
  function isLatestHistoryRequest(requestVersion: number): boolean {
    return historyRequestVersion === requestVersion;
  }

  /** 消费目标 Session 的 SSE；尾流丢失时以同 Turn 的服务端终态结束陈旧 reader，并返回收口结果。 */
  async function consume(response: Response, messageId: string, options?: SessionTaskConsumeOptions): Promise<SessionTaskStreamOutcome> {
    if (!response.body) throw new Error("响应体为空");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let observedTurnId = "";
    let sawTerminal = false;
    let lastEventAt = Date.now();
    let monitorStopped = false;
    let releaseMonitorWait: (() => void) | undefined;

    /** 非阻塞取消底层 reader；页面收口不等待代理连接真正 close。 */
    function cancelReader(): void {
      void reader.cancel().catch(function ignoreReaderCancelError() {});
    }

    /** 解析一个完整 SSE 分片；协议终态事件本身即可结束消费，不再强依赖尾部 [DONE]。 */
    function dispatchSsePart(part: string): boolean {
      const dataLine = part.split("\n").find(function findDataLine(line) { return line.startsWith("data: "); });
      if (!dataLine) return false;
      const payload = dataLine.slice(6).trim();
      if (payload === "[DONE]") return true;
      const parseStartedAt = performance.now();
      try {
        const data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
        recordWebPerformanceDiagnostic("browser_sse_parse", typeof data.type === "string" ? data.type : "unknown", performance.now() - parseStartedAt);
        lastEventAt = Date.now();
        if (typeof data.turnId === "string") observedTurnId = data.turnId;
        onEvent(messageId, data);
        sawTerminal = data.type === "turn_completed" || data.type === "turn_failed" || data.type === "turn_interrupted" || data.type === "turn_limit_reached";
        return sawTerminal;
      } catch {
        recordWebPerformanceDiagnostic("browser_sse_parse", "malformed", performance.now() - parseStartedAt);
        // 损坏分片不进入 reducer；后续 History 重放仍以 Core 持久 transcript 为准。
      }
      return false;
    }

    /** 持续读取 SSE，任一明确协议终点都立即释放页面。 */
    async function consumeReader(): Promise<void> {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // 兼容没有结尾空行的实现；正常 Web Agent 流会在此之前发送 [DONE]。
          if (buffer.trim()) dispatchSsePart(buffer);
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          if (!dispatchSsePart(part)) continue;
          cancelReader();
          return;
        }
      }
    }

    /** 等待下一次空闲检查；消费完成时可立即唤醒并停止计时器。 */
    async function waitForMonitorInterval(intervalMs: number): Promise<void> {
      await new Promise<void>(function waitForInterval(resolve) {
        const timer = setTimeout(function finishInterval() {
          releaseMonitorWait = undefined;
          resolve();
        }, intervalMs);
        releaseMonitorWait = function releaseEarly() {
          clearTimeout(timer);
          releaseMonitorWait = undefined;
          resolve();
        };
      });
    }

    /** SSE 长时间无新分片时，按已观察到的 Turn 身份恢复服务端终态快照。 */
    async function monitorDurableTerminal(): Promise<"reconciled" | "stopped"> {
      const idleTimeoutMs = Math.max(1, options?.idleTimeoutMs ?? 5_000);
      while (!monitorStopped) {
        await waitForMonitorInterval(idleTimeoutMs);
        if (monitorStopped) return "stopped";
        if (!observedTurnId || Date.now() - lastEventAt < idleTimeoutMs) continue;
        try {
          const snapshot = await options?.getTerminalSnapshot?.(observedTurnId);
          if (!snapshot) continue;
          if (options?.applyTerminalSnapshot && !(await options.applyTerminalSnapshot(observedTurnId, snapshot))) continue;
          return "reconciled";
        } catch {
          // 校准请求失败不能篡改 Runtime 状态；保留 SSE 并等待下一次空闲检查。
        }
      }
      return "stopped";
    }

    if (!options?.getTerminalSnapshot) {
      await consumeReader();
      return sawTerminal ? "terminal_seen" : "ended_without_terminal";
    }

    try {
      const outcome = await Promise.race([
        consumeReader().then(function markStreamCompleted() { return "stream" as const; }),
        monitorDurableTerminal(),
      ]);
      if (outcome === "reconciled") {
        cancelReader();
        return "reconciled";
      }
    } finally {
      monitorStopped = true;
      releaseMonitorWait?.();
    }
    return sawTerminal ? "terminal_seen" : "ended_without_terminal";
  }

  return { sessionId, createAbortController, beginHistoryRequest, isLatestHistoryRequest, consume };
}
