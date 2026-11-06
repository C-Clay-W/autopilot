/**
 * web-queued-turn.ts — 普通 Work 排队输入的宿主侧装配
 *
 * 页面只提交 delivery=queue 的输入事实；真正的领取、附件/Skill 投影、消费与启动由
 * TurnHost 在上一轮成功后执行。首轮消息构建与 Messages Route 共用同一实现，不另写一套。
 */

import type * as Core from "@autopilot-agent/core";
import type { WebCompositionRoot, WebResolvedSelectedSkill } from "../composition-root";
import { persistUserMessage } from "../runtime-host/web-message-projection";
import { readSessionImage, resolveSessionImages, SessionAttachmentError, type SessionImageAttachment } from "../session-attachment-store";
import { getSessionMeta, updatePinnedSkills } from "../session-store";
import type { WebQueuedTurnPreparer } from "./web-turn-host";

/** 单轮图片数量与总大小上限；与 Messages Route 的请求边界一致。 */
const MAX_TURN_IMAGES = 10;
const MAX_TURN_IMAGE_BYTES = 20 * 1024 * 1024;

/** 组装 Work Turn 的首轮消息：Skill 指令、附件指令与带图片引用的用户正文。 */
export function buildWorkTurnMessages(input: {
  compositionRoot: WebCompositionRoot;
  content: string;
  attachments: SessionImageAttachment[];
  skills: WebResolvedSelectedSkill[];
}): Core.AgentMessage[] {
  const legacyAttachments = input.attachments.filter(function isLegacy(attachment) { return !attachment.sha256 || !attachment.width || !attachment.height; });
  const attachmentInstruction = input.compositionRoot.createAttachmentInstruction(legacyAttachments);
  const selectedSkillsInstruction = input.compositionRoot.createSelectedSkillsInstruction(input.skills);
  return [
    ...(selectedSkillsInstruction ? [selectedSkillsInstruction] : []),
    ...(attachmentInstruction ? [attachmentInstruction] : []),
    { role: "user", content: [
      { type: "text", text: input.content },
      ...input.attachments
        .filter(function hasIdentity(attachment) { return Boolean(attachment.sha256 && attachment.width && attachment.height); })
        .map(function toImage(attachment) { return { type: "image-ref" as const, id: attachment.id, sha256: attachment.sha256!, width: attachment.width!, height: attachment.height! }; }),
    ] },
  ];
}

/** 校验本轮附件与领取时冻结的引用完全一致，并沿用同一数量与体积上限。 */
export function assertTurnAttachments(sessionId: string, references: Core.InboxAttachmentRef[], attachments: SessionImageAttachment[]): void {
  const mismatched = references.some(function compare(reference, index) {
    return Boolean(reference.sha256) && (attachments[index]?.sha256 !== reference.sha256
      || attachments[index]?.width !== reference.width
      || attachments[index]?.height !== reference.height
      || attachments[index]?.bytes !== reference.bytes);
  });
  if (mismatched) throw new SessionAttachmentError("WORK_ATTACHMENT_INVALID");
  const totalBytes = attachments.reduce(function totalBytes(total, attachment) { return total + readSessionImage(sessionId, attachment.id).content.byteLength; }, 0);
  if (attachments.length > MAX_TURN_IMAGES || totalBytes > MAX_TURN_IMAGE_BYTES) throw new SessionAttachmentError("WORK_ATTACHMENT_INVALID");
}

/** 创建排队输入装配器；消费与用户消息投影在真正启动前完成，失败时由宿主取消该输入。 */
export function createWebQueuedTurnPreparer(deps: {
  runtime: Core.AgentRuntime;
  compositionRoot: WebCompositionRoot;
}): WebQueuedTurnPreparer {
  const runtime = deps.runtime;
  const compositionRoot = deps.compositionRoot;

  /** 把一条已领取输入装配为 Turn 启动请求：校验附件、冻结 Skill、消费输入并写入用户消息。 */
  return async function prepareQueuedTurn({ sessionId, turnId, input }) {
    const sessionMeta = await getSessionMeta(runtime, sessionId);
    const attachments = resolveSessionImages(sessionId, input.attachments.map(function attachmentId(attachment) { return attachment.id; }));
    assertTurnAttachments(sessionId, input.attachments, attachments);
    const selectedSkills = input.selectedSkills.map(function toSelection(skill) { return { skillRef: skill.skillRef, arguments: skill.arguments, pinned: skill.pinned }; });
    const resolvedSkills = await compositionRoot.resolveSelectedSkills(selectedSkills, sessionMeta.pinnedSkills ?? []);
    if (selectedSkills.length) await updatePinnedSkills(runtime, sessionId, resolvedSkills.pinnedSkills);
    const context = await compositionRoot.prepareTurnContext(input.content);
    const messages = buildWorkTurnMessages({ compositionRoot, content: input.content, attachments, skills: resolvedSkills.skills });
    // 先消费再写用户消息：消费失败说明该输入已被别的执行段处理，不能再启动一轮。
    if (!(await runtime.inbox.consume({ sessionId, inputId: input.inputId, turnId }))) throw new Error("排队输入未能从 claimed 转为 consumed");
    await persistUserMessage(runtime, sessionId, input.content, attachments, `input:${input.inputId}`);
    return {
      content: input.content,
      messages,
      continuity: { source: "claimed_queue" as const },
      // 权限模式不在此覆盖：沿用 Session.defaultRunConfig 的会话级选择，Core 缺省仍为 ask。
      runConfig: { databaseSearchPolicy: { enabled: false } },
      contextBudget: context?.budget,
      initialDiagnostics: resolvedSkills.diagnostics,
      activeSkills: resolvedSkills.skills.map(function toIdentity(skill) { return { skillId: skill.skillId, contentHash: skill.contentHash }; }),
    };
  };
}
