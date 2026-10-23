/**
 * work-preview-readiness.ts — 本地开发服务就绪探测。
 *
 * 有界轮询冻结契约（§7.4）：总等待 ≤30s、单次 ≤3s、次数 ≤10；redirect:"manual"，只看状态码、
 * 立即取消正文，不跟随重定向、不携带任何凭据。3xx 返回 redirect_pending 待确认目标，
 * 4xx/5xx 立即 unavailable 并保留状态码；连接拒绝/单次超时按预算重试，预算耗尽返回最后失败原因。
 * 外部取消/退出/Trust 失效经 signal 立即停止。自 Stage0 原型迁移，行为不变。
 */

/** 不可用原因：连接拒绝、单次超时、明确 HTTP 错误状态、外部取消。 */
export type ProbeUnavailableReason = "connection_refused" | "timeout" | "http_status" | "aborted";

/** 探测结果：不返回任何正文内容，仅状态与安全原因。 */
export type ProbeResult =
  | { state: "ready" }
  | { state: "redirect_pending" }
  | { state: "unavailable"; reason: ProbeUnavailableReason; status?: number };

/** 探测选项：全部有界且可注入（sleep/fetchImpl 供测试替换，不写真实等待）。 */
export interface ProbeOptions {
  /** 总等待预算，默认 30000ms */
  totalMs?: number;
  /** 单次请求超时，默认 3000ms */
  perTryMs?: number;
  /** 最大请求次数，默认 10 */
  maxAttempts?: number;
  /** 相邻两次探测间隔，默认 500ms */
  delayMs?: number;
  /** 睡眠实现，默认真实 setTimeout */
  sleep?: (ms: number) => Promise<void>;
  /** fetch 实现，默认全局 fetch */
  fetchImpl?: typeof fetch;
  /** 外部取消信号：取消/退出/Trust 失效立即停止 */
  signal?: AbortSignal;
}

/** 单次探测：合并外部信号与单次超时；超时以 TimeoutError 抛出以便与连接拒绝区分。 */
async function fetchOnce(
  fetchImpl: typeof fetch,
  url: string,
  perTryMs: number,
  external: AbortSignal | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("probe timeout", "TimeoutError")), perTryMs);
  const onExternal = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onExternal, { once: true });
  }
  try {
    return await fetchImpl(url, { redirect: "manual", signal: controller.signal });
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternal);
  }
}

/** 探测本地服务是否就绪；只保留状态码与安全失败原因，不读取、不返回任何正文。 */
export async function probeLocalService(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const {
    totalMs = 30000,
    perTryMs = 3000,
    maxAttempts = 10,
    delayMs = 500,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetchImpl = fetch,
    signal,
  } = options;
  const startedAt = Date.now();
  let lastReason: ProbeUnavailableReason = "connection_refused";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) return { state: "unavailable", reason: "aborted" };
    if (attempt > 0) {
      const remaining = totalMs - (Date.now() - startedAt);
      if (remaining <= 0) break;
      await sleep(Math.min(delayMs, remaining));
      if (signal?.aborted) return { state: "unavailable", reason: "aborted" };
    }
    try {
      const response = await fetchOnce(fetchImpl, url, perTryMs, signal);
      // 立即放弃正文流，只消费状态码；可达不代表页面视觉或功能正确。
      try {
        await response.body?.cancel();
      } catch {
        // 正文流取消失败不影响状态判定。
      }
      if (response.status >= 200 && response.status < 300) return { state: "ready" };
      if (response.status >= 300 && response.status < 400) return { state: "redirect_pending" };
      return { state: "unavailable", reason: "http_status", status: response.status };
    } catch (error) {
      if (signal?.aborted) return { state: "unavailable", reason: "aborted" };
      lastReason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "connection_refused";
    }
  }
  return { state: "unavailable", reason: lastReason };
}
