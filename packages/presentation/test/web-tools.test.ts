/**
 * Web 工具 Presentation 契约：Profile、文案及 Live/History 只消费 Core 冻结的安全展示事实。
 */

import type { AgentEventEnvelope, ToolDisplayDetail, ToolDisplayFacts } from "@autopilot-agent/core";
import { describe, expect, it } from "vitest";
import {
  createPresentationState,
  getPresentationCopy,
  getToolPresentationProfile,
  reducePresentationInput,
  replayPresentationInputs,
  selectToolCalls,
  type PresentationInput,
  type ToolCallItem,
} from "../src/index.js";

const PRIVATE_QUERY = "PRIVATE_WEB_QUERY";
const PRIVATE_BODY = "PRIVATE_WEB_BODY";

/** 构造固定顺序的 Runtime 事件输入。 */
function runtimeEvent(seq: number, event: AgentEventEnvelope["event"]): PresentationInput {
  return {
    kind: "runtime_event",
    envelope: {
      seq,
      sessionId: "session-web-presentation",
      turnId: "turn-web-presentation",
      timestamp: `2026-09-05T01:00:${String(seq).padStart(2, "0")}.000Z`,
      event,
    },
  };
}

/** 构造只携带安全 display 的成功 Web 工具事件。 */
function webToolResult(seq: number, callId: string, toolName: "web_search" | "web_fetch", display: ToolDisplayFacts): PresentationInput {
  return runtimeEvent(seq, {
    type: "tool_result",
    turnId: "turn-web-presentation",
    stepId: "step-web",
    callId,
    toolName,
    retryCount: 0,
    summary: `${PRIVATE_QUERY}:${PRIVATE_BODY}`,
    result: {
      status: "success",
      callId,
      toolName,
      output: `${PRIVATE_QUERY}:${PRIVATE_BODY}`,
      meta: { durationMs: 1, inputHash: "safe-hash" },
      display,
    },
  });
}

/** 创建 Search 与 Fetch 的运行中、完成和 Turn 终态输入。 */
function createWebPresentationInputs(): PresentationInput[] {
  const searchDetail: ToolDisplayDetail = { kind: "web_search", sourceCount: 3, truncated: true };
  const fetchDetail: ToolDisplayDetail = { kind: "web_fetch", host: "docs.example.com", contentType: "text/html", truncated: false };
  return [
    runtimeEvent(0, { type: "turn_started", turnId: "turn-web-presentation", stepCount: 0 }),
    runtimeEvent(1, { type: "tool_started", turnId: "turn-web-presentation", stepId: "step-web", callId: "search-web", toolName: "web_search", summary: PRIVATE_QUERY }),
    webToolResult(2, "search-web", "web_search", { titleKey: "tool.web_search.completed", summary: "找到 3 个公开来源，结果已截断", detail: searchDetail }),
    runtimeEvent(3, { type: "tool_started", turnId: "turn-web-presentation", stepId: "step-web", callId: "fetch-web", toolName: "web_fetch", summary: PRIVATE_BODY }),
    webToolResult(4, "fetch-web", "web_fetch", { titleKey: "tool.web_fetch.completed", target: "docs.example.com", summary: "已读取 text/html", detail: fetchDetail }),
    runtimeEvent(5, { type: "turn_completed", turnId: "turn-web-presentation", checkpoint: {} }),
  ];
}

/** 按 callId 读取唯一 Web 工具节点。 */
function findWebCall(calls: ToolCallItem[], callId: string): ToolCallItem {
  const call = calls.find(
    /** 匹配当前测试指定的稳定调用身份。 */
    function matchesCall(candidate) { return candidate.callId === callId; },
  );
  if (!call) throw new Error(`missing call ${callId}`);
  return call;
}

/** Web 工具从 Profile 到 Live/History 状态的共享展示契约。 */
describe("Web 工具 Presentation", function webToolPresentationSuite() {
  /** 取消后继续复用 Turn 标识，旧总结不再代表恢复后的当前执行状态。 */
  it("继续同一 Turn 后不残留中断总结", function clearsResumedSummary() {
    const state = replayPresentationInputs([
      runtimeEvent(0, { type: "turn_started", turnId: "turn-web-presentation", stepCount: 0 }),
      runtimeEvent(1, { type: "turn_interrupted", turnId: "turn-web-presentation", checkpoint: {} }),
      runtimeEvent(2, { type: "turn_started", turnId: "turn-web-presentation", stepCount: 1 }),
    ]);
    expect(state.turnSummary).toBeUndefined();
    expect(state.items.some(item => item.kind === "turn_summary")).toBe(false);
  });
  /** 同一次抓取的目标域名审批替代起始域名审批，刷新回放也不能复活旧按钮。 */
  it("跨域 Fetch 只保留最新域名审批", function supersedesRedirectApproval() {
    const inputs = ["origin", "target"].map(function approvalForHost(host, index) {
      return runtimeEvent(index, {
        type: "approval_required", turnId: "turn-web-presentation", stepId: "step-web", callId: "fetch-web", toolName: "web_fetch",
        result: { status: "approval_required", callId: "fetch-web", toolName: "web_fetch", approval: {
          approvalId: host, callId: "fetch-web", toolName: "web_fetch", normalizedInputHash: "hash", reason: "域名审批", risk: "external_side_effect", preview: {}, expiresAt: "2026-09-06T00:00:00.000Z",
          allowedDecisions: ["allow_once", "deny"],
        } },
      });
    });
    const live = inputs.reduce(reducePresentationInput, createPresentationState());
    const history = replayPresentationInputs(inputs);
    expect(live).toEqual(history);
    expect(history.items.filter(item => item.kind === "approval" && item.state === "required")).toMatchObject([{ approvalId: "target" }]);
    expect(history.items.find(item => item.kind === "approval" && item.approvalId === "origin")).toMatchObject({ state: "resolved" });
  });
  /** Search 与 Fetch 使用专用外部工具 Profile，且不得进入本地代码探索分组。 */
  it("提供统一专用 Profile 与中文文案", function exposesDedicatedProfiles() {
    expect(getToolPresentationProfile("web_search")).toEqual({ key: "web_search", category: "external", runningTitleKey: "tool.web_search.running", completedTitleKey: "tool.web_search.completed", explorationGroup: false });
    expect(getToolPresentationProfile("web_fetch")).toEqual({ key: "web_fetch", category: "external", runningTitleKey: "tool.web_fetch.running", completedTitleKey: "tool.web_fetch.completed", explorationGroup: false });
    expect(getToolPresentationProfile("rag_search")).toEqual({ key: "rag_search", category: "search", runningTitleKey: "tool.search.running", completedTitleKey: "tool.search.completed", explorationGroup: true });
    expect(getPresentationCopy("tool.web_search.running")).toBe("正在搜索网络");
    expect(getPresentationCopy("tool.web_fetch.completed")).toBe("网页读取");
  });

  /** Live 增量与 History 回放保留完全相同的安全明细和专用标题。 */
  it("保持 Live 与 History 同构且不回读 raw 字段", function keepsLiveHistoryParity() {
    const inputs = createWebPresentationInputs();
    const live = inputs.reduce(reducePresentationInput, createPresentationState());
    const history = replayPresentationInputs(inputs);
    const liveCalls = selectToolCalls(live, "turn-web-presentation");
    const historyCalls = selectToolCalls(history, "turn-web-presentation");

    expect(liveCalls).toEqual(historyCalls);
    expect(findWebCall(historyCalls, "search-web")).toMatchObject({ profileKey: "web_search", category: "external", titleKey: "tool.web_search.completed", detail: { kind: "web_search", sourceCount: 3, truncated: true } });
    expect(findWebCall(historyCalls, "fetch-web")).toMatchObject({ profileKey: "web_fetch", category: "external", titleKey: "tool.web_fetch.completed", target: "docs.example.com", detail: { kind: "web_fetch", contentType: "text/html", truncated: false } });
    expect(JSON.stringify(history)).not.toContain(PRIVATE_QUERY);
    expect(JSON.stringify(history)).not.toContain(PRIVATE_BODY);
  });
});
