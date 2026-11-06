/** 从持久Thread消息和真实Turn只读重建首条Prompt，避免依赖某个宿主的瞬时回调。 */
import type { RuntimePorts } from "@autopilot-agent/core";
import type { SessionMessage } from "../session-store";

/** 用messageId覆盖同一缓存投影并绑定真实Turn；预留身份必须已经存在于目标Session。 */
export async function restoreWebThreadPrompts(ports: RuntimePorts, sessionId: string, messages: SessionMessage[]): Promise<SessionMessage[]> {
  const session = await ports.sessionStore.get(sessionId);
  if (!session) return messages;
  const projected = new Map<string, SessionMessage>();
  for (const groupId of await ports.threadStore.listGroups()) {
    const control = await ports.threadStore.readControl(groupId);
    if (!control || control.group.projectId !== session.projectId || !control.members.some(function target(member) { return member.threadId === sessionId; })) continue;
    for (const delivery of control.deliveries) {
      if (delivery.threadId !== sessionId || delivery.mode !== "run") continue;
      const turnId = delivery.turnId ?? delivery.reservedTurnId;
      if (!turnId) continue;
      const turn = await ports.turnStore.get(turnId);
      if (!turn || turn.sessionId !== sessionId) continue;
      const message = await ports.threadStore.readMessage(groupId, sessionId, delivery.deliverySeq);
      if (!message || message.messageId !== delivery.messageId || message.mode !== "run") continue;
      const clientRecordId = `thread:${message.messageId}`;
      projected.set(clientRecordId, {
        type: "message", id: clientRecordId, clientRecordId, role: "user", turnId,
        content: message.handoffDisplay ? `# Handoff：${message.handoffDisplay.title}\n\n${message.handoffDisplay.instruction}` : message.content,
        ...(message.from.kind === "thread" ? { origin: { kind: "thread", threadId: message.from.threadId } } : {}),
        ...(message.handoffDisplay ? { handoffDisplay: message.handoffDisplay } : {}),
        createdAt: turn.startedAt,
      });
    }
  }
  const restored = new Set<string>();
  const result = messages.flatMap(function restore(message) {
    const replacement = message.clientRecordId ? projected.get(message.clientRecordId) : undefined;
    if (!replacement) return [message];
    if (restored.has(message.clientRecordId!)) return [];
    restored.add(message.clientRecordId!);
    return [{ ...replacement, id: message.id }];
  });
  return [...result, ...[...projected.entries()].filter(function missing([id]) { return !restored.has(id); }).map(function prompt([, message]) { return message; })].sort(function chronological(left, right) {
    return left.createdAt - right.createdAt || Number(right.role === "user") - Number(left.role === "user");
  });
}
