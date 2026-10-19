/**
 * 工具审计事件：只上报状态、哈希和大小等元数据，不记录文件内容或命令输出。
 */
import type { ToolEvent, ToolExecutionContext } from "./types";

/** 经宿主注入的回调发送审计事件，core 不直接写 session 或日志文件。 */
export function emitToolEvent(context: ToolExecutionContext, event: Omit<ToolEvent, "timestamp">): void {
  context.onToolEvent?.({ ...event, timestamp: new Date().toISOString() });
}
