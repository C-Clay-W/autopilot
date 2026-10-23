/**
 * work-preview-facts.ts — Work 内置预览的权威工具事实读取。
 *
 * 从同一 Work 会话的 Runtime transcript 提取已成功交付的 open_preview 安全事实
 * （previewId/Turn/call/copyUrl/openWhen），供短期缓存过期或 Host 重启后重新校验并重建缓存
 * （Talk-Plan0908 §7.3）。只读既有 transcript，不新建持久库，不接受浏览器自报 URL。
 */

import type { AgentEventEnvelope } from "@autopilot-agent/core";

/** 一条可重新校验的预览交付事实；jobId 只来自宿主核验后写入成功明细的绑定结果。 */
export interface WorkPreviewToolFact {
  /** 宿主签发的稳定预览引用。 */
  previewId: string;
  /** 交付事实所属 Turn。 */
  turnId: string;
  /** 交付事实所属工具调用。 */
  callId: string;
  /** 宿主批准的实际页面地址；与当时的导航地址严格一致。 */
  copyUrl: string;
  /** 面板展示用的安全主机标签。 */
  hostLabel: string;
  /** 当时的打开时机。 */
  openWhen: "now" | "after_turn";
  /** 宿主核验并绑定成功后才存在的受管 Job；不来自模型输入或审批事件。 */
  jobId?: string;
}

/** 判断展示明细里的 jobId 是否为安全不透明标识；非字符串或格式不符时不采信。 */
function readBoundJobId(detail: { jobId?: unknown }): string | undefined {
  return typeof detail.jobId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(detail.jobId) ? detail.jobId : undefined;
}

/**
 * 从会话 transcript 提取 open_preview 成功事实。
 * Job 绑定只取成功明细里的宿主核验结果：不依赖 approval_required 事件，因此
 * full_access、命中持久授权等免审批路径同样保留关联。
 */
export function extractWorkPreviewToolFacts(events: readonly AgentEventEnvelope[]): WorkPreviewToolFact[] {
  const facts: WorkPreviewToolFact[] = [];
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type !== "tool_result" || event.toolName !== "open_preview" || event.result.status !== "success") continue;
    const detail = event.result.display?.detail;
    if (detail?.kind !== "open_preview") continue;
    const jobId = readBoundJobId(detail);
    facts.push({
      previewId: detail.previewId,
      turnId: envelope.turnId,
      callId: event.callId,
      copyUrl: detail.copyUrl,
      hostLabel: detail.hostLabel,
      openWhen: detail.openWhen,
      ...(jobId !== undefined ? { jobId } : {}),
    });
  }
  return facts;
}
