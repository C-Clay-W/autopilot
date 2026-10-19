/**
 * Web Stage 4 行为契约：受控 fake sampler 验证 Search First、明确 URL、能力可见性与拒绝终止。
 */

import { describe, expect, it, vi } from "vitest";
import { createAgentRuntime as createInternalAgentRuntime, type AgentLoopEvent } from "../../internal/agent-runtime";
import type { ModelSampler } from "../../internal/kernel/model-sampler";
import { createAgentTextMessage } from "../../internal/types/agent-message";
import { createMemoryPorts } from "../adapters/memory";
import { createAgentRuntime as createPersistedAgentRuntime } from "../public/create-agent-runtime";
import type { WebFetchCapability, WebSearchCapability } from "../protocol";

/** 收集内部 Runtime 的完整事件流。 */
async function collectInternalEvents(runtime: ReturnType<typeof createInternalAgentRuntime>, turnId: string, content: string): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of runtime.run({ turnId, messages: [createAgentTextMessage("user", content)] })) events.push(event);
  return events;
}

/** 判断事件是否是指定 Web 工具开始执行。 */
function isStartedWebTool(event: AgentLoopEvent, toolName: "web_search" | "web_fetch"): boolean {
  return event.type === "tool_started" && event.toolName === toolName;
}

/** 主模型在不同 Web 能力与授权状态下的工具选择契约。 */
describe("Web Stage 4 behavior", function webStage4BehaviorSuite() {
  /** 需要最新事实时 fake sampler 的首个联网动作必须是 Search，结果回到同一 sampler 后才完成。 */
  it("最新信息先调用 web_search", async function searchesBeforeAnsweringLatestFacts() {
    let sampleCount = 0;
    const search = vi.fn(
      /** 返回一个固定公开来源，不触发真实网络。 */
      async function searchPublicFixture() {
        return { answer: "current fixture", sources: [{ title: "Fixture", url: "https://example.com/current" }], truncated: false };
      },
    );
    const sampler: ModelSampler = {
      /** 首轮请求 Search，第二轮读取工具结果后结束。 */
      async sample() {
        sampleCount += 1;
        return sampleCount === 1
          ? { content: "", reasoningSummary: "查询最新公开事实", toolCalls: [{ id: "latest-search", name: "web_search", input: { query: "current fixture" } }] }
          : { content: "已根据公开来源回答。", reasoningSummary: "完成", toolCalls: [] };
      },
    };
    const events = await collectInternalEvents(createInternalAgentRuntime({ modelSampler: sampler, permissionMode: "auto_approve", web: { search: { search } } }), "turn-latest-search", "查询最新公开信息");

    expect(search).toHaveBeenCalledTimes(1);
    expect(events.filter(
      /** 只读取本次联网工具开始事件。 */
      function webStarts(event) { return event.type === "tool_started" && (event.toolName === "web_search" || event.toolName === "web_fetch"); },
    ).map(
      /** 返回稳定工具名以验证调用顺序。 */
      function toolName(event) { return event.type === "tool_started" ? event.toolName : ""; },
    )).toEqual(["web_search"]);
    expect(events.some(
      /** 确认 Turn 在 Search 后正常完成。 */
      function completed(event) { return event.type === "turn_completed"; },
    )).toBe(true);
  });

  /** 用户提供明确 URL 时允许直接 Fetch，不强制制造一次无关 Search。 */
  it("明确 URL 可直接调用 web_fetch", async function fetchesExplicitUrlDirectly() {
    let sampleCount = 0;
    const search: WebSearchCapability = {
      /** 若被调用即表明直接 Fetch 契约被破坏。 */
      async search() { throw new Error("SEARCH_MUST_NOT_RUN"); },
    };
    const fetch = vi.fn(
      /** 返回固定网页文本，不触发真实网络。 */
      async function fetchPublicFixture(input: { url: string }) {
        return { url: input.url, finalUrl: input.url, content: "fixture", contentType: "text/plain", truncated: false };
      },
    );
    const sampler: ModelSampler = {
      /** 首轮直接请求 Fetch，第二轮完成。 */
      async sample() {
        sampleCount += 1;
        return sampleCount === 1
          ? { content: "", reasoningSummary: "读取明确网页", toolCalls: [{ id: "explicit-fetch", name: "web_fetch", input: { url: "https://example.com/known" } }] }
          : { content: "已读取明确网页。", reasoningSummary: "完成", toolCalls: [] };
      },
    };
    const events = await collectInternalEvents(createInternalAgentRuntime({ modelSampler: sampler, permissionMode: "full_access", web: { search, fetch: { fetch } } }), "turn-explicit-fetch", "读取 https://example.com/known");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(events.some(
      /** 查找直接 Fetch 的执行开始事件。 */
      function startedFetch(event) { return isStartedWebTool(event, "web_fetch"); },
    )).toBe(true);
    expect(events.some(
      /** 确认没有额外 Search。 */
      function startedSearch(event) { return isStartedWebTool(event, "web_search"); },
    )).toBe(false);
  });

  /** 未装配 Web capability 时两个工具都不得出现在主模型目录。 */
  it("无能力时 Web 工具不可见", async function hidesUnavailableWebTools() {
    let visibleToolNames: string[] = [];
    const sampler: ModelSampler = {
      /** 记录主模型收到的工具目录后直接结束。 */
      async sample(_messages, tools) {
        visibleToolNames = tools.map(
          /** 只读取公开工具定义名。 */
          function readToolName(tool) { return tool.function.name; },
        );
        return { content: "离线完成。", reasoningSummary: "完成", toolCalls: [] };
      },
    };
    await collectInternalEvents(createInternalAgentRuntime({ modelSampler: sampler }), "turn-no-web", "离线问题");

    expect(visibleToolNames).not.toContain("web_search");
    expect(visibleToolNames).not.toContain("web_fetch");
  });

  /** 用户拒绝 Fetch 审批后必须立即结束，不再次采样替代命令或其他联网路径。 */
  it("拒绝 web_fetch 后不绕过", async function stopsAfterFetchDenial() {
    const ports = createMemoryPorts();
    const sessionId = "session-web-fetch-denial";
    const turnId = "turn-web-fetch-denial";
    let sampleCount = 0;
    const fetch = vi.fn(
      /** 审批拒绝前后都不应真正触发网页读取。 */
      async function forbiddenFetch(input: Parameters<WebFetchCapability["fetch"]>[0]) {
        return { url: input.url, finalUrl: input.url, content: "must not run", contentType: "text/plain", truncated: false };
      },
    );
    const sampler: ModelSampler = {
      /** 首轮请求 Fetch；若拒绝后再次采样则刻意尝试 run_command 以暴露绕过。 */
      async sample() {
        sampleCount += 1;
        return sampleCount === 1
          ? { content: "", reasoningSummary: "读取网页", toolCalls: [{ id: "denied-fetch", name: "web_fetch", input: { url: "https://example.com/known" } }] }
          : { content: "", reasoningSummary: "尝试绕过", toolCalls: [{ id: "forbidden-command", name: "run_command", input: { program: "curl", args: ["https://example.com/known"] } }] };
      },
    };
    await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: 1, updatedAt: 1 });
    const runtime = createPersistedAgentRuntime({ ports, defaultRunConfig: { permissionMode: "ask", modelSampler: sampler, maxSteps: 8, web: { fetch: { fetch } } } });
    const initialEvents = [];
    for await (const event of runtime.turns.start({ sessionId, turnId, content: "读取明确网页" })) initialEvents.push(event);
    const approvalEvent = initialEvents.find(
      /** 查找冻结的 Fetch 审批事件。 */
      function findApproval(event) { return event.type === "approval_required" && event.toolName === "web_fetch"; },
    );
    if (approvalEvent?.type !== "approval_required") throw new Error("web_fetch approval missing");
    const approvalId = approvalEvent.result.approval.approvalId;
    await runtime.approvals.submit({ sessionId, turnId, approvalId, decision: "deny" });
    const resumedEvents = [];
    for await (const event of runtime.turns.continue({ sessionId, turnId, approval: { approvalId, decision: "deny" } })) resumedEvents.push(event);

    expect(sampleCount).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(resumedEvents.some(
      /** Fetch 必须以 denied 终态公开。 */
      function deniedFetch(event) { return event.type === "tool_result" && event.toolName === "web_fetch" && event.result.status === "denied"; },
    )).toBe(true);
    expect(resumedEvents.some(
      /** 拒绝后不得启动备用命令。 */
      function startedFallback(event) { return event.type === "tool_started" && event.toolName === "run_command"; },
    )).toBe(false);
    expect(resumedEvents.some(
      /** 2.5：拒绝路径形成失败终态，不得显示为任务成功完成。 */
      function failed(event) { return event.type === "turn_failed"; },
    )).toBe(true);
  });
});
