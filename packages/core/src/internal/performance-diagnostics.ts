/**
 * 性能诊断事件：只在显式诊断模式下缓冲分段时刻与耗时，不记录正文、输入、凭据或路径。
 */

const PERFORMANCE_DIAGNOSTICS_KEY = Symbol.for("autopilot.performanceDiagnostics");

interface PerformanceDiagnosticRecord {
  version: 1;
  point: string;
  eventType: string;
  monotonicMs: number;
  durationMs?: number;
}

/** 返回跨 Core bundle 与 CLI 共享的进程内诊断缓冲。 */
function getPerformanceDiagnosticBuffer(): PerformanceDiagnosticRecord[] {
  const target = globalThis as typeof globalThis & Record<symbol, PerformanceDiagnosticRecord[] | undefined>;
  target[PERFORMANCE_DIAGNOSTICS_KEY] ??= [];
  return target[PERFORMANCE_DIAGNOSTICS_KEY];
}

/** 记录一个可安全落盘的性能诊断点。 */
export function recordPerformanceDiagnostic(point: string, eventType: string, durationMs?: number): void {
  if (process.env.AUTOPILOT_PERF_DIAGNOSTICS !== "1") return;
  const record: PerformanceDiagnosticRecord = {
    version: 1,
    point,
    eventType,
    monotonicMs: Number(performance.now().toFixed(3)),
    ...(durationMs === undefined ? {} : { durationMs: Number(durationMs.toFixed(3)) }),
  };
  getPerformanceDiagnosticBuffer().push(record);
}
