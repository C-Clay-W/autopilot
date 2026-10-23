/**
 * work-preview-state.ts — Work 内置预览的纯前端状态与计算。
 *
 * 只做面板状态机、交付事实选择、宽度/比例的纯计算与请求代次；不复制 SSE/Presentation
 * 持久逻辑，不读服务端。导航 DTO 仅来自 Stage2 受限 API（工具交付 GET / 手动 open-link POST），
 * 浏览器自报 URL 一律不作为导航依据（Talk-Plan0908 §7.5/§7.6）。
 */

import type { AgentPresentationState, TurnSummaryItem } from "@autopilot-agent/presentation";

/** 面板阶段：closed → resolving → opening → displayed；失败分 unavailable 与 embedding_unknown。 */
export type WorkPreviewPhase = "closed" | "resolving" | "opening" | "displayed" | "unavailable" | "embedding_unknown";

/** 沙箱档与 Stage2 DTO 一致：本地受信档与公网严格档。 */
export type PreviewSandboxProfile = "trusted_local" | "strict_public";

/** 面板当前导航目标；previewId/turnId 仅工具交付来源存在。 */
export interface WorkPreviewTarget {
  source: "tool_delivery" | "user_link";
  previewId?: string;
  turnId?: string;
  hostLabel: string;
  navigationUrl: string;
  sandboxProfile: PreviewSandboxProfile;
  serviceState: "unchecked" | "probing" | "ready" | "redirect_pending" | "unavailable";
  canStop: boolean;
}

/** 面板状态：resolving 起持有目标；unavailable 携带服务端固定安全文案。 */
export interface WorkPreviewPanelState {
  phase: WorkPreviewPhase;
  target: WorkPreviewTarget | null;
  errorMessage?: string;
}

/** 某一轮已成功交付的预览安全事实（来自 Core open_preview 受控明细）。 */
export interface TurnPreviewDelivery {
  previewId: string;
  /** 交付该预览的工具调用；自动打开抑制按 callId 判断“动作前已开始”。 */
  callId: string;
  hostLabel: string;
  copyUrl: string;
  openWhen: "now" | "after_turn";
  /** 宿主核验后的 Job 绑定；缺省表示没有可证明的服务归属。 */
  jobId?: string;
  /** false 表示无法证明服务归属，只能由用户显式打开。 */
  autoOpen?: boolean;
}

/** 装配层向消息链路透传的预览视图接线；对象引用变化即触发 memo 刷新。 */
export interface WorkPreviewViewProps {
  /** 面板当前正显示的 previewId；null 表示面板关闭或显示手动目标。 */
  panelPreviewId: string | null;
  /** 导航请求进行中的 previewId；null 表示无在途请求。 */
  resolvingPreviewId: string | null;
  /** 切换某结果的面板显示。 */
  onTogglePreview(previewId: string): void;
  /** Work 弹窗的内置打开回调；signal 由弹窗持有，取消/退出时中止并在途响应不再落地。 */
  onOpenInPreview(url: string, signal: AbortSignal): Promise<string | undefined>;
}

/** 面板关闭初始态。 */
export function closedPreview(): WorkPreviewPanelState {
  return { phase: "closed", target: null };
}

/** 进入解析阶段；目标已知时先展示目标，手动输入在 DTO 返回前为 null。 */
export function startPreviewResolve(target: WorkPreviewTarget | null): WorkPreviewPanelState {
  return { phase: "resolving", target };
}

/** DTO 就绪：挂载 iframe 并等待页面 load。 */
export function previewTargetReady(target: WorkPreviewTarget): WorkPreviewPanelState {
  return { phase: "opening", target };
}

/** iframe load 触发：只结束等待动画，不代表页面视觉或功能正确。 */
export function previewLoaded(state: WorkPreviewPanelState): WorkPreviewPanelState {
  return state.phase === "opening" ? { ...state, phase: "displayed" } : state;
}

/** 界面等待超时：保留 iframe 与手动入口，不凭超时断言被 CSP 阻止。 */
export function previewEmbeddingUnknown(state: WorkPreviewPanelState): WorkPreviewPanelState {
  return state.phase === "opening" ? { ...state, phase: "embedding_unknown" } : state;
}

/** 解析/校验失败：展示固定安全文案并保留手动入口。 */
export function previewFailed(state: WorkPreviewPanelState, errorMessage: string): WorkPreviewPanelState {
  return { ...state, phase: "unavailable", errorMessage };
}

/** 取消交付资格的写类工具类别：变更命令与写/编辑工具（判定 3）。 */
const DISQUALIFYING_CATEGORIES = new Set(["write", "edit", "command"]);

/**
 * 交付资格共享评估：本轮必须已有正常终态摘要（state=completed，失败/拒绝/取消/limit 均非），
 * 取最后一次成功 open_preview 交付，且交付之后没有失败/拒绝/取消/超时调用、没有新的变更命令或写工具。
 * 运行中、恢复中与失格轮一律返回 undefined。
 */
function selectEligibleTurnDelivery(state: AgentPresentationState, turnId: string): TurnPreviewDelivery | undefined {
  const summary = state.items.find(function sameTurn(item): item is TurnSummaryItem { return item.kind === "turn_summary" && item.turnId === turnId; });
  if (!summary || summary.state !== "completed") return undefined;
  const items = state.items;
  let deliveryIndex = -1;
  let delivery: TurnPreviewDelivery | undefined;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== "tool_call" || item.turnId !== turnId || item.state !== "completed") continue;
    const detail = item.detail;
    if (detail?.kind !== "open_preview") continue;
    deliveryIndex = index;
    delivery = {
      previewId: detail.previewId,
      callId: item.callId,
      hostLabel: detail.hostLabel,
      copyUrl: detail.copyUrl,
      openWhen: detail.openWhen,
      ...(detail.jobId !== undefined ? { jobId: detail.jobId } : {}),
      ...(detail.autoOpen === false ? { autoOpen: false } : {}),
    };
  }
  if (!delivery) return undefined;
  for (let index = deliveryIndex + 1; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== "tool_call" || item.turnId !== turnId) continue;
    if (item.state === "failed" || item.state === "denied" || item.state === "cancelled" || item.state === "timeout") return undefined;
    if (DISQUALIFYING_CATEGORIES.has(item.category)) return undefined;
  }
  return delivery;
}

/**
 * 选择某轮的最终结果交付：正常终态后最后一次成功交付的 open_preview 安全事实。
 * now 与 after_turn 都可形成结果尾部，但失败/取消/limit/运行中/失格轮没有正常结果入口（AC-8）。
 */
export function selectTurnPreviewDelivery(state: AgentPresentationState, turnId: string): TurnPreviewDelivery | undefined {
  return selectEligibleTurnDelivery(state, turnId);
}

/**
 * 评估某轮的 after_turn 交付是否仍具自动展开资格；合格返回交付事实，否则 undefined。
 * 结果资格成立后只接受 after_turn 候选；now 交付由工具完成即开，不走此评估。
 */
export function evaluateAfterTurnCandidate(state: AgentPresentationState, turnId: string): TurnPreviewDelivery | undefined {
  const delivery = selectEligibleTurnDelivery(state, turnId);
  return delivery?.openWhen === "after_turn" ? delivery : undefined;
}

/**
 * 自动导航是否允许落地：实例必须可见活动、非只读且文档可见。
 * 隐藏实例或后台标签页只保留结果入口，不自动请求/挂载 iframe（AC-5、判定 5）。
 */
export function canAutoOpenPreview(input: { active: boolean; readOnly: boolean; documentVisible: boolean }): boolean {
  return input.active && !input.readOnly && input.documentVisible;
}

/** 工具交付候选身份：previewId、callId 与所属 Turn 一起参与用户动作与自动打开抑制判定。 */
export interface PreviewCandidate {
  turnId: string;
  previewId: string;
  callId: string;
}

/** 已开始（无论是否完成）的 open_preview 调用；用于淘汰动作前已开始、动作后才完成的调用。 */
export interface PreviewStartedCall {
  turnId: string;
  callId: string;
}

/** 自动打开抑制记录（会话内存）：用户动作淘汰的更早候选、更早开始的调用与用户关闭过的 Turn。 */
export interface PreviewAutoOpenSuppression {
  /** 已被用户动作淘汰的候选键（`turnId:previewId`）。 */
  invalidated: Set<string>;
  /** 用户动作时已经开始（尚未完成）的调用键（`turnId#callId`）。 */
  invalidatedCalls: Set<string>;
  /** 用户在本 Turn 关闭过面板；同 Turn 后续候选不再自动弹回（判定 6）。 */
  closedTurns: Set<string>;
}

/** 创建空抑制记录；不进入 Runtime、SSE、History 或 settings。 */
export function createPreviewAutoOpenSuppression(): PreviewAutoOpenSuppression {
  return { invalidated: new Set<string>(), invalidatedCalls: new Set<string>(), closedTurns: new Set<string>() };
}

/** 候选唯一键：同一 Turn 内按 previewId 去重（判定 4）。 */
export function previewCandidateKey(turnId: string, previewId: string): string {
  return turnId + ":" + previewId;
}

/** 调用唯一键：同一 Turn 内按 callId 判定“动作前已开始”。 */
export function previewCallKey(turnId: string, callId: string): string {
  return turnId + "#" + callId;
}

/** 按时间线顺序列出状态中全部 open_preview 交付候选，供用户动作按候选边界作废。 */
export function listPreviewCandidates(state: AgentPresentationState): PreviewCandidate[] {
  const candidates: PreviewCandidate[] = [];
  for (const item of state.items) {
    if (item.kind !== "tool_call") continue;
    const detail = item.detail;
    if (detail?.kind !== "open_preview") continue;
    candidates.push({ turnId: item.turnId, previewId: detail.previewId, callId: item.callId });
  }
  return candidates;
}

/**
 * 列出当前已存在的 open_preview 调用（包含运行中）。
 * 用户动作以“此刻已经开始”为边界：动作前已开始、动作后才完成的调用不得覆盖用户选择。
 */
export function listStartedPreviewCalls(state: AgentPresentationState): PreviewStartedCall[] {
  const calls: PreviewStartedCall[] = [];
  for (const item of state.items) {
    if (item.kind !== "tool_call" || item.toolName !== "open_preview") continue;
    calls.push({ turnId: item.turnId, callId: item.callId });
  }
  return calls;
}

/** 用户显式动作淘汰动作之前已存在的自动候选与已开始的调用；动作之后的新工具请求仍按实时规则判定（§7.5）。 */
export function invalidatePendingAutoCandidates(
  suppression: PreviewAutoOpenSuppression,
  candidates: readonly PreviewCandidate[],
  startedCalls: readonly PreviewStartedCall[] = [],
): void {
  for (const candidate of candidates) suppression.invalidated.add(previewCandidateKey(candidate.turnId, candidate.previewId));
  for (const call of startedCalls) suppression.invalidatedCalls.add(previewCallKey(call.turnId, call.callId));
}

/** 用户关闭面板：抑制同一 Turn 后续自动弹回（判定 6）。 */
export function suppressAutoOpenTurn(suppression: PreviewAutoOpenSuppression, turnId: string): void {
  suppression.closedTurns.add(turnId);
}

/** 按 previewId 反查候选所属 Turn；resolving 阶段面板尚无目标，关闭抑制用它取得 Turn 身份。 */
export function findPreviewCandidateTurnId(candidates: PreviewCandidate[], previewId: string | undefined): string | undefined {
  if (!previewId) return undefined;
  for (const candidate of candidates) {
    if (candidate.previewId === previewId) return candidate.turnId;
  }
  return undefined;
}

/**
 * 自动打开准入：首次评估即记为已消费（失格、后台完成与用户作废都不再重复评估），
 * 再依次检查实例可见性、用户动作淘汰与本轮关闭抑制；不合格只保留结果尾部入口。
 */
export function admitAutoOpenPreview(input: {
  suppression: PreviewAutoOpenSuppression;
  consumed: Set<string>;
  turnId: string;
  previewId: string;
  callId: string;
  visible: boolean;
}): boolean {
  const key = previewCandidateKey(input.turnId, input.previewId);
  if (input.consumed.has(key)) return false;
  input.consumed.add(key);
  if (!input.visible) return false;
  if (input.suppression.invalidated.has(key)) return false;
  // 动作前已开始、动作后才完成的调用同样不得覆盖用户选择（AC-7）。
  if (input.suppression.invalidatedCalls.has(previewCallKey(input.turnId, input.callId))) return false;
  return !input.suppression.closedTurns.has(input.turnId);
}

/** 分隔轨道宽度常量：左右各 320px 下限 + 8px 轨道（§7.6 冻结数值）。 */
export const PREVIEW_MIN_WIDTH = 320;
export const PREVIEW_DIVIDER_WIDTH = 8;

/** 内容容器是否允许双栏：C ≥ 320*2+8 才启用，不按浏览器窗口推断。 */
export function isDualPaneCapable(containerWidth: number): boolean {
  return containerWidth >= PREVIEW_MIN_WIDTH * 2 + PREVIEW_DIVIDER_WIDTH;
}

/** 把左栏宽度钳制到 [320, C−8−320]；容器未知时返回下限。 */
export function clampPreviewLeftWidth(leftWidth: number, containerWidth: number): number {
  const max = containerWidth - PREVIEW_DIVIDER_WIDTH - PREVIEW_MIN_WIDTH;
  if (!Number.isFinite(max) || max < PREVIEW_MIN_WIDTH) return PREVIEW_MIN_WIDTH;
  return Math.min(max, Math.max(PREVIEW_MIN_WIDTH, Math.round(leftWidth)));
}

/** 双栏初始宽度：首次展开左/右各 A/2（50:50）。 */
export function initialPreviewLeftWidth(containerWidth: number): number {
  return clampPreviewLeftWidth(Math.round((containerWidth - PREVIEW_DIVIDER_WIDTH) / 2), containerWidth);
}

/** 左栏宽度换算为 0–100 会话内存比例（用于同会话保留用户比例）。 */
export function previewWidthToRatio(leftWidth: number, containerWidth: number): number {
  const allocatable = containerWidth - PREVIEW_DIVIDER_WIDTH;
  if (allocatable <= 0) return 50;
  return Math.round((clampPreviewLeftWidth(leftWidth, containerWidth) / allocatable) * 100);
}

/** 会话内存比例换算回左栏宽度并按当前容器钳制。 */
export function previewRatioToWidth(ratio: number, containerWidth: number): number {
  const allocatable = containerWidth - PREVIEW_DIVIDER_WIDTH;
  if (allocatable <= 0) return PREVIEW_MIN_WIDTH;
  return clampPreviewLeftWidth(Math.round((Math.min(100, Math.max(0, ratio)) / 100) * allocatable), containerWidth);
}

/** 同会话比例内存：仅会话内存，不进入 Runtime、SSE、History 或 settings。 */
export function createPreviewRatioMemory() {
  const ratios = new Map<string, number>();
  return {
    /** 读取会话比例；未记录返回 undefined，走 50:50 默认。 */
    get(sessionId: string): number | undefined {
      return ratios.get(sessionId);
    },
    /** 记录会话比例；同一会话覆盖旧值。 */
    set(sessionId: string, ratio: number): void {
      ratios.set(sessionId, ratio);
    },
  };
}

/** 请求代次：新导航/关闭/会话切换时递增，迟到响应按代次丢弃，防覆盖用户选择。 */
export function createRequestGeneration() {
  let generation = 0;
  return {
    /** 分配新代次并返回；旧请求持旧值，写回前必须比对。 */
    next(): number {
      generation += 1;
      return generation;
    },
    /** 判断代次是否仍是最新。 */
    isCurrent(value: number): boolean {
      return value === generation;
    },
  };
}
