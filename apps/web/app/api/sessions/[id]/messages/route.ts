/** Work 处理器只能由已校验 Workspace 的 canonical Route 调用。 */
import { readRequestObject, WebRouteError } from "@/lib/runtime-host/web-http-error";
import { toWorkSessionErrorResponse } from "@/lib/workspace-host/work-session-error";
import { rejectUnscopedWorkRequest } from "@/lib/workspace-host/work-route-boundary";
/**
 * Work 消息入口：校验与投影在请求内完成，实际 Turn 执行交给 Workspace TurnHost。
 * 页面通过 `GET /api/workspaces/:id/sessions/:sid/stream?turnId=` 观察持久事件。
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import type * as Core from "@autopilot-agent/core";
import {
  getSessionMessages,
  getSessionMeta,
  updatePinnedSkills,
  updateSessionPermissionMode,
  type SessionMessage,
} from "@/lib/session-store";
import { resolveSessionImages, type SessionImageAttachment } from "@/lib/session-attachment-store";
import { getDefaultWebCompositionRoot, getSharedWebRuntime, type WebResolvedSelectedSkill, type WebSelectedSkillInput } from "@/lib/composition-root";
import { persistUserMessage } from "@/lib/runtime-host/web-message-projection";
import { requireWorkspaceTurnHost } from "@/lib/workspace-host/web-workspace-session";
import { persistCompactionRecord } from "@/lib/runtime-host/web-compaction-projection";
import { assertTurnAttachments, buildWorkTurnMessages } from "@/lib/workspace-host/web-queued-turn";

type SelectedSkillInput = WebSelectedSkillInput;
type LoadedSelectedSkill = WebResolvedSelectedSkill;
type InputDelivery = "auto" | "steer" | "queue";
type SessionAttachmentRef = Core.InboxAttachmentRef;
type SessionSkillRef = Core.InboxSkillRef;

/** 将 Session 图片附件转换为 durable inbox 的安全引用，不向浏览器回显内部绝对路径。 */
function toSessionAttachmentRefs(attachments: SessionImageAttachment[]): SessionAttachmentRef[] {
  return attachments.map(function toReference(attachment) { return { id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, relativePath: attachment.relativePath, sha256: attachment.sha256, width: attachment.width, height: attachment.height, bytes: attachment.bytes }; });
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

/** 校验浏览器提交的工具权限模式；缺省保持 ask，未知值拒绝而不是静默放宽。 */
function parsePermissionMode(value: unknown): Core.ToolPermissionMode {
  if (value === undefined) return "ask";
  if (value === "ask" || value === "auto_approve" || value === "full_access") return value;
  throw new WebRouteError("INVALID_SESSION_REQUEST");
}

/** 接收新用户任务；已绑定工作区的任务进入 Agent，只使用任务能力。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = rejectUnscopedWorkRequest();
  if (rejected) return rejected;
  try {
    const { id } = await params;
    const body = await readRequestObject(request, "INVALID_SESSION_REQUEST") as Record<string, unknown>;
    const databaseSearchEnabled = body.databaseSearchEnabled === true;
    // Route 只保留 HTTP DTO 与 SSE 投影；Trust 后的 Provider、Context、Skill 与任务能力 都由 Composition Root 装配。
    const compositionRoot = getDefaultWebCompositionRoot();
    const runtime = await getSharedWebRuntime();
    const sessionMeta = await getSessionMeta(runtime, id);
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
    const permissionMode = parsePermissionMode(body.permissionMode);
    // 权限模式是会话级默认：本轮立即生效，也作为排队输入消费时新 Turn 的缺省。
    if (body.permissionMode !== undefined) await updateSessionPermissionMode(runtime, id, permissionMode);
    if (!content) return NextResponse.json({ error: "请先输入问题；图片已保存，可在后续提问中按需分析" }, { status: 400 });
    const selectedSkills = parseSelectedSkills(body.selectedSkills);
    const submittedAttachments = resolveSessionImages(id, body.attachmentIds);
    const rawMessages = await getSessionMessages(runtime, id);
    const attachments = submittedAttachments.length ? submittedAttachments : getPendingSessionImages(rawMessages);
    // 本轮没有领取冻结引用，只复用同一数量与体积边界，避免两处各写一套上限。
    assertTurnAttachments(id, [], attachments);
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
      return NextResponse.json({ error: "当前任务已暂停；点击「继续执行」恢复，或新建任务", code: "active_turn_paused" }, { status: 409 });
    }
    if (requestedDelivery !== "auto") {
      return NextResponse.json({ error: "前一个任务已经结束，请重新发送当前输入。", code: "active_turn_finished" }, { status: 409 });
    }
    const context = await compositionRoot.prepareTurnContext(content);
    const turnId = crypto.randomUUID();
    const resolvedSkills = await compositionRoot.resolveSelectedSkills(selectedSkills, sessionMeta.pinnedSkills ?? []);
    if (selectedSkills.length) await updatePinnedSkills(runtime, id, resolvedSkills.pinnedSkills);
    // 历史、默认行为、Context 与 compact 由 Runtime 统一处理；Web 只提交已验证的专属 capability 引用。
    const messages = buildWorkTurnMessages({ compositionRoot, content, attachments, skills: resolvedSkills.skills });
    await persistUserMessage(runtime, id, content, attachments);

    const runConfig: Partial<Core.RunConfig> = {
      permissionMode,
      databaseSearchPolicy: { enabled: databaseSearchEnabled },
    };

    // 普通 Work 统一由 TurnHost 执行：POST 只提交意图并立即回执（Talk-Plan1028 7.17）。
    requireWorkspaceTurnHost().start({
      sessionId: id,
      turnId,
      content,
      messages,
      runConfig,
      contextBudget: context?.budget,
      initialDiagnostics: resolvedSkills.diagnostics,
      activeSkills: resolvedSkills.skills.map(({ skillId, contentHash }) => ({ skillId, contentHash })),
    });
    return NextResponse.json({ accepted: true, turnId }, { status: 202 });
  } catch (error) {
    return toWorkSessionErrorResponse(error);
  }
}
