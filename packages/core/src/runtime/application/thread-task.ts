/** 从既有消息、交付和 Inbox 消费事实解析任务，不创建任务数据库或执行循环。 */
import type { RuntimePorts } from "../ports";
import type { ThreadControl } from "../domain/thread-collaboration";

/** 读取唯一 run 消息的真实执行身份；排队必须以已消费 inputId 为准，不采用预投递 Turn。 */
export async function readThreadTask(ports: RuntimePorts, control: ThreadControl, threadId: string, taskId: string) {
  const intent = control.messageIntents.find(function task(item) { return item.committed && item.message.messageId === taskId && item.message.mode === "run" && item.message.toThreadId === threadId; });
  const delivery = control.deliveries.find(function task(item) { return item.messageId === taskId && item.mode === "run" && item.threadId === threadId; });
  if (!intent || !delivery) return undefined;
  let turnId = delivery.turnId ?? delivery.reservedTurnId;
  if (delivery.inputId) {
    const input = (await ports.inputInbox.list({ sessionId: threadId })).find(function exact(item) { return item.inputId === delivery.inputId && item.clientMessageId === taskId; });
    if (!input) return undefined;
    turnId = input.status === "consumed" ? input.turnId : undefined;
  }
  const turn = turnId ? await ports.turnStore.get(turnId) : undefined;
  if (turn && turn.sessionId !== threadId) return undefined;
  return { taskId, message: intent.message, delivery, turnId, turn: turn ?? undefined };
}

/** 当前 Turn 仅在唯一真实 run 映射时得到任务；普通后续 Turn 和多任务歧义均无默认归属。 */
export async function currentThreadTaskId(ports: RuntimePorts, control: ThreadControl, threadId: string, turnId: string): Promise<string | undefined> {
  const tasks: string[] = [];
  for (const delivery of control.deliveries) {
    if (delivery.mode !== "run" || delivery.threadId !== threadId) continue;
    const task = await readThreadTask(ports, control, threadId, delivery.messageId);
    if (task?.turnId === turnId) tasks.push(task.taskId);
  }
  return tasks.length === 1 ? tasks[0] : undefined;
}

/** 任务进展序号在同目标内独立计数，键使用 JSON 编码避免身份拼接碰撞。 */
export function threadTaskProgressKey(threadId: string, taskId: string): string {
  return JSON.stringify([threadId, taskId]);
}
