/** 受管 Runtime 的独占进程所有权；复用 Node 既有锁，只有确认旧 PID 退出才能回收。 */
import { join } from "node:path";
import { withFileLock } from "./file-utils";

/** 路径由受信 bootstrap 提供；整个 operation 生命周期只允许一个 Runtime owner。 */
export function withNodeRuntimeOwner<T>(stateRoot: string, operation: () => Promise<T>): Promise<T> {
  return withFileLock(join(stateRoot, "managed-runtime-owner"), operation, { requireExitedOwner: true });
}
