/** 独立验证 S1 新组件、绑定归一、局部动作与旧目录兼容。 */
import { describe, expect, it } from "vitest";
import { createRenderUiTool } from "../../../src/internal/tools/builtins/render-ui-tool";
import { ToolRegistry } from "../../../src/internal/tools/tool-registry";
import { UI_COMPONENT_NAMES } from "../../../src/ui/catalog";
import { createUiDocument, projectUiDocument, validateUiDocumentInput } from "../../../src/ui/document";

/** 为单个叶节点建立最小完整文档，测试走生产 validator 和投影入口。 */
function inputFor(element: Record<string, unknown>, state?: Record<string, string | number | boolean>) {
  return {
    title: "独立契约夹具",
    fallbackText: "合成说明",
    spec: {
      root: "root",
      elements: { root: element },
      ...(state ? { state } : {}),
    },
  };
}

/** 构造仍由 S1 保留的全部 14 类组件输入，不依赖新版样例。 */
function makeLegacyFourteenInput() {
  const types = [
    "Grid", "Card", "Text", "Metric", "Tabs", "Disclosure", "NumberInput", "Slider", "Select", "DataTable", "LineChart", "BarChart", "Button",
  ];
  const elements: Record<string, Record<string, unknown>> = {
    root: { type: "Stack", props: { direction: "column", gap: 8 }, children: types.map(function child(type) { return type.toLowerCase(); }) },
    grid: { type: "Grid", props: { columns: 2, gap: 8 } },
    card: { type: "Card", props: { title: "旧卡片" } },
    text: { type: "Text", props: { value: "旧文本", size: "sm", tone: "ink" } },
    metric: { type: "Metric", props: { label: "旧指标", value: 12 } },
    tabs: { type: "Tabs", props: { items: [{ key: "one", label: "一" }, { key: "two", label: "二" }] } },
    disclosure: { type: "Disclosure", props: { summary: "旧说明", defaultOpen: false } },
    numberinput: { type: "NumberInput", props: { label: "数值", statePath: "amount", min: 0, max: 100, step: 1 } },
    slider: { type: "Slider", props: { label: "比例", statePath: "ratio", min: 0, max: 1, step: 0.1 } },
    select: { type: "Select", props: { label: "方案", statePath: "plan", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } },
    datatable: { type: "DataTable", props: { columns: [{ key: "name", label: "名称" }], rows: [{ name: "旧行" }] } },
    linechart: { type: "LineChart", props: { series: [{ name: "旧线", points: [{ x: 0, y: 1 }] }] } },
    barchart: { type: "BarChart", props: { series: [{ name: "旧柱", points: [{ x: 0, y: 1 }] }] } },
    button: { type: "Button", props: { action: "continue_chat", text: "继续", fields: [{ label: "数值", statePath: "amount" }] }, on: { press: { action: "continue_chat" } } },
  };
  return {
    title: "旧目录文档",
    fallbackText: "旧版文字回退",
    spec: { root: "root", elements, state: { amount: 12, ratio: 0.5, plan: "a" } },
  };
}

describe("S1 independent Core UI contract", function suite() {
  it("Provider schema 从唯一 Core 目录导出全部 18 类", function providerCatalog() {
    const registry = new ToolRegistry();
    registry.register(createRenderUiTool(function collect() {}));
    const tool = registry.getModelDefinitions().find(function renderUi(item) { return item.name === "render_ui"; });
    expect(tool).toBeDefined();

    const schema = tool!.inputSchema as Record<string, any>;
    const elementSchema = schema.properties.spec.properties.elements.additionalProperties;
    const variants = elementSchema.anyOf ?? elementSchema.oneOf;
    expect(variants).toHaveLength(UI_COMPONENT_NAMES.length);
    expect(variants.map(function component(item: Record<string, any>) { return item.properties.type.const; }).sort()).toEqual([...UI_COMPONENT_NAMES].sort());
  });

  it("新增清单与时间线接受有效 props，并拒绝空清单和越界字段", function listAndTimeline() {
    expect(UI_COMPONENT_NAMES.slice(-4)).toEqual(["ItemList", "Timeline", "Steps", "ChoiceGroup"]);
    expect(function validList() {
      validateUiDocumentInput(inputFor({ type: "ItemList", props: { ordered: true, items: [{ title: "第一项", description: "说明" }] } }));
    }).not.toThrow();
    expect(function emptyList() {
      validateUiDocumentInput(inputFor({ type: "ItemList", props: { items: [] } }));
    }).toThrow();
    expect(function longTimelineLabel() {
      validateUiDocumentInput(inputFor({ type: "Timeline", props: { items: [{ label: "标".repeat(41), title: "事件" }] } }));
    }).toThrow();
    expect(function extraProp() {
      validateUiDocumentInput(inputFor({ type: "ItemList", props: { items: [{ title: "项" }], className: "text-blue-500" } }));
    }).toThrow();
  });

  it("Steps 绑定归一为 state pointer，整数范围在输入和回放投影中一致拒绝", function stepBindingAndReplay() {
    const input = inputFor({ type: "Steps", props: { items: [{ title: "第一步" }, { title: "第二步" }], statePath: "step" } }, { step: 1 });
    const payload = validateUiDocumentInput(input);
    expect(payload.spec.elements.root.props).toMatchObject({ value: { $bindState: "/step" } });
    expect(payload.spec.elements.root.props).not.toHaveProperty("statePath");
    const document = createUiDocument(payload, `ui_${"a".repeat(32)}`);
    expect(projectUiDocument(document)).toEqual(document);

    for (const step of [-1, 2, 0.5, "1"]) {
      const invalid = inputFor({ type: "Steps", props: { items: [{ title: "第一步" }, { title: "第二步" }], statePath: "step" } }, { step: step as string | number });
      expect(function rejectStep() { validateUiDocumentInput(invalid); }).toThrow();
    }

    const invalidReplay = structuredClone(document);
    invalidReplay.spec.state!.step = 0.5;
    expect(function rejectFractionalReplay() { projectUiDocument(invalidReplay); }).toThrow();
  });

  it("ChoiceGroup 要求唯一枚举和匹配初值，并保持标量绑定与原值类型", function choiceBinding() {
    const valid = inputFor({
      type: "ChoiceGroup",
      props: { label: "方案", statePath: "choice", options: [{ value: "steady", label: "稳健" }, { value: 2, label: "增长" }, { value: true, label: "试验" }] },
    }, { choice: 2 });
    const payload = validateUiDocumentInput(valid);
    expect(payload.spec.elements.root.props).toMatchObject({ value: { $bindState: "/choice" } });
    expect(projectUiDocument(createUiDocument(payload, `ui_${"b".repeat(32)}`)).spec.state).toEqual({ choice: 2 });

    const duplicate = structuredClone(valid);
    duplicate.spec.elements.root.props.options[1].value = "steady";
    expect(function rejectDuplicateOption() { validateUiDocumentInput(duplicate); }).toThrow();
    const unmatched = structuredClone(valid);
    unmatched.spec.state.choice = "2";
    expect(function rejectUnmatchedInitialValue() { validateUiDocumentInput(unmatched); }).toThrow();
  });

  it("reset_state 仅接受成对动作且不混入 fields，continue_chat 旧分支仍可用", function resetActionPairing() {
    const reset = inputFor({ type: "Button", props: { action: "reset_state", text: "重置" }, on: { press: { action: "reset_state" } } }, { amount: 10 });
    expect(validateUiDocumentInput(reset).spec.elements.root).toMatchObject({ props: { action: "reset_state" }, on: { press: { action: "reset_state" } } });
    const mismatch = structuredClone(reset);
    mismatch.spec.elements.root.on.press.action = "continue_chat";
    expect(function rejectMismatchedAction() { validateUiDocumentInput(mismatch); }).toThrow();
    const mixedFields = structuredClone(reset);
    mixedFields.spec.elements.root.props.fields = [];
    expect(function rejectResetFields() { validateUiDocumentInput(mixedFields); }).toThrow();
    expect(function acceptExistingContinueButton() {
      validateUiDocumentInput(inputFor({ type: "Button", props: { action: "continue_chat", text: "继续", fields: [{ label: "金额", statePath: "amount" }] }, on: { press: { action: "continue_chat" } } }, { amount: 10 }));
    }).not.toThrow();
  });

  it("DataTable 筛选列必须存在且类型齐全，旧无筛选 props 仍兼容", function filterColumn() {
    const columns = [{ key: "group", label: "分组" }, { key: "amount", label: "金额" }];
    const rows = [{ group: "A", amount: 2 }, { group: "B", amount: 1 }];
    expect(function validFilter() {
      validateUiDocumentInput(inputFor({ type: "DataTable", props: { columns, rows, filterColumnKey: "group", sortable: true } }));
    }).not.toThrow();
    expect(function legacyTable() {
      validateUiDocumentInput(inputFor({ type: "DataTable", props: { columns: [{ key: "name", label: "名称" }], rows: [{ name: "旧值" }] } }));
    }).not.toThrow();
    expect(function unknownFilterColumn() {
      validateUiDocumentInput(inputFor({ type: "DataTable", props: { columns, rows, filterColumnKey: "missing" } }));
    }).toThrow();
    expect(function missingFilterValue() {
      validateUiDocumentInput(inputFor({ type: "DataTable", props: { columns, rows: [{ group: "A", amount: 2 }, { amount: 1 }], filterColumnKey: "group" } }));
    }).toThrow();
    expect(function mixedFilterTypes() {
      validateUiDocumentInput(inputFor({ type: "DataTable", props: { columns, rows: [{ group: "A", amount: 2 }, { group: 2, amount: 1 }], filterColumnKey: "group" } }));
    }).toThrow();
  });

  it("保留旧 14 类输入在 schemaVersion 1 下的归一与投影回放", function oldFourteenCompatibility() {
    const document = createUiDocument(validateUiDocumentInput(makeLegacyFourteenInput()), `ui_${"c".repeat(32)}`);
    expect(new Set(Object.values(document.spec.elements).map(function type(element) { return element.type; }))).toEqual(new Set(UI_COMPONENT_NAMES.slice(0, 14)));
    expect(projectUiDocument(document)).toEqual(document);
    expect(document.schemaVersion).toBe(1);
  });
});
