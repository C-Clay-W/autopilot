/** Work 历史来源边界：只读检查旧状态，未知知识上下文不得再次进入模型或压缩器。 */
import type { Session } from "../../domain";
import type { RuntimePorts } from "../../ports";
import { AgentRuntimeError } from "../../protocol/error-code";

/** 只认可新边界签发的全部 Turn；不通过缺省产品身份、工具列表或文本猜测旧来源。 */
export async function getWorkHistoryRestriction(ports: RuntimePorts, session: Session): Promise<"WORK_HISTORY_READ_ONLY" | undefined> {
  if (session.productMode === "chat") return undefined;
  const turns = await ports.turnStore.list(session.id);
  if (turns.some(function unverified(turn) { return turn.frozenRunConfig.workContextVersion !== 1 || turn.frozenRunConfig.capabilityCeiling?.productMode !== "work"; })) return "WORK_HISTORY_READ_ONLY";
  const checkpoint = await ports.checkpointStore.getLatest(session.id);
  const events = await ports.transcriptStore.getEvents(session.id);
  const ids = new Set(turns.map(function turnId(turn) { return turn.id; }));
  if ((checkpoint && !ids.has(checkpoint.turnId)) || events.some(function orphan(event) { return !ids.has(event.turnId); })) return "WORK_HISTORY_READ_ONLY";
  if (!turns.length && session.workContextVersion !== 1 && (session.presentation?.messages?.length || session.presentation?.compactions?.length)) return "WORK_HISTORY_READ_ONLY";
  return undefined;
}

/** 在加载 Provider、Context、恢复或压缩前拒绝旧知识上下文，原数据保持不变。 */
export async function assertWorkHistoryWritable(ports: RuntimePorts, session: Session): Promise<void> {
  if (await getWorkHistoryRestriction(ports, session)) throw new AgentRuntimeError("WORK_HISTORY_READ_ONLY", "旧任务上下文来源未验证，仅可查看；请创建新的 Work 任务");
}
