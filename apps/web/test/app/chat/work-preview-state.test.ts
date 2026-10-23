/** Work 预览纯状态定向测试：交付选择、面板状态机、宽度计算与请求代次。 */

import { describe, expect, it } from "vitest";
import type { AgentPresentationState, ToolCallItem } from "@autopilot-agent/presentation";
import {
  admitAutoOpenPreview,
  canAutoOpenPreview,
  clampPreviewLeftWidth,
  createPreviewAutoOpenSuppression,
  createPreviewRatioMemory,
  createRequestGeneration,
  closedPreview,
  evaluateAfterTurnCandidate,
  findPreviewCandidateTurnId,
  initialPreviewLeftWidth,
  invalidatePendingAutoCandidates,
  isDualPaneCapable,
  listPreviewCandidates,
  listStartedPreviewCalls,
  previewFailed,
  previewLoaded,
  previewEmbeddingUnknown,
  previewRatioToWidth,
  previewTargetReady,
  previewWidthToRatio,
  selectTurnPreviewDelivery,
  startPreviewResolve,
  suppressAutoOpenTurn,
  PREVIEW_DIVIDER_WIDTH,
  PREVIEW_MIN_WIDTH,
  type TurnPreviewDelivery,
} from "@/app/chat/work-preview-state";

/** 构造带 open_preview 明细的已完成工具调用。 */
function openPreviewCall(turnId: string, previewId: string, state: ToolCallItem["state"] = "completed", openWhen: "now" | "after_turn" = "now", category: ToolCallItem["category"] = "external"): ToolCallItem {
  return {
    id: "item-" + previewId, kind: "tool_call", turnId, callId: "call-" + previewId, toolName: "open_preview",
    profileKey: "p", category, state, titleKey: "t",
    detail: { kind: "open_preview", previewId, hostLabel: "127.0.0.1:5173", copyUrl: "http://127.0.0.1:5173/demo", openWhen, state: "prepared" },
  };
}

/** 构造普通工具调用（无 open_preview 明细）。 */
function plainCall(turnId: string, name: string, category: ToolCallItem["category"], state: ToolCallItem["state"] = "completed"): ToolCallItem {
  return { id: "item-" + name + "-" + state, kind: "tool_call", turnId, callId: "call-" + name, toolName: name, profileKey: "p", category, state, titleKey: "t" };
}

/** 构造终态摘要。 */
function summaryItem(turnId: string, state: "completed" | "failed" | "limit_reached" | "interrupted") {
  return { id: "sum-" + turnId + "-" + state, kind: "turn_summary" as const, turnId, state, toolCount: 1 };
}

/** 组装 presentation 状态。 */
function stateWithItems(items: Array<ToolCallItem | ReturnType<typeof summaryItem>>): AgentPresentationState {
  return { items, appliedEventIds: [], lastSeqByTurn: {}, turnStartedAt: {} } as unknown as AgentPresentationState;
}

function stateWith(items: ToolCallItem[]): AgentPresentationState {
  return { items, appliedEventIds: [], lastSeqByTurn: {}, turnStartedAt: {} };
}

describe("evaluateAfterTurnCandidate", function suite() {
  const AFTER_TURN: TurnPreviewDelivery = { previewId: "pvw-a", callId: "call-pvw-a", hostLabel: "127.0.0.1:5173", copyUrl: "http://127.0.0.1:5173/demo", openWhen: "after_turn" };

  it("正常终态且交付后无失败/写工具时返回交付事实", function eligible() {
    const state = stateWithItems([openPreviewCall("t1", "pvw-a", "completed", "after_turn"), summaryItem("t1", "completed")]);
    expect(evaluateAfterTurnCandidate(state, "t1")).toEqual(AFTER_TURN);
    const withRead = stateWithItems([openPreviewCall("t1", "pvw-a", "completed", "after_turn"), plainCall("t1", "read_file", "read"), summaryItem("t1", "completed")]);
    expect(evaluateAfterTurnCandidate(withRead, "t1")).toEqual(AFTER_TURN);
  });

  it("宿主标记 autoOpen=false 的交付保留结果入口但不自动展开", function keepsManualDelivery() {
    const call = openPreviewCall("t1", "pvw-a", "completed", "after_turn");
    const state = stateWithItems([{ ...call, detail: { ...call.detail!, autoOpen: false } as typeof call.detail }, summaryItem("t1", "completed")]);
    const delivery = evaluateAfterTurnCandidate(state, "t1");
    expect(delivery?.autoOpen).toBe(false);
    expect(delivery?.previewId).toBe("pvw-a");
  });

  it("终态非 completed（失败/取消/limit）或缺失摘要时不触发", function terminalGate() {
    expect(evaluateAfterTurnCandidate(stateWithItems([openPreviewCall("t1", "pvw-a", "completed", "after_turn"), summaryItem("t1", "failed")]), "t1")).toBeUndefined();
    expect(evaluateAfterTurnCandidate(stateWithItems([openPreviewCall("t1", "pvw-a", "completed", "after_turn"), summaryItem("t1", "limit_reached")]), "t1")).toBeUndefined();
    expect(evaluateAfterTurnCandidate(stateWithItems([openPreviewCall("t1", "pvw-a", "completed", "after_turn")]), "t1")).toBeUndefined();
  });

  it("交付之后出现失败/拒绝/取消调用或写/编辑/命令工具即失去资格", function postDeliveryDisqualifiers() {
    const base = function base(state: ToolCallItem["state"], category: ToolCallItem["category"]) {
      return stateWithItems([openPreviewCall("t1", "pvw-a", "completed", "after_turn"), plainCall("t1", "x", category, state), summaryItem("t1", "completed")]);
    };
    expect(evaluateAfterTurnCandidate(base("failed", "read"), "t1")).toBeUndefined();
    expect(evaluateAfterTurnCandidate(base("denied", "read"), "t1")).toBeUndefined();
    expect(evaluateAfterTurnCandidate(base("cancelled", "read"), "t1")).toBeUndefined();
    expect(evaluateAfterTurnCandidate(base("timeout", "read"), "t1")).toBeUndefined();
    expect(evaluateAfterTurnCandidate(base("completed", "write"), "t1")).toBeUndefined();
    expect(evaluateAfterTurnCandidate(base("completed", "edit"), "t1")).toBeUndefined();
    expect(evaluateAfterTurnCandidate(base("completed", "command"), "t1")).toBeUndefined();
  });

  it("交付之前的写工具不影响资格；now 交付不走此评估", function beforeDeliveryAndNow() {
    const state = stateWithItems([plainCall("t1", "write_file", "write"), openPreviewCall("t1", "pvw-a", "completed", "after_turn"), summaryItem("t1", "completed")]);
    expect(evaluateAfterTurnCandidate(state, "t1")).toEqual(AFTER_TURN);
    const nowState = stateWithItems([openPreviewCall("t1", "pvw-n", "completed", "now"), summaryItem("t1", "completed")]);
    expect(evaluateAfterTurnCandidate(nowState, "t1")).toBeUndefined();
  });
});

describe("selectTurnPreviewDelivery", function suite() {
  it("正常终态下取本轮最后一次成功交付，忽略失败调用与其他 Turn", function picksLastCompleted() {
    const state = stateWithItems([
      openPreviewCall("t1", "pvw-1"),
      openPreviewCall("t1", "pvw-2", "failed"),
      openPreviewCall("t1", "pvw-3"),
      openPreviewCall("t2", "pvw-other"),
      summaryItem("t1", "completed"),
      summaryItem("t2", "completed"),
    ]);
    expect(selectTurnPreviewDelivery(state, "t1")).toEqual({
      previewId: "pvw-3", callId: "call-pvw-3", hostLabel: "127.0.0.1:5173", copyUrl: "http://127.0.0.1:5173/demo", openWhen: "now",
    });
  });

  it("运行中、失败、取消与 limit 都没有正常结果尾部（AC-8）", function terminalGate() {
    const calls = [openPreviewCall("t1", "pvw-1")];
    expect(selectTurnPreviewDelivery(stateWithItems(calls), "t1")).toBeUndefined();
    expect(selectTurnPreviewDelivery(stateWithItems([...calls, summaryItem("t1", "failed")]), "t1")).toBeUndefined();
    expect(selectTurnPreviewDelivery(stateWithItems([...calls, summaryItem("t1", "interrupted")]), "t1")).toBeUndefined();
    expect(selectTurnPreviewDelivery(stateWithItems([...calls, summaryItem("t1", "limit_reached")]), "t1")).toBeUndefined();
  });

  it("交付之后的失败/拒绝调用或写工具使候选失去正常结果尾部", function postDeliveryDisqualifiers() {
    const base = function base(state: ToolCallItem["state"], category: ToolCallItem["category"]) {
      return stateWithItems([openPreviewCall("t1", "pvw-a", "completed", "after_turn"), plainCall("t1", "x", category, state), summaryItem("t1", "completed")]);
    };
    expect(selectTurnPreviewDelivery(base("denied", "read"), "t1")).toBeUndefined();
    expect(selectTurnPreviewDelivery(base("cancelled", "read"), "t1")).toBeUndefined();
    expect(selectTurnPreviewDelivery(base("completed", "write"), "t1")).toBeUndefined();
    expect(selectTurnPreviewDelivery(base("completed", "read"), "t1")).toEqual({
      previewId: "pvw-a", callId: "call-pvw-a", hostLabel: "127.0.0.1:5173", copyUrl: "http://127.0.0.1:5173/demo", openWhen: "after_turn",
    });
  });

  it("无交付或仅有失败调用时没有结果尾部资格", function noDeliveryWithoutSuccess() {
    expect(selectTurnPreviewDelivery(stateWithItems([summaryItem("t1", "completed")]), "t1")).toBeUndefined();
    expect(selectTurnPreviewDelivery(stateWithItems([openPreviewCall("t1", "pvw-1", "denied"), summaryItem("t1", "completed")]), "t1")).toBeUndefined();
  });
});

describe("面板状态机", function suite() {
  it("closed → resolving → opening → displayed 单向推进", function forwardPhases() {
    const target = { source: "tool_delivery" as const, previewId: "pvw-1", turnId: "t1", hostLabel: "h", navigationUrl: "http://127.0.0.1:5173/", sandboxProfile: "trusted_local" as const, serviceState: "ready" as const, canStop: true };
    const resolving = startPreviewResolve(target);
    expect(resolving.phase).toBe("resolving");
    const opening = previewTargetReady(target);
    expect(opening.phase).toBe("opening");
    expect(previewLoaded(opening).phase).toBe("displayed");
    expect(previewLoaded(closedPreview()).phase).toBe("closed");
  });

  it("opening 超时进入 embedding_unknown，失败携带安全文案", function failurePhases() {
    const opening = previewTargetReady({ source: "user_link", hostLabel: "h", navigationUrl: "http://127.0.0.1:5173/", sandboxProfile: "strict_public", serviceState: "unchecked", canStop: false });
    expect(previewEmbeddingUnknown(opening).phase).toBe("embedding_unknown");
    const failed = previewFailed(startPreviewResolve(null), "预览目标地址不符合首期支持范围");
    expect(failed.phase).toBe("unavailable");
    expect(failed.errorMessage).toContain("首期支持范围");
  });
});

describe("宽度与比例", function suite() {
  it("648px 以下不启用双栏，648px 恰好可用", function dualGate() {
    expect(isDualPaneCapable(647)).toBe(false);
    expect(isDualPaneCapable(648)).toBe(true);
  });

  it("左栏宽度钳制到 [320, C−8−320]，初始为 50:50", function clampAndInit() {
    expect(clampPreviewLeftWidth(100, 1000)).toBe(PREVIEW_MIN_WIDTH);
    expect(clampPreviewLeftWidth(900, 1000)).toBe(1000 - PREVIEW_DIVIDER_WIDTH - PREVIEW_MIN_WIDTH);
    expect(initialPreviewLeftWidth(1008)).toBe(500);
    expect(clampPreviewLeftWidth(100, 0)).toBe(PREVIEW_MIN_WIDTH);
  });

  it("比例与宽度互转并按新容器钳制，比例内存按会话覆盖", function ratioRoundTrip() {
    expect(previewWidthToRatio(500, 1008)).toBe(50);
    expect(previewRatioToWidth(50, 1008)).toBe(500);
    expect(previewRatioToWidth(50, 648)).toBe(320);
    const memory = createPreviewRatioMemory();
    expect(memory.get("s1")).toBeUndefined();
    memory.set("s1", 60);
    memory.set("s1", 70);
    expect(memory.get("s1")).toBe(70);
    expect(memory.get("s2")).toBeUndefined();
  });
});

describe("请求代次", function suite() {
  it("新导航递增代次，迟到响应不再生效", function generationGuard() {
    const gen = createRequestGeneration();
    const first = gen.next();
    expect(gen.isCurrent(first)).toBe(true);
    const second = gen.next();
    expect(gen.isCurrent(first)).toBe(false);
    expect(gen.isCurrent(second)).toBe(true);
  });
});

describe("自动导航可见性（AC-5）", function suite() {
  it("仅可见活动实例允许自动打开，隐藏/只读/后台标签都只留入口", function gatedByVisibility() {
    expect(canAutoOpenPreview({ active: true, readOnly: false, documentVisible: true })).toBe(true);
    expect(canAutoOpenPreview({ active: false, readOnly: false, documentVisible: true })).toBe(false);
    expect(canAutoOpenPreview({ active: true, readOnly: true, documentVisible: true })).toBe(false);
    expect(canAutoOpenPreview({ active: true, readOnly: false, documentVisible: false })).toBe(false);
  });
});

describe("用户动作与自动打开抑制（AC-7）", function suite() {
  it("用户动作只淘汰此前已存在的候选，动作之后的新候选仍按实时规则判定", function invalidatesEarlierCandidates() {
    const suppression = createPreviewAutoOpenSuppression();
    const consumed = new Set<string>();
    invalidatePendingAutoCandidates(suppression, listPreviewCandidates(stateWith([openPreviewCall("t1", "pvw-old", "completed", "after_turn")])));
    expect(admitAutoOpenPreview({ suppression, consumed, turnId: "t1", previewId: "pvw-old", callId: "call-pvw-old", visible: true })).toBe(false);
    expect(admitAutoOpenPreview({ suppression, consumed, turnId: "t1", previewId: "pvw-new", callId: "call-pvw-new", visible: true })).toBe(true);
  });

  it("关闭抑制提升到 Turn：同 Turn 新候选不再弹回，不同 Turn 不受影响（判定 6）", function suppressesClosedTurn() {
    const suppression = createPreviewAutoOpenSuppression();
    const consumed = new Set<string>();
    suppressAutoOpenTurn(suppression, "t1");
    expect(admitAutoOpenPreview({ suppression, consumed, turnId: "t1", previewId: "pvw-new", callId: "call-pvw-new", visible: true })).toBe(false);
    expect(admitAutoOpenPreview({ suppression, consumed, turnId: "t2", previewId: "pvw-new", callId: "call-pvw-new", visible: true })).toBe(true);
  });

  it("resolving 阶段关闭可用 previewId 反查 Turn 身份", function resolvesTurnWhileResolving() {
    const candidates = listPreviewCandidates(stateWith([openPreviewCall("t1", "pvw-old"), openPreviewCall("t2", "pvw-other")]));
    expect(findPreviewCandidateTurnId(candidates, "pvw-old")).toBe("t1");
    expect(findPreviewCandidateTurnId(candidates, "pvw-other")).toBe("t2");
    expect(findPreviewCandidateTurnId(candidates, "pvw-missing")).toBeUndefined();
    expect(findPreviewCandidateTurnId(candidates, undefined)).toBeUndefined();
  });

  it("动作前已开始、动作后才完成的调用不得覆盖用户选择", function invalidatesEarlierStartedCall() {
    const suppression = createPreviewAutoOpenSuppression();
    const consumed = new Set<string>();
    const started = listStartedPreviewCalls(stateWith([openPreviewCall("t1", "pvw-running", "running")]));
    invalidatePendingAutoCandidates(suppression, [], started);
    expect(admitAutoOpenPreview({ suppression, consumed, turnId: "t1", previewId: "pvw-running", callId: "call-pvw-running", visible: true })).toBe(false);
    // 动作之后才开始的新调用仍按实时规则判定。
    expect(admitAutoOpenPreview({ suppression, consumed, turnId: "t1", previewId: "pvw-new", callId: "call-pvw-new", visible: true })).toBe(true);
  });

  it("同一候选只准入一次；隐藏实例消费后返回不补开", function consumedOnceAndVisibility() {
    const suppression = createPreviewAutoOpenSuppression();
    const consumed = new Set<string>();
    expect(admitAutoOpenPreview({ suppression, consumed, turnId: "t1", previewId: "pvw-a", callId: "call-pvw-a", visible: false })).toBe(false);
    expect(admitAutoOpenPreview({ suppression, consumed, turnId: "t1", previewId: "pvw-a", callId: "call-pvw-a", visible: true })).toBe(false);
    expect(consumed.has("t1:pvw-a")).toBe(true);
    expect(admitAutoOpenPreview({ suppression, consumed, turnId: "t1", previewId: "pvw-b", callId: "call-pvw-b", visible: true })).toBe(true);
  });
});
