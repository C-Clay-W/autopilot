/** Web 待执行参数只在当前 Runtime 短期保存，落盘占位永远不能当作网络请求输入。 */
import { getAgentToolCalls } from "../../../internal/types/agent-message";
import type { AgentCheckpoint } from "../../protocol";

export interface WebCheckpointInputs {
  remember(checkpoint: AgentCheckpoint): void;
  restore(checkpoint: AgentCheckpoint): AgentCheckpoint;
}

/** 创建有界的进程内参数暂存；与审批相同保留十分钟，完成或被新状态覆盖时释放。 */
export function createWebCheckpointInputs(): WebCheckpointInputs {
  const entries = new Map<string, { expiresAt: number; stepCount: number; calls: ReturnType<typeof getAgentToolCalls>; timer: ReturnType<typeof setTimeout> }>();
  /** 释放原参数及其过期计时器，避免空闲 Runtime 长期保留输入。 */
  function forget(turnId: string): void {
    const entry = entries.get(turnId);
    if (entry) clearTimeout(entry.timer);
    entries.delete(turnId);
  }
  return {
    /** 仅保存明确暂停边界的 Web 输入，不保存网页结果或完整 checkpoint。 */
    remember(checkpoint) {
      forget(checkpoint.turnId);
      for (const [key, entry] of entries) if (entry.expiresAt <= Date.now()) forget(key);
      const calls = checkpoint.messages.flatMap(getAgentToolCalls).filter(function selectWebCall(call) {
        return (call.name === "web_search" || call.name === "web_fetch") && checkpoint.pendingCalls?.some(function isPending(pending) { return pending.id === call.id; });
      });
      if (checkpoint.status !== "awaiting_approval" || !calls?.length) return;
      if (entries.size >= 32) forget(entries.keys().next().value!);
      const turnId = checkpoint.turnId;
      const timer = setTimeout(function expireWebInputs() { forget(turnId); }, 600_000);
      timer.unref();
      entries.set(turnId, { expiresAt: Date.now() + 600_000, stepCount: checkpoint.stepCount, calls, timer });
    },
    /** 只恢复同一 Turn/步骤/调用的原参数；失效时保留占位，Kernel 将整批安全闭合。 */
    restore(checkpoint) {
      const entry = entries.get(checkpoint.turnId);
      if (!entry || entry.expiresAt <= Date.now() || entry.stepCount !== checkpoint.stepCount) {
        forget(checkpoint.turnId);
        return checkpoint;
      }
      const inputs = new Map(entry.calls.map(function bindCall(call) { return [call.id, call]; }));
      const pendingCalls = checkpoint.pendingCalls?.map(function restoreCall(call) {
        const original = inputs.get(call.id);
        return original?.name === call.name ? original : call;
      });
      const messages = checkpoint.messages.map(function restoreMessage(message) {
        return { ...message, content: message.content.map(function restoreBlock(block) {
          const original = block.type === "tool-call" ? inputs.get(block.id) : undefined;
          return block.type === "tool-call" && original?.name === block.name ? { ...block, input: original.input } : block;
        }) };
      });
      return { ...checkpoint, pendingCalls, messages };
    },
  };
}
