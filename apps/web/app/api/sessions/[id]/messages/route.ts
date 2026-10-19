/** Work 处理器只能由已校验 Workspace 的 canonical Route 调用。 */
import { readRequestObject, WebRouteError } from "@/lib/runtime-host/web-http-error";
import { toWorkSessionErrorResponse } from "@/lib/workspace-host/work-session-error";
import { rejectUnscopedWorkRequest } from "@/lib/workspace-host/work-route-boundary";
/**
 * 这里是Agent Loop的唯一入口
 * 由 workspace-scoped Route 复用标准 Core Agent Loop。
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import type * as Core from "@autopilot-agent/core";
import { tryAcquireQueueStartLock } from "@/lib/agent-turn-store";
import {
  getSessionMessages,
  getSessionMeta,
  updatePinnedSkills,
  type SessionMessage,
} from "@/lib/session-store";
import { resolveSessionImages, type SessionImageAttachment } from "@/lib/session-attachment-store";
import { getDefaultWebCompositionRoot, getSharedWebRuntime, type WebResolvedSelectedSkill, type WebSelectedSkillInput } from "@/lib/composition-root";
import { persistUserMessage } from "@/lib/runtime-host/web-message-projection";
import { createRuntimeAgentStream } from "@/lib/runtime-host/web-agent-stream";
import { persistCompactionRecord } from "@/lib/runtime-host/web-compaction-projection";

type SelectedSkillInput = WebSelectedSkillInput;
type LoadedSelectedSkill = WebResolvedSelectedSkill;
type InputDelivery = "auto" | "steer" | "queue";
type SessionAttachmentRef = Core.InboxAttachmentRef;
type SessionSkillRef = Core.InboxSkillRef;

/** 将 Session 图片附件转换为 durable inbox 的安全引用，不向浏览器回显内部绝对路径。 */
function toSessionAttachmentRefs(attachments: SessionImageAttachment[]): SessionAttachmentRef[] {
  return attachments.map((attachment) => ({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, relativePath: attachment.relativePath }));
}

/** 将已加载 Skill 的冻结身份写入 durable inbox，正文继续由受控 catalog 在运行时加载。 */
function toSessionSkillRefs(skills: LoadedSelectedSkill[]): SessionSkillRef[] {
  return skills.map((skill) => ({ skillRef: skill.skillRef, skillId: skill.skillId, contentHash: skill.contentHash, arguments: skill.arguments, pinned: skill.pinned }));
}

export const maxDuration = 120;

/** Reuse only images uploaded immediately before this question, so old images never leak into unrelated follow-ups. */
function getPendingSessionImages(messages: SessionMessage[]): SessionImageAttachment[] {
  const attachments: SessionImageAttachment[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user" || message.content.trim() || !message.attachments?.length) break;
    attachments.unshift(...message.attachments);
  }
  return attachments;
}

/** 校验浏览器传来的结构化 Skill 引用，路径和正文永远只由服务端 catalog 解析。 */
function parseSelectedSkills(value: unknown): SelectedSkillInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) throw new WebRouteError("INVALID_SESSION_REQUEST");
  const skills = value.map((item) => {
    if (!item || typeof item !== "object") throw new WebRouteError("INVALID_SESSION_REQUEST");
    const selected = item as Record<string, unknown>;
    if (typeof selected.skillRef !== "string" || !/^(repo|user|claude):[a-z0-9-]{1,64}$/.test(selected.skillRef)) throw new WebRouteError("INVALID_SESSION_REQUEST");
    if (selected.arguments !== undefined && (typeof selected.arguments !== "string" || selected.arguments.length > 4_000)) throw new WebRouteError("INVALID_SESSION_REQUEST");
    if (selected.pinned !== undefined && typeof selected.pinned !== "boolean") throw new WebRouteError("INVALID_SESSION_REQUEST");
    return { skillRef: selected.skillRef, arguments: selected.arguments as string | undefined, pinned: selected.pinned as boolean | undefined };
  });
  if (new Set(skills.map((skill) => skill.skillRef)).size !== skills.length) throw new WebRouteError("INVALID_SESSION_REQUEST");
  return skills;
}

/** 校验浏览器生成的幂等键，避免重试或多标签页把同一输入重复写入 Session。 */
function parseClientMessageId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(value)) throw new WebRouteError("INVALID_SESSION_REQUEST");
  return value;
}

/** 校验持续输入的投递语义；auto 只在空闲会话时可直接创建 turn。 */
function parseDelivery(value: unknown): InputDelivery {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "steer" || value === "queue") return value;
  throw new WebRouteError("INVALID_SESSION_REQUEST");
}

/** 接收新用户任务；已绑定工作区的任务进入 Agent，只使用任务能力。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = rejectUnscopedWorkRequest();
  if (rejected) return rejected;
  let queueStartLock: (() => void) | undefined;
  let claimedQueuedInput: Core.InboxInput | null = null;
  let runtimeForCleanup: Core.AgentRuntime | undefined;
  try {
    const { id } = await params;
    let body = await readRequestObject(request, "INVALID_SESSION_REQUEST") as Record<string, unknown>;
    const databaseSearchEnabled = body.databaseSearchEnabled === true;
    // Route 只保留 HTTP DTO 与 SSE 投影；Trust 后的 Provider、Context、Skill 与任务能力 都由 Composition Root 装配。
    const compositionRoot = getDefaultWebCompositionRoot();
    const runtime = await getSharedWebRuntime();
    runtimeForCleanup = runtime;
    const sessionMeta = await getSessionMeta(runtime, id);
    if (body.operation === "start_next") {
      queueStartLock = tryAcquireQueueStartLock(id);
      if (!queueStartLock) return NextResponse.json({ error: "排队任务正在启动", code: "QUEUE_START_IN_PROGRESS" }, { status: 409 });
      const runtimeState = await runtime.turns.getState({ sessionId: id });
      const runtimeStatus = runtimeState.checkpoint?.status ?? runtimeState.turn?.status;
      if (runtimeStatus === "running" || runtimeStatus === "awaiting_approval" || runtimeStatus === "waiting_approval") {
        queueStartLock();
        queueStartLock = undefined;
        return NextResponse.json({ error: "当前任务仍在运行", code: "TURN_ALREADY_RUNNING" }, { status: 409 });
      }
      claimedQueuedInput = await runtime.inbox.claimNext({ sessionId: id });
      if (!claimedQueuedInput) {
        queueStartLock();
        queueStartLock = undefined;
        return new Response(null, { status: 204 });
      }
      body = {
        content: claimedQueuedInput.content,
        clientMessageId: claimedQueuedInput.clientMessageId ?? claimedQueuedInput.inputId,
        delivery: "auto",
        attachmentIds: claimedQueuedInput.attachments.map((attachment) => attachment.id),
        selectedSkills: claimedQueuedInput.selectedSkills.map((skill) => ({ skillRef: skill.skillRef, arguments: skill.arguments, pinned: skill.pinned })),
      };
    }
    if (body.operation === "compact") {
      const runtimeState = await runtime.turns.getState({ sessionId: id });
      const checkpoint = runtimeState.checkpoint;
      // 活动 Turn 直接拒绝手动 compact：不排队、不返回 202、不声称会在安全边界执行。
      if (runtimeState.turn?.status === "running" || checkpoint?.status === "running") {
        return NextResponse.json({ error: "当前任务仍在运行，请等待其结束后再压缩上下文", code: "TURN_ALREADY_RUNNING" }, { status: 409 });
      }
      const history = await getSessionMessages(runtime, id);
      const turnId = checkpoint?.turnId ?? runtimeState.turn?.id;
      if (!turnId) return NextResponse.json({ error: "当前会话没有可压缩的 Turn" }, { status: 409 });
      // Core 在外部新鲜 lease 下同样抛 TURN_ALREADY_RUNNING，由统一错误映射收敛为 409。
      const compacted = await runtime.turns.compact({ sessionId: id, turnId, trigger: "manual", signal: request.signal });
      // skipped 表示没有实际压缩事实，不写入压缩记录，也不回传伪 pre/postTokens。
      if (compacted.outcome === "skipped") {
        return NextResponse.json({ outcome: compacted.outcome, reason: compacted.reason, contextUsage: compacted.contextUsage });
      }
      const record = await persistCompactionRecord(runtime, id, compacted, history, "manual");
      return NextResponse.json({
        type: "context_compacted",
        compactId: record.compactId,
        preTokens: record.preTokens,
        postTokens: record.postTokens,
        outcome: compacted.outcome,
        contextUsage: compacted.contextUsage,
      });
    }
    if (body.operation === "cancel_input") {
      if (typeof body.inputId !== "string") return NextResponse.json({ error: "请提供 inputId" }, { status: 400 });
      const cancelled = await runtime.inbox.cancel(body.inputId);
      return NextResponse.json({ cancelled }, { status: cancelled ? 200 : 409 });
    }
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const clientMessageId = parseClientMessageId(body.clientMessageId);
    const requestedDelivery = parseDelivery(body.delivery);
    if (!content) return NextResponse.json({ error: "请先输入问题；图片已保存，可在后续提问中按需分析" }, { status: 400 });
    const selectedSkills = parseSelectedSkills(body.selectedSkills);
    const submittedAttachments = resolveSessionImages(id, body.attachmentIds);
    const rawMessages = await getSessionMessages(runtime, id);
    const attachments = submittedAttachments.length ? submittedAttachments : getPendingSessionImages(rawMessages);
    const runtimeState = await runtime.turns.getState({ sessionId: id });
    const previousTurnId = runtimeState.checkpoint?.turnId ?? runtimeState.turn?.id;
    const previousStatus = runtimeState.checkpoint?.status ?? runtimeState.turn?.status;
    if (previousTurnId && (previousStatus === "running" || previousStatus === "awaiting_approval" || previousStatus === "waiting_approval")) {
      const resolvedSkills = await compositionRoot.resolveSelectedSkills(selectedSkills, sessionMeta.pinnedSkills ?? []);
      const delivery = requestedDelivery === "queue" ? "queue" : "steer";
      const input = delivery === "queue"
        ? await runtime.inbox.post({
          sessionId: id,
          clientMessageId,
          delivery,
          content,
          attachments: toSessionAttachmentRefs(attachments),
          selectedSkills: toSessionSkillRefs(resolvedSkills.skills),
        })
        : await runtime.turns.steer({
          sessionId: id,
          turnId: previousTurnId,
          clientMessageId,
          delivery,
          content,
          attachments: toSessionAttachmentRefs(attachments),
          selectedSkills: toSessionSkillRefs(resolvedSkills.skills),
        });
      return NextResponse.json({ accepted: true, inputId: input.inputId, delivery: input.delivery, status: input.status, turnId: previousTurnId }, { status: 202 });
    }
    if (previousStatus === "interrupted" || previousStatus === "interrupted_recoverable" || previousStatus === "limit_reached") {
      return NextResponse.json({ error: "当前任务需要通过继续执行恢复；普通新输入不会猜测恢复意图" }, { status: 409 });
    }
    if (requestedDelivery !== "auto") {
      return NextResponse.json({ error: "前一个任务已经结束，请重新发送当前输入。", code: "active_turn_finished" }, { status: 409 });
    }
    const context = await compositionRoot.prepareTurnContext(content);
    const turnId = crypto.randomUUID();
    const resolvedSkills = await compositionRoot.resolveSelectedSkills(selectedSkills, sessionMeta.pinnedSkills ?? []);
    if (selectedSkills.length) await updatePinnedSkills(runtime, id, resolvedSkills.pinnedSkills);
    const attachmentInstruction = compositionRoot.createAttachmentInstruction(attachments);
    const selectedSkillsInstruction = compositionRoot.createSelectedSkillsInstruction(resolvedSkills.skills);
    // 历史、默认行为、Context 与 compact 由 Runtime 统一处理；Web 只提交已验证的专属 capability 引用。
    const messages: Core.AgentMessage[] = [
      ...(selectedSkillsInstruction ? [selectedSkillsInstruction] : []),
      ...(attachmentInstruction ? [attachmentInstruction] : []),
    ];
    if (claimedQueuedInput && !(await runtime.inbox.consume({ sessionId: id, inputId: claimedQueuedInput.inputId, turnId }))) {
      throw new Error("start_next 输入未能从 claimed 转为 consumed");
    }
    await persistUserMessage(runtime, id, content, attachments, claimedQueuedInput ? `input:${claimedQueuedInput.inputId}` : undefined);

    const runConfig: Partial<Core.RunConfig> = {
      permissionMode: "ask",
      databaseSearchPolicy: { enabled: databaseSearchEnabled },
    };

    const stream = createRuntimeAgentStream({
      sessionId: id,
      turnId,
      runtime,
      mode: "start",
      content,
      messages,
      continuity: claimedQueuedInput ? { source: "claimed_queue" } : undefined,
      runConfig,
      requestSignal: request.signal,
      initialDiagnostics: resolvedSkills.diagnostics,
      contextBudget: context?.budget,
      activeSkills: resolvedSkills.skills.map(({ skillId, contentHash }) => ({ skillId, contentHash })),
      onSettled: queueStartLock,
    });
    queueStartLock = undefined;
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", ...(claimedQueuedInput ? { "X-Agent-Input-Id": claimedQueuedInput.inputId, "X-Agent-Turn-Id": turnId } : {}) },
    });
  } catch (error) {
    if (claimedQueuedInput && runtimeForCleanup) await runtimeForCleanup.inbox.cancel(claimedQueuedInput.inputId).catch(() => false);
    queueStartLock?.();
    return toWorkSessionErrorResponse(error);
  }
}
