/** 协作执行档位解析与旧记录补齐；只采用持久执行证据并经组 CAS 写入。 */
import type { RuntimePorts } from "../ports";
import type { ThreadControl } from "../domain/thread-collaboration";
import { AgentRuntimeError } from "../protocol/error-code";

/** 原 Turn 与冻结工具目录共同证明 Web 能力；工具缺省不反推 CLI。 */
export async function readFrozenThreadExecutionHost(ports: RuntimePorts, threadId: string): Promise<string | undefined> {
  const checkpoint = await ports.checkpointStore.getLatest(threadId);
  if (!checkpoint) return undefined;
  const turn = await ports.turnStore.get(checkpoint.turnId);
  if (turn?.sessionId === threadId && (turn.frozenRunConfig.workPreviewEnabled || checkpoint.samplingTools?.some(function question(tool) { return tool.function.name === "ask_user_question"; }))) return "web-work-v1";
  return undefined;
}

/** 从成员、创建意图和真实 Turn 的领取 owner 收集档位；冲突保持未确认。 */
export async function inferThreadExecutionHost(ports: RuntimePorts, control: ThreadControl, threadId: string): Promise<string | undefined> {
  const hosts = new Set<string>();
  const member = control.members.find(function target(item) { return item.threadId === threadId; });
  if (member?.executionHost) return member.executionHost;
  for (const intent of control.creates) if (intent.threadId === threadId && intent.executionHost) hosts.add(intent.executionHost);
  for (const delivery of control.deliveries) {
    if (delivery.threadId !== threadId) continue;
    if (delivery.executionHost) hosts.add(delivery.executionHost);
  }
  if (hosts.size) return hosts.size === 1 ? [...hosts][0] : undefined;
  const frozenHost = await readFrozenThreadExecutionHost(ports, threadId);
  if (frozenHost) hosts.add(frozenHost);
  for (const delivery of control.deliveries) {
    if (delivery.threadId !== threadId) continue;
    const turnId = delivery.turnId ?? delivery.reservedTurnId;
    if (!turnId || !delivery.ownerId) continue;
    const turn = await ports.turnStore.get(turnId);
    if (!turn || turn.sessionId !== threadId) continue;
    for (const kind of ["cli", "web"]) {
      const prefix = `${kind}:${control.group.workspaceId}:`;
      if (delivery.ownerId.startsWith(prefix) && /^\d+$/u.test(delivery.ownerId.slice(prefix.length))) hosts.add(`${kind}-work-v1`);
    }
  }
  return hosts.size === 1 ? [...hosts][0] : undefined;
}

/** 将已确认档位补齐到同一目标的缺省记录，保留已有档位、领取和执行身份。 */
export function withThreadExecutionHost(control: ThreadControl, threadId: string, executionHost: string): ThreadControl {
  return {
    ...control,
    revision: control.revision + 1,
    members: control.members.map(function member(item) { return item.threadId === threadId && !item.executionHost ? { ...item, executionHost } : item; }),
    creates: control.creates.map(function intent(item) { return item.threadId === threadId && !item.executionHost ? { ...item, executionHost } : item; }),
    deliveries: control.deliveries.map(function delivery(item) { return item.threadId === threadId && !item.executionHost ? { ...item, executionHost } : item; }),
  };
}

/** 旧目标仅在证据唯一时补齐；CAS 失败重读，未知记录保持原样等待人工绑定。 */
export async function resolveThreadExecutionHost(ports: RuntimePorts, groupId: string, threadId: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const control = await ports.threadStore.readControl(groupId);
    if (!control) return undefined;
    const member = control.members.find(function target(item) { return item.threadId === threadId; });
    const host = member?.executionHost ?? await inferThreadExecutionHost(ports, control, threadId);
    if (!host) return undefined;
    const incomplete = control.members.some(function member(item) { return item.threadId === threadId && !item.executionHost; })
      || control.deliveries.some(function delivery(item) { return item.threadId === threadId && !item.executionHost; });
    if (!incomplete) return host;
    if (await ports.threadStore.compareAndSetControl(groupId, control.revision, withThreadExecutionHost(control, threadId, host))) return host;
  }
  throw new AgentRuntimeError("THREAD_STATE_CONFLICT", "THREAD_STATE_CONFLICT");
}

/** 直接启动/继续也校验目标归属；读取、改标题和提交人类决定不调用此执行门禁。 */
export async function assertThreadExecutionHost(ports: RuntimePorts, sessionId: string, projectId: string | undefined, executionHost: string | undefined, continuing = false): Promise<void> {
  for (const groupId of await ports.threadStore.listGroups()) {
    const control = await ports.threadStore.readControl(groupId);
    if (!control || control.group.projectId !== projectId || !control.members.some(function member(item) { return item.threadId === sessionId; })) continue;
    if (continuing && executionHost !== "web-work-v1") {
      const frozenHost = await readFrozenThreadExecutionHost(ports, sessionId);
      if (frozenHost && frozenHost !== executionHost) throw new AgentRuntimeError("THREAD_RECOVERY_REQUIRED", "THREAD_RECOVERY_REQUIRED");
    }
    const required = await resolveThreadExecutionHost(ports, groupId, sessionId);
    if (required !== executionHost) throw new AgentRuntimeError("THREAD_RECOVERY_REQUIRED", "THREAD_RECOVERY_REQUIRED");
  }
}
