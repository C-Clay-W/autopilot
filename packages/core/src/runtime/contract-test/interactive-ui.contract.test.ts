/** Intelligent UI S1 契约：计算类型、state 绑定、Chat 能力门与事件投影。 */
import { describe, expect, it } from "vitest";
import { createAgentRuntime, type AgentOptions } from "../../internal/agent-runtime";
import { createRenderUiTool } from "../../internal/tools/builtins/render-ui-tool";
import { getChatToolNames } from "../../internal/tools/chat-tool-runtime";
import type { ModelSampler } from "../../internal/kernel/model-sampler";
import { createAgentTextMessage } from "../../internal/types/agent-message";
import type { AgentLoopEvent } from "../../internal/agent-runtime";
import { readSessionIdentity } from "../domain/product-mode";
import { UI_COMPUTED_FUNCTIONS, createUiDocument, projectUiDocument, validateUiDocumentInput } from "../../ui";
import type { UiDocumentPayload } from "../../ui";
import { sanitizeEventForExternal } from "../protocol/sanitize-checkpoint";

/** 构造首个储蓄计算样板，允许测试目标 prop 对应的 selector。 */
function createSavingsDocumentInput(chartSelector: unknown = "series") {
  return {
    title: "储蓄增长",
    fallbackText: "按本金、月投入、利率和年数估算储蓄余额。",
    spec: {
      root: "card",
      state: { "balance/year~1": 1_000 },
      elements: {
        card: { type: "Card", props: { title: "储蓄增长" }, children: ["principal", "final", "chart"] },
        principal: { type: "NumberInput", props: { label: "本金", statePath: "balance/year~1", min: 0, max: 100_000, step: 100 } },
        final: { type: "Metric", props: { label: "期末余额", value: { $computed: "savingsGrowth", args: { P: { $state: "/balance~1year~01" }, C: 100, R: 0.05, Y: 10, select: "final" } } } },
        chart: { type: "LineChart", props: { series: { $computed: "savingsGrowth", args: { P: { $state: "/balance~1year~01" }, C: 100, R: 0.05, Y: 10, select: chartSelector } } } },
      },
    },
  };
}

/** 使用本地模型采样器读取真实 Runtime 暴露的工具目录，不触发网络。 */
async function getRuntimeToolNames(options: AgentOptions): Promise<string[]> {
  let names: string[] = [];
  const modelSampler: ModelSampler = {
    /** 捕获本次冻结目录后直接给出合成文字终答。 */
    async sample(_messages, tools) {
      names = tools.map(function name(tool) { return tool.function.name; });
      return { content: "完成", reasoningSummary: "", toolCalls: [] };
    },
  };
  const runtime = createAgentRuntime({ ...options, modelSampler });
  for await (const _event of runtime.run({ turnId: "interactive-ui-matrix", messages: [createAgentTextMessage("user", "检查工具目录")] })) { /* 只消费本地合成 Turn。 */ }
  return names;
}

/** 校验受限计算表达式、renderer 绑定和计算函数的图表输出形状。 */
describe("Intelligent UI S1 contract", function intelligentUiContractSuite() {
  it("只把 savingsGrowth.final 接入 Metric，把 series 接入 LineChart，并转换 statePath", function validatesSavingsSelectorsAndInputBinding() {
    const input = createSavingsDocumentInput();
    const payload = validateUiDocumentInput(input);
    const spec = payload.spec;

    expect(spec.elements.principal.props).toMatchObject({ label: "本金", value: { $bindState: "/balance~1year~01" } });
    expect(spec.elements.principal.props).not.toHaveProperty("statePath");
    expect(UI_COMPUTED_FUNCTIONS.savingsGrowth({ P: 1_000, C: 100, R: 0.05, Y: 10, select: "final" })).toBeCloseTo(
      (UI_COMPUTED_FUNCTIONS.savingsGrowth({ P: 1_000, C: 100, R: 0.05, Y: 10, select: "series" }) as Array<{ name: string; points: Array<{ x: number; y: number }> }>)[0].points.at(-1)!.y,
    );
    expect(UI_COMPUTED_FUNCTIONS.savingsGrowth({ P: 1_000, C: 100, R: 0.05, Y: 2, select: "series" })).toEqual([
      { name: "储蓄余额", points: [{ x: 0, y: 1_000 }, { x: 1, y: expect.any(Number) }, { x: 2, y: expect.any(Number) }] },
    ]);
  });

  it("拒绝不匹配的 selector、未知 selector 与 Text 上的数值计算", function rejectsInvalidComputedTargets() {
    expect(function validateMismatchedSelector() { validateUiDocumentInput(createSavingsDocumentInput("final")); }).toThrow();
    expect(function validateUnknownSelector() { validateUiDocumentInput(createSavingsDocumentInput("all")); }).toThrow();
    expect(function validateComputedText() {
      validateUiDocumentInput({
        title: "文本",
        fallbackText: "",
        spec: { root: "text", elements: { text: { type: "Text", props: { value: { $computed: "sum", args: { values: [1, 2] } }, size: "md", tone: "ink" } } } },
      });
    }).toThrow();
  });

  it("仅在受信 Chat none/web 能力中列出 render_ui", function gatesRenderUiByChatModeAndCapability() {
    const none = { sessionId: "session", turnId: "turn", retrievalMode: "none" } as const;
    const web = { ...none, retrievalMode: "web" } as const;
    const rag = { ...none, retrievalMode: "rag" } as const;

    expect(getChatToolNames(none, { interactiveUi: true }, [], 0)).toContain("render_ui");
    expect(getChatToolNames(none, undefined, [], 0)).not.toContain("render_ui");
    expect(getChatToolNames(web, { interactiveUi: true }, [], 0)).toContain("render_ui");
    expect(getChatToolNames(rag, { interactiveUi: true }, [], 0)).not.toContain("render_ui");
  });

  it("web保留Search/Fetch并注册UI，RAG、Work与无Chat身份的CLI目录不扩权", async function registersOnlyAuthorizedRuntimeModes() {
    const capability = { interactiveUi: true as const };
    const noneNames = await getRuntimeToolNames({ capabilityCeiling: readSessionIdentity({ productMode: "chat", chatRetrievalMode: "none" }), chatCapability: capability });
    const webNames = await getRuntimeToolNames({
      capabilityCeiling: readSessionIdentity({ productMode: "chat", chatRetrievalMode: "web" }),
      chatCapability: capability,
      web: {
        search: { async search() { return { answer: "本地来源", sources: [{ title: "来源", url: "https://example.test/" }], truncated: false }; } },
        fetch: { async fetch() { throw new Error("本测试不执行网络读取"); } },
      },
    });
    const ragNames = await getRuntimeToolNames({ capabilityCeiling: readSessionIdentity({ productMode: "chat", chatRetrievalMode: "rag" }), chatCapability: capability });
    const workNames = await getRuntimeToolNames({ capabilityCeiling: { productMode: "work" }, chatCapability: capability });
    const cliNames = await getRuntimeToolNames({ chatCapability: capability });

    expect(noneNames).toContain("render_ui");
    expect(webNames).toEqual(expect.arrayContaining(["render_ui", "web_search", "web_fetch"]));
    expect(ragNames).not.toContain("render_ui");
    expect(workNames).not.toContain("render_ui");
    expect(cliNames).not.toContain("render_ui");
  });

  it("工具只返回有限确认，公开事件投影再次校验并复制安全文档", async function projectsOnlySafeToolAndEventData() {
    let delivered: UiDocumentPayload | undefined;
    const tool = createRenderUiTool(function collect(_callId, document) { delivered = document; });
    const input = createSavingsDocumentInput();
    const output = await tool.execute(input, { permissionMode: "ask", toolCallId: "call-ui" });
    const serializedOutput = tool.serializeOutput(output);

    expect(delivered?.spec.elements.principal.props.value).toEqual({ $bindState: "/balance~1year~01" });
    expect(serializedOutput).toEqual({ delivered: true });
    expect(JSON.stringify(serializedOutput)).not.toContain("储蓄增长");

    const document = createUiDocument(delivered!, `ui_${"a".repeat(32)}`);
    const safeEvent = sanitizeEventForExternal({
      type: "ui_document", turnId: "turn", stepId: "step", callId: "call-ui", document,
    } satisfies AgentLoopEvent);
    expect(safeEvent).toEqual({ type: "ui_document", turnId: "turn", stepId: "step", callId: "call-ui", document });
    expect(safeEvent).not.toBe(document);

    const forged = { ...document, spec: { ...document.spec, elements: { ...document.spec.elements, injected: { type: "Text", props: { value: "unsafe", size: "md", tone: "ink" } } } } };
    expect(function projectForgedDocument() { projectUiDocument(forged); }).toThrow();

    const safeToolResult = sanitizeEventForExternal({
      type: "tool_result", turnId: "turn", stepId: "step", callId: "call-ui", toolName: "render_ui",
      result: { status: "success", callId: "call-ui", toolName: "render_ui", output: { private: "raw document payload" }, meta: { durationMs: 1, inputHash: "hash" } },
      retryCount: 0, summary: "已交付交互内容",
    } satisfies AgentLoopEvent);
    expect((safeToolResult as Extract<AgentLoopEvent, { type: "tool_result" }>).result).toMatchObject({ output: { delivered: true } });
    expect(JSON.stringify(safeToolResult)).not.toContain("raw document payload");
  });
});
