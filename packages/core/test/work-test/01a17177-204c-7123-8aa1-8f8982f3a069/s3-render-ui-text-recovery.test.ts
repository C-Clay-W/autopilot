/** S3 窄文字收口：仅真实内置UI输入错误可恢复，权限、混合批次与预算仍关闭。 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runKernel } from "../../../src/internal/kernel/agent-kernel";
import type { RunContext } from "../../../src/internal/kernel/run-context";
import type { ModelSampler } from "../../../src/internal/kernel/model-sampler";
import { createRenderUiTool } from "../../../src/internal/tools/builtins/render-ui-tool";
import { createWebSearchTool } from "../../../src/internal/tools/builtins/web-search-tool";
import { createChatToolRuntime } from "../../../src/internal/tools/chat-tool-runtime";
import { ToolRegistry } from "../../../src/internal/tools/tool-registry";
import { createToolError } from "../../../src/internal/tools/tool-error";
import { createAgentTextMessage } from "../../../src/internal/types/agent-message";
import { AgentSampleError, type AgentSampleResult } from "../../../src/internal/lib/llm";
import type { AgentCheckpoint, AgentLoopEvent } from "../../../src/internal/agent-runtime";
import { sanitizeCheckpoint } from "../../../src/runtime/protocol/sanitize-checkpoint";

/** 未知组件保持结构拒绝；合法Text形状可承载深层未声明state引用。 */
function input(deep = false) {
  return { title: "合成说明", fallbackText: "普通文字", spec: { root: "x", elements: {
    x: deep ? { type: "Text", props: { value: { $state: "/missing" }, size: "md", tone: "ink" } } : { type: "UnknownNode", props: {} },
  } } };
}

/** 返回单个UI调用，所有内容均为无隐私合成数据。 */
function uiSample(value: unknown = input()): AgentSampleResult {
  return { content: "", reasoningSummary: "", toolCalls: [{ id: "bad-ui", name: "render_ui", input: value }] };
}

/** 生成最小且精确的 Chat ceiling，Web 仅额外允许原 Search/Fetch 工具。 */
function ceilingFor(retrievalMode: "none" | "web") {
  return { productMode: "chat" as const, chatRetrievalMode: retrievalMode, allowedTools: retrievalMode === "none" ? ["render_ui", "chat_attachment_read"] : ["render_ui", "web_search", "web_fetch", "chat_attachment_read"] };
}

/** 复用真实Kernel、Chat capability和内置定义，handler spy只观察是否被调度。 */
function fixture(sampler: ModelSampler, extra: Partial<RunContext> = {}) {
  const ceiling = extra.capabilityCeiling ?? { productMode: "chat" as const, chatRetrievalMode: "none" as const, allowedTools: ["render_ui", "chat_attachment_read"] };
  const registry = new ToolRegistry(ceiling);
  const publish = vi.fn();
  const definition = createRenderUiTool(publish);
  const execute = vi.spyOn(definition, "execute");
  registry.register(definition);
  const context: RunContext = {
    turnId: "s3-ui-recovery", messages: [createAgentTextMessage("user", "请说明")],
    capabilityCeiling: ceiling, toolRegistry: registry, permissionContext: { mode: "auto_approve" },
    chat: createChatToolRuntime({ sessionId: "s", turnId: "s3-ui-recovery", retrievalMode: ceiling.chatRetrievalMode ?? "none" }, { interactiveUi: true }, [], Date.now),
    modelSampler: sampler, maxSteps: 3, maxToolRetries: 0, ...extra,
  };
  return { context, registry, definition, execute, publish };
}

/** 收集离线事件，不读取模型消息或打印原输入。 */
async function collect(context: RunContext): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of runKernel(context)) events.push(event);
  return events;
}

/** 从真实终态取私有checkpoint，供恢复与预算断言。 */
function checkpoint(events: AgentLoopEvent[]): AgentCheckpoint {
  const event = events.at(-1);
  if (!event || !("checkpoint" in event) || !event.checkpoint) throw new Error("FIXTURE_TERMINAL_MISSING");
  return event.checkpoint;
}

describe("S3 render_ui text-only recovery", function suite() {
  it.each(["none", "web"] as const)("Chat %s 的深层语义非法仍拒绝UI并只给无工具文字", async function deepFailure(retrievalMode) {
    let samples = 0;
    const f = fixture({
      /** 结构合法但引用未声明，真实handler负责深层拒绝。 */
      async sample(_messages, tools, options) {
        if (++samples === 1) return uiSample(input(true));
        expect(tools).toEqual([]);
        expect(options.toolChoice).toBeUndefined();
        return { content: "普通文字说明", reasoningSummary: "", toolCalls: [] };
      },
    }, { capabilityCeiling: ceilingFor(retrievalMode), modelSampleOptions: { toolChoice: { name: "render_ui" } } });
    const events = await collect(f.context);
    expect(samples).toBe(2);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
    expect(events.some(function ui(event) { return event.type === "ui_document"; })).toBe(false);
    expect(events.find(function error(event) { return event.type === "tool_result"; })).toMatchObject({ result: { status: "error", error: { code: "INVALID_INPUT", message: expect.stringContaining("改用普通文字") } } });
    expect(events.some(function text(event) { return event.type === "answer_delta" && event.delta.includes("普通文字"); })).toBe(true);
    expect(events.at(-1)?.type).toBe("turn_completed");
  });

  /** 结构schema拒绝时不执行内置handler，Web 也只沿原预算文字收口。 */
  it.each(["none", "web"] as const)("Chat %s 的输入schema拒绝只收口一次普通文字", async function schemaFailure(retrievalMode) {
    let samples = 0;
    const f = fixture({
      /** 首次返回未知节点，第二次必须无工具采样。 */
      async sample(_messages, tools, options) {
        if (++samples === 1) return uiSample();
        expect(tools).toEqual([]);
        expect(options.toolChoice).toBeUndefined();
        return { content: "普通文字说明", reasoningSummary: "", toolCalls: [] };
      },
    }, { capabilityCeiling: ceilingFor(retrievalMode), modelSampleOptions: { toolChoice: { name: "render_ui" } } });

    const events = await collect(f.context);

    expect(samples).toBe(2);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(events.some(function ui(event) { return event.type === "ui_document"; })).toBe(false);
    expect(events.find(function error(event) { return event.type === "tool_result"; })).toMatchObject({ result: { status: "error", error: { code: "INVALID_INPUT", message: expect.stringContaining("改用普通文字") } } });
    expect(events.at(-1)?.type).toBe("turn_completed");
  });

  /** 孤立草稿触发既有结构拒绝后，只允许一次无工具文字收口。 */
  it.each(["none", "web"] as const)("Chat %s 的未引用节点不发布UI且沿窄文字路径收口", async function orphanElementFallsBackToText(retrievalMode) {
    const invalidInput = {
      title: "合成讲解",
      fallbackText: "用普通文字说明概念。",
      spec: {
        root: "tabs",
        elements: {
          tabs: { type: "Tabs", props: { items: [{ key: "overview", label: "概念" }, { key: "example", label: "例子" }] }, slots: { items: ["overview-panel", "example-panel"] } },
          "overview-panel": { type: "Text", props: { value: "合法可达面板", size: "sm", tone: "ink" } },
          "example-panel": { type: "Text", props: { value: "合法第二面板", size: "sm", tone: "ink" } },
          neg_placeholder: { type: "Text", props: { value: "孤立占位", size: "sm", tone: "ink" } },
        },
      },
    };
    let samples = 0;
    const f = fixture({
      /** 首次返回含孤立占位节点的模型输入，第二次只生成普通文字。 */
      async sample(_messages, tools, options) {
        if (++samples === 1) return uiSample(invalidInput);
        expect(tools).toEqual([]);
        expect(options.toolChoice).toBeUndefined();
        return { content: "普通文字说明", reasoningSummary: "", toolCalls: [] };
      },
    }, { capabilityCeiling: ceilingFor(retrievalMode), modelSampleOptions: { toolChoice: { name: "render_ui" } } });

    const events = await collect(f.context);

    expect(samples).toBe(2);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
    expect(events.some(function ui(event) { return event.type === "ui_document"; })).toBe(false);
    expect(events.find(function error(event) { return event.type === "tool_result"; })).toMatchObject({
      result: { status: "error", error: { code: "INVALID_INPUT", message: expect.stringContaining("改用普通文字") } },
    });
    expect(events.some(function text(event) { return event.type === "answer_delta" && event.delta.includes("普通文字说明"); })).toBe(true);
    expect(events.at(-1)?.type).toBe("turn_completed");
  });

  it.each(["forged-definition", "validate-input", "other-tool", "ceiling-disabled", "web-capability-disabled", "mode-mismatch"])("%s不因同名或INVALID_INPUT获得恢复", async function rejectUntrusted(mode) {
    let samples = 0;
    const f = fixture({
      /** 只有首步调用；错误恢复将通过采样次数暴露。 */
      async sample() { samples++; return mode === "other-tool" ? { ...uiSample(), toolCalls: [{ id: "other", name: "chat_attachment_read", input: {} }] } : uiSample(mode === "validate-input" ? { title: "合成", fallbackText: "", spec: { root: "x", elements: { x: { type: "Card", props: {} } } } } : input()); },
    }, mode === "ceiling-disabled" ? { capabilityCeiling: { productMode: "chat", chatRetrievalMode: "none", allowedTools: [] } }
      : mode === "web-capability-disabled" || mode === "mode-mismatch" ? {
        capabilityCeiling: { productMode: "chat", chatRetrievalMode: "web", allowedTools: mode === "mode-mismatch" ? ["render_ui"] : ["web_search", "web_fetch"] },
        ...(mode === "mode-mismatch" ? { chat: createChatToolRuntime({ sessionId: "s", turnId: "s3-ui-recovery", retrievalMode: "none" }, { interactiveUi: true }, [], Date.now) } : {}),
      } : {});
    if (mode === "forged-definition") { f.registry.unregister("render_ui"); f.registry.register({ ...f.definition }); }
    if (mode === "validate-input") f.definition.validateInput = async function deny() { throw createToolError("INVALID_INPUT", "固定引用拒绝"); };
    if (mode === "other-tool") f.registry.register({ name: "chat_attachment_read", description: "合成", inputSchema: z.object({ ref: z.string() }), metadata: { effect: "none", destructive: false, concurrency: { max: 1 }, retry: { safe: false } },
      /** 合成工具不得被调度。 */
      createActionFacts() { return { toolName: "chat_attachment_read", effect: "none", destructive: false, operation: "合成" }; },
      /** 若预检失效则用固定失败标记暴露。 */
      async execute() { throw new Error("UNEXPECTED_HANDLER"); },
    });
    const events = await collect(f.context);
    expect(samples).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(events.some(function started(event) { return event.type === "tool_started"; })).toBe(false);
    expect(events.at(-1)?.type).toBe("turn_failed");
    expect(checkpoint(events).uiTextFallbackOnly).toBeUndefined();
  });

  /** 即使UI输入本身合法schema，和Web Search的混合批次也必须整体预检失败。 */
  it("Web UI非法输入与合法Search混合时整批fail-closed", async function rejectsMixedWebBatch() {
    let samples = 0;
    const f = fixture({
      /** Search 输入合法，但任何混合批次都不得执行。 */
      async sample() { samples++; return { content: "", reasoningSummary: "", toolCalls: [uiSample().toolCalls[0], { id: "search", name: "web_search", input: { query: "合成查询" } }] }; },
    }, { capabilityCeiling: ceilingFor("web") });
    const searchTool = createWebSearchTool({ async search() { return { answer: "合成", sources: [], truncated: false }; } });
    const searchExecute = vi.spyOn(searchTool, "execute");
    f.registry.register(searchTool);

    const events = await collect(f.context);

    expect(samples).toBe(1);
    expect(searchExecute).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(events.some(function started(event) { return event.type === "tool_started"; })).toBe(false);
    expect(events.at(-1)?.type).toBe("turn_failed");
    expect(checkpoint(events).uiTextFallbackOnly).toBeUndefined();
  });

  it.each([false, true])("混合禁止工具批次不恢复、不dispatch，禁止项在前=%s", async function mixedBatch(forbiddenFirst) {
    let samples = 0;
    const forbidden = { id: "forbidden", name: "run_command", input: { command: "synthetic" } };
    const ui = uiSample().toolCalls[0];
    const f = fixture({
      /** 两种顺序都不能以UI输入错误掩盖越权调用。 */
      async sample() { samples++; return { content: "", reasoningSummary: "", toolCalls: forbiddenFirst ? [forbidden, ui] : [ui, forbidden] }; },
    });
    const events = await collect(f.context);
    expect(samples).toBe(1);
    expect(events.filter(function result(event) { return event.type === "tool_result"; })).toHaveLength(2);
    expect(events.some(function started(event) { return event.type === "tool_started"; })).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe("turn_failed");
    expect(checkpoint(events).uiTextFallbackOnly).toBeUndefined();
  });

  it.each(["steps", "tokens"])("%s耗尽不额外采样、不把limit当完成", async function exhaustedBudget(mode) {
    let samples = 0;
    const f = fixture({
      /** 首步耗尽指定预算，恢复不能增加第二次采样。 */
      async sample() { samples++; return { ...uiSample(), usage: { inputTokens: 8, outputTokens: 2, contextTokens: 10 } }; },
    }, mode === "steps" ? { maxSteps: 1 } : { maxTotalTokens: 10 });
    const events = await collect(f.context);
    expect(samples).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(events.some(function completed(event) { return event.type === "turn_completed"; })).toBe(false);
    expect(checkpoint(events).uiTextFallbackOnly).toBe(true);
    expect(f.publish).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe(mode === "steps" ? "turn_limit_reached" : "turn_failed");
    if (mode === "tokens") {
      expect(events.at(-1)).toMatchObject({
        termination: { reason: "token_budget", budget: { used: 10, limit: 10, unit: "tokens" } },
      });
    }
  });

  it("私有checkpoint恢复仍只给文字，公开投影不暴露标记", async function resumeTextOnly() {
    const f = fixture({
      /** 首段只有一个模型步骤。 */
      async sample() { return uiSample(); },
    }, { maxSteps: 1 });
    const first = await collect(f.context);
    const saved = structuredClone(checkpoint(first));
    expect(saved.uiTextFallbackOnly).toBe(true);
    expect(JSON.stringify(sanitizeCheckpoint(saved))).not.toContain("uiTextFallbackOnly");
    let resumedSamples = 0;
    const resumed = fixture({
      /** 重建Kernel后也必须撤掉全部工具。 */
      async sample(_messages, tools) { resumedSamples++; expect(tools).toEqual([]); return { content: "普通文字说明", reasoningSummary: "", toolCalls: [] }; },
    }, { checkpoint: saved, messages: saved.messages, maxSteps: 1 });
    const events = await collect(resumed.context);
    expect(resumedSamples).toBe(1);
    expect(resumed.execute).not.toHaveBeenCalled();
    expect(checkpoint(events).completedCallIds).toContain("bad-ui");
    expect(checkpoint(events).uiTextFallbackOnly).toBe(true);
    expect(events.at(-1)?.type).toBe("turn_completed");
  });

  it("无工具文字阶段仍返回UI调用时直接终止，不给第三次修复机会", async function noRepairLoop() {
    let samples = 0;
    const f = fixture({
      /** 第二次故意违反无工具限制，Kernel不能dispatch。 */
      async sample() { samples++; return uiSample(); },
    });
    const events = await collect(f.context);
    expect(samples).toBe(2);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe("turn_failed");
  });

  it("UI拒绝后取消直接收敛到中断终态，不采样文字或挂起", async function cancelBeforeText() {
    const controller = new AbortController();
    let samples = 0;
    const f = fixture({
      /** 拒绝工具后由测试取消，不能再发起采样。 */
      async sample() { samples++; return uiSample(); },
    }, { signal: controller.signal });
    const events: AgentLoopEvent[] = [];
    for await (const event of runKernel(f.context)) {
      events.push(event);
      if (event.type === "tool_result") controller.abort();
    }
    expect(samples).toBe(1);
    expect(events.at(-1)?.type).toBe("turn_interrupted");
    expect(checkpoint(events).uiTextFallbackOnly).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("文字收口采样失败不追加模型恢复请求", async function noProviderRecovery() {
    let samples = 0;
    const f = fixture({
      /** 合成Provider错误不访问网络。 */
      async sample() { if (++samples === 1) return uiSample(); throw new AgentSampleError("合成连接失败", "PROVIDER_CONNECTION"); },
    });
    const events = await collect(f.context);
    expect(samples).toBe(2);
    expect(events.some(function recovery(event) { return event.type === "model_recovery"; })).toBe(false);
    expect(events.at(-1)?.type).toBe("turn_failed");
  });
});
