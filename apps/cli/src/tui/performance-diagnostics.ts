/**
 * CLI 性能诊断事件：只缓冲渲染与输入时刻、耗时和事件类型，退出时一次性写入显式文件。
 */

import fs from "node:fs";
import path from "node:path";
import { classifyCliError, type CliErrorCategory } from "../error-diagnostics.js";

const PERFORMANCE_DIAGNOSTICS_KEY = Symbol.for("autopilot.performanceDiagnostics");
let exitHookInstalled = false;

interface TuiPerformanceDiagnosticRecord {
  version: 1;
  point: string;
  eventType: string;
  monotonicMs: number;
  durationMs?: number;
  errorCategory?: CliErrorCategory;
  errorCode?: string;
}

/** 返回与 Core 诊断点共享的进程内缓冲。 */
function getPerformanceDiagnosticBuffer(): TuiPerformanceDiagnosticRecord[] {
  const target = globalThis as typeof globalThis & Record<symbol, TuiPerformanceDiagnosticRecord[] | undefined>;
  target[PERFORMANCE_DIAGNOSTICS_KEY] ??= [];
  return target[PERFORMANCE_DIAGNOSTICS_KEY];
}

/** 在进程退出时一次性写入 JSONL，避免逐事件文件 I/O 污染被测热路径。 */
function ensureExitFlush(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", function flushPerformanceDiagnostics() {
    const outputFile = process.env.AUTOPILOT_PERF_DIAGNOSTICS_FILE;
    if (!outputFile) return;
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    const records = getPerformanceDiagnosticBuffer();
    fs.writeFileSync(outputFile, records.map(function serialize(record) { return JSON.stringify(record); }).join("\n") + "\n", "utf8");
  });
}

/** 记录一个不含用户内容的 CLI 性能诊断点。 */
export function recordTuiPerformanceDiagnostic(point: string, eventType: string, durationMs?: number): void {
  if (process.env.AUTOPILOT_PERF_DIAGNOSTICS !== "1") return;
  ensureExitFlush();
  const record: TuiPerformanceDiagnosticRecord = {
    version: 1,
    point,
    eventType,
    monotonicMs: Number(performance.now().toFixed(3)),
    ...(durationMs === undefined ? {} : { durationMs: Number(durationMs.toFixed(3)) }),
  };
  getPerformanceDiagnosticBuffer().push(record);
}

/** 只把稳定类别与白名单错误码写入显式诊断缓冲，不保存异常正文或调用内容。 */
export function recordTuiRuntimeErrorDiagnostic(error: unknown): void {
  if (process.env.AUTOPILOT_PERF_DIAGNOSTICS !== "1") return;
  ensureExitFlush();
  const classification = classifyCliError(error);
  getPerformanceDiagnosticBuffer().push({
    version: 1,
    point: "tui_runtime_error",
    eventType: "dispatch",
    monotonicMs: Number(performance.now().toFixed(3)),
    errorCategory: classification.category,
    errorCode: classification.code,
  });
}
