/** Web 性能诊断：仅在显式诊断模式下记录分段时刻与耗时，不保存回答、输入、凭据或路径。 */

const WEB_PERFORMANCE_DIAGNOSTICS_KEY = Symbol.for("autopilot.webPerformanceDiagnostics");

export interface WebPerformanceDiagnosticRecord {
  version: 1;
  point: string;
  eventType: string;
  monotonicMs: number;
  durationMs?: number;
}

type DiagnosticRuntime = typeof globalThis & {
  __AUTOPILOT_PERF_DIAGNOSTICS__?: boolean;
  process?: { env?: Record<string, string | undefined> };
};

/** 返回 Web 进程内共享的诊断缓冲；缓冲本身不触发文件或网络 I/O。 */
function getDiagnosticBuffer(): WebPerformanceDiagnosticRecord[] {
  const target = globalThis as DiagnosticRuntime & Record<symbol, WebPerformanceDiagnosticRecord[] | undefined>;
  target[WEB_PERFORMANCE_DIAGNOSTICS_KEY] ??= [];
  return target[WEB_PERFORMANCE_DIAGNOSTICS_KEY];
}

/** 判断是否由显式运行时开关启用诊断。 */
function isDiagnosticsEnabled(): boolean {
  const runtime = globalThis as DiagnosticRuntime;
  return runtime.__AUTOPILOT_PERF_DIAGNOSTICS__ === true
    || runtime.process?.env?.AUTOPILOT_PERF_DIAGNOSTICS === "1"
    || runtime.process?.env?.NEXT_PUBLIC_AUTOPILOT_PERF_DIAGNOSTICS === "1";
}

/** 记录一个只含类型、时刻和耗时的 Web 热路径诊断点。 */
export function recordWebPerformanceDiagnostic(point: string, eventType: string, durationMs?: number): void {
  if (!isDiagnosticsEnabled()) return;
  const record: WebPerformanceDiagnosticRecord = {
    version: 1,
    point,
    eventType,
    monotonicMs: Number(performance.now().toFixed(3)),
    ...(durationMs === undefined ? {} : { durationMs: Number(Math.max(0, durationMs).toFixed(3)) }),
  };
  getDiagnosticBuffer().push(record);
}

/** 返回当前诊断快照，供确定性测试或显式诊断宿主读取。 */
export function readWebPerformanceDiagnostics(): WebPerformanceDiagnosticRecord[] {
  return [...getDiagnosticBuffer()];
}

/** 清空当前诊断缓冲；只供诊断宿主在一次测量开始前调用。 */
export function clearWebPerformanceDiagnostics(): void {
  getDiagnosticBuffer().length = 0;
}
