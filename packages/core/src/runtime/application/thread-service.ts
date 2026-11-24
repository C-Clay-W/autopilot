/** 协作组与可恢复 Session 创建服务；受信宿主绑定来源，不执行模型。 */
import { createHash, randomUUID } from "node:crypto";
import { AgentRuntimeError } from "../protocol/error-code";
import type { AgentErrorCode } from "../protocol/error-code";
import type { RuntimePorts } from "../ports";
import type { ThreadStore } from "../ports/thread-store";
import type { ThreadActor, ThreadControl, ThreadCreateIntent, ThreadDelivery, ThreadGroup, ThreadHandoffInput, ThreadHandoffRef, ThreadMessage, ThreadEvent, ThreadProgressEntry, ThreadProgressKind } from "../domain/thread-collaboration";
import type { ThreadHandoffWriter } from "../ports/thread-handoff";
import type { InboxInput } from "../domain/input-inbox";
import { currentThreadTaskId, readThreadTask, threadTaskProgressKey } from "./thread-task";
import { createSessionForThread } from "./session-service";
import { readFrozenThreadExecutionHost, inferThreadExecutionHost, resolveThreadExecutionHost, withThreadExecutionHost } from "./thread-execution-host";
import { STALE_AGENT_LEASE_MS } from "./turn/turn-lease-coordinator";
import { readTurnExecutionView } from "./turn/turn-execution-view";

/** 受信宿主提供的工作区、Project 和调用者，不来自工具参数或消息正文。 */
export interface ThreadHostContext {
  workspaceId: string;
  /** 受信宿主的稳定执行档位；具名宿主拒绝未消歧旧任务，浏览器/模型不能指定。 */
  executionHost?: string;
  /** 由宿主从实际状态根确定的稳定不透明身份。 */
  stateRootId: string;
  projectId: string;
  /** 已获人类授权且经宿主收窄的工具目录；空数组默认拒绝全部工具。 */
  allowedTools: readonly string[];
  /** 受信宿主的人类 owner 身份；仅供新 Work root 建组时记录，不代替 thread Actor。 */
  humanPrincipalId?: string;
  /** 仅 fresh Work start 可创建无组 root 的标记，不接受工具参数。 */
  allowRootGroupBootstrap?: boolean;
  /** 宿主提供的合法模型目录。 */
  modelCatalog: readonly import("../domain/model-ref").ModelRef[];
  /**
   * 受信宿主是否在线驱动本状态根；仅宿主能判定，缺省表示未知，不据此填充 hostOffline。
   * `run` 投递在离线时只返回 accepted + hostOffline，不暗示已启动。
   */
  hostOnline?: boolean;
  /**
   * 显式交接的文档写入能力；未装配时 handoff 明确返回不可用，
   * 不降级为只发正文的普通消息。实现由受信宿主注入，Core 不做文件 IO。
   */
  handoff?: ThreadHandoffWriter;
  actor: ThreadActor;
}

/** 错误不包含磁盘路径或其他组的存在性。 */
export class ThreadServiceError extends AgentRuntimeError {
  constructor(code: AgentErrorCode) { super(code, code); this.name = "ThreadServiceError"; }
}

/** 将来源转为稳定的幂等域键。 */
function actorKey(actor: ThreadActor): string {
  return actor.kind === "human" ? JSON.stringify(["human", actor.principalId]) : JSON.stringify(["thread", actor.threadId]);
}

/** 读取协作组的人类管理 owner；旧组兼容原 human createdBy。 */
function groupOwnerPrincipalId(group: ThreadGroup): string | undefined {
  return group.ownerPrincipalId ?? (group.createdBy.kind === "human" ? group.createdBy.principalId : undefined);
}

/** 使用标准库生成稳定摘要，避免把请求正文当作幂等键。 */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** 交互边界只冻结原调用/决定身份；预算迁移和心跳不改变这一身份。 */
export function interactionCheckpointDigest(checkpoint: import("../protocol").AgentCheckpoint): string {
  return digest([checkpoint.turnId, checkpoint.status, checkpoint.pendingCalls ?? null, checkpoint.pendingUserQuestion?.requestId ?? null, checkpoint.completedCallIds]);
}

/** 按受信工作区、来源与请求身份派生交接文档的唯一固定路径。 */
export function threadHandoffPath(workspaceId: string, actor: ThreadActor, requestId: string): string {
  const handoffId = digest([workspaceId, actorKey(actor), "send", requestId]).slice(0, 32);
  return `.autopilot/thread-passdown-${handoffId}.md`;
}

/** 校验可供持久身份使用的短字符串。 */
function requireId(value: string): void {
  if (typeof value !== "string" || !value || value.length > 200 || /[\\/\x00-\x1f]/u.test(value)) throw new ThreadServiceError("INVALID_INPUT");
}

/** 交接标题必须是单行、非空、最多 128 个字符；换行会破坏固定首行。 */
function requireHandoffTitle(value: unknown): string {
  if (typeof value !== "string") throw new ThreadServiceError("INVALID_INPUT");
  const title = value.trim();
  if (!title || /[\r\n]/u.test(title) || Array.from(title).length > 128) throw new ThreadServiceError("INVALID_INPUT");
  return title;
}

/** 交接摘要必须非空且不超过 16 KiB；超限拒绝，不截断后假称完整。 */
function requireHandoffMarkdown(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ThreadServiceError("INVALID_INPUT");
  if (Buffer.byteLength(value, "utf8") > 16 * 1024) throw new ThreadServiceError("THREAD_PAYLOAD_TOO_LARGE");
  return value;
}

/** 创建绑定受信上下文的服务；本阶段只提供组和可恢复创建。 */
export function createThreadService(ports: RuntimePorts, store: ThreadStore, context: ThreadHostContext) {
  // 仅复制声明为数据的宿主字段；进程内回调等多余字段不能进入 structuredClone 或持久状态。
  const handoffWriter = context.handoff;
  context = {
    ...structuredClone({
      workspaceId: context.workspaceId,
      ...(context.executionHost ? { executionHost: context.executionHost } : {}),
      stateRootId: context.stateRootId,
      projectId: context.projectId,
      allowedTools: context.allowedTools,
      modelCatalog: context.modelCatalog,
      ...(context.hostOnline !== undefined ? { hostOnline: context.hostOnline } : {}),
      ...(context.humanPrincipalId !== undefined ? { humanPrincipalId: context.humanPrincipalId } : {}),
      ...(context.allowRootGroupBootstrap !== undefined ? { allowRootGroupBootstrap: context.allowRootGroupBootstrap } : {}),
      actor: context.actor,
    }),
    ...(handoffWriter ? { handoff: handoffWriter } : {}),
  };
  requireId(context.workspaceId);
  if (context.executionHost !== undefined) requireId(context.executionHost);
  requireId(context.stateRootId);
  requireId(context.projectId);
  if (!Array.isArray(context.allowedTools) || context.allowedTools.some(function invalid(name) { return typeof name !== "string" || !name; }) || !Array.isArray(context.modelCatalog)) throw new ThreadServiceError("INVALID_INPUT");
  const allowedTools = [...new Set(context.allowedTools)];
  const modelCatalog = structuredClone(context.modelCatalog);
  const actor = structuredClone(context.actor);
  if (actor.kind === "human") requireId(actor.principalId);
  else { requireId(actor.threadId); requireId(actor.turnId); }
  if (context.humanPrincipalId !== undefined) requireId(context.humanPrincipalId);
  if (context.allowRootGroupBootstrap !== undefined && typeof context.allowRootGroupBootstrap !== "boolean") throw new ThreadServiceError("INVALID_INPUT");
  const key = actorKey(actor);

  /** 每次检查当前 Project 与 workspace 绑定，撤销后拒绝继续使用旧能力。 */
  async function verifyWorkspace(): Promise<void> {
    if (actor.kind === "thread" && (await ports.sessionStore.get(actor.threadId))?.managedExecution) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    const project = await ports.projectStore.get(context.projectId);
    const workspace = await ports.workspaceAdapter.resolveWorkspaceRoot();
    if (!project || project.workspaceRoot !== workspace) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
  }

  /**
   * 校验组、成员和活动来源，杜绝跨组或伪造来源访问。
   * `readOnly` 允许已停用组的只读访问；写入、投递和控制仍要求组处于启用状态。
   */
  async function authorize(groupId: string, options: { readOnly?: boolean } = {}): Promise<ThreadControl> {
    requireId(groupId);
    await verifyWorkspace();
    const control = await store.readControl(groupId);
    if (!control || (!options.readOnly && !control.group.enabled) || control.group.workspaceId !== context.workspaceId || control.group.projectId !== context.projectId) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    if (actor.kind === "human") {
      if (groupOwnerPrincipalId(control.group) !== actor.principalId) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    } else {
      const turn = await ports.turnStore.get(actor.turnId);
      if (!control.members.some(function member(item) { return item.threadId === actor.threadId; }) || !turn || turn.sessionId !== actor.threadId || turn.status !== "running") throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    }
    return control;
  }

  /** 在工作区、可信 actor 与操作域内持久预留稳定请求身份。 */
  async function reserve(operation: string, requestId: string, groupId: string, payloadDigest: string): Promise<void> {
    try { await store.reserveRequest(digest([context.workspaceId, key, operation, requestId]), groupId, payloadDigest); }
    catch (error) {
      if (error instanceof Error && error.message === "THREAD_REQUEST_CONFLICT") throw new ThreadServiceError("THREAD_REQUEST_CONFLICT");
      throw error;
    }
  }

  /** 只读检查已有身份；实际预留仍通过 Store 原子比较处理竞争。 */
  async function verifyRequest(operation: string, requestId: string, groupId: string, payloadDigest: string): Promise<void> {
    try { await store.verifyRequest(digest([context.workspaceId, key, operation, requestId]), groupId, payloadDigest); }
    catch (error) {
      if (error instanceof Error && error.message === "THREAD_REQUEST_CONFLICT") throw new ThreadServiceError("THREAD_REQUEST_CONFLICT");
      throw error;
    }
  }

  /** 判断目标是否仍由未过期的执行 lease 持有；超时只代表失联。 */
  async function hasFreshLease(threadId: string): Promise<boolean> {
    const checkpoint = await ports.checkpointStore.getLatest(threadId);
    return Boolean(checkpoint && checkpoint.status === "running" && checkpoint.lease && ports.clock.now() - checkpoint.lease.heartbeatAt <= STALE_AGENT_LEASE_MS);
  }

  /** 新工作只占用控制聚合的前三 MiB，保留余量处理终态和恢复。 */
  function assertAdmission(control: ThreadControl): void {
    // 组标识、来源、标题、请求 ID 均有长度限制；每个未完成意图预留 16 KiB 覆盖 member、receipt 和事件。
    const pending = control.creates.filter(function pendingCreate(item) { return item.status === "creating"; }).length
      + control.messageIntents.filter(function pendingMessage(item) { return !item.committed; }).length;
    const reservedBytes = pending * 16 * 1024;
    if (Buffer.byteLength(JSON.stringify(control), "utf8") + reservedBytes > 3 * 1024 * 1024) throw new ThreadServiceError("THREAD_STORAGE_FULL");
  }

  /** 将安全事件意图与领域状态一起提交，记录写入可按稳定序号重试。 */
  function withEvent(current: ThreadControl, event: Omit<ThreadEvent, "groupId" | "groupSeq" | "actor" | "createdAt">, origin: ThreadActor = actor): ThreadControl {
    const record: ThreadEvent = { groupId: current.group.groupId, groupSeq: current.nextGroupSeq, actor: origin, createdAt: ports.clock.now(), ...event };
    return { ...current, nextGroupSeq: current.nextGroupSeq + 1, eventIntents: [...current.eventIntents, record] };
  }

  /** 查找并补写某次已提交事件；不会重复或改变原事件。 */
  async function persistEvent(control: ThreadControl, predicate: (event: ThreadEvent) => boolean): Promise<void> {
    const event = control.eventIntents.find(predicate);
    if (!event) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
    await store.writeEvent(event);
  }

  /** 按根会话查找本受信 owner 在当前 Project 已有的组；停用组也返回，禁止自举复活。 */
  async function findGroupByRoot(rootThreadId: string, selectedGroupId?: string): Promise<ThreadControl | undefined> {
    const principalId = actor.kind === "human" ? actor.principalId : context.humanPrincipalId;
    if (!principalId) return undefined;
    let found: ThreadControl | undefined;
    for (const groupId of await store.listGroups()) {
      const control = await store.readControl(groupId);
      if (!control) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      if (control.group.rootThreadId !== rootThreadId || (selectedGroupId && groupId !== selectedGroupId)) continue;
      if (control.group.workspaceId !== context.workspaceId || control.group.projectId !== context.projectId) continue;
      if (groupOwnerPrincipalId(control.group) !== principalId || found) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      found = control;
    }
    return found;
  }

  /** 只接受空闲或最近一次 Turn 已成功完成的会话；恢复态和不完整事实均拒绝。 */
  async function canEnableForSession(session: import("../domain").Session | null): Promise<boolean> {
    if (session?.managedExecution) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    if (!session || session.productMode !== "work" || session.projectId !== context.projectId || session.activeTurnId) return false;
    if (session.status === "idle") return true;
    if (session.status !== "completed") return false;
    const turn = await ports.turnStore.getLatest(session.id);
    if (!turn || turn.status !== "completed") return false;
    const checkpoint = await ports.checkpointStore.getByTurn(session.id, turn.id);
    return checkpoint?.turnId === turn.id && checkpoint.status === "completed";
  }

  /** 仅可信人类入口可为已存在且空闲的 Work Session 显式启用或重新启用协作。 */
  async function enableLocked(input: { requestId: string; rootThreadId: string; groupId?: string }): Promise<ThreadControl> {
    if ((await ports.sessionStore.get(input.rootThreadId))?.managedExecution) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    if (actor.kind !== "human") throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    requireId(input.requestId); requireId(input.rootThreadId);
    if (input.groupId !== undefined) requireId(input.groupId);
    await verifyWorkspace();
    const fingerprint = digest([input.rootThreadId]);
    const found = await findGroupByRoot(input.rootThreadId, input.groupId);
    // 面板按 groupId 重新启用时，必须与根会话实际所属组一致，避免 URL 与操作对象错位。
    if (found && input.groupId !== undefined && found.group.groupId !== input.groupId) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    if (found) {
      const groupId = found.group.groupId;
      await verifyRequest("enable", input.requestId, groupId, fingerprint);
      const existing = await store.readControl(groupId);
      if (!existing) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      if (existing.group.enabled) {
        await reserve("enable", input.requestId, groupId, fingerprint);
        for (let n = 0; n < 32; n++) {
          const current = await store.readControl(groupId);
          if (!current) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
          const receipt = current.receipts.find(function match(item) { return item.actorKey === key && item.operation === "enable" && item.requestId === input.requestId; });
          if (receipt) {
            if (receipt.payloadDigest !== fingerprint) throw new ThreadServiceError("THREAD_REQUEST_CONFLICT");
            await persistEvent(current, function rootEvent(event) { return event.kind === "member_created" && event.threadId === input.rootThreadId; });
            return current;
          }
          if (!current.group.enabled) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
          const next: ThreadControl = {
            ...current,
            revision: current.revision + 1,
            receipts: [...current.receipts, { actorKey: key, operation: "enable", requestId: input.requestId, payloadDigest: fingerprint, result: { groupId } }],
          };
          if (await store.compareAndSetControl(groupId, current.revision, next)) {
            await persistEvent(next, function rootEvent(event) { return event.kind === "member_created" && event.threadId === input.rootThreadId; });
            return next;
          }
        }
        throw new ThreadServiceError("THREAD_STATE_CONFLICT");
      }
      // 重新启用必须重新校验 Trust 后的工作区与空闲会话，不继承停用前的授权状态。
      const session = await ports.sessionStore.get(input.rootThreadId);
      if (!session || !await canEnableForSession(session)) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      for (let n = 0; n < 32; n++) {
        const current = await store.readControl(groupId);
        if (!current) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
        if (current.group.enabled) {
          await reserve("enable", input.requestId, groupId, fingerprint);
          return current;
        }
        const result = { groupId };
        const next: ThreadControl = {
          ...current,
          revision: current.revision + 1,
          group: { ...current.group, enabled: true },
          receipts: [...current.receipts, { actorKey: key, operation: "enable", requestId: input.requestId, payloadDigest: fingerprint, result }],
        };
        const withEnabledEvent = withEvent(next, { kind: "group_enabled" });
        assertAdmission(withEnabledEvent);
        const eventSeq = withEnabledEvent.nextGroupSeq - 1;
        await reserve("enable", input.requestId, groupId, fingerprint);
        if (await store.compareAndSetControl(groupId, current.revision, withEnabledEvent)) {
          await persistEvent(withEnabledEvent, function enabledEvent(event) { return event.kind === "group_enabled" && event.groupSeq === eventSeq; });
          return withEnabledEvent;
        }
      }
      throw new ThreadServiceError("THREAD_STATE_CONFLICT");
    }
    const groupId = digest([context.workspaceId, key, "enable", input.requestId]);
    await verifyRequest("enable", input.requestId, groupId, fingerprint);
    const prior = await store.readControl(groupId);
    if (prior) {
      await reserve("enable", input.requestId, groupId, fingerprint);
      const receipt = prior.receipts.find(function match(item) { return item.actorKey === key && item.operation === "enable" && item.requestId === input.requestId; });
      if (!receipt || receipt.payloadDigest !== fingerprint) throw new ThreadServiceError("THREAD_REQUEST_CONFLICT");
      await persistEvent(prior, function rootEvent(event) { return event.kind === "member_created" && event.threadId === input.rootThreadId; });
      return prior;
    }
    const session = await ports.sessionStore.get(input.rootThreadId);
    if (!session || !await canEnableForSession(session)) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    const now = ports.clock.now();
    const value: ThreadControl = { group: { groupId, workspaceId: context.workspaceId, projectId: context.projectId, rootThreadId: session.id, enabled: true, createdAt: now, createdBy: actor, ownerPrincipalId: actor.principalId, allowedTools }, revision: 0, members: [{ executionHost: await readFrozenThreadExecutionHost(ports, session.id) ?? context.executionHost, threadId: session.id, groupId, parentThreadId: null, title: session.title, createdAt: now }], receipts: [{ actorKey: key, operation: "enable", requestId: input.requestId, payloadDigest: fingerprint, result: { groupId } }], creates: [], sharedState: {}, stateRevision: 0, stateUpdatedAt: now, stateUpdatedBy: actor, nextGroupSeq: 1, eventIntents: [], nextDeliverySeq: {}, messageIntents: [], deliveries: [], controls: [] };
    const initialized = withEvent(value, { kind: "member_created", threadId: session.id });
    assertAdmission(initialized);
    await reserve("enable", input.requestId, groupId, fingerprint);
    if (await store.compareAndSetControl(groupId, null, initialized)) {
      await persistEvent(initialized, function rootEvent(event) { return event.kind === "member_created" && event.threadId === session.id; });
      return initialized;
    }
    const existing = await store.readControl(groupId);
    const receipt = existing?.receipts.find(function match(item) { return item.actorKey === key && item.operation === "enable" && item.requestId === input.requestId; });
    if (!existing || !receipt || receipt.payloadDigest !== fingerprint) throw new ThreadServiceError("THREAD_REQUEST_CONFLICT");
    await persistEvent(existing, function rootEvent(event) { return event.kind === "member_created" && event.threadId === session.id; });
    return existing;
  }

  /** 启用和 Session 删除共享短锁，防止创建组时根会话被删除。 */
  async function enable(input: { requestId: string; rootThreadId: string; groupId?: string }): Promise<ThreadControl> {
    requireId(input.rootThreadId);
    return store.withSessionLock(input.rootThreadId, function enableUnderLock() { return enableLocked(input); });
  }

  /** 只投影组与成员的安全字段，供宿主面板展示，不返回回执、意图或交付内部记录。 */
  function projectGroup(control: ThreadControl) {
    return {
      groupId: control.group.groupId,
      revision: control.revision,
      rootThreadId: control.group.rootThreadId,
      enabled: control.group.enabled,
      createdAt: control.group.createdAt,
      allowedTools: [...control.group.allowedTools],
      members: control.members.map(function member(item) { return { threadId: item.threadId, parentThreadId: item.parentThreadId, title: item.title, roleLabel: item.roleLabel, createdAt: item.createdAt }; }),
    };
  }

  /**
   * 人类显式停用协作组：拒绝后续 create/send/state.update/interrupt，保留成员、历史和未交付项。
   * 停用不停止任何活动 Turn；需要停止时先走显式 interrupt。
   */
  async function disable(input: { requestId: string; groupId: string }): Promise<{ groupId: string; enabled: false }> {
    if (actor.kind !== "human") throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    requireId(input.requestId); requireId(input.groupId);
    await verifyWorkspace();
    const fingerprint = digest([input.groupId]);
    await verifyRequest("disable", input.requestId, input.groupId, fingerprint);
    const result = { groupId: input.groupId, enabled: false as const };
    for (let n = 0; n < 32; n++) {
      const current = await authorize(input.groupId, { readOnly: true });
      const prior = current.receipts.find(function match(item) { return item.actorKey === key && item.operation === "disable" && item.requestId === input.requestId; });
      if (prior) {
        if (prior.payloadDigest !== fingerprint) throw new ThreadServiceError("THREAD_REQUEST_CONFLICT");
        await reserve("disable", input.requestId, input.groupId, fingerprint);
        await persistEvent(current, function disabledEvent(event) { return event.kind === "group_disabled"; });
        return result;
      }
      if (!current.group.enabled) {
        await reserve("disable", input.requestId, input.groupId, fingerprint);
        return result;
      }
      const next: ThreadControl = {
        ...current,
        revision: current.revision + 1,
        group: { ...current.group, enabled: false },
        receipts: [...current.receipts, { actorKey: key, operation: "disable", requestId: input.requestId, payloadDigest: fingerprint, result }],
      };
      const withDisabledEvent = withEvent(next, { kind: "group_disabled" });
      assertAdmission(withDisabledEvent);
      const eventSeq = withDisabledEvent.nextGroupSeq - 1;
      await reserve("disable", input.requestId, input.groupId, fingerprint);
      if (await store.compareAndSetControl(input.groupId, current.revision, withDisabledEvent)) {
        await persistEvent(withDisabledEvent, function disabledEvent(event) { return event.kind === "group_disabled" && event.groupSeq === eventSeq; });
        return result;
      }
    }
    throw new ThreadServiceError("THREAD_STATE_CONFLICT");
  }

  /** 按本次动作的显式范围或共同成员解析，多个匹配拒绝，不缓存上次动作的组。 */
  async function resolveGroup(input: { groupId?: string; threadIds?: readonly string[]; readOnly?: boolean } = {}): Promise<string | null> {
    const targets = input.threadIds ?? [];
    for (const target of targets) requireId(target);
    if (input.groupId) {
      const control = await authorize(input.groupId, { readOnly: input.readOnly });
      if (targets.some(function absent(id) { return !control.members.some(function member(item) { return item.threadId === id; }); })) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      return input.groupId;
    }
    await verifyWorkspace();
    const matches: string[] = [];
    for (const id of await store.listGroups()) {
      const control = await store.readControl(id);
      if (!control) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      if ((!input.readOnly && !control.group.enabled) || control.group.workspaceId !== context.workspaceId || control.group.projectId !== context.projectId) continue;
      if (actor.kind === "human" ? groupOwnerPrincipalId(control.group) !== actor.principalId : !control.members.some(function member(item) { return item.threadId === actor.threadId; })) continue;
      if (targets.some(function absent(target) { return !control.members.some(function member(item) { return item.threadId === target; }); })) continue;
      await authorize(id, { readOnly: input.readOnly });
      matches.push(id);
    }
    if (matches.length > 1) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    return matches[0] ?? null;
  }

  /** 仅人类 owner 显式关联现有同域普通会话；Session 锁保护并发删除，来源不产生权限。 */
  async function associate(input: { groupId: string; threadId: string; requestId: string }): Promise<{ groupId: string; threadId: string }> {
    if (actor.kind !== "human") throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    requireId(input.threadId); requireId(input.requestId);
    const fingerprint = digest([input.threadId]);
    return store.withSessionLock(input.threadId, async function associateUnderLock() {
      for (let n = 0; n < 32; n++) {
        const current = await authorize(input.groupId);
        const session = await ports.sessionStore.get(input.threadId);
        if (session?.managedExecution) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
        if (!session || session.productMode !== "work" || session.projectId !== context.projectId) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
        await verifyRequest("associate", input.requestId, input.groupId, fingerprint);
        const prior = current.receipts.find(function same(item) { return item.actorKey === key && item.operation === "associate" && item.requestId === input.requestId; });
        if (prior) {
          if (prior.payloadDigest !== fingerprint) throw new ThreadServiceError("THREAD_REQUEST_CONFLICT");
          await reserve("associate", input.requestId, input.groupId, fingerprint);
          if (current.eventIntents.some(function member(event) { return event.kind === "member_created" && event.threadId === input.threadId; })) await persistEvent(current, function member(event) { return event.kind === "member_created" && event.threadId === input.threadId; });
          return prior.result as { groupId: string; threadId: string };
        }
        const result = { groupId: input.groupId, threadId: input.threadId };
        const known = current.members.some(function member(item) { return item.threadId === input.threadId; });
        const next: ThreadControl = { ...current, revision: current.revision + 1, members: known ? current.members : [...current.members, { executionHost: await inferThreadExecutionHost(ports, current, input.threadId) ?? (session.status === "running" || session.status === "waiting_approval" || session.status === "waiting_user_input" || session.status === "interrupted" ? undefined : context.executionHost), threadId: input.threadId, groupId: input.groupId, parentThreadId: null, title: session.title, createdAt: ports.clock.now() }], receipts: [...current.receipts, { actorKey: key, operation: "associate", requestId: input.requestId, payloadDigest: fingerprint, result }] };
        const committed = known ? next : withEvent(next, { kind: "member_created", threadId: input.threadId });
        assertAdmission(committed);
        await reserve("associate", input.requestId, input.groupId, fingerprint);
        if (await store.compareAndSetControl(input.groupId, current.revision, committed)) {
          if (!known) await persistEvent(committed, function member(event) { return event.kind === "member_created" && event.threadId === input.threadId; });
          return result;
        }
      }
      throw new ThreadServiceError("THREAD_STATE_CONFLICT");
    });
  }

  /** 人类列出本工作区、本 Project 自己创建的组（含已停用）；供面板与 Sidebar 发现归属。 */
  async function groups(input: { cursor?: string; limit?: number } = {}) {
    if (actor.kind !== "human") throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    await verifyWorkspace();
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ThreadServiceError("INVALID_INPUT");
    let offset = 0;
    if (input.cursor) {
      try {
        const data = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as { v: number; schema: number; view: string; stateRootId: string; workspaceId: string; offset: number };
        if (data.v !== 1 || data.schema !== 8 || data.view !== "groups" || data.stateRootId !== context.stateRootId || data.workspaceId !== context.workspaceId || !Number.isSafeInteger(data.offset) || data.offset < 0) throw new Error("cursor");
        offset = data.offset;
      } catch { throw new ThreadServiceError("THREAD_CURSOR_INVALID"); }
    }
    const visible: ThreadControl[] = [];
    for (const groupId of await store.listGroups()) {
      const control = await store.readControl(groupId);
      if (!control) continue;
      if (control.group.workspaceId !== context.workspaceId || control.group.projectId !== context.projectId) continue;
      if (groupOwnerPrincipalId(control.group) !== actor.principalId) continue;
      visible.push(control);
    }
    visible.sort(function byCreated(left, right) { return left.group.createdAt - right.group.createdAt; });
    if (offset > visible.length) throw new ThreadServiceError("THREAD_CURSOR_INVALID");
    const items = visible.slice(offset, offset + limit).map(projectGroup);
    offset += items.length;
    const nextCursor = offset < visible.length
      ? Buffer.from(JSON.stringify({ v: 1, schema: 8, view: "groups", stateRootId: context.stateRootId, workspaceId: context.workspaceId, offset })).toString("base64url")
      : undefined;
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }

  /** 查询某个会话所属的组（含已停用）；不属于当前人类的组按不存在处理。 */
  async function groupOf(input: { threadId: string; groupId?: string }): Promise<{ group: ReturnType<typeof projectGroup> | null }> {
    if (actor.kind !== "human") throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    requireId(input.threadId);
    await verifyWorkspace();
    let found: ReturnType<typeof projectGroup> | null = null;
    for (const groupId of await store.listGroups()) {
      if (input.groupId && groupId !== input.groupId) continue;
      const control = await store.readControl(groupId);
      if (!control) continue;
      if (control.group.workspaceId !== context.workspaceId || control.group.projectId !== context.projectId) continue;
      if (groupOwnerPrincipalId(control.group) !== actor.principalId) continue;
      if (!control.members.some(function member(item) { return item.threadId === input.threadId; })) continue;
      if (found) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      found = projectGroup(control);
    }
    return { group: found };
  }

  /** 稳定 ID 先持久预留，再幂等创建 Session 和绑定成员。 */
  async function createLocked(input: { groupId: string; requestId: string; parentThreadId: string; title?: string; roleLabel?: string; modelRef?: import("../domain/model-ref").ModelRef; reasoningEffort?: import("../domain/model-ref").ReasoningEffort }): Promise<{ threadId: string; groupId: string; parentThreadId: string }> {
    requireId(input.requestId); requireId(input.parentThreadId);
    if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200)) throw new ThreadServiceError("INVALID_INPUT");
    if (input.roleLabel !== undefined && (typeof input.roleLabel !== "string" || input.roleLabel.length > 100)) throw new ThreadServiceError("INVALID_INPUT");
    if (input.modelRef !== undefined) { requireId(input.modelRef.provider); requireId(input.modelRef.modelId); }
    if (input.modelRef !== undefined && (!modelCatalog.some(function allowed(model) { return model.provider === input.modelRef?.provider && model.modelId === input.modelRef?.modelId; }))) throw new ThreadServiceError("MODEL_NOT_FOUND");
    if (input.reasoningEffort !== undefined && !["none", "low", "medium", "high", "xhigh", "max"].includes(input.reasoningEffort)) throw new ThreadServiceError("INVALID_INPUT");
    const fingerprint = digest([input.parentThreadId, input.title ?? null, input.roleLabel ?? null, input.modelRef ?? null, input.reasoningEffort ?? null]);
    let intent: ThreadCreateIntent | undefined;
    for (let n = 0; n < 32; n++) {
      const current = await authorize(input.groupId);
      if (!current.members.some(function parent(item) { return item.threadId === input.parentThreadId; }) || (actor.kind === "thread" && actor.threadId !== input.parentThreadId)) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      await verifyRequest("create", input.requestId, input.groupId, fingerprint);
      intent = current.creates.find(function match(item) { return item.actorKey === key && item.requestId === input.requestId; });
      if (intent) {
        if (intent.payloadDigest !== fingerprint) throw new ThreadServiceError("THREAD_REQUEST_CONFLICT");
        await reserve("create", input.requestId, input.groupId, fingerprint);
        break;
      }
      // 只在首次预留时冻结当前权限偏好；重试读取原intent，不追改已建目标或历史Turn。
      const parentSession = await ports.sessionStore.get(input.parentThreadId);
      const parentTurn = actor.kind === "thread" ? await ports.turnStore.get(actor.turnId) : parentSession?.activeTurnId ? await ports.turnStore.get(parentSession.activeTurnId) : undefined;
      const project = parentSession?.projectId ? await ports.projectStore.get(parentSession.projectId) : undefined;
      const preference = parentSession?.defaultRunConfig?.permissionMode ?? (parentTurn?.sessionId === input.parentThreadId ? parentTurn.frozenRunConfig?.permissionMode : undefined) ?? project?.defaultRunConfig?.permissionMode;
      const permissionMode = preference === "ask" || preference === "auto_approve" || preference === "full_access" ? preference : undefined;
      const executionHost = await resolveThreadExecutionHost(ports, input.groupId, input.parentThreadId);
      if (context.executionHost && !executionHost) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      intent = { requestId: input.requestId, actorKey: key, from: actor, payloadDigest: fingerprint, threadId: randomUUID(), parentThreadId: input.parentThreadId, title: input.title, roleLabel: input.roleLabel, modelRef: input.modelRef, reasoningEffort: input.reasoningEffort, permissionMode, executionHost, status: "creating" };
      const next = { ...current, revision: current.revision + 1, creates: [...current.creates, intent] };
      assertAdmission(next);
      await reserve("create", input.requestId, input.groupId, fingerprint);
      if (await store.compareAndSetControl(input.groupId, current.revision, next)) break;
      intent = undefined;
    }
    if (!intent) throw new ThreadServiceError("THREAD_STATE_CONFLICT");
    if (intent.status === "recovery_required") throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
    const reserved = intent;
    return store.withSessionLock(reserved.threadId, async function createReservedSession() {
    const intent = reserved;
    const creationId = digest([input.groupId, key, input.requestId]);
    const now = ports.clock.now();
    await authorize(input.groupId);
    try {
      await createSessionForThread(ports, {
        id: intent.threadId, productMode: "work", projectId: context.projectId, persistenceMode: "durable", title: intent.title,
        defaultRunConfig: { ...(intent.permissionMode ? { permissionMode: intent.permissionMode } : {}), ...(intent.modelRef ? { modelRef: intent.modelRef } : {}), ...(intent.reasoningEffort ? { reasoningProfile: { effort: intent.reasoningEffort } } : {}) },
      }, { creationId, source: { actor: intent.from, requestId: intent.requestId } });
    } catch (error) {
      if ((error as { code?: string }).code !== "SESSION_MODE_MISMATCH") throw error;
      for (let n = 0; n < 32; n++) {
        const current = await authorize(input.groupId);
        const found = current.creates.find(function matches(item) { return item.actorKey === key && item.requestId === input.requestId; });
        if (!found || found.threadId !== intent.threadId) break;
        if (found.status === "recovery_required") break;
        const next = withEvent({ ...current, revision: current.revision + 1, creates: current.creates.map(function flag(item) { return item === found ? { ...item, status: "recovery_required" as const } : item; }) }, { kind: "recovery_required", threadId: intent.threadId });
        if (await store.compareAndSetControl(input.groupId, current.revision, next)) {
          await persistEvent(next, function recovery(event) { return event.kind === "recovery_required" && event.threadId === intent.threadId; });
          break;
        }
      }
      throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
    }
    for (let n = 0; n < 32; n++) {
      const current = await authorize(input.groupId);
      const existing = current.creates.find(function match(item) { return item.actorKey === key && item.requestId === input.requestId; });
      if (!existing || existing.threadId !== intent.threadId || existing.payloadDigest !== fingerprint) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      if (existing.status === "created") {
        await persistEvent(current, function memberEvent(event) { return event.kind === "member_created" && event.threadId === intent.threadId; });
        return { threadId: intent.threadId, groupId: input.groupId, parentThreadId: intent.parentThreadId };
      }
      const member = { ...(intent.executionHost ? { executionHost: intent.executionHost } : {}), threadId: intent.threadId, groupId: input.groupId, parentThreadId: intent.parentThreadId, title: intent.title, roleLabel: intent.roleLabel, createdAt: now };
      const next: ThreadControl = { ...current, revision: current.revision + 1, creates: current.creates.map(function finish(item) { return item === existing ? { ...item, status: "created" } : item; }), members: [...current.members, member], receipts: [...current.receipts, { actorKey: key, operation: "create", requestId: input.requestId, payloadDigest: fingerprint, result: { threadId: intent.threadId, groupId: input.groupId, parentThreadId: intent.parentThreadId } }] };
      const withMemberEvent = withEvent(next, { kind: "member_created", threadId: intent.threadId }, intent.from);
      if (await store.compareAndSetControl(input.groupId, current.revision, withMemberEvent)) {
        await persistEvent(withMemberEvent, function memberEvent(event) { return event.kind === "member_created" && event.threadId === intent.threadId; });
        return { threadId: intent.threadId, groupId: input.groupId, parentThreadId: intent.parentThreadId };
      }
    }
    throw new ThreadServiceError("THREAD_STATE_CONFLICT");
    });
  }

  /** 创建时保护父会话，不让并发删除越过成员检查。 */
  async function create(input: { groupId: string; requestId: string; parentThreadId: string; title?: string; roleLabel?: string; modelRef?: import("../domain/model-ref").ModelRef; reasoningEffort?: import("../domain/model-ref").ReasoningEffort }): Promise<{ threadId: string; groupId: string; parentThreadId: string }> {
    requireId(input.parentThreadId);
    return store.withSessionLock(input.parentThreadId, function createUnderLock() { return createLocked(input); });
  }

  /** 解析当前 Turn 唯一的启用通信范围；停用组不阻止普通会话另建范围，多组歧义拒绝。 */
  async function currentGroupIdOrNull(): Promise<string | null> {
    if (actor.kind !== "thread") throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    await verifyWorkspace();
    const matched: ThreadControl[] = [];
    for (const groupId of await store.listGroups()) {
      const control = await store.readControl(groupId);
      if (!control) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      if (control.group.workspaceId !== context.workspaceId || control.group.projectId !== context.projectId) continue;
      if (control.group.enabled && control.members.some(function member(item) { return item.threadId === actor.threadId; })) matched.push(control);
    }
    if (matched.length > 1) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    const current = matched[0];
    if (!current) return null;
    return current.group.groupId;
  }

  /** create 重试时补写已提交根成员事件；只在显式 create 路径调用，不让只读 list 产生写入。 */
  async function persistCurrentRootMemberEvent(groupId: string): Promise<void> {
    if (actor.kind !== "thread") throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    const control = await store.readControl(groupId);
    if (!control) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
    if (control.group.rootThreadId !== actor.threadId) return;
    await persistEvent(control, function rootEvent(event) { return event.kind === "member_created" && event.threadId === actor.threadId; });
  }

  /**
   * 普通 Work 的可信活动 Turn 可按需建立新通信范围；不恢复已停用组，复用 Session 锁避免并发重复，
   * 此方法结束后绑定才会进入 create 的同锁段，因此不会嵌套 withSessionLock。
   */
  async function ensureCurrentGroupForCreate(selectedGroupId?: string): Promise<string> {
    if (selectedGroupId) {
      const selected = await resolveGroup({ groupId: selectedGroupId });
      return selected!;
    }
    if (actor.kind !== "thread") throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    const current = await currentGroupIdOrNull();
    if (current) {
      await persistCurrentRootMemberEvent(current);
      return current;
    }
    if (!context.humanPrincipalId) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    return store.withSessionLock(actor.threadId, async function bootstrapRootGroup() {
      const afterLock = await currentGroupIdOrNull();
      if (afterLock) {
        await persistCurrentRootMemberEvent(afterLock);
        return afterLock;
      }
      const session = await ports.sessionStore.get(actor.threadId);
      const turn = await ports.turnStore.get(actor.turnId);
      if (!session || session.productMode !== "work" || session.projectId !== context.projectId
        || session.status !== "running" || session.activeTurnId !== actor.turnId
        || !turn || turn.sessionId !== actor.threadId || turn.status !== "running") {
        throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      }
      const principalId = context.humanPrincipalId;
      const groupId = randomUUID();
      const prior = await store.readControl(groupId);
      if (prior) {
        if (prior.group.rootThreadId !== actor.threadId || groupOwnerPrincipalId(prior.group) !== principalId) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
        if (!prior.group.enabled) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
        if (!prior.members.some(function rootMember(item) { return item.threadId === actor.threadId && item.parentThreadId === null; })) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
        await persistCurrentRootMemberEvent(prior.group.groupId);
        return prior.group.groupId;
      }
      const now = ports.clock.now();
      const control: ThreadControl = {
        group: { groupId, workspaceId: context.workspaceId, projectId: context.projectId, rootThreadId: actor.threadId, enabled: true, createdAt: now, createdBy: actor, ownerPrincipalId: principalId, allowedTools },
        revision: 0,
        members: [{ executionHost: await readFrozenThreadExecutionHost(ports, actor.threadId) ?? context.executionHost, threadId: actor.threadId, groupId, parentThreadId: null, title: session.title, createdAt: now }],
        receipts: [], creates: [], sharedState: {}, stateRevision: 0, stateUpdatedAt: now, stateUpdatedBy: actor,
        nextGroupSeq: 1, eventIntents: [], nextDeliverySeq: {}, messageIntents: [], deliveries: [], controls: [],
      };
      const initialized = withEvent(control, { kind: "member_created", threadId: actor.threadId });
      assertAdmission(initialized);
      if (!await store.compareAndSetControl(groupId, null, initialized)) {
        const raced = await store.readControl(groupId);
        if (!raced || raced.group.rootThreadId !== actor.threadId || groupOwnerPrincipalId(raced.group) !== principalId || !raced.group.enabled) throw new ThreadServiceError("THREAD_STATE_CONFLICT");
        if (!raced.members.some(function rootMember(item) { return item.threadId === actor.threadId && item.parentThreadId === null; })) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
        await persistEvent(raced, function rootEvent(event) { return event.kind === "member_created" && event.threadId === actor.threadId; });
        return raced.group.groupId;
      }
      await persistEvent(initialized, function rootEvent(event) { return event.kind === "member_created" && event.threadId === actor.threadId; });
      return groupId;
    });
  }

  /** 人类按组版本绑定无执行事实或权威completed的旧目标，租约/CAS保护新Turn归属。 */
  async function bindExecutionHost(input: { groupId: string; threadId: string; expectedRevision: number; executionHost: "cli-work-v1" | "web-work-v1" }): Promise<{ groupId: string; threadId: string; executionHost: string }> {
    if (actor.kind !== "human") throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    requireId(input.threadId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !["cli-work-v1", "web-work-v1"].includes(input.executionHost)) throw new ThreadServiceError("INVALID_INPUT");
    return store.withSessionLock(input.threadId, async function bindUnderLock() {
      const current = await authorize(input.groupId);
      if (current.revision !== input.expectedRevision) throw new ThreadServiceError("THREAD_STATE_CONFLICT");
      const member = current.members.find(function target(item) { return item.threadId === input.threadId; });
      if (!member) throw new ThreadServiceError("THREAD_NOT_FOUND");
      const known = await inferThreadExecutionHost(ports, current, input.threadId);
      const session = await ports.sessionStore.get(input.threadId);
      const checkpoint = await ports.checkpointStore.getLatest(input.threadId);
      if (!session || session.status === "running" || checkpoint?.status === "running"
        || current.deliveries.some(function claimed(item) { return item.threadId === input.threadId && item.status === "claimed"; })) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      if (known && known !== input.executionHost) throw new ThreadServiceError("THREAD_STATE_CONFLICT");
      const historical = !known && Boolean(checkpoint || session.activeTurnId || member.executionHost || current.deliveries.some(function executed(item) { return item.threadId === input.threadId && Boolean(item.turnId || item.reservedTurnId || item.executionHost); }));
      let bindingLease: import("../../internal/agent-runtime").AgentLease | null = null;
      try {
        if (historical) {
          if (checkpoint?.status !== "completed" || current.controls.some(function claimed(item) { return item.threadId === input.threadId && ["claimed", "executing"].includes(item.status); })) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
          const now = ports.clock.now();
          bindingLease = await ports.leaseStore.acquire({ sessionId: input.threadId, turnId: checkpoint.turnId, lease: { leaseId: randomUUID(), ownerId: randomUUID(), heartbeatAt: now, safeBoundarySeq: 0 }, now, staleAfterMs: STALE_AGENT_LEASE_MS });
          if (!bindingLease) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
          const latest = await ports.turnStore.getLatest(input.threadId);
          const verified = await ports.checkpointStore.getLatest(input.threadId);
          const view = await readTurnExecutionView(ports, { sessionId: input.threadId });
          const currentSession = await ports.sessionStore.get(input.threadId);
          if (latest?.id !== checkpoint.turnId || latest.status !== "completed" || verified?.turnId !== latest.id || verified.status !== "completed" || verified.pendingCalls?.length || verified.pendingUserQuestion || view?.turnId !== latest.id || view.result !== "completed" || !currentSession || currentSession.activeTurnId || !["idle", "completed"].includes(currentSession.status)) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
        }
        const next = withThreadExecutionHost(current, input.threadId, input.executionHost);
        assertAdmission(next);
        if (!await store.compareAndSetControl(input.groupId, current.revision, next)) throw new ThreadServiceError("THREAD_STATE_CONFLICT");
        return { groupId: input.groupId, threadId: input.threadId, executionHost: input.executionHost };
      } finally {
        if (bindingLease) await ports.leaseStore.release({ sessionId: input.threadId, lease: bindingLease });
      }
    });
  }

  /**
   * 解析当前 Turn 所属的唯一启用组；工具只按此身份操作，模型不能自报 groupId。
   * 多个匹配或停用组表示归属歧义，fail-closed 拒绝而不是猜一个。
   */
  async function currentGroupId(): Promise<string> {
    if (actor.kind !== "thread") throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    const current = await currentGroupIdOrNull();
    if (!current) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    return current;
  }

  /** 读取授权组共享板副本，不注入模型或改变 Turn 状态。 */
  async function readState(groupId: string) {
    const current = await authorize(groupId, { readOnly: true });
    return { value: structuredClone(current.sharedState), revision: current.stateRevision, updatedAt: current.stateUpdatedAt, updatedBy: structuredClone(current.stateUpdatedBy) };
  }

  /** 使用显式 revision 做原子共享板更新，冲突时不合并。 */
  async function updateState(input: { groupId: string; requestId: string; expectedRevision: number; operations: Array<{ op: "set"; key: string; value: unknown } | { op: "remove"; key: string }> }) {
    requireId(input.requestId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !Array.isArray(input.operations) || input.operations.length === 0 || input.operations.length > 100) throw new ThreadServiceError("INVALID_INPUT");
    const serialized = JSON.stringify(input.operations);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 64 * 1024) throw new ThreadServiceError("THREAD_PAYLOAD_TOO_LARGE");
    const fingerprint = digest([input.expectedRevision, JSON.parse(serialized)]);
    for (let n = 0; n < 32; n++) {
      const current = await authorize(input.groupId);
      await verifyRequest("state.update", input.requestId, input.groupId, fingerprint);
      const prior = current.receipts.find(function match(item) { return item.actorKey === key && item.operation === "state.update" && item.requestId === input.requestId; });
      if (prior) {
        if (prior.payloadDigest !== fingerprint) throw new ThreadServiceError("THREAD_REQUEST_CONFLICT");
        await reserve("state.update", input.requestId, input.groupId, fingerprint);
        const result = prior.result as { revision: number };
        await persistEvent(current, function stateEvent(event) { return event.kind === "shared_state_changed" && event.stateRevision === result.revision; });
        return result;
      }
      if (current.stateRevision !== input.expectedRevision) throw new ThreadServiceError("THREAD_STATE_CONFLICT");
      const nextState = structuredClone(current.sharedState);
      for (const operation of input.operations) {
        requireId(operation.key);
        if (["__proto__", "prototype", "constructor"].includes(operation.key) || /(?:credential|password|secret|api[_-]?key|approval|checkpoint)/iu.test(operation.key)) throw new ThreadServiceError("INVALID_INPUT");
        if (operation.op === "remove") delete nextState[operation.key];
        else if (operation.op === "set") nextState[operation.key] = JSON.parse(JSON.stringify(operation.value));
        else throw new ThreadServiceError("INVALID_INPUT");
      }
      /** 检查 JSON 深度，限制共享板对宿主的内存占用。 */
      function checkDepth(value: unknown, depth: number): void {
        if (depth > 8) throw new ThreadServiceError("THREAD_PAYLOAD_TOO_LARGE");
        if (typeof value === "string" && (/^[a-z]:[\\/]/iu.test(value) || value.startsWith("/") || value.startsWith("\\\\"))) throw new ThreadServiceError("INVALID_INPUT");
        if (value && typeof value === "object") {
          for (const [name, child] of Object.entries(value)) {
            if (/(?:credential|password|secret|api[_-]?key|approval|checkpoint)/iu.test(name)) throw new ThreadServiceError("INVALID_INPUT");
            checkDepth(child, depth + 1);
          }
        }
      }
      checkDepth(nextState, 0);
      if (Buffer.byteLength(JSON.stringify(nextState), "utf8") > 64 * 1024) throw new ThreadServiceError("THREAD_PAYLOAD_TOO_LARGE");
      const result = { revision: current.stateRevision + 1 };
      const next: ThreadControl = { ...current, revision: current.revision + 1, sharedState: nextState, stateRevision: result.revision, stateUpdatedAt: ports.clock.now(), stateUpdatedBy: actor, receipts: [...current.receipts, { actorKey: key, operation: "state.update", requestId: input.requestId, payloadDigest: fingerprint, result }] };
      const withStateEvent = withEvent(next, { kind: "shared_state_changed", stateRevision: result.revision });
      assertAdmission(withStateEvent);
      await reserve("state.update", input.requestId, input.groupId, fingerprint);
      if (await store.compareAndSetControl(input.groupId, current.revision, withStateEvent)) {
        await persistEvent(withStateEvent, function stateEvent(event) { return event.kind === "shared_state_changed" && event.stateRevision === result.revision; });
        return result;
      }
    }
    throw new ThreadServiceError("THREAD_STATE_CONFLICT");
  }

  /**
   * 子会话回报一条进展摘要：只写结论与证据引用，不触发任何执行。
   * 人类与宿主 actor 不能写；`threadId` 取 actor，模型不能自报来源。
   */
  async function recordProgress(input: { groupId: string; requestId: string; kind: ThreadProgressKind; summary: string; evidence?: { turnId?: string; messageId?: string } }): Promise<{ progressSeq: number; taskId: string; taskProgressSeq: number }> {
    if (actor.kind !== "thread") throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    requireId(input.requestId);
    if (!PROGRESS_KINDS.includes(input.kind)) throw new ThreadServiceError("INVALID_INPUT");
    if (typeof input.summary !== "string" || !input.summary.trim()) throw new ThreadServiceError("INVALID_INPUT");
    // 超限拒绝而不是截断：被截断的摘要不能假称完整。
    if (Buffer.byteLength(input.summary, "utf8") > PROGRESS_SUMMARY_BYTES) throw new ThreadServiceError("THREAD_PAYLOAD_TOO_LARGE");
    let evidence: { turnId?: string; messageId?: string } | undefined;
    if (input.evidence && (input.evidence.turnId !== undefined || input.evidence.messageId !== undefined)) {
      if (input.evidence.turnId !== undefined) requireId(input.evidence.turnId);
      if (input.evidence.messageId !== undefined) requireId(input.evidence.messageId);
      evidence = { ...(input.evidence.turnId ? { turnId: input.evidence.turnId } : {}), ...(input.evidence.messageId ? { messageId: input.evidence.messageId } : {}) };
    }
    const taskGroup = await authorize(input.groupId);
    const taskId = await currentThreadTaskId(ports, taskGroup, actor.threadId, actor.turnId);
    if (!taskId) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    const progressKey = threadTaskProgressKey(actor.threadId, taskId);
    const fingerprint = digest([actor.threadId, actor.turnId, taskId, input.kind, input.summary, evidence ?? null]);
    for (let n = 0; n < 32; n++) {
      const current = await authorize(input.groupId);
      if (await currentThreadTaskId(ports, current, actor.threadId, actor.turnId) !== taskId) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      await verifyRequest("progress", input.requestId, input.groupId, fingerprint);
      const prior = current.receipts.find(function match(item) { return item.actorKey === key && item.operation === "progress" && item.requestId === input.requestId; });
      if (prior) {
        if (prior.payloadDigest !== fingerprint) throw new ThreadServiceError("THREAD_REQUEST_CONFLICT");
        await reserve("progress", input.requestId, input.groupId, fingerprint);
        return prior.result as { progressSeq: number; taskId: string; taskProgressSeq: number };
      }
      // 证据只能是当前报告 Turn 或本次 run 消息；不接受的引用按越权处理。
      if (evidence?.turnId) {
        const turn = await ports.turnStore.get(evidence.turnId);
        if (!turn || turn.sessionId !== actor.threadId || evidence.turnId !== actor.turnId) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      }
      if (evidence?.messageId && evidence.messageId !== taskId) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      const seq = nextProgressSeqOf(current, actor.threadId);
      const entries = appendProgress(current.progress ?? [], { threadId: actor.threadId, taskId, turnId: actor.turnId, taskProgressSeq: nextProgressSeqOf(current, progressKey), progressSeq: seq, kind: input.kind, summary: input.summary, createdAt: ports.clock.now(), ...(evidence ? { evidence } : {}) });
      if (!entries) throw new ThreadServiceError("THREAD_STORAGE_FULL");
      const result = { progressSeq: seq, taskId, taskProgressSeq: nextProgressSeqOf(current, progressKey) };
      const next: ThreadControl = { ...current, revision: current.revision + 1, progress: entries, nextProgressSeq: { ...(current.nextProgressSeq ?? {}), [actor.threadId]: seq + 1, [progressKey]: nextProgressSeqOf(current, progressKey) + 1 }, receipts: [...current.receipts, { actorKey: key, operation: "progress", requestId: input.requestId, payloadDigest: fingerprint, result }] };
      assertAdmission(next);
      await reserve("progress", input.requestId, input.groupId, fingerprint);
      if (await store.compareAndSetControl(input.groupId, current.revision, next)) return result;
    }
    throw new ThreadServiceError("THREAD_STATE_CONFLICT");
  }

  /**
   * 按游标读取进展摘要：连续普通进度合并为一条，关键条目逐条保留。
   * 读取不启动、不恢复、不确认已读；被容量淘汰的条目只以计数说明。
   */
  async function readProgress(input: { groupId: string; threadId: string; taskId?: string; cursor?: string; limit?: number; kinds?: ThreadProgressKind[] }) {
    const current = await authorize(input.groupId, { readOnly: true });
    if (!current.members.some(function target(item) { return item.threadId === input.threadId; })) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > PROGRESS_PAGE_MAX) throw new ThreadServiceError("INVALID_INPUT");
    const kinds = input.kinds === undefined ? undefined : new Set(input.kinds);
    if (kinds && (kinds.size === 0 || [...kinds].some(function known(kind) { return !PROGRESS_KINDS.includes(kind); }))) throw new ThreadServiceError("INVALID_INPUT");
    if (input.taskId !== undefined) requireId(input.taskId);
    if (input.taskId !== undefined && !await readThreadTask(ports, current, input.threadId, input.taskId)) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    const end = nextProgressSeqOf(current, input.taskId ? threadTaskProgressKey(input.threadId, input.taskId) : input.threadId);
    let seq = 1;
    if (input.cursor) {
      try {
        const data = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as { v: number; schema: number; view: string; stateRootId: string; workspaceId: string; groupId: string; threadId: string; taskId?: string; seq: number };
        if (data.v !== 1 || data.schema !== 8 || data.view !== "progress" || data.stateRootId !== context.stateRootId || data.workspaceId !== context.workspaceId || data.groupId !== input.groupId || data.threadId !== input.threadId || data.taskId !== input.taskId || !Number.isSafeInteger(data.seq) || data.seq < 1) throw new Error("cursor");
        seq = data.seq;
      } catch { throw new ThreadServiceError("THREAD_CURSOR_INVALID"); }
    }
    if (seq > end) throw new ThreadServiceError("THREAD_CURSOR_INVALID");
    const retained = (current.progress ?? []).filter(function own(item) { return item.threadId === input.threadId && (!input.taskId || (item.taskId === input.taskId && Number.isSafeInteger(item.taskProgressSeq))); }).map(function view(item) { return input.taskId ? { ...item, progressSeq: item.taskProgressSeq! } : item; }).filter(function unread(item) { return item.progressSeq >= seq; }).sort(function bySeq(left, right) { return left.progressSeq - right.progressSeq; });
    // 游标之前的淘汰只报告条数，不补写内容，也不把丢弃说成未发生。
    const compacted = (retained.length ? retained[0]!.progressSeq : end) - seq;
    const items: ThreadProgressView[] = [];
    let consumed = Math.max(seq, retained[0]?.progressSeq ?? end) - 1;
    for (const entry of retained) {
      // 被过滤的类别仍然推进游标：过滤是汇报策略，不是未读。
      if (kinds && !kinds.has(entry.kind)) { consumed = entry.progressSeq; continue; }
      const previous = items[items.length - 1];
      // 连续普通进度合并为一条：摘要取最新，条数只做计数，不拼接原文。
      if (entry.kind === "progress" && previous?.kind === "progress" && previous.taskId === entry.taskId && previous.turnId === entry.turnId) {
        previous.summary = entry.summary;
        previous.progressSeq = entry.progressSeq;
        previous.createdAt = entry.createdAt;
        previous.mergedCount += 1;
        if (entry.evidence) previous.evidence = entry.evidence;
        consumed = entry.progressSeq;
        continue;
      }
      if (items.length >= limit) break;
      items.push({ threadId: entry.threadId, taskId: entry.taskId, turnId: entry.turnId, kind: entry.kind, summary: entry.summary, progressSeq: entry.progressSeq, mergedCount: 1, createdAt: entry.createdAt, ...(entry.evidence ? { evidence: entry.evidence } : {}) });
      consumed = entry.progressSeq;
    }
    const cursor = writeProgressCursor(input.groupId, input.threadId, consumed + 1, input.taskId);
    return { items, cursor, compacted, ...(consumed + 1 < end ? { nextCursor: cursor } : {}) };
  }

  /**
   * 组装交接 Prompt：首行固定为 `# Handoff：<标题>`，其后是接续指令、文档相对路径、
   * 来源/目标不透明身份与同一份已规范化摘要。文件与 Prompt 使用同一个 summary，不各自生成。
   */
  function composeHandoffPrompt(input: { title: string; instruction: string; markdown: string; ref: ThreadHandoffRef; targetThreadId: string }): string {
    const from = actor.kind === "thread" ? `thread:${actor.threadId}` : "human";
    return [
      `# Handoff：${input.title}`,
      "",
      input.instruction,
      "",
      `交接文档：${input.ref.relativePath}`,
      `来源：${from}`,
      `目标：${input.targetThreadId}`,
      `交接摘要 sha256：${input.ref.sha256}`,
      "",
      "交接摘要：",
      input.markdown,
    ].join("\n");
  }

  /** 先原子写入交接文档再接受消息；写入失败、越界或内容冲突都不降级成普通发送。 */
  async function writeHandoffDocument(input: { handoffId: string; title: string; markdown: string }): Promise<ThreadHandoffRef> {
    const writer = context.handoff;
    if (!writer) throw new ThreadServiceError("THREAD_HANDOFF_UNAVAILABLE");
    let document;
    try {
      document = await writer.write({ workspaceId: context.workspaceId, handoffId: input.handoffId, title: input.title, markdown: input.markdown });
    } catch (error) {
      if (error instanceof ThreadServiceError) throw error;
      if (error instanceof Error && error.message === "THREAD_HANDOFF_CONFLICT") throw new ThreadServiceError("THREAD_HANDOFF_CONFLICT");
      throw new ThreadServiceError("THREAD_HANDOFF_WRITE_FAILED");
    }
    // 宿主只能返回固定目录下的固定文件名，避免把消息指向授权范围外的位置。
    const expectedPath = `.autopilot/thread-passdown-${input.handoffId}.md`;
    if (!document || document.handoffId !== input.handoffId || document.relativePath !== expectedPath || typeof document.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(document.sha256)) {
      throw new ThreadServiceError("THREAD_HANDOFF_WRITE_FAILED");
    }
    return { handoffId: document.handoffId, relativePath: document.relativePath, sha256: document.sha256 };
  }

  /** 父会话省略mode时按目标当前状态冻结投递决策；重试先复用原意图，不重新选择Turn或启动新执行。 */
  async function send(input: { reportingAgreement?: { taskId: string; explicit: boolean }; groupId: string; threadId: string; requestId: string; mode?: "notify" | "run" | "steer"; content: string; replyTo?: string; expectedTurnId?: string; handoff?: ThreadHandoffInput }): Promise<{ messageId: string; mode: ThreadMessage["mode"]; expectedTurnId?: string; taskId?: string; deliverySeq: number; deliveryStatus: "pending"; handoffRef?: ThreadHandoffRef }> {
    input = { ...input };
    requireId(input.requestId); requireId(input.threadId);
    if (input.reportingAgreement) {
      requireId(input.reportingAgreement.taskId);
      if (actor.kind !== "thread" || input.mode !== "steer" || input.handoff || input.replyTo || typeof input.reportingAgreement.explicit !== "boolean") throw new ThreadServiceError("INVALID_INPUT");
    }
    if ((input.mode !== undefined && !["notify", "run", "steer"].includes(input.mode)) || typeof input.content !== "string" || !input.content) throw new ThreadServiceError("INVALID_INPUT");
    if (input.replyTo !== undefined) requireId(input.replyTo);
    if (input.mode === "steer") { if (!input.expectedTurnId) throw new ThreadServiceError("INVALID_INPUT"); requireId(input.expectedTurnId); }
    else if (input.expectedTurnId !== undefined) throw new ThreadServiceError("INVALID_INPUT");
    // 显式交接只允许 run；notify/steer 携带 handoff 直接拒绝，原三种模式语义不变。
    let handoffTitle: string | undefined;
    let handoffMarkdown: string | undefined;
    if (input.handoff !== undefined) {
      if (input.mode !== "run") throw new ThreadServiceError("INVALID_INPUT");
      handoffTitle = requireHandoffTitle(input.handoff.title);
      handoffMarkdown = requireHandoffMarkdown(input.handoff.markdown);
      // 写入前的上限预检，避免先落盘再因正文超限拒绝。
      if (Buffer.byteLength(input.content, "utf8") + Buffer.byteLength(handoffMarkdown, "utf8") + 1024 > 32 * 1024) throw new ThreadServiceError("THREAD_PAYLOAD_TOO_LARGE");
    }
    let content = input.content;
    let handoffRef: ThreadHandoffRef | undefined;
    if (handoffTitle !== undefined && handoffMarkdown !== undefined) {
      // 先由规范化内容推导引用与幂等摘要，完成容量及冲突检查后才允许写文件。
      const control = await authorize(input.groupId);
      if (!control.members.some(function target(item) { return item.threadId === input.threadId; })) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      if (input.replyTo && !control.messageIntents.some(function reply(item) { return item.message.messageId === input.replyTo; })) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      const relativePath = threadHandoffPath(context.workspaceId, actor, input.requestId);
      const handoffId = relativePath.slice(".autopilot/thread-passdown-".length, -3);
      handoffRef = { handoffId, relativePath, sha256: createHash("sha256").update(`# Handoff：${handoffTitle}\n\n${handoffMarkdown}\n`, "utf8").digest("hex") };
      content = composeHandoffPrompt({ title: handoffTitle, instruction: input.content, markdown: handoffMarkdown, ref: handoffRef, targetThreadId: input.threadId });
      if (Buffer.byteLength(content, "utf8") > 32 * 1024) throw new ThreadServiceError("THREAD_PAYLOAD_TOO_LARGE");
      const prospectiveFingerprint = digest([input.threadId, input.mode, content, input.replyTo ?? null, input.expectedTurnId ?? null]);
      await verifyRequest("send", input.requestId, input.groupId, prospectiveFingerprint);
      const previous = control.messageIntents.find(function match(item) { return item.actorKey === key && item.message.requestId === input.requestId; });
      if (previous && previous.payloadDigest !== prospectiveFingerprint) throw new ThreadServiceError("THREAD_REQUEST_CONFLICT");
      if (!previous) {
        const pendingBytes = control.messageIntents.reduce(function total(sum, item) { return sum + Buffer.byteLength(item.message.content, "utf8"); }, 0);
        if (pendingBytes + Buffer.byteLength(content, "utf8") > 3 * 1024 * 1024) throw new ThreadServiceError("THREAD_STORAGE_FULL");
        const seq = Object.prototype.hasOwnProperty.call(control.nextDeliverySeq, input.threadId) ? control.nextDeliverySeq[input.threadId] : 1;
        const message: ThreadMessage = { messageId: randomUUID(), requestId: input.requestId, groupId: input.groupId, from: actor, toThreadId: input.threadId, mode: "run", content, replyTo: input.replyTo, expectedTurnId: input.expectedTurnId, handoff: handoffRef, handoffDisplay: { title: handoffTitle, instruction: input.content, summary: handoffMarkdown }, createdAt: ports.clock.now(), deliverySeq: seq, deliveryStatus: "pending" };
        const delivery: ThreadDelivery = { executionHost: control.members.find(function target(item) { return item.threadId === input.threadId; })?.executionHost, messageId: message.messageId, threadId: input.threadId, deliverySeq: seq, mode: "run", status: "pending", attempts: 0, updatedAt: message.createdAt };
        assertAdmission({ ...control, revision: control.revision + 1, nextDeliverySeq: { ...control.nextDeliverySeq, [input.threadId]: seq + 1 }, messageIntents: [...control.messageIntents, { actorKey: key, payloadDigest: prospectiveFingerprint, message, committed: false }], deliveries: [...control.deliveries, delivery] });
      }
      // 写入前原子占用幂等域，避免其他组或不同内容在预检与落盘之间竞争同一文件身份。
      await reserve("send", input.requestId, input.groupId, prospectiveFingerprint);
      // 已接受消息以持久快照为准；文件被删除或改动也不能在重试时重写或替换快照。
      if (!previous?.committed) {
        const written = await writeHandoffDocument({ handoffId, title: handoffTitle, markdown: handoffMarkdown });
        if (written.sha256 !== handoffRef.sha256) throw new ThreadServiceError("THREAD_HANDOFF_WRITE_FAILED");
      }
    }
    if (Buffer.byteLength(content, "utf8") > 32 * 1024) throw new ThreadServiceError("THREAD_PAYLOAD_TOO_LARGE");
    // 原始省略语义以null进入摘要；解析出的mode/expectedTurn保存在首个持久消息，不随目标状态重算。
    let fingerprint = digest([input.threadId, input.mode ?? null, content, input.replyTo ?? null, input.expectedTurnId ?? null]);
    let intent: ThreadControl["messageIntents"][number] | undefined;
    for (let n = 0; n < 32; n++) {
      const current = await authorize(input.groupId);
      if (!current.members.some(function target(item) { return item.threadId === input.threadId; })) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      if (input.replyTo && !current.messageIntents.some(function reply(item) { return item.message.messageId === input.replyTo; })) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      if (input.reportingAgreement) {
        const task = await readThreadTask(ports, current, input.threadId, input.reportingAgreement.taskId);
        if (!task || task.turnId !== input.expectedTurnId) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
        const previous = current.messageIntents.filter(function agreement(item) { return item.actorKey === key && item.message.toThreadId === input.threadId && item.message.purpose?.kind === "reporting_agreement" && item.message.purpose.taskId === input.reportingAgreement!.taskId; }).at(-1);
        // 同任务没有新约定时沿用已有值；失败重试复用未提交意图，跨父Turn也不重投默认约定。
        if (previous && (!input.reportingAgreement.explicit || previous.message.content === content)) {
          input.requestId = previous.message.requestId;
          content = previous.message.content;
          fingerprint = previous.payloadDigest;
        } else {
          input.requestId = `agreement-${digest([input.groupId, input.threadId, input.reportingAgreement.taskId, previous?.message.messageId ?? null, content])}`;
          fingerprint = digest([input.threadId, input.mode, content, input.expectedTurnId, input.reportingAgreement.taskId]);
        }
      }
      await verifyRequest("send", input.requestId, input.groupId, fingerprint);
      intent = current.messageIntents.find(function match(item) { return item.actorKey === key && item.message.requestId === input.requestId; });
      if (intent) { if (intent.payloadDigest !== fingerprint) throw new ThreadServiceError("THREAD_REQUEST_CONFLICT"); await reserve("send", input.requestId, input.groupId, fingerprint); break; }
      let mode = input.mode;
      let expectedTurnId = input.expectedTurnId;
      if (mode === undefined) {
        if (actor.kind !== "thread" || !current.members.some(function ownChild(member) { return member.threadId === input.threadId && member.parentThreadId === actor.threadId; })) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
        const target = await ports.sessionStore.get(input.threadId);
        if (!target || !["idle", "completed", "failed", "running"].includes(target.status)) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
        mode = target.status === "running" ? "steer" : "run";
        expectedTurnId = mode === "steer" ? target.activeTurnId : undefined;
      }
      if (mode === "steer") {
        const target = await ports.sessionStore.get(input.threadId);
        if (!target || target.status === "waiting_approval" || target.status === "waiting_user_input" || target.status === "interrupted") throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
        if (target.status !== "running" || !target.activeTurnId) throw new ThreadServiceError("THREAD_NOT_RUNNING");
        if (target.activeTurnId !== expectedTurnId) throw new ThreadServiceError("THREAD_TURN_MISMATCH");
        const turn = await ports.turnStore.get(expectedTurnId!);
        if (!turn || turn.sessionId !== input.threadId || turn.status !== "running") throw new ThreadServiceError("THREAD_NOT_RUNNING");
      }
      const pendingBytes = current.messageIntents.reduce(function total(sum, item) { return sum + Buffer.byteLength(item.message.content, "utf8"); }, 0);
      if (pendingBytes + Buffer.byteLength(content, "utf8") > 3 * 1024 * 1024) throw new ThreadServiceError("THREAD_STORAGE_FULL");
      const seq = Object.prototype.hasOwnProperty.call(current.nextDeliverySeq, input.threadId) ? current.nextDeliverySeq[input.threadId] : 1;
      const message: ThreadMessage = { messageId: randomUUID(), requestId: input.requestId, groupId: input.groupId, from: actor, toThreadId: input.threadId, mode, content, ...(input.reportingAgreement ? { purpose: { kind: "reporting_agreement" as const, taskId: input.reportingAgreement.taskId } } : {}), replyTo: input.replyTo, expectedTurnId, ...(handoffRef && handoffTitle !== undefined && handoffMarkdown !== undefined ? { handoff: handoffRef, handoffDisplay: { title: handoffTitle, instruction: input.content, summary: handoffMarkdown } } : {}), createdAt: ports.clock.now(), deliverySeq: seq, deliveryStatus: "pending" };
      intent = { actorKey: key, payloadDigest: fingerprint, message, committed: false };
      const delivery: ThreadDelivery = { executionHost: current.members.find(function target(item) { return item.threadId === input.threadId; })?.executionHost, messageId: message.messageId, threadId: input.threadId, deliverySeq: seq, mode, status: "pending", attempts: 0, updatedAt: message.createdAt };
      const next: ThreadControl = { ...current, revision: current.revision + 1, nextDeliverySeq: { ...current.nextDeliverySeq, [input.threadId]: seq + 1 }, messageIntents: [...current.messageIntents, intent], deliveries: [...current.deliveries, delivery] };
      assertAdmission(next);
      await reserve("send", input.requestId, input.groupId, fingerprint);
      if (await store.compareAndSetControl(input.groupId, current.revision, next)) break;
      intent = undefined;
    }
    if (!intent) throw new ThreadServiceError("THREAD_STATE_CONFLICT");
    await store.writeMessage(intent.message);
    // receipt 与返回值都复用已持久化的交接引用，重试不会换入最新文件身份。
    const result = { messageId: intent.message.messageId, mode: intent.message.mode, ...(intent.message.expectedTurnId ? { expectedTurnId: intent.message.expectedTurnId } : {}), ...(intent.message.mode === "run" ? { taskId: intent.message.messageId } : {}), deliverySeq: intent.message.deliverySeq, deliveryStatus: "pending" as const, ...(intent.message.handoff ? { handoffRef: intent.message.handoff } : {}) };
    for (let n = 0; n < 32; n++) {
      const current = await authorize(input.groupId);
      const found = current.messageIntents.find(function match(item) { return item.actorKey === key && item.message.requestId === input.requestId; });
      if (!found || found.payloadDigest !== fingerprint || found.message.messageId !== intent.message.messageId) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      if (found.committed) {
        await persistEvent(current, function messageEvent(event) { return event.kind === "message_accepted" && event.messageId === result.messageId; });
        return result;
      }
      const next: ThreadControl = { ...current, revision: current.revision + 1, messageIntents: current.messageIntents.map(function finish(item) { return item === found ? { ...item, committed: true } : item; }), receipts: [...current.receipts, { actorKey: key, operation: "send", requestId: input.requestId, payloadDigest: fingerprint, result }] };
      const withMessageEvent = withEvent(next, { kind: "message_accepted", threadId: input.threadId, messageId: result.messageId }, intent.message.from);
      if (await store.compareAndSetControl(input.groupId, current.revision, withMessageEvent)) {
        await persistEvent(withMessageEvent, function messageEvent(event) { return event.kind === "message_accepted" && event.messageId === result.messageId; });
        return result;
      }
    }
    throw new ThreadServiceError("THREAD_STATE_CONFLICT");
  }

  /** 只投影已桥接消息的精确Inbox事实；交付/执行不是消费，错身份或blocked不报告consumed。 */
  function projectInputState(message: ThreadMessage, delivery: ThreadDelivery | undefined, inputs: readonly InboxInput[]): { inputId: string; turnId: string; status: InboxInput["status"] } | undefined {
    if (delivery?.status !== "delivered" || !delivery.inputId || !delivery.turnId) return undefined;
    const input = inputs.find(function exactInput(item) { return item.inputId === delivery.inputId && item.sessionId === message.toThreadId && item.clientMessageId === message.messageId && item.turnId === delivery.turnId && item.delivery === "steer"; });
    if (!input?.turnId || (message.mode === "steer" && input.turnId !== message.expectedTurnId)) return undefined;
    return { inputId: input.inputId, turnId: input.turnId, status: input.status };
  }

  /** 只按序读取受限条数；未提交或缺失的意图必须显式恢复，消费状态仅来自精确Inbox记录。 */
  async function listMessages(input: { groupId: string; threadId: string; cursor?: string; limit?: number }) {
    const current = await authorize(input.groupId, { readOnly: true });
    if (!current.members.some(function target(item) { return item.threadId === input.threadId; })) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ThreadServiceError("INVALID_INPUT");
    let seq = 1;
    if (input.cursor) {
      try {
        const data = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as { v: number; schema: number; view: string; stateRootId: string; workspaceId: string; groupId: string; threadId: string; taskId?: string; seq: number };
        if (data.v !== 1 || data.schema !== 8 || data.view !== "messages" || data.stateRootId !== context.stateRootId || data.workspaceId !== context.workspaceId || data.groupId !== input.groupId || data.threadId !== input.threadId || !Number.isSafeInteger(data.seq) || data.seq < 1) throw new Error("cursor");
        seq = data.seq;
      } catch { throw new ThreadServiceError("THREAD_CURSOR_INVALID"); }
    }
    const end = Object.prototype.hasOwnProperty.call(current.nextDeliverySeq, input.threadId) ? current.nextDeliverySeq[input.threadId] : 1;
    if (seq > end) throw new ThreadServiceError("THREAD_CURSOR_INVALID");
    const items: Array<ThreadMessage & { deliveryReason?: import("../domain/thread-collaboration").ThreadDeliveryReason; inputState?: ReturnType<typeof projectInputState> }> = [];
    const inputs = current.deliveries.some(function bridged(item) { return item.threadId === input.threadId && item.status === "delivered" && item.inputId; }) ? await ports.inputInbox.list({ sessionId: input.threadId }) : [];
    while (seq < end && items.length < limit) {
      const intent = current.messageIntents.find(function match(item) { return item.message.toThreadId === input.threadId && item.message.deliverySeq === seq; });
      if (!intent?.committed) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      const item = await store.readMessage(input.groupId, input.threadId, seq);
      if (!item || item.messageId !== intent.message.messageId) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      // 正文不可变，交付状态另存；读取时投影交付事实，避免把“已接受”写成“已送达”。
      const delivery = current.deliveries.find(function matchDelivery(record) { return record.messageId === item.messageId; });
      const inputState = projectInputState(item, delivery, inputs);
      items.push(delivery
        ? { ...item, deliveryStatus: delivery.status, ...(delivery.reason ? { deliveryReason: delivery.reason } : {}), ...(delivery.inputId ? { inputId: delivery.inputId } : {}), ...(delivery.turnId ? { turnId: delivery.turnId } : {}), ...(inputState ? { inputState } : {}) }
        : item);
      seq++;
    }
    const cursor = Buffer.from(JSON.stringify({ v: 1, schema: 8, view: "messages", stateRootId: context.stateRootId, workspaceId: context.workspaceId, groupId: input.groupId, threadId: input.threadId, seq })).toString("base64url");
    return { items, cursor, ...(seq < end ? { nextCursor: cursor } : {}) };
  }

  /** 安全摘要与 Transcript 元数据页；对外游标绑定授权域和视图。 */
  async function readThread(input: { groupId: string; threadId: string; cursor?: string; limit?: number }) {
    const current = await authorize(input.groupId, { readOnly: true });
    if (!current.members.some(function member(item) { return item.threadId === input.threadId; })) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ThreadServiceError("INVALID_INPUT");
    let inner: string | undefined;
    if (input.cursor) {
      try {
        const data = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as { version: number; schema: number; view: string; workspaceId: string; stateRootId: string; groupId: string; threadId: string; inner: string };
        if (data.version !== 1 || data.schema !== 8 || data.view !== "transcript" || data.workspaceId !== context.workspaceId || data.stateRootId !== context.stateRootId || data.groupId !== input.groupId || data.threadId !== input.threadId || typeof data.inner !== "string") throw new Error();
        inner = data.inner;
      } catch { throw new ThreadServiceError("THREAD_CURSOR_INVALID"); }
    }
    const session = await ports.sessionStore.get(input.threadId);
    if (!session || session.projectId !== context.projectId || session.productMode !== "work") throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    const latestTurn = await ports.turnStore.getLatest(input.threadId);
    const latestMessages = (session.presentation?.messages ?? []).filter(function assistant(item) { return item.role === "assistant"; }).slice(-20).map(function safeAssistant(item) {
      if (typeof item.content !== "string" || Buffer.byteLength(item.content, "utf8") > 32 * 1024) throw new ThreadServiceError("THREAD_PAYLOAD_TOO_LARGE");
      return { id: item.id, role: "assistant" as const, content: item.content, turnId: item.turnId, createdAt: item.createdAt };
    });
    if (Buffer.byteLength(JSON.stringify(latestMessages), "utf8") > 1024 * 1024) throw new ThreadServiceError("THREAD_PAYLOAD_TOO_LARGE");
    const page = await ports.transcriptStore.readPage(input.threadId, { cursor: inner, limit });
    const nextCursor = page.nextCursor ? Buffer.from(JSON.stringify({ version: 1, schema: 8, view: "transcript", workspaceId: context.workspaceId, stateRootId: context.stateRootId, groupId: input.groupId, threadId: input.threadId, inner: page.nextCursor })).toString("base64url") : undefined;
    /** 仅投影助手文字及其重置语义，不返回工具参数、结果、审批或 checkpoint。 */
    const history = page.items.map(function safeMetadata(item) {
      const event = item.event;
      const content = event.type === "answer_delta" ? event.delta : undefined;
      if (content !== undefined && (typeof content !== "string" || Buffer.byteLength(content, "utf8") > 32 * 1024)) throw new ThreadServiceError("THREAD_PAYLOAD_TOO_LARGE");
      return { seq: item.seq, turnId: item.turnId, timestamp: item.timestamp, type: event.type, ...(content !== undefined ? { content } : {}) };
    });
    if (Buffer.byteLength(JSON.stringify(history), "utf8") > 1024 * 1024) throw new ThreadServiceError("THREAD_PAYLOAD_TOO_LARGE");
    return { thread: { threadId: session.id, title: session.title, status: session.status, activeTurnId: session.activeTurnId }, ...(latestTurn ? { turn: { turnId: latestTurn.id, status: latestTurn.status } } : {}), latestMessages, history, ...(nextCursor ? { nextCursor } : {}) };
  }

  /** 按 groupSeq 只读事件页；丢失记录时显式要求恢复，不补写。 */
  async function listEvents(input: { groupId: string; cursor?: string; limit?: number }) {
    const current = await authorize(input.groupId, { readOnly: true });
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ThreadServiceError("INVALID_INPUT");
    let seq = 1;
    if (input.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
        if (cursor.v !== 1 || cursor.schema !== 8 || cursor.view !== "events" || cursor.stateRootId !== context.stateRootId || cursor.workspaceId !== context.workspaceId || cursor.groupId !== input.groupId || !Number.isSafeInteger(cursor.seq) || cursor.seq < 1) throw new Error();
        seq = cursor.seq;
      } catch { throw new ThreadServiceError("THREAD_CURSOR_INVALID"); }
    }
    if (seq > current.nextGroupSeq) throw new ThreadServiceError("THREAD_CURSOR_INVALID");
    const items: ThreadEvent[] = [];
    while (seq < current.nextGroupSeq && items.length < limit) {
      const event = await store.readEvent(input.groupId, seq);
      if (!event) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      items.push(event); seq++;
    }
    const cursor = Buffer.from(JSON.stringify({ v: 1, schema: 8, view: "events", stateRootId: context.stateRootId, workspaceId: context.workspaceId, groupId: input.groupId, seq })).toString("base64url");
    return { items, cursor, ...(seq < current.nextGroupSeq ? { nextCursor: cursor } : {}) };
  }

  /** 分页返回本组成员，不枚举整个宿主会话。 */
  async function listThreads(input: { groupId: string; cursor?: string; limit?: number }) {
    const current = await authorize(input.groupId, { readOnly: true });
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ThreadServiceError("INVALID_INPUT");
    let offset = 0;
    if (input.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
        if (cursor.v !== 1 || cursor.schema !== 8 || cursor.view !== "members" || cursor.stateRootId !== context.stateRootId || cursor.workspaceId !== context.workspaceId || cursor.groupId !== input.groupId || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > current.members.length) throw new Error();
        offset = cursor.offset;
      } catch { throw new ThreadServiceError("THREAD_CURSOR_INVALID"); }
    }
    const items = await Promise.all(current.members.slice(offset, offset + limit).map(async function currentTitle(member) {
      const session = ports.sessionStore.getDirectoryEntry ? await ports.sessionStore.getDirectoryEntry(member.threadId) : await ports.sessionStore.get(member.threadId);
      return { ...structuredClone(member), ...(session?.title !== undefined ? { title: session.title } : {}) };
    }));
    offset += items.length;
    const nextCursor = offset < current.members.length ? Buffer.from(JSON.stringify({ v: 1, schema: 8, view: "members", stateRootId: context.stateRootId, workspaceId: context.workspaceId, groupId: input.groupId, offset })).toString("base64url") : undefined;
    return { revision: current.revision, items, ...(nextCursor ? { nextCursor } : {}) };
  }

  /** 返回消息持久回执与交付状态；执行结果只投影真实 Turn，不推断成功。 */
  async function messageStatus(input: { groupId: string; threadId: string; messageId: string }) {
    const current = await authorize(input.groupId, { readOnly: true });
    if (!current.members.some(function member(item) { return item.threadId === input.threadId; })) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    const found = current.messageIntents.find(function match(item) { return item.message.toThreadId === input.threadId && item.message.messageId === input.messageId; });
    if (!found) throw new ThreadServiceError("THREAD_NOT_FOUND");
    const delivery = current.deliveries.find(function match(item) { return item.messageId === input.messageId; });
    const turnId = delivery?.turnId ?? found.message.turnId;
    const turn = turnId ? await ports.turnStore.get(turnId) : null;
    const inputState = projectInputState(found.message, found.committed ? delivery : undefined, delivery?.inputId ? await ports.inputInbox.list({ sessionId: input.threadId }) : []);
    return {
      messageId: found.message.messageId,
      deliverySeq: found.message.deliverySeq,
      deliveryStatus: !found.committed ? "accepted" : delivery?.status ?? found.message.deliveryStatus,
      ...(delivery?.inputId ? { inputId: delivery.inputId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(turn ? { execution: { turnId: turn.id, status: turn.status } } : {}),
      ...(inputState ? { inputState } : {}),
    };
  }

  /** 等待游标绑定工作区、状态根、组与目标，不能跨域复用。 */
  function writeWaitCursor(groupId: string, threadId: string, state: WaitState, taskId?: string): string {
    return Buffer.from(JSON.stringify({ v: 1, schema: 8, view: "wait", stateRootId: context.stateRootId, workspaceId: context.workspaceId, groupId, threadId, taskId, seq: state.seq, progressSeq: state.progressSeq, turnId: state.turnId, turnStatus: state.turnStatus, sessionStatus: state.sessionStatus, deliveryStatus: state.deliveryStatus, attentionEpoch: state.attentionEpoch })).toString("base64url");
  }

  /** 进展游标只编码“下一条未消费序号”，不绑定 Turn 状态，重复读同一游标不会重复返回。 */
  function writeProgressCursor(groupId: string, threadId: string, seq: number, taskId?: string): string {
    return Buffer.from(JSON.stringify({ v: 1, schema: 8, view: "progress", stateRootId: context.stateRootId, workspaceId: context.workspaceId, groupId, threadId, taskId, seq })).toString("base64url");
  }

  /** 解码并校验等待游标；跨组、跨状态根、缺少进展序号或损坏一律拒绝。 */
  function readWaitCursor(groupId: string, threadId: string, cursor: string, taskId?: string): WaitState {
    try {
      const data = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v: number; schema: number; view: string; stateRootId: string; workspaceId: string; groupId: string; threadId: string; taskId?: string; seq: number; progressSeq: number; turnId?: string; turnStatus?: string; sessionStatus: string; deliveryStatus?: string; attentionEpoch?: string };
      if (data.v !== 1 || data.schema !== 8 || data.view !== "wait" || data.stateRootId !== context.stateRootId || data.workspaceId !== context.workspaceId || data.groupId !== groupId || data.threadId !== threadId || data.taskId !== taskId || !Number.isSafeInteger(data.seq) || data.seq < 1 || !Number.isSafeInteger(data.progressSeq) || data.progressSeq < 1 || typeof data.sessionStatus !== "string") throw new Error("cursor");
      return { seq: data.seq, progressSeq: data.progressSeq, turnId: data.turnId, turnStatus: data.turnStatus, sessionStatus: data.sessionStatus, deliveryStatus: data.deliveryStatus, attentionEpoch: typeof data.attentionEpoch === "string" ? data.attentionEpoch : undefined };
    } catch { throw new ThreadServiceError("THREAD_CURSOR_INVALID"); }
  }

  /** 跨进程中断：只持久化给实际 owner 的控制意图，接受命令不等于已停止。 */
  async function interrupt(input: { groupId: string; requestId: string; threadId: string; expectedTurnId: string }): Promise<{ accepted: true; controlId: string; hostOffline: boolean }> {
    requireId(input.requestId); requireId(input.threadId); requireId(input.expectedTurnId);
    const fingerprint = digest([input.threadId, input.expectedTurnId]);
    for (let n = 0; n < 32; n++) {
      const current = await authorize(input.groupId);
      if (!current.members.some(function member(item) { return item.threadId === input.threadId; })) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      await verifyRequest("interrupt", input.requestId, input.groupId, fingerprint);
      const prior = current.receipts.find(function match(item) { return item.actorKey === key && item.operation === "interrupt" && item.requestId === input.requestId; });
      if (prior) {
        if (prior.payloadDigest !== fingerprint) throw new ThreadServiceError("THREAD_REQUEST_CONFLICT");
        await reserve("interrupt", input.requestId, input.groupId, fingerprint);
        const replay = prior.result as { accepted: true; controlId: string; hostOffline: boolean };
        return { ...replay, hostOffline: context.hostOnline === false };
      }
      const session = await ports.sessionStore.get(input.threadId);
      // 需恢复的会话必须先走原恢复流程；审批/用户输入等待没有活动执行体，由 owner 的 turns.cancel 直接收尾。
      if (!session || session.status === "interrupted") throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      if (session.status === "running") {
        if (!session.activeTurnId) throw new ThreadServiceError("THREAD_NOT_RUNNING");
        if (session.activeTurnId !== input.expectedTurnId) throw new ThreadServiceError("THREAD_TURN_MISMATCH");
      } else if (session.status === "waiting_approval" || session.status === "waiting_user_input") {
        const [turn, latest, checkpoint] = await Promise.all([ports.turnStore.get(input.expectedTurnId), ports.turnStore.getLatest(input.threadId), ports.checkpointStore.getLatest(input.threadId)]);
        const checkpointStatus = session.status === "waiting_approval" ? "awaiting_approval" : "awaiting_user_input";
        // 等待态没有执行active ID；必须由三份当前持久事实共同确认精确目标，不能回退到任意最近轮。
        if ((session.activeTurnId && session.activeTurnId !== input.expectedTurnId) || !turn || turn.sessionId !== input.threadId || turn.status !== session.status
          || latest?.id !== input.expectedTurnId || checkpoint?.turnId !== input.expectedTurnId || checkpoint.status !== checkpointStatus) throw new ThreadServiceError("THREAD_TURN_MISMATCH");
      } else throw new ThreadServiceError("THREAD_NOT_RUNNING");
      const now = ports.clock.now();
      const result = { accepted: true as const, controlId: randomUUID(), hostOffline: context.hostOnline === false };
      const next: ThreadControl = {
        ...current,
        revision: current.revision + 1,
        controls: [...current.controls, { controlId: result.controlId, kind: "interrupt", threadId: input.threadId, expectedTurnId: input.expectedTurnId, status: "pending", createdAt: now, updatedAt: now }],
        receipts: [...current.receipts, { actorKey: key, operation: "interrupt", requestId: input.requestId, payloadDigest: fingerprint, result }],
      };
      assertAdmission(next);
      await reserve("interrupt", input.requestId, input.groupId, fingerprint);
      if (await store.compareAndSetControl(input.groupId, current.revision, next)) return result;
    }
    throw new ThreadServiceError("THREAD_STATE_CONFLICT");
  }

  /** 已领取控制仍未证明恢复时提供既有目标 Continue 入口，不自动重放、不宣称已执行。 */
  async function resumeReceipt(groupId: string, threadId: string, result: { accepted: true; controlId: string }): Promise<{ accepted: true; controlId: string; recoveryAction?: "open_target_continue" }> {
    const [control, session] = await Promise.all([store.readControl(groupId), ports.sessionStore.get(threadId)]);
    const intent = control?.controls.find(function same(item) { return item.controlId === result.controlId; });
    return intent?.status === "applied" && session?.status === "interrupted" && !await hasFreshLease(threadId) ? { ...result, recoveryAction: "open_target_continue" } : result;
  }

  /** 精确恢复既有暂停轮：控制按 checkpoint 去重，绝不写入消息、Inbox 或新 Turn。 */
  async function resume(input: { groupId: string; requestId: string; threadId: string; expectedTurnId: string }): Promise<{ accepted: true; controlId: string; recoveryAction?: "open_target_continue" }> {
    requireId(input.requestId); requireId(input.threadId); requireId(input.expectedTurnId);
    const fingerprint = digest([input.threadId, input.expectedTurnId]);
    for (let n = 0; n < 32; n++) {
      const current = await authorize(input.groupId);
      if (!current.members.some(function member(item) { return item.threadId === input.threadId; })) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      await verifyRequest("resume", input.requestId, input.groupId, fingerprint);
      const prior = current.receipts.find(function receipt(item) { return item.actorKey === key && item.operation === "resume" && item.requestId === input.requestId; });
      if (prior) {
        if (prior.payloadDigest !== fingerprint) throw new ThreadServiceError("THREAD_REQUEST_CONFLICT");
        return resumeReceipt(input.groupId, input.threadId, prior.result as { accepted: true; controlId: string });
      }
      const [session, turn, latest, checkpoint] = await Promise.all([ports.sessionStore.get(input.threadId), ports.turnStore.get(input.expectedTurnId), ports.turnStore.getLatest(input.threadId), ports.checkpointStore.getLatest(input.threadId)]);
      if (!session || !turn || turn.sessionId !== input.threadId || latest?.id !== input.expectedTurnId || checkpoint?.turnId !== input.expectedTurnId) throw new ThreadServiceError("THREAD_TURN_MISMATCH");
      const checkpointDigest = digest(checkpoint);
      const existing = current.controls.find(function same(item) { return item.kind === "resume" && item.threadId === input.threadId && item.expectedTurnId === input.expectedTurnId && (item.status === "pending" || (item.status !== "rejected" && item.checkpointDigest === checkpointDigest)); });
      if (existing) return resumeReceipt(input.groupId, input.threadId, { accepted: true, controlId: existing.controlId });
      // 运行中重发只返回已存在的恢复控制；等待审批/回答必须使用目标自己的审批/回答链。
      if (session.status === "running") {
        const running = [...current.controls].reverse().find(function same(item) { return item.kind === "resume" && item.threadId === input.threadId && item.expectedTurnId === input.expectedTurnId && item.status === "applied"; });
        if (running) return { accepted: true, controlId: running.controlId };
      }
      if (session.status !== "interrupted" || turn.status !== "interrupted" || !["interrupted", "interrupted_recoverable", "limit_reached"].includes(checkpoint.status)) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      const now = ports.clock.now();
      const result = { accepted: true as const, controlId: randomUUID() };
      const next: ThreadControl = { ...current, revision: current.revision + 1,
        controls: [...current.controls, { controlId: result.controlId, kind: "resume", checkpointDigest, threadId: input.threadId, expectedTurnId: input.expectedTurnId, status: "pending", createdAt: now, updatedAt: now }],
        receipts: [...current.receipts, { actorKey: key, operation: "resume", requestId: input.requestId, payloadDigest: fingerprint, result }],
      };
      assertAdmission(next);
      await reserve("resume", input.requestId, input.groupId, fingerprint);
      if (await store.compareAndSetControl(input.groupId, current.revision, next)) return result;
    }
    throw new ThreadServiceError("THREAD_STATE_CONFLICT");
  }

  /** 人类决定保存后持久交接原交互，按原请求及暂停checkpoint幂等收敛。 */
  async function continueInteraction(input: { groupId: string; threadId: string; turnId: string; approvalId?: string; requestId?: string }): Promise<{ controlId: string }> {
    if (actor.kind !== "human") throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    requireId(input.threadId); requireId(input.turnId);
    if (Boolean(input.approvalId) === Boolean(input.requestId)) throw new ThreadServiceError("INVALID_INPUT");
    if (input.approvalId) requireId(input.approvalId);
    if (input.requestId) requireId(input.requestId);
    for (let attempt = 0; attempt < 32; attempt++) {
      const current = await authorize(input.groupId);
      if (!current.members.some(function target(item) { return item.threadId === input.threadId; })) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      const prior = current.controls.find(function original(item) { return item.kind === "continue_interaction" && item.threadId === input.threadId && item.expectedTurnId === input.turnId && item.approvalId === input.approvalId && item.requestId === input.requestId; });
      if (prior && prior.status !== "failed") return { controlId: prior.controlId };
      const view = await readTurnExecutionView(ports, { sessionId: input.threadId, turnId: input.turnId });
      const latest = await ports.turnStore.getLatest(input.threadId);
      const checkpoint = await ports.checkpointStore.getLatest(input.threadId);
      const approval = view?.interaction?.approval?.event;
      if (latest?.id !== input.turnId || checkpoint?.turnId !== input.turnId || view?.interaction?.state !== "decided"
        || (input.approvalId ? approval?.type !== "approval_required" || approval.result.approval.approvalId !== input.approvalId : view.interaction.requestId !== input.requestId)) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      if (!await resolveThreadExecutionHost(ports, input.groupId, input.threadId)) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      const checkpointDigest = prior && prior.pauseSeq === undefined ? digest(checkpoint) : interactionCheckpointDigest(checkpoint);
      if (prior && prior.checkpointDigest !== checkpointDigest) throw new ThreadServiceError("THREAD_STATE_CONFLICT");
      // 失败重试必须仍是原暂停，且没有原边界之后的新启动事实；未知旧记录保持人工核对。
      if (prior && (prior.pauseSeq === undefined || prior.failureDiagnostic?.started || (await ports.transcriptStore.getEvents(input.threadId)).some(function started(item) { return item.turnId === input.turnId && item.seq > prior.pauseSeq! && item.event.type === "turn_started"; }))) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      const now = ports.clock.now();
      const intent = { failureDiagnostic: prior?.failureDiagnostic, controlId: prior?.controlId ?? randomUUID(), kind: "continue_interaction" as const, threadId: input.threadId, expectedTurnId: input.turnId, approvalId: input.approvalId, requestId: input.requestId, checkpointDigest, pauseSeq: prior ? prior.pauseSeq : checkpoint.lease?.safeBoundarySeq ?? view.lastSeq, status: "pending" as const, createdAt: prior?.createdAt ?? now, updatedAt: now };
      const next = { ...current, revision: current.revision + 1, controls: prior ? current.controls.map(function retry(item) { return item.controlId === prior.controlId ? intent : item; }) : [...current.controls, intent] };
      assertAdmission(next);
      if (await store.compareAndSetControl(input.groupId, current.revision, next)) return { controlId: intent.controlId };
    }
    throw new ThreadServiceError("THREAD_STATE_CONFLICT");
  }

  /** 读取等待用的组快照；停用或越界不继续等待。 */
  async function waitControl(groupId: string): Promise<ThreadControl> {
    const current = await store.readControl(groupId);
    if (!current || !current.group.enabled || current.group.workspaceId !== context.workspaceId || current.group.projectId !== context.projectId) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    return current;
  }

  /** 以冻结待审批调用/问答身份区分关注代次，不把敏感参数写入游标。 */
  async function attentionEpoch(threadId: string, turnId: string | undefined, status: string | undefined): Promise<string | undefined> {
    if (!turnId || (status !== "waiting_approval" && status !== "waiting_user_input")) return undefined;
    const checkpoint = await ports.checkpointStore.getByTurn(threadId, turnId);
    const fact = await readTurnExecutionView(ports, { sessionId: threadId, turnId });
    return digest([turnId, status, fact?.interaction?.state, fact?.interaction?.continuation?.state, checkpoint?.pendingCalls?.map(function identity(call) { return [call.id, call.name]; }), checkpoint?.pendingUserQuestion?.requestId]);
  }

  /** 目标当前状态；只读，不触发恢复或执行。 */
  async function waitSnapshot(groupId: string, threadId: string, taskId?: string): Promise<WaitSnapshot> {
    const current = await waitControl(groupId);
    const session = await ports.sessionStore.get(threadId);
    if (!session) throw new ThreadServiceError("THREAD_NOT_FOUND");
    if (taskId !== undefined) {
      const task = await readThreadTask(ports, current, threadId, taskId);
      if (!task) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
      const fact = task.turn ? await readTurnExecutionView(ports, { sessionId: threadId, turnId: task.turn.id }) : null;
      const turnStatus = fact ? fact.execution === "unconfirmed" || fact.execution === "lost" ? fact.execution : fact.status : task.turn?.status;
      const progressSeq = nextProgressSeqOf(current, threadTaskProgressKey(threadId, taskId));
      const state: WaitState = { seq: task.delivery.deliverySeq, progressSeq, turnId: task.turn?.id, turnStatus, sessionStatus: turnStatus ?? task.delivery.status, deliveryStatus: task.delivery.status, attentionEpoch: await attentionEpoch(threadId, task.turn?.id, turnStatus) };
      return { state, summary: { taskId, deliveryStatus: task.delivery.status, ...(task.turn ? { turnId: task.turn.id, turnStatus } : {}), ...(fact ? { execution: fact.execution, waiting: fact.waiting, result: fact.result, interactionState: fact.interaction?.state, continuationState: fact.interaction?.continuation?.state, interactionDecision: fact.interaction?.decision, attentionKind: attentionKindOf(fact), unconfirmedReason: fact.unconfirmedReason } : {}), progressCount: progressSeq - 1 } };
    }
    const turn = await ports.turnStore.getLatest(threadId);
    const fact = turn ? await readTurnExecutionView(ports, { sessionId: threadId, turnId: turn.id }) : null;
    const turnStatus = fact ? fact.execution === "unconfirmed" || fact.execution === "lost" ? fact.execution : fact.status : turn?.status;
    const sessionStatus = turnStatus ?? session.status;
    const seq = Object.prototype.hasOwnProperty.call(current.nextDeliverySeq, threadId) ? current.nextDeliverySeq[threadId] : 1;
    const progressSeq = nextProgressSeqOf(current, threadId);
    const last = current.deliveries.filter(function target(item) { return item.threadId === threadId; }).slice(-1)[0];
    const state: WaitState = { seq, progressSeq, turnId: turn?.id, turnStatus, sessionStatus, attentionEpoch: await attentionEpoch(threadId, turn?.id, turnStatus) };
    return {
      state,
      summary: {
        sessionStatus,
        ...(fact ? { execution: fact.execution, waiting: fact.waiting, result: fact.result, interactionState: fact.interaction?.state, continuationState: fact.interaction?.continuation?.state, interactionDecision: fact.interaction?.decision, attentionKind: attentionKindOf(fact), unconfirmedReason: fact.unconfirmedReason } : {}),
        ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}),
        ...(turn ? { turnId: turn.id, turnStatus } : {}),
        messageCount: seq - 1,
        progressCount: progressSeq - 1,
        ...(last ? { lastDeliveryStatus: last.status } : {}),
      },
    };
  }

  /** 等待目标变化：只观察，不启动、不恢复、不取消任何执行；超时或取消只结束本次等待。 */
  async function wait(input: { groupId: string; targets: Array<{ threadId: string; taskId?: string; cursor?: string }>; timeoutMs: number; signal?: AbortSignal }): Promise<WaitResult> {
    const group = await authorize(input.groupId);
    if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 8) throw new ThreadServiceError("INVALID_INPUT");
    if (new Set(input.targets.map(function id(target) { return JSON.stringify([target.threadId, target.taskId ?? null]); })).size !== input.targets.length) throw new ThreadServiceError("INVALID_INPUT");
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > 30_000) throw new ThreadServiceError("INVALID_INPUT");
    for (const target of input.targets) { requireId(target.threadId); if (target.taskId !== undefined) requireId(target.taskId); }
    if (input.targets.some(function member(target) { return !group.members.some(function known(item) { return item.threadId === target.threadId; }); })) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    const cursors = input.targets.map(function decode(target) { return target.cursor ? readWaitCursor(input.groupId, target.threadId, target.cursor, target.taskId) : undefined; });

    /** 组装单目标结果：只给状态身份、原因与待读进展条数，不带任何正文。 */
    function project(target: { threadId: string; taskId?: string }, index: number, snapshot: WaitSnapshot, reason: WaitTargetResult["reason"]): WaitTargetResult {
      const before = cursors[index];
      return {
        threadId: target.threadId,
        ...(target.taskId ? { taskId: target.taskId } : {}),
        reason,
        cursor: writeWaitCursor(input.groupId, target.threadId, snapshot.state, target.taskId),
        pendingProgress: Math.max(0, snapshot.state.progressSeq - (before ? before.progressSeq : 1)),
        summary: snapshot.summary,
      };
    }

    /** 统一读取全部目标；顺序与输入一致，便于按目标配对游标。 */
    async function snapshots(): Promise<WaitSnapshot[]> {
      return await Promise.all(input.targets.map(function load(target) { return waitSnapshot(input.groupId, target.threadId, target.taskId); }));
    }

    /** 观察一次并按需给出返回原因；不带正文，也不确认已读。 */
    async function settle(requested?: "timeout" | "aborted"): Promise<WaitResult> {
      const current = await snapshots();
      const results = input.targets.map(function each(target, index) {
        const reason = requested ?? attentionReason(current[index]!.state) ?? "snapshot";
        return project(target, index, current[index]!, reason);
      });
      return { results, timedOut: requested === "timeout" };
    }

    const deadline = ports.clock.now() + input.timeoutMs;
    const initial = await snapshots();
    /** 立即返回当前快照，不占住执行。 */
    function immediateResult(): WaitResult {
      const results = input.targets.map(function each(target, index) {
        const reason = attentionReason(initial[index]!.state) ?? "snapshot";
        return project(target, index, initial[index]!, reason);
      });
      return { results, timedOut: false };
    }
    // 首次观察和终态立即返回；已消费的相同关注需等待新的事实或审批代次。
    if (input.timeoutMs === 0 || cursors.every(function absent(cursor) { return cursor === undefined; })) return immediateResult();
    if (initial.some(function attention(snapshot, index) { return attentionReason(snapshot.state) === "terminal" || (attentionReason(snapshot.state) === "attention" && (!cursors[index] || stateChanged(cursors[index]!, snapshot.state))); })) return immediateResult();
    // 取消入口：父 Turn 中止时立刻结束等待，不必等下一次轮询。
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<void>(function waitAbort(resolve) {
      if (!input.signal) return;
      onAbort = function abortedSignal() { resolve(); };
      input.signal.addEventListener("abort", onAbort, { once: true });
    });
    // 订阅保持在本次等待全程：写入落在读取前、读取中或等待中，都不会漏掉下一次复读。
    let onWake: (() => void) | undefined;
    const unsubscribe = store.subscribe?.(input.groupId, function wake() { onWake?.(); });
    try {
      while (true) {
        if (input.signal?.aborted) return await settle("aborted");
        if (ports.clock.now() >= deadline) break;
        // 先建立本轮唤醒再复读：读取期间发生的写入也会让下面的等待立刻返回。
        const woken = new Promise<void>(function waitWake(resolve) { onWake = resolve; });
        const current = await snapshots();
        const changed = current.some(function differ(snapshot, index) { return !cursors[index] || stateChanged(cursors[index]!, snapshot.state); });
        if (changed) {
          const results = input.targets.map(function each(target, index) {
            return project(target, index, current[index]!, reasonOf(cursors[index], current[index]!.state));
          });
          return { results, timedOut: false };
        }
        const remaining = deadline - ports.clock.now();
        if (remaining <= 0) break;
        // 进程内唤醒、取消信号与有界轮询（跨进程或存储不支持订阅时的兜底）三者取先到者。
        await Promise.race([woken, aborted, new Promise<void>(function waitTick(resolve) { setTimeout(resolve, Math.min(WAIT_POLL_MS, remaining)); })]);
        onWake = undefined;
      }
    } finally {
      onWake = undefined;
      unsubscribe?.();
      if (onAbort) input.signal?.removeEventListener("abort", onAbort);
    }
    return await settle("timeout");
  }

  /** 按明确发起会话列出有界任务事实；不把组成员后续Session状态投影成原委派。 */
  async function tasks(input: { groupId: string; threadId: string }) {
    const current = await authorize(input.groupId, { readOnly: true });
    if (!current.members.some(function member(item) { return item.threadId === input.threadId; })) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    const accepted = current.messageIntents.filter(function sent(item) { const from = item.message.from; return item.committed && item.message.mode === "run" && from.kind === "thread" && from.threadId === input.threadId; }).slice(-20);
    const items = [];
    for (const intent of accepted) {
      const task = await readThreadTask(ports, current, intent.message.toThreadId, intent.message.messageId);
      if (!task) throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      const target = await ports.sessionStore.get(task.message.toThreadId);
      items.push({ taskId: task.taskId, threadId: task.message.toThreadId, title: target?.title ?? task.message.toThreadId, createdAt: task.message.createdAt, deliveryStatus: task.delivery.status, ...(task.turn ? { turnId: task.turn.id, turnStatus: task.turn.status } : {}) });
    }
    return { items };
  }

  /** 当前阶段的能力与限制，不宣称 Agent 工具或 Web/CLI 入口已经可用。 */
  function capabilities() {
    return {
      protocolVersion: 1 as const,
      operations: ["enable", "disable", "groups", "group.read", "associate", "create", "list", "read", "send", "messageStatus", "state.read", "state.update", "interrupt", "resume", "wait", "events", "progress.report", "progress.read"],
      deliveryModes: ["notify", "run", "steer"],
      // handoff 只是 send 的可选参数，不是独立操作；未装配写入能力时该参数明确不可用。
      handoff: { available: Boolean(context.handoff), modes: ["run"], titleMax: 128, markdownBytes: 16384, relativePath: ".autopilot/thread-passdown-<handoffId>.md" },
      limits: { pageDefault: 20, pageMax: 100, messageBytes: 32768, stateBytes: 65536, stateDepth: 8, controlBytes: 4194304, admissionBytes: 3145728, completionReservePerIntent: 16384, waitTargets: 8, waitTimeoutMs: 30000, progressBytes: PROGRESS_SUMMARY_BYTES, progressEntriesPerThread: PROGRESS_MAX_PER_THREAD, progressPageMax: PROGRESS_PAGE_MAX, progressKinds: [...PROGRESS_KINDS] },
    };
  }

  return { enable, disable, groups, groupOf, associate, bindExecutionHost, continueInteraction, resolveGroup, create, currentGroupId, currentGroupIdOrNull, ensureCurrentGroupForCreate, listThreads, readState, updateState, recordProgress, readProgress, send, messageStatus, interrupt, resume, wait, tasks, listMessages, readThread, listEvents, capabilities };
}

/** 受信宿主绑定后的协作服务。 */
export type ThreadService = ReturnType<typeof createThreadService>;

/** 等待观察的状态集合；只含状态身份与序号，不含消息正文、摘要正文或工具内容。 */
interface WaitState {
  seq: number;
  /** 该目标下一个进展序号；进展写入只改变这一项，不产生投递。 */
  progressSeq: number;
  turnId?: string;
  turnStatus?: string;
  sessionStatus: string;
  deliveryStatus?: string;
  /** 冻结关注调用的摘要；旧游标缺失时首次重新唤醒一次。 */
  attentionEpoch?: string;
}

/** 单个目标的安全摘要与状态。 */
interface WaitSnapshot {
  state: WaitState;
  summary: Record<string, unknown>;
}

/** wait 单目标结果；reason 只描述本次观察为何返回。 */
export interface WaitTargetResult {
  threadId: string;
  taskId?: string;
  reason: "snapshot" | "changed" | "progress" | "attention" | "terminal" | "timeout" | "aborted";
  cursor: string;
  /** 自给定游标以来新写入的进展条数（含已被容量淘汰的条目）；只给计数，不带摘要正文。 */
  pendingProgress: number;
  summary: Record<string, unknown>;
}

/** wait 结果；超时只结束等待，不取消任何目标执行。 */
export interface WaitResult {
  results: WaitTargetResult[];
  timedOut: boolean;
}

/** 进展页条目：连续普通进度已合并，`mergedCount` 表示代表了多少条原始摘要。 */
export interface ThreadProgressView {
  threadId: string;
  taskId?: string;
  turnId?: string;
  kind: ThreadProgressKind;
  summary: string;
  /** 该条目覆盖到的最新进展序号，可直接作为下一次读取的依据。 */
  progressSeq: number;
  /** 合并的原始摘要条数；1 表示单条。 */
  mergedCount: number;
  createdAt: number;
  evidence?: { turnId?: string; messageId?: string };
}

/** 进展类别固定集合；模型只能选择，不能扩展。 */
const PROGRESS_KINDS: readonly ThreadProgressKind[] = ["progress", "milestone", "blocked", "completed", "failed"];

/** 单条摘要最多 2048 字节；超限拒绝，不截断后假称完整。 */
const PROGRESS_SUMMARY_BYTES = 2048;

/** 每目标最多保留 32 条；只淘汰普通进度，关键条目不被合并或丢弃。 */
const PROGRESS_MAX_PER_THREAD = 32;

/** 进展单页最多 50 条，避免一次读取把大量摘要搬进主上下文。 */
const PROGRESS_PAGE_MAX = 50;

/** 读取某目标的下一个进展序号；旧状态根缺该字段时从 1 开始。 */
function nextProgressSeqOf(control: ThreadControl, threadId: string): number {
  return control.nextProgressSeq?.[threadId] ?? 1;
}

/** 追加一条进展，必要时淘汰该目标最旧的普通进度；关键条目占满上限时返回 undefined。 */
function appendProgress(entries: readonly ThreadProgressEntry[], entry: ThreadProgressEntry): ThreadProgressEntry[] | undefined {
  const mine = entries.filter(function own(item) { return item.threadId === entry.threadId; });
  const overflow = mine.length + 1 - PROGRESS_MAX_PER_THREAD;
  if (overflow <= 0) return [...entries, entry];
  const droppable = mine.filter(function ordinary(item) { return item.kind === "progress"; }).slice(0, overflow);
  if (droppable.length < overflow) return undefined;
  const dropped = new Set(droppable.map(function seq(item) { return item.progressSeq; }));
  return [...entries.filter(function keep(item) { return item.threadId !== entry.threadId || !dropped.has(item.progressSeq); }), entry];
}

/** 等待的本地复读间隔；跨进程写入靠复读发现，不依赖推送。 */
const WAIT_POLL_MS = 150;

/** attention只说明需要关注；精确pending交互才代表可处理的人类请求。 */
function attentionKindOf(view: Awaited<ReturnType<typeof readTurnExecutionView>>): string | undefined {
  if (!view) return undefined;
  if (view.execution === "unconfirmed") return "execution_unconfirmed";
  if (view.execution === "lost") return "execution_lost";
  if (view.interaction?.state === "pending") return view.waiting === "approval" ? "approval" : view.waiting === "user_input" ? "user_input" : undefined;
  if (view.interaction?.state === "decided") return view.interaction.continuation?.state === "failed" ? "continuation_failed" : "continuation_pending";
  if (view.interaction) return "interaction_unconfirmed";
  return undefined;
}

/** 目标当前是否需要人工关注：审批、用户输入或失败/中断终态。 */
function attentionReason(state: WaitState): "attention" | "terminal" | undefined {
  if (state.turnStatus === "unconfirmed" || state.turnStatus === "lost") return "attention";
  if (state.deliveryStatus === "failed" || state.deliveryStatus === "cancelled") return "terminal";
  if (state.sessionStatus === "waiting_approval" || state.sessionStatus === "waiting_user_input" || state.turnStatus === "waiting_approval" || state.turnStatus === "waiting_user_input") return "attention";
  if (state.turnStatus === "completed" || state.turnStatus === "failed" || state.turnStatus === "interrupted") return "terminal";
  return undefined;
}

/** 投递、Turn 或 Session 层面的变化；进展序号单独比较，避免把摘要当成会话变化。 */
function stateShifted(before: WaitState, after: WaitState): boolean {
  return before.attentionEpoch !== after.attentionEpoch || before.deliveryStatus !== after.deliveryStatus || before.seq !== after.seq || before.turnId !== after.turnId || before.turnStatus !== after.turnStatus || before.sessionStatus !== after.sessionStatus;
}

/** 目标状态是否相对游标发生变化（含进展）。 */
function stateChanged(before: WaitState, after: WaitState): boolean {
  return stateShifted(before, after) || before.progressSeq !== after.progressSeq;
}

/** 只有进展推进时按 progress 返回：父会话只需读摘要，不必重读会话历史。 */
function progressOnly(before: WaitState | undefined, after: WaitState): boolean {
  return Boolean(before) && before!.progressSeq !== after.progressSeq && !stateShifted(before!, after);
}

/**
 * 单目标返回原因：需关注/终态优先，其次只有进展推进，再次会话层面变化；
 * 本次读取没有变化的目标按 snapshot 返回，避免父会话把它当成会话变化去重读历史。
 */
function reasonOf(before: WaitState | undefined, after: WaitState): WaitTargetResult["reason"] {
  const attention = attentionReason(after);
  if (attention) return attention;
  if (!before) return "snapshot";
  if (progressOnly(before, after)) return "progress";
  return stateShifted(before, after) ? "changed" : "snapshot";
}

/**
 * 会话是否是当前工作区某个启用组的成员。
 * 供 Turn 能力装配按会话注入协作工具；读取失败按“不是成员”处理，不阻断普通 Work Turn。
 */
export async function hasEnabledThreadMembership(
  ports: RuntimePorts,
  capability: { workspaceId: string; projectId: string },
  threadId: string,
): Promise<boolean> {
  try {
    for (const groupId of await ports.threadStore.listGroups()) {
      const control = await ports.threadStore.readControl(groupId);
      if (!control || !control.group.enabled) continue;
      if (control.group.workspaceId !== capability.workspaceId || control.group.projectId !== capability.projectId) continue;
      if (control.members.some(function member(item) { return item.threadId === threadId; })) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 绑定后的公开协议 Facade；每个命令都显式校验协议版本。 */
export function createThreadFacade(ports: RuntimePorts, context: ThreadHostContext, service = createThreadService(ports, ports.threadStore, context)) {
  /** 拒绝不支持的协议版本，不回退或猜测字段。 */
  function version(input: { protocolVersion: number }): void {
    if (input.protocolVersion !== 1) throw new ThreadServiceError("INVALID_INPUT");
  }
  /** 统一映射存储失败，禁止向宿主返回路径或内部异常正文。 */
  async function invoke<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ThreadServiceError) throw error;
      const code = error instanceof Error ? error.message : "";
      if (code === "THREAD_REQUEST_CONFLICT" || code === "THREAD_STORAGE_FULL" || code === "THREAD_PAYLOAD_TOO_LARGE" || code === "THREAD_CURSOR_INVALID" || code === "THREAD_CURSOR_EXPIRED") throw new ThreadServiceError(code);
      if (code === "THREAD_CONTROL_CORRUPTED" || code === "THREAD_EVENT_CORRUPTED" || code === "THREAD_MESSAGE_CORRUPTED" || code === "DURABLE_JSONL_CORRUPTED") throw new ThreadServiceError("THREAD_RECOVERY_REQUIRED");
      throw new ThreadServiceError("THREADS_UNAVAILABLE");
    }
  }
  return {
    async enable(input: Parameters<typeof service.enable>[0] & { protocolVersion: number }) { version(input); const result = await invoke(function call() { return service.enable(input); }); return { protocolVersion: 1 as const, group: result.group }; },
    async disable(input: Parameters<typeof service.disable>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.disable(input); }) }; },
    async groups(input: Parameters<typeof service.groups>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.groups(input); }) }; },
    async groupOf(input: Parameters<typeof service.groupOf>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.groupOf(input); }) }; },
    /** 人类协议显式确认旧目标档位，CAS 版本保证迟到确认不能覆盖新事实。 */
    async bindExecutionHost(input: Parameters<typeof service.bindExecutionHost>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.bindExecutionHost(input); }) }; },
    async associate(input: Parameters<typeof service.associate>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.associate(input); }) }; },
    async create(input: Parameters<typeof service.create>[0] & { protocolVersion: number }) { version(input); const result = await invoke(function call() { return service.create(input); }); return { protocolVersion: 1 as const, ...result, relativeLink: `/chat?mode=work&workspaceId=${encodeURIComponent(context.workspaceId)}&sessionId=${encodeURIComponent(result.threadId)}` }; },
    async list(input: Parameters<typeof service.listThreads>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.listThreads(input); }) }; },
    async read(input: Parameters<typeof service.readThread>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.readThread(input); }) }; },
    async send(input: Omit<Parameters<typeof service.send>[0], "reportingAgreement"> & { protocolVersion: number }) {
      version(input);
      if ("reportingAgreement" in input || "purpose" in input) throw new ThreadServiceError("INVALID_INPUT");
      const result = await invoke(function call() { return service.send(input); });
      // 宿主明确离线时 `run` 只返回 accepted + hostOffline；未知状态不猜测，也不暗示已启动。
      const hostOffline = result.mode === "run" && context.hostOnline === false ? { hostOffline: true as const } : {};
      return { protocolVersion: 1 as const, ...result, ...hostOffline };
    },
    async messageStatus(input: Parameters<typeof service.messageStatus>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.messageStatus(input); }) }; },
    async interrupt(input: Parameters<typeof service.interrupt>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.interrupt(input); }) }; },
    async resume(input: Parameters<typeof service.resume>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.resume(input); }) }; },
    async tasks(input: Parameters<typeof service.tasks>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.tasks(input); }) }; },
    async wait(input: Parameters<typeof service.wait>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.wait(input); }) }; },
    async messages(input: Parameters<typeof service.listMessages>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.listMessages(input); }) }; },
    async readState(input: { protocolVersion: number; groupId: string }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.readState(input.groupId); }) }; },
    async updateState(input: Parameters<typeof service.updateState>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.updateState(input); }) }; },
    async reportProgress(input: Parameters<typeof service.recordProgress>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.recordProgress(input); }) }; },
    async readProgress(input: Parameters<typeof service.readProgress>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.readProgress(input); }) }; },
    async events(input: Parameters<typeof service.listEvents>[0] & { protocolVersion: number }) { version(input); return { protocolVersion: 1 as const, ...await invoke(function call() { return service.listEvents(input); }) }; },
    capabilities(input: { protocolVersion: number }) { version(input); return service.capabilities(); },
  };
}

/** 公开的受信宿主绑定接口。 */
export type ThreadFacade = ReturnType<typeof createThreadFacade>;
