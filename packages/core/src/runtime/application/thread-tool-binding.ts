/**
 * runtime/application/thread-tool-binding.ts — 把当前 Turn 绑定为受信协作来源
 *
 * Agent 工具只能通过本绑定调用协作服务：创建来源与 actor 由绑定提供，模型可选择 groupId 但不能以此取得授权；
 * 每次调用仍由 ThreadService 重新校验组成员、工作区与 Project，注册工具不等于授予权限。
 */

import { createHash } from "node:crypto";
import type { ModelRef, ReasoningEffort } from "../domain/model-ref";
import type { Session, TurnStatus } from "../domain";
import type { ThreadActor, ThreadHandoffInput, ThreadHandoffRef, ThreadMessage, ThreadProgressKind } from "../domain/thread-collaboration";
import type { RuntimePorts } from "../ports";
import type { ThreadsCapability } from "../protocol/threads-capability";
import { createThreadFacade, createThreadService, ThreadServiceError, threadHandoffPath } from "./thread-service";
import type { WaitResult } from "./thread-service";

/** 组成员的安全视图；不暴露组内部存储字段。 */
export interface AgentThreadMemberView {
  threadId: string;
  parentThreadId: string | null;
  title?: string;
  roleLabel?: string;
  createdAt: number;
}

/** 单条协作消息的安全视图；正文与交付状态分开，接受不等于已送达。 */
export interface AgentThreadMessageView {
  messageId: string;
  from: ThreadActor;
  mode: ThreadMessage["mode"];
  content: string;
  replyTo?: string;
  expectedTurnId?: string;
  createdAt: number;
  deliverySeq: number;
  deliveryStatus: ThreadMessage["deliveryStatus"];
  deliveryReason?: import("../domain/thread-collaboration").ThreadDeliveryReason;
  inputId?: string;
  turnId?: string;
  /** 只有交付与持久Inbox的消息/输入/Turn身份一致才有；delivered不等于consumed。 */
  inputState?: { inputId: string; turnId: string; status: "pending" | "claimed" | "consumed" | "cancelled" };
  /** 显式交接的文档引用；普通消息不含。 */
  handoffRef?: ThreadHandoffRef;
}

/** read_thread 的安全结果：会话摘要、最近 Turn、消息页与有界历史。 */
export interface AgentThreadReadResult {
  thread: { threadId: string; title?: string; status: Session["status"]; activeTurnId?: string; relativeLink?: string };
  turn?: { turnId: string; status: TurnStatus };
  latestMessages: Array<{ id: string; role: "assistant"; content: string; turnId?: string; createdAt: number }>;
  messages: AgentThreadMessageView[];
  history: Array<{ seq: number; turnId: string; timestamp: string; type: string; content?: string }>;
  nextCursor?: string;
}

/** read_progress 的单页结果：连续普通进度已合并，不含子会话历史或工具输出。 */
export interface AgentThreadProgressPage {
  items: Array<{
    threadId: string;
    taskId?: string;
    turnId?: string;
    kind: ThreadProgressKind;
    summary: string;
    progressSeq: number;
    mergedCount: number;
    createdAt: number;
    evidence?: { turnId?: string; messageId?: string };
  }>;
  cursor: string;
  /** 游标之前被容量淘汰的条数；只报告数量，不补写内容。 */
  compacted: number;
  nextCursor?: string;
}

/** 当前 Turn 可用的协作操作；显式 groupId 只选择既有授权，来源与 actor 不能自报。 */
export interface AgentThreadsCapability {
  /** 只由可信宿主档位派生，用于模型展示指引，不授予审批权限。 */
  presentationHost?: "web";
  /** 依据本 Turn 的受信身份计算固定交接路径，供既有文件策略检查。 */
  handoffPath(requestId: string): string;
  create(input: { groupId?: string; requestId: string; title?: string; roleLabel?: string; modelRef?: ModelRef; reasoningEffort?: ReasoningEffort }): Promise<{ threadId: string; groupId: string; parentThreadId: string; relativeLink: string }>;
  list(input: { groupId?: string; cursor?: string; limit?: number }): Promise<{ items: AgentThreadMemberView[]; nextCursor?: string }>;
  read(input: { groupId?: string; threadId: string; cursor?: string; limit?: number }): Promise<AgentThreadReadResult>;
  send(input: { reportingAgreement?: { taskId: string; explicit: boolean }; groupId?: string; requestId: string; threadId: string; mode?: ThreadMessage["mode"]; content: string; replyTo?: string; expectedTurnId?: string; handoff?: ThreadHandoffInput }): Promise<{ messageId: string; mode: ThreadMessage["mode"]; expectedTurnId?: string; taskId?: string; deliverySeq: number; deliveryStatus: ThreadMessage["deliveryStatus"]; handoffRef?: ThreadHandoffRef }>;
  wait(input: { groupId?: string; targets: Array<{ threadId: string; taskId?: string; cursor?: string }>; timeoutMs: number; signal?: AbortSignal }): Promise<WaitResult>;
  readState(input?: { groupId?: string }): Promise<{ value: Record<string, unknown>; revision: number; updatedAt: number; updatedBy: ThreadActor }>;
  updateState(input: { groupId?: string; requestId: string; expectedRevision: number; operations: Array<{ op: "set"; key: string; value: unknown } | { op: "remove"; key: string }> }): Promise<{ revision: number }>;
  /** 子会话回报一条进展摘要；来源固定为当前 Turn 的会话，不能代替显式通信。 */
  reportProgress(input: { groupId?: string; requestId: string; kind: ThreadProgressKind; summary: string; evidence?: { turnId?: string; messageId?: string } }): Promise<{ progressSeq: number; taskId: string; taskProgressSeq: number }>;
  /** 读取本组目标的进展摘要页；不启动目标，也不附带会话历史。 */
  readProgress(input: { groupId?: string; threadId: string; taskId?: string; cursor?: string; limit?: number; kinds?: ThreadProgressKind[] }): Promise<AgentThreadProgressPage>;
  resumeConstraint(input: { groupId?: string; threadId: string; expectedTurnId: string }): Promise<string>;
  resume(input: { groupId?: string; requestId: string; threadId: string; expectedTurnId: string }): Promise<{ accepted: true; controlId: string; recoveryAction?: "open_target_continue" }>;
  interrupt(input: { groupId?: string; requestId: string; threadId: string; expectedTurnId: string }): Promise<{ accepted: true; controlId: string; hostOffline: boolean }>;
}

/** 绑定当前 Turn；组解析在每个操作前执行，组停用或归属变化立即拒绝。 */
export function createThreadsToolBinding(
  ports: RuntimePorts,
  capability: ThreadsCapability,
  actor: { threadId: string; turnId: string },
): AgentThreadsCapability {
  const context = {
    workspaceId: capability.workspaceId,
    stateRootId: capability.stateRootId,
    projectId: capability.projectId,
    allowedTools: capability.allowedTools,
    modelCatalog: capability.modelCatalog,
    humanPrincipalId: capability.humanPrincipalId,
    executionHost: capability.executionHost,
    allowRootGroupBootstrap: capability.allowRootGroupBootstrap,
    handoff: capability.handoff,
    actor: { kind: "thread" as const, threadId: actor.threadId, turnId: actor.turnId },
  };
  const service = createThreadService(ports, ports.threadStore, context);
  const facade = createThreadFacade(ports, context, service);

  /** 每个动作重新解析可信成员与目标共同范围；显式 ID 也须经过服务授权。 */
  async function groupId(selected?: string, targets: readonly string[] = [], readOnly = false): Promise<string> {
    const result = await optionalGroupId(selected, targets, readOnly);
    if (!result) throw new ThreadServiceError("THREAD_SCOPE_DENIED");
    return result;
  }

  /** 无匹配返回 null；歧义与存储损坏不能伪装成空范围。 */
  async function optionalGroupId(selected?: string, targets: readonly string[] = [], readOnly = false): Promise<string | null> {
    try { return await service.resolveGroup({ groupId: selected, threadIds: targets, readOnly }); }
    catch (error) {
      if (error instanceof ThreadServiceError) throw error;
      throw new ThreadServiceError("THREADS_UNAVAILABLE");
    }
  }

  /** 消息投影只保留协作所需字段，不透传组内请求键。 */
  function projectMessage(message: ThreadMessage & Pick<AgentThreadMessageView, "inputState" | "deliveryReason">): AgentThreadMessageView {
    return {
      messageId: message.messageId,
      from: message.from,
      mode: message.mode,
      content: message.content,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(message.expectedTurnId ? { expectedTurnId: message.expectedTurnId } : {}),
      createdAt: message.createdAt,
      deliverySeq: message.deliverySeq,
      deliveryStatus: message.deliveryStatus,
      ...(message.deliveryReason ? { deliveryReason: message.deliveryReason } : {}),
      ...(message.inputId ? { inputId: message.inputId } : {}),
      ...(message.turnId ? { turnId: message.turnId } : {}),
      ...(message.inputState ? { inputState: { ...message.inputState } } : {}),
      ...(message.handoff ? { handoffRef: message.handoff } : {}),
    };
  }

  return {
    ...(capability.executionHost === "web-work-v1" ? { presentationHost: "web" as const } : {}),
    /** 只计算目标路径，不执行写入或暴露宿主绝对路径。 */
    handoffPath: function handoffPath(requestId) { return threadHandoffPath(capability.workspaceId, context.actor, requestId); },
    /** 子会话挂在当前 Turn 所属 Session 下，创建不启动推理。 */
    async create(input) {
      let currentGroupId: string;
      try {
        currentGroupId = await service.ensureCurrentGroupForCreate(input.groupId);
      } catch (error) {
        if (error instanceof ThreadServiceError) throw error;
        throw new ThreadServiceError("THREADS_UNAVAILABLE");
      }
      const result = await facade.create({
        protocolVersion: 1,
        groupId: currentGroupId,
        parentThreadId: actor.threadId,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.roleLabel !== undefined ? { roleLabel: input.roleLabel } : {}),
        ...(input.modelRef ? { modelRef: input.modelRef } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        requestId: input.requestId,
      });
      capability.onThreadCreated?.();
      return { threadId: result.threadId, groupId: result.groupId, parentThreadId: result.parentThreadId, relativeLink: result.relativeLink };
    },

    /** 只列出当前授权组成员；分页游标由 Core 绑定授权域。 */
    async list(input) {
      const currentGroupId = await optionalGroupId(input.groupId, [], true);
      if (!currentGroupId) return { items: [] };
      const page = await facade.list({
        protocolVersion: 1,
        groupId: currentGroupId,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return {
        items: page.items.map(function project(member) {
          return { threadId: member.threadId, parentThreadId: member.parentThreadId, ...(member.title !== undefined ? { title: member.title } : {}), ...(member.roleLabel !== undefined ? { roleLabel: member.roleLabel } : {}), createdAt: member.createdAt };
        }),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },

    /** 读取不启动、不恢复、不确认已读；协作消息与执行结果分开投影。 */
    async read(input) {
      const currentGroupId = await groupId(input.groupId, [input.threadId], true);
      const page = await facade.read({
        protocolVersion: 1,
        groupId: currentGroupId,
        threadId: input.threadId,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      const messages = await facade.messages({ protocolVersion: 1, groupId: currentGroupId, threadId: input.threadId, limit: Math.min(input.limit ?? 20, 20) });
      return {
        thread: { threadId: page.thread.threadId, ...(page.thread.title !== undefined ? { title: page.thread.title } : {}), relativeLink: `/chat?mode=work&workspaceId=${encodeURIComponent(capability.workspaceId)}&sessionId=${encodeURIComponent(page.thread.threadId)}`, status: page.thread.status, ...(page.thread.activeTurnId ? { activeTurnId: page.thread.activeTurnId } : {}) },
        ...(page.turn ? { turn: { turnId: page.turn.turnId, status: page.turn.status } } : {}),
        latestMessages: page.latestMessages.map(function project(item) {
          return { id: item.id, role: "assistant" as const, content: item.content, ...(item.turnId !== undefined ? { turnId: item.turnId } : {}), createdAt: item.createdAt };
        }),
        messages: messages.items.map(projectMessage),
        history: page.history.map(function project(item) {
          return { seq: item.seq, turnId: item.turnId, timestamp: item.timestamp, type: item.type, ...(item.content !== undefined ? { content: item.content } : {}) };
        }),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },

    /** 投递只报告接受与交付游标；是否执行由目标宿主 Runner 决定。 */
    async send(input) {
      const currentGroupId = await groupId(input.groupId, [input.threadId]);
      if (input.reportingAgreement) return service.send({ ...input, groupId: currentGroupId });
      const result = await facade.send({
        protocolVersion: 1,
        groupId: currentGroupId,
        requestId: input.requestId,
        threadId: input.threadId,
        mode: input.mode,
        content: input.content,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(input.expectedTurnId ? { expectedTurnId: input.expectedTurnId } : {}),
        ...(input.handoff ? { handoff: input.handoff } : {}),
      });
      return { messageId: result.messageId, mode: result.mode, ...(result.expectedTurnId ? { expectedTurnId: result.expectedTurnId } : {}), ...(result.taskId ? { taskId: result.taskId } : {}), deliverySeq: result.deliverySeq, deliveryStatus: result.deliveryStatus, ...(result.handoffRef ? { handoffRef: result.handoffRef } : {}) };
    },

    /** 等待只观察目标状态；取消只结束本次等待，不取消目标 Turn。 */
    async wait(input) {
      const currentGroupId = await groupId(input.groupId, input.targets.map(function target(item) { return item.threadId; }));
      const result = await facade.wait({
        protocolVersion: 1,
        groupId: currentGroupId,
        targets: input.targets,
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { results: result.results, timedOut: result.timedOut };
    },

    /** 共享板读取返回显式版本与写入来源，不自动注入模型上下文。 */
    async readState(input) {
      const currentGroupId = await groupId(input?.groupId, [], true);
      const result = await facade.readState({ protocolVersion: 1, groupId: currentGroupId });
      return { value: result.value, revision: result.revision, updatedAt: result.updatedAt, updatedBy: result.updatedBy };
    },

    /** 写入必须携带 expectedRevision，冲突时返回当前版本而不是覆盖。 */
    async updateState(input) {
      const currentGroupId = await groupId(input.groupId);
      const result = await facade.updateState({
        protocolVersion: 1,
        groupId: currentGroupId,
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
        operations: input.operations,
      });
      return { revision: result.revision };
    },

    /** 进展写入固定为当前 Turn 的会话；模型不能指定回报来源或目标。 */
    async reportProgress(input) {
      const currentGroupId = await groupId(input.groupId, [actor.threadId]);
      const result = await facade.reportProgress({
        protocolVersion: 1,
        groupId: currentGroupId,
        requestId: input.requestId,
        kind: input.kind,
        summary: input.summary,
        ...(input.evidence ? { evidence: input.evidence } : {}),
      });
      return { progressSeq: result.progressSeq, taskId: result.taskId, taskProgressSeq: result.taskProgressSeq };
    },

    /** 进展读取只返回有界摘要页；连续普通进度由 Core 合并，历史仍需显式 read。 */
    async readProgress(input) {
      const currentGroupId = await groupId(input.groupId, [input.threadId], true);
      const page = await facade.readProgress({
        protocolVersion: 1,
        groupId: currentGroupId,
        threadId: input.threadId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.kinds ? { kinds: input.kinds } : {}),
      });
      return {
        items: page.items.map(function project(item) {
          return { threadId: item.threadId, taskId: item.taskId, turnId: item.turnId, kind: item.kind, summary: item.summary, progressSeq: item.progressSeq, mergedCount: item.mergedCount, createdAt: item.createdAt, ...(item.evidence ? { evidence: item.evidence } : {}) };
        }),
        cursor: page.cursor,
        compacted: page.compacted,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },

    /** 审批约束冻结当前 checkpoint；目标又经历新暂停时旧批准不能跨执行段复用。 */
    async resumeConstraint(input) {
      await groupId(input.groupId, [input.threadId]);
      const checkpoint = await ports.checkpointStore.getLatest(input.threadId);
      if (checkpoint?.turnId !== input.expectedTurnId) throw new ThreadServiceError("THREAD_TURN_MISMATCH");
      return `thread-resume:${createHash("sha256").update(JSON.stringify([input.threadId, input.expectedTurnId, checkpoint])).digest("hex")}`;
    },

    /** 恢复只提交精确暂停轮的控制，不产生后续任务；人类授权由工具审批链处理。 */
    async resume(input) {
      const currentGroupId = await groupId(input.groupId, [input.threadId]);
      const result = await facade.resume({ protocolVersion: 1, ...input, groupId: currentGroupId });
      return { accepted: result.accepted, controlId: result.controlId, ...(result.recoveryAction ? { recoveryAction: result.recoveryAction } : {}) };
    },

    /** 中断只向实际 owner 持久化请求；接受命令不代表目标已停止。 */
    async interrupt(input) {
      const currentGroupId = await groupId(input.groupId, [input.threadId]);
      const result = await facade.interrupt({
        protocolVersion: 1,
        groupId: currentGroupId,
        requestId: input.requestId,
        threadId: input.threadId,
        expectedTurnId: input.expectedTurnId,
      });
      return { accepted: result.accepted, controlId: result.controlId, hostOffline: result.hostOffline };
    },
  };
}
