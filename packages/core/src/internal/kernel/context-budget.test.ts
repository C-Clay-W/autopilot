/**
 * Context Usage 投影测试（Talk-Plan0828 Stage 1）：
 * 验证三态总量（measured/projected/estimated）、分类最大余数归一、恢复基线与 fail-closed 断言；
 * 总量与 auto compact 共用 calculateContextBudget，不建立第二套计算。
 */

import { describe, expect, it, vi } from "vitest";
import { createAgentKernel } from "./agent-kernel";
import type { AgentLoopEvent } from "../agent-runtime";
import { getUsageAnchorRequestSignature, type AgentCheckpoint } from "../agent-runtime";
import { assertContextUsageView, getToolSignature, projectContextUsage, projectPublicContextUsage, type ContextUsageContribution, type ContextUsageView } from "./context-budget";
import type { ModelSampler } from "./model-sampler";
import { sanitizeEventForExternal } from "../../runtime/protocol/sanitize-checkpoint";
import { ToolRegistry } from "../tools/tool-registry";
import { createGlobFilesTool } from "../tools/builtins/glob-files-tool";
import { createAgentTextMessage, type AgentMessage } from "../types/agent-message";
import type { AgentModelToolDefinition, AgentSampleResult } from "../lib/llm";
import type { ModelSampleOptions } from "../types";

const TOOL: AgentModelToolDefinition = { type: "function", function: { name: "glob_files", description: "glob files", parameters: { type: "object" } } };
const TOOLS = [TOOL];
const WINDOW = 200_000;
const OUTPUT_RESERVE = 8_192;
const TRIGGER = 160_000;
const MODEL_REF = "openai/gpt-test";
const PROJECTION_BASE = { contextWindowTokens: WINDOW, outputReserveTokens: OUTPUT_RESERVE, compactTriggerTokens: TRIGGER, modelRef: MODEL_REF };

/** 构造覆盖给定消息前缀的完整 usage anchor。 */
function buildAnchor(messages: AgentMessage[], sampleOptions?: ModelSampleOptions) {
  return {
    usage: { inputTokens: 100, outputTokens: 20, contextTokens: 120 },
    messageCount: messages.length,
    toolSignature: getToolSignature(TOOLS),
    requestSignature: getUsageAnchorRequestSignature(messages, sampleOptions),
  };
}

/** 构造投影输入。 */
function buildInput(overrides: Partial<Parameters<typeof projectContextUsage>[0]> = {}): Parameters<typeof projectContextUsage>[0] {
  return {
    messages: [createAgentTextMessage("user", "请简短确认。")],
    tools: TOOLS,
    ...PROJECTION_BASE,
    ...overrides,
  };
}

/** 汇总内容分类（不含 output_reserve）token 合计。 */
function contentTokenSum(view: ContextUsageView): number {
  return view.breakdown.categories.filter((category) => category.kind !== "output_reserve").reduce((sum, category) => sum + category.tokens, 0);
}

describe("projectContextUsage 三态总量", function threeStateSuite() {
  it("完整 usage 且无新增消息时输出 measured，并满足求和与窗口分区不变量", function measuredWithoutAdditions() {
    const messages = [createAgentTextMessage("user", "请简短确认。")];
    const view = projectContextUsage(buildInput({
      checkpoint: { usageAnchor: buildAnchor(messages) },
      messages,
      contributions: [{ kind: "conversation", weight: 41 }],
      contributionsComplete: true,
    }));
    expect(view).not.toBeNull();
    expect(view!.measurement).toBe("measured");
    expect(view!.providerMeasuredTokens).toBe(120);
    expect(view!.estimatedAddedTokens).toBe(0);
    expect(view!.currentContextTokens).toBe(120);
    expect(view!.projectedTokens).toBe(120 + OUTPUT_RESERVE);
    expect(view!.usageRatio).toBeCloseTo(view!.projectedTokens / WINDOW, 12);
    expect(view!.compactNeeded).toBe(false);
    expect(contentTokenSum(view!)).toBe(120);
    expect(view!.breakdown.measurement).toBe("estimated");
    expect(view!.projectedTokens + view!.breakdown.freeTokens + view!.breakdown.compactBufferTokens).toBe(WINDOW);
    expect(view!.breakdown.freeTokens).toBe(TRIGGER - view!.projectedTokens);
    expect(view!.breakdown.compactBufferTokens).toBe(WINDOW - TRIGGER);
    const reserved = view!.breakdown.categories.find((category) => category.kind === "output_reserve");
    expect(reserved?.measurement).toBe("reserved");
    expect(reserved?.tokens).toBe(OUTPUT_RESERVE);
  });

  it("锚点后追加 user 消息时输出 projected", function projectedAfterSuffix() {
    const prefix = [createAgentTextMessage("user", "请简短确认。")];
    const messages = [...prefix, createAgentTextMessage("user", "补充：还要列出 md 文件。")];
    const view = projectContextUsage(buildInput({
      checkpoint: { usageAnchor: buildAnchor(prefix) },
      messages,
      contributions: [
        { kind: "conversation", weight: 41 },
        { kind: "conversation", weight: 37 },
      ],
      contributionsComplete: true,
    }));
    expect(view).not.toBeNull();
    expect(view!.measurement).toBe("projected");
    expect(view!.providerMeasuredTokens).toBe(120);
    expect(view!.estimatedAddedTokens).toBeGreaterThan(0);
    expect(view!.currentContextTokens).toBe(120 + view!.estimatedAddedTokens);
  });

  it("usage 缺失时全量估算：无 providerMeasuredTokens 且 added 等于 current", function estimatedWithoutUsage() {
    const view = projectContextUsage(buildInput({
      contributions: [{ kind: "conversation", weight: 41 }],
      contributionsComplete: true,
    }));
    expect(view).not.toBeNull();
    expect(view!.measurement).toBe("estimated");
    expect(view!.providerMeasuredTokens).toBeUndefined();
    expect(view!.estimatedAddedTokens).toBe(view!.currentContextTokens);
  });

  it("anchor 消息边界超出当前消息数时禁止继承 usage", function rejectsOutOfRangeAnchor() {
    const view = projectContextUsage(buildInput({
      checkpoint: { usageAnchor: { ...buildAnchor([createAgentTextMessage("user", "请简短确认。")]), messageCount: 99 } },
      contributions: [{ kind: "conversation", weight: 41 }],
      contributionsComplete: true,
    }));
    expect(view?.measurement).toBe("estimated");
  });

  it("工具签名变化导致 anchor 失配时回退完整估算", function rejectsToolSignatureDrift() {
    const messages = [createAgentTextMessage("user", "请简短确认。")];
    const view = projectContextUsage(buildInput({
      checkpoint: { usageAnchor: buildAnchor(messages) },
      messages,
      tools: [{ ...TOOL, function: { ...TOOL.function, name: "glob_files_v2" } }],
      contributions: [{ kind: "conversation", weight: 41 }],
      contributionsComplete: true,
    }));
    expect(view?.measurement).toBe("estimated");
    expect(view?.providerMeasuredTokens).toBeUndefined();
  });

  it("冻结采样配置变化导致请求签名失配时回退完整估算", function rejectsRequestSignatureDrift() {
    const messages = [createAgentTextMessage("user", "请简短确认。")];
    const view = projectContextUsage(buildInput({
      checkpoint: { usageAnchor: buildAnchor(messages, { temperature: 0.2 }) },
      messages,
      sampleOptions: { temperature: 0.9 },
      contributions: [{ kind: "conversation", weight: 41 }],
      contributionsComplete: true,
    }));
    expect(view?.measurement).toBe("estimated");
  });

  it("分母来自输入冻结窗口：128k 与 1M 均按输入计算", function respectsFrozenWindow() {
    const million = projectContextUsage(buildInput({
      contextWindowTokens: 1_000_000,
      compactTriggerTokens: 800_000,
      contributions: [{ kind: "conversation", weight: 41 }],
      contributionsComplete: true,
    }));
    expect(million?.contextWindowTokens).toBe(1_000_000);
    expect(million?.usageRatio).toBeCloseTo(million!.projectedTokens / 1_000_000, 12);
    const compact = projectContextUsage(buildInput({
      contextWindowTokens: 8_000,
      outputReserveTokens: 1_000,
      compactTriggerTokens: 6_000,
      contributions: [{ kind: "conversation", weight: 41 }],
      contributionsComplete: true,
    }));
    expect(compact?.contextWindowTokens).toBe(8_000);
    expect(compact?.breakdown.compactBufferTokens).toBe(2_000);
  });
});

describe("projectContextUsage 分类与归一", function breakdownSuite() {
  it("instructions/Memory/Skills/tools/conversation 分类按固定顺序输出并聚合 itemCount", function classifiesFixedKinds() {
    const view = projectContextUsage(buildInput({
      contributions: [
        { kind: "instructions", weight: 500 },
        { kind: "memory", weight: 300, count: 2 },
        { kind: "skills", weight: 200, count: 3 },
        { kind: "system", weight: 100 },
        { kind: "conversation", weight: 900 },
      ],
      contributionsComplete: true,
    }));
    expect(view).not.toBeNull();
    const order = ["system", "instructions", "memory", "skills", "tools", "conversation", "other", "output_reserve"];
    const indexes = view!.breakdown.categories.map((category) => order.indexOf(category.kind));
    expect([...indexes].sort((left, right) => left - right)).toEqual(indexes);
    const memory = view!.breakdown.categories.find((category) => category.kind === "memory");
    expect(memory?.itemCount).toBe(2);
    const skills = view!.breakdown.categories.find((category) => category.kind === "skills");
    expect(skills?.itemCount).toBe(3);
    const conversation = view!.breakdown.categories.find((category) => category.kind === "conversation");
    expect(conversation?.measurement).toBe("estimated");
  });

  it("权重除不尽时用最大余数法归一，使内容分类之和严格等于 currentContextTokens", function normalizesWithLargestRemainder() {
    const view = projectContextUsage(buildInput({
      checkpoint: { usageAnchor: { ...buildAnchor([createAgentTextMessage("user", "请简短确认。")]), messageCount: 0 } },
      contributions: [
        { kind: "conversation", weight: 1 },
        { kind: "system", weight: 1 },
        { kind: "instructions", weight: 1 },
        { kind: "memory", weight: 1, count: 1 },
        { kind: "skills", weight: 1, count: 1 },
      ],
      contributionsComplete: true,
    }));
    expect(view).not.toBeNull();
    const contentSum = contentTokenSum(view!);
    expect(contentSum).toBe(view!.currentContextTokens);
    expect(view!.projectedTokens).toBe(contentSum + OUTPUT_RESERVE);
    for (const category of view!.breakdown.categories) {
      expect(category.windowRatio).toBeCloseTo(category.tokens / WINDOW, 12);
    }
  });

  it("恢复的 Turn 以 checkpoint 安全 breakdown 为基线，仅对新增贡献做更新", function restoresFromCheckpointBaseline() {
    const baseline = projectContextUsage(buildInput({
      contributions: [{ kind: "instructions", weight: 500 }, { kind: "conversation", weight: 900 }],
      contributionsComplete: true,
    }));
    expect(baseline).not.toBeNull();
    // 恢复：无完整账本（contributionsComplete 缺省），仅传入安全边界后的新增贡献
    const restored = projectContextUsage(buildInput({
      checkpoint: { contextUsage: baseline! },
      contributions: [{ kind: "conversation", weight: 120 }],
      messages: [createAgentTextMessage("user", "请简短确认。"), createAgentTextMessage("user", "工具结果正文")],
    }));
    expect(restored).not.toBeNull();
    expect(restored!.measurement).toBe("estimated");
    expect(contentTokenSum(restored!)).toBe(restored!.currentContextTokens);
    expect(restored!.breakdown.categories.some((category) => category.kind === "instructions")).toBe(true);
  });

  it("旧 checkpoint 没有 breakdown 且无账本时整体回退为 other/estimated", function fallsBackToOtherWithoutBaseline() {
    const view = projectContextUsage(buildInput({}));
    expect(view).not.toBeNull();
    expect(view!.measurement).toBe("estimated");
    const kinds = view!.breakdown.categories.filter((category) => category.kind !== "output_reserve").map((category) => category.kind);
    expect(kinds).toEqual(["other"]);
  });

  it("有总量但没有任何消息权重时未知部分写入 other，不伪造已知内容分类", function writesOtherWithoutWeights() {
    const view = projectContextUsage(buildInput({
      checkpoint: { usageAnchor: buildAnchor([createAgentTextMessage("user", "请简短确认。")]) },
    }));
    expect(view).not.toBeNull();
    expect(view!.measurement).toBe("measured");
    const kinds = view!.breakdown.categories.map((category) => category.kind);
    expect(kinds.filter((kind) => kind !== "output_reserve")).toEqual(["other"]);
    expect(contentTokenSum(view!)).toBe(view!.currentContextTokens);
  });
});

describe("projectContextUsage fail closed", function failClosedSuite() {
  it("窗口缺失、非正数、阈值越界、负输出预留或 modelRef 缺失时返回 null", function rejectsInvalidBounds() {
    expect(projectContextUsage(buildInput({ contextWindowTokens: undefined }))).toBeNull();
    expect(projectContextUsage(buildInput({ contextWindowTokens: 0 }))).toBeNull();
    expect(projectContextUsage(buildInput({ contextWindowTokens: -128_000 }))).toBeNull();
    expect(projectContextUsage(buildInput({ compactTriggerTokens: 0 }))).toBeNull();
    expect(projectContextUsage(buildInput({ compactTriggerTokens: WINDOW + 1 }))).toBeNull();
    expect(projectContextUsage(buildInput({ outputReserveTokens: -1 }))).toBeNull();
    expect(projectContextUsage(buildInput({ modelRef: undefined }))).toBeNull();
    expect(projectContextUsage(buildInput({ modelRef: "" }))).toBeNull();
  });

  it("账本出现未知 kind、负权重或错误位置 itemCount 时返回 null", function rejectsCorruptLedger() {
    expect(projectContextUsage(buildInput({
      contributions: [{ kind: "conversation" as ContextUsageContribution["kind"], weight: -5 }],
      contributionsComplete: true,
    }))).toBeNull();
    expect(projectContextUsage(buildInput({
      contributions: [{ kind: "mystery" as ContextUsageContribution["kind"], weight: 5 }],
      contributionsComplete: true,
    }))).toBeNull();
    expect(projectContextUsage(buildInput({
      contributions: [{ kind: "conversation", weight: 5, count: 2 }],
      contributionsComplete: true,
    }))).toBeNull();
  });

  it("assertContextUsageView 对重复 kind、错误位置 itemCount、求和破坏与非法三态字段 fail closed", function assertionFailsClosed() {
    const valid = projectContextUsage(buildInput({
      contributions: [{ kind: "conversation", weight: 41 }],
      contributionsComplete: true,
    }))!;
    expect(assertContextUsageView(valid)).not.toBeNull();
    const duplicate: ContextUsageView = {
      ...valid,
      breakdown: { ...valid.breakdown, categories: [valid.breakdown.categories[0], valid.breakdown.categories[0]] },
    };
    expect(assertContextUsageView(duplicate)).toBeNull();
    const misplacedCount: ContextUsageView = {
      ...valid,
      breakdown: {
        ...valid.breakdown,
        categories: valid.breakdown.categories.map((category) => (category.kind === "conversation" ? { ...category, itemCount: 3 } : category)),
      },
    };
    expect(assertContextUsageView(misplacedCount)).toBeNull();
    const brokenSum: ContextUsageView = { ...valid, projectedTokens: valid.projectedTokens + 1 };
    expect(assertContextUsageView(brokenSum)).toBeNull();
    const measuredWithoutUsage: ContextUsageView = { ...valid, measurement: "measured" };
    expect(assertContextUsageView(measuredWithoutUsage)).toBeNull();
    const ratioDrift: ContextUsageView = { ...valid, usageRatio: 0.01 };
    expect(assertContextUsageView(ratioDrift)).toBeNull();
    const nanRatio: ContextUsageView = { ...valid, usageRatio: Number.NaN };
    expect(assertContextUsageView(nanRatio)).toBeNull();
    const infiniteTokens: ContextUsageView = { ...valid, currentContextTokens: Number.POSITIVE_INFINITY };
    expect(assertContextUsageView(infiniteTokens)).toBeNull();
    const triggerBeyondWindow: ContextUsageView = { ...valid, compactTriggerTokens: WINDOW + 1 };
    expect(assertContextUsageView(triggerBeyondWindow)).toBeNull();
  });

  it("超窗口时保留真实 usageRatio 与 overLimit，不做 Core 侧 clamp", function keepsRealRatioBeyondWindow() {
    const view = projectContextUsage(buildInput({
      contextWindowTokens: 8_000,
      outputReserveTokens: 1_000,
      compactTriggerTokens: 6_000,
      checkpoint: { usageAnchor: { usage: { inputTokens: 9_000, outputTokens: 100, contextTokens: 9_500 }, messageCount: 1, toolSignature: getToolSignature(TOOLS), requestSignature: undefined } },
      messages: [createAgentTextMessage("user", "请简短确认。")],
      contributions: [{ kind: "conversation", weight: 900 }],
      contributionsComplete: true,
    }));
    expect(view).not.toBeNull();
    expect(view!.measurement).toBe("measured");
    expect(view!.projectedTokens).toBe(10_500);
    expect(view!.usageRatio).toBeGreaterThan(1);
    expect(view!.breakdown.overLimitTokens).toBe(2_500);
    expect(view!.breakdown.overLimitRatio).toBeCloseTo(2_500 / 8_000, 12);
    expect(view!.compactNeeded).toBe(true);
    expect(view!.breakdown.freeTokens).toBe(0);
  });
});

describe("私有字段不泄漏", function privacySuite() {
  it("公开事件投影继续剥离 usageAnchor 与 contextUsage", function publicProjectionStripsPrivateFields() {
    const messages = [createAgentTextMessage("user", "请简短确认。")];
    const contextUsage = projectContextUsage(buildInput({
      checkpoint: { usageAnchor: buildAnchor(messages) },
      messages,
      contributions: [{ kind: "conversation", weight: 41 }],
      contributionsComplete: true,
    }))!;
    const checkpoint: AgentCheckpoint = {
      turnId: "leak-check",
      status: "completed",
      stepCount: 0,
      messages,
      completedCallIds: [],
      usageAnchor: buildAnchor(messages),
      contextUsage,
    };
    const event = { type: "turn_completed", turnId: "leak-check", checkpoint } as unknown as AgentLoopEvent;
    const sanitized = sanitizeEventForExternal(event) as { checkpoint?: Record<string, unknown> };
    expect("usageAnchor" in sanitized.checkpoint!).toBe(false);
    expect("contextUsage" in sanitized.checkpoint!).toBe(false);
  });
});

describe("projectPublicContextUsage 白名单投影", function publicProjectionSuite() {
  it("合法视图输出相等副本并丢弃多余字段", function copiesWhitelistOnly() {
    const messages = [createAgentTextMessage("user", "请简短确认。")];
    const view = projectContextUsage(buildInput({
      checkpoint: { usageAnchor: buildAnchor(messages) },
      messages,
      contributions: [{ kind: "conversation", weight: 41 }],
      contributionsComplete: true,
    }))!;
    const projected = projectPublicContextUsage({ ...view, intruder: "unexpected" } as ContextUsageView & { intruder?: string });
    expect(projected).not.toBeNull();
    expect("intruder" in projected!).toBe(false);
    expect(projected).toEqual(view);
  });

  it("求和被篡改时 fail closed 为 null", function failsClosedOnTamperedSum() {
    const messages = [createAgentTextMessage("user", "请简短确认。")];
    const view = projectContextUsage(buildInput({
      checkpoint: { usageAnchor: buildAnchor(messages) },
      messages,
      contributions: [{ kind: "conversation", weight: 41 }],
      contributionsComplete: true,
    }))!;
    expect(projectPublicContextUsage({ ...view, currentContextTokens: view.currentContextTokens + 7 })).toBeNull();
  });

  it("null 与 undefined 输入统一返回 null", function passesThroughNull() {
    expect(projectPublicContextUsage(null)).toBeNull();
    expect(projectPublicContextUsage(undefined)).toBeNull();
  });
});

describe("Kernel 集成", function kernelIntegrationSuite() {
  /** 构造最小 ToolRegistry。 */
  function createMinimalRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(createGlobFilesTool());
    return registry;
  }

  /** 构造带 usage 的确定性 mock 采样器。 */
  function createUsageSampler(result: AgentSampleResult): ModelSampler {
    return { sample: vi.fn(async () => result) } as unknown as ModelSampler;
  }

  it("注入冻结窗口配置与组装账本后，终态 checkpoint 写入 measured 快照", async function kernelWritesMeasuredSnapshot() {
    const messages = [createAgentTextMessage("user", "请简短确认。")];
    const sampler = createUsageSampler({
      content: "已完成。",
      toolCalls: [],
      reasoningSummary: "完成",
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 20, contextTokens: 120 },
    });
    const kernel = createAgentKernel({
      turnId: "usage-kernel",
      messages,
      toolRegistry: createMinimalRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
      contextUsageProjection: { modelRef: MODEL_REF, contextWindowTokens: WINDOW, outputReserveTokens: OUTPUT_RESERVE, compactTriggerTokens: TRIGGER },
      initialContextContributions: [[{ kind: "conversation", weight: 41 }]],
    });
    const events: AgentLoopEvent[] = [];
    for await (const event of kernel.run()) events.push(event);
    const completed = events.find((event) => event.type === "turn_completed");
    expect(completed?.type).toBe("turn_completed");
    const usage = completed?.type === "turn_completed" ? completed.checkpoint.contextUsage : undefined;
    expect(usage).toBeDefined();
    expect(usage!.measurement).toBe("measured");
    expect(usage!.providerMeasuredTokens).toBe(120);
    expect(usage!.modelRef).toBe(MODEL_REF);
    expect(contentTokenSum(usage!)).toBe(usage!.currentContextTokens);
    expect(usage!.projectedTokens).toBe(contentTokenSum(usage!) + OUTPUT_RESERVE);
  });

  it("未注入冻结窗口配置时 checkpoint 不携带 contextUsage 字段", async function kernelOmitsWithoutProjection() {
    const messages = [createAgentTextMessage("user", "请简短确认。")];
    const sampler = createUsageSampler({ content: "已完成。", toolCalls: [], reasoningSummary: "完成", finishReason: "stop" });
    const kernel = createAgentKernel({
      turnId: "usage-less-kernel",
      messages,
      toolRegistry: createMinimalRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
    });
    const events: AgentLoopEvent[] = [];
    for await (const event of kernel.run()) events.push(event);
    const completed = events.find((event) => event.type === "turn_completed");
    expect(completed?.type).toBe("turn_completed");
    const checkpoint = completed?.type === "turn_completed" ? completed.checkpoint : undefined;
    expect(checkpoint && "contextUsage" in checkpoint).toBe(false);
    expect(events.some((event) => event.type === "context_usage_updated")).toBe(false);
  });

  it("before_sample 首帧 estimated、完整 usage 后 measured，且 measured 先于 terminal 发布", async function kernelEmitsMeasuredAfterUsage() {
    const messages = [createAgentTextMessage("user", "请简短确认。")];
    const sampler = createUsageSampler({
      content: "已完成。",
      toolCalls: [],
      reasoningSummary: "完成",
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 20, contextTokens: 120 },
    });
    const kernel = createAgentKernel({
      turnId: "usage-event-kernel",
      messages,
      toolRegistry: createMinimalRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
      contextUsageProjection: { modelRef: MODEL_REF, contextWindowTokens: WINDOW, outputReserveTokens: OUTPUT_RESERVE, compactTriggerTokens: TRIGGER },
      initialContextContributions: [[{ kind: "conversation", weight: 41 }]],
    });
    const events: AgentLoopEvent[] = [];
    for await (const event of kernel.run()) events.push(event);
    const usageEvents = events.filter((event) => event.type === "context_usage_updated");
    // 启动投影与 before_sample 投影同值：只发首帧；完整 usage 到达后切换 measured，共两帧。
    expect(usageEvents.length).toBe(2);
    const first = usageEvents[0]!;
    const second = usageEvents[1]!;
    expect(first.type === "context_usage_updated" && first.usage?.measurement).toBe("estimated");
    expect(second.type === "context_usage_updated" && second.usage?.measurement).toBe("measured");
    expect(second.type === "context_usage_updated" && second.usage?.providerMeasuredTokens).toBe(120);
    expect(events.indexOf(second)).toBeLessThan(events.findIndex((event) => event.type === "turn_completed"));
  });

  it("工具轮次依次发射 measured 与 projected，下一完整 usage 后切回 measured", async function kernelEmitsProjectedAfterToolResult() {
    const messages = [createAgentTextMessage("user", "请列出 md 文件。")];
    let call = 0;
    const sampler: ModelSampler = { sample: vi.fn(async function sampled() {
      call += 1;
      if (call === 1) return { content: "", toolCalls: [{ id: "call-1", name: "glob_files", input: { pattern: "*.md" } }], reasoningSummary: "查找文件", usage: { inputTokens: 10, outputTokens: 5, contextTokens: 30 } };
      return { content: "完成。", toolCalls: [], reasoningSummary: "完成", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, contextTokens: 40 } };
    }) } as unknown as ModelSampler;
    const kernel = createAgentKernel({
      turnId: "usage-event-tools-kernel",
      messages,
      toolRegistry: createMinimalRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
      contextUsageProjection: { modelRef: MODEL_REF, contextWindowTokens: WINDOW, outputReserveTokens: OUTPUT_RESERVE, compactTriggerTokens: TRIGGER },
      initialContextContributions: [[{ kind: "conversation", weight: 41 }]],
    });
    const events: AgentLoopEvent[] = [];
    for await (const event of kernel.run()) events.push(event);
    const measurements = events.flatMap((event) => event.type === "context_usage_updated" ? [event.usage?.measurement] : []);
    expect(measurements).toEqual(["estimated", "measured", "projected", "measured"]);
  });

  it("投影 fail closed 时以 usage=null 明确清空旧状态", async function kernelEmitsNullOnFailedProjection() {
    const messages = [createAgentTextMessage("user", "请简短确认。")];
    const sampler = createUsageSampler({
      content: "已完成。",
      toolCalls: [],
      reasoningSummary: "完成",
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 20, contextTokens: 120 },
    });
    const kernel = createAgentKernel({
      turnId: "usage-null-kernel",
      messages,
      toolRegistry: createMinimalRegistry(),
      permissionContext: { mode: "auto_approve" },
      modelSampler: sampler,
      // 阈值大于窗口属于非法边界：投影必须 fail closed，并以 null 事件明确清空。
      contextUsageProjection: { modelRef: MODEL_REF, contextWindowTokens: WINDOW, outputReserveTokens: OUTPUT_RESERVE, compactTriggerTokens: WINDOW + 1 },
      initialContextContributions: [[{ kind: "conversation", weight: 41 }]],
    });
    const events: AgentLoopEvent[] = [];
    for await (const event of kernel.run()) events.push(event);
    const usageEvents = events.filter((event) => event.type === "context_usage_updated");
    expect(usageEvents.length).toBe(1);
    expect(usageEvents[0]!.type === "context_usage_updated" && usageEvents[0]!.usage).toBeNull();
  });
});
