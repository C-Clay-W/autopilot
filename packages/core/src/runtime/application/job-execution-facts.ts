/** Job 执行诊断：只依据包装 close 和 runner 固定错误签名生成安全事实。 */
import type { JobExecutionFacts } from "../domain/job";

/** 无 ready 协议时不推断目标已启动；只复制固定阶段、signal 与 Win32 十六进制码。 */
export function projectJobCloseFacts(stderr: string, signal?: NodeJS.Signals | null): JobExecutionFacts {
  const targetSpawnError = /srt-win: error: CreateProcessAsUserW\([^\r\n]*\):[^\r\n]*\((0x[0-9a-f]{8})\)/i.exec(stderr);
  return {
    phase: targetSpawnError ? "target_spawn_error_reported" : "wrapper_exit",
    targetState: "unknown",
    ...(signal ? { signal } : {}),
    ...(targetSpawnError ? { win32Code: targetSpawnError[1].toLowerCase() } : {}),
  };
}
