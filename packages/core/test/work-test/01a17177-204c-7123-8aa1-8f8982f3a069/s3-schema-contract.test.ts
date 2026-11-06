/** S3 回归：验证 Provider schema、同源示例、归一投影和计算输入边界。 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../../src/internal/tools/tool-registry";
import { createRenderUiTool } from "../../../src/internal/tools/builtins/render-ui-tool";
import {
  UI_COMPONENT_NAMES,
  UI_COMPONENT_SCHEMAS,
  UI_COMPUTED_FUNCTIONS,
  uiSpecInputSchema,
} from "../../../src/ui/catalog";
import {
  createUiDocument,
  projectUiDocument,
  validateUiDocumentInput,
} from "../../../src/ui/document";
import {
  projectUiDocument as projectBuiltUiDocument,
  validateUiDocumentInput as validateBuiltUiDocumentInput,
} from "@autopilot-agent/core/ui";

type JsonSchema = Record<string, any>;
type UiComponent = typeof UI_COMPONENT_NAMES[number];

const componentProps: Record<UiComponent, Record<string, unknown>> = {
  Stack: { direction: "column", gap: 8 },
  Grid: { columns: 2, gap: 4 },
  Card: {},
  Text: { value: "说明", size: "sm", tone: "ink" },
  Metric: { label: "金额", value: 120 },
  Tabs: { items: [{ key: "first", label: "一" }, { key: "second", label: "二" }] },
  Disclosure: { summary: "细节", defaultOpen: false },
  NumberInput: { label: "金额", statePath: "amount", min: 0, max: 100, step: 1 },
  Slider: { label: "比例", statePath: "rate", min: 0, max: 1, step: 0.1 },
  Select: { label: "方案", statePath: "choice", options: [{ value: "low", label: "低" }, { value: "high", label: "高" }] },
  DataTable: { columns: [{ key: "name", label: "名称" }], rows: [{ name: "方案" }] },
  LineChart: { series: [{ name: "余额", points: [{ x: 0, y: 1 }] }] },
  BarChart: { series: [{ name: "金额", points: [{ x: 0, y: 1 }] }] },
  Button: { text: "继续", action: "continue_chat", fields: [{ label: "金额", statePath: "amount" }] },
  ItemList: { items: [{ title: "第一项" }] },
  Timeline: { items: [{ label: "上午", title: "安排" }] },
  Steps: { items: [{ title: "第一步" }, { title: "第二步" }], statePath: "stepIndex" },
  ChoiceGroup: { label: "方案", statePath: "choiceGroup", options: [{ value: "first", label: "方案一" }, { value: "second", label: "方案二" }] },
};

/** 建立能通过 Core 完整语义校验的 18 类节点树。 */
function makeAllComponentInput() {
  const ids = UI_COMPONENT_NAMES.map(function getId(name) { return `node-${name.toLowerCase()}`; });
  const elements: Record<string, Record<string, unknown>> = {};
  for (const name of UI_COMPONENT_NAMES) {
    const id = `node-${name.toLowerCase()}`;
    const element: Record<string, unknown> = { type: name, props: componentProps[name] };
    if (name === "Stack") element.children = ids.filter(function child(childId) { return childId !== id && childId !== "node-timeline"; });
    if (name === "Card") element.children = ["node-timeline"];
    if (name === "Tabs") element.slots = { items: [] };
    if (name === "Disclosure") element.slots = { content: [] };
    if (name === "Text") element.visible = { $state: "/enabled", eq: true };
    if (name === "Button") element.on = { press: { action: "continue_chat" } };
    elements[id] = element;
  }
  return {
    title: "完整白名单",
    fallbackText: "文字说明",
    spec: {
      root: "node-stack",
      elements,
      state: { amount: 5, rate: 0.1, choice: "low", choiceGroup: "first", stepIndex: 0, enabled: true },
    },
  };
}

/** 构建同时包含 state 绑定与两个 savingsGrowth selector 的完整模型输入。 */
function makeCalculationInput() {
  const args = {
    P: { $state: "/principal" },
    C: { $state: "/contribution" },
    R: { $state: "/rate" },
    Y: { $state: "/years" },
  };
  return {
    title: "储蓄增长",
    fallbackText: "金额随参数变化。",
    spec: {
      root: "root",
      state: { principal: 10000, contribution: 500, rate: 0.04, years: 10, scenario: "稳健" },
      elements: {
        root: { type: "Stack", props: { direction: "column", gap: 8 }, children: ["principal", "contribution", "rate", "years", "value", "chart", "text"] },
        principal: { type: "NumberInput", props: { label: "本金", statePath: "principal", min: 0, max: 1e12, step: 1000 } },
        contribution: { type: "NumberInput", props: { label: "月投入", statePath: "contribution", min: 0, max: 1e9, step: 100 } },
        rate: { type: "Slider", props: { label: "利率", statePath: "rate", min: 0, max: 0.3, step: 0.01 } },
        years: { type: "NumberInput", props: { label: "年数", statePath: "years", min: 1, max: 60, step: 1 } },
        value: { type: "Metric", props: { label: "期末余额", value: { $computed: "savingsGrowth", args: { ...args, select: "final" } } } },
        chart: { type: "LineChart", props: { series: { $computed: "savingsGrowth", args: { ...args, select: "series" } } } },
        text: { type: "Text", props: { value: { $state: "/scenario" }, size: "sm", tone: "ink" } },
      },
    },
  };
}

/** 将 JSON Schema 内的本地 $ref 解引用，便于比较目录分支与唯一 props schema。 */
function resolveSchema(value: unknown, root: JsonSchema, seen = new Set<string>()): unknown {
  if (Array.isArray(value)) return value.map(function resolveItem(item) { return resolveSchema(item, root, new Set(seen)); });
  if (!value || typeof value !== "object") return value;
  const schema = value as JsonSchema;
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) return schema;
    const path = schema.$ref.slice(2).split("/").map(function decode(part) { return part.replace(/~1/g, "/").replace(/~0/g, "~"); });
    let target: any = root;
    for (const part of path) target = target[part];
    return resolveSchema(target, root, new Set([...seen, schema.$ref]));
  }
  const result: JsonSchema = {};
  for (const [key, nested] of Object.entries(schema)) {
    if (key !== "$defs") result[key] = resolveSchema(nested, root, new Set(seen));
  }
  return result;
}

/** 经现有 ToolRegistry 的 draft-2020-12 路径取得 render_ui 的 Provider schema。 */
function getProviderSchema(): JsonSchema {
  const registry = new ToolRegistry();
  registry.register(createRenderUiTool(function collect() {}));
  const definition = registry.getModelDefinitions().find(function renderUi(item) { return item.name === "render_ui"; });
  if (!definition) throw new Error("render_ui model definition missing");
  return definition.inputSchema as JsonSchema;
}

describe("S3 complete render_ui schema contract", function suite() {
  it("Registry JSON Schema 保留 18 类 type/props、动态 ID map 与外层互斥", function providerSchema() {
    const schema = getProviderSchema();
    const input = schema.properties;
    const spec = input.spec;
    const elementMap = spec.properties.elements;
    const elementUnion = elementMap.additionalProperties;
    const branches = elementUnion.anyOf ?? elementUnion.oneOf;

    expect(input.title).toMatchObject({ type: "string", minLength: 1, maxLength: 80 });
    expect(input.fallbackText).toMatchObject({ type: "string", maxLength: 2000 });
    expect(schema.required).toEqual(expect.arrayContaining(["title", "fallbackText", "spec"]));
    expect(schema.additionalProperties).toBe(false);
    expect(spec.type).toBe("object");
    expect(spec.required).toEqual(expect.arrayContaining(["root", "elements"]));
    expect(elementMap.type).toBe("object");
    expect(elementMap.items).toBeUndefined();
    expect(branches).toHaveLength(UI_COMPONENT_NAMES.length);

    const byType = new Map<string, JsonSchema>();
    for (const branch of branches as JsonSchema[]) byType.set(branch.properties.type.const, branch);
    expect([...byType.keys()].sort()).toEqual([...UI_COMPONENT_NAMES].sort());

    for (const name of UI_COMPONENT_NAMES) {
      const branch = byType.get(name)!;
      const branchProperties = branch.properties;
      const actualProps = resolveSchema(branchProperties.props, schema) as JsonSchema;
      const expectedProps = z.toJSONSchema(UI_COMPONENT_SCHEMAS[name], { target: "draft-2020-12" }) as JsonSchema;
      expect(branch.required).toEqual(expect.arrayContaining(["type", "props"]));
      expect(branch.additionalProperties).toBe(false);
      expect(branchProperties.visible).toBeDefined();

      const outerNames = Object.keys(branchProperties).sort();
      if (name === "Button") {
        const actions = ["continue_chat", "reset_state"];
        const actualBranches = actualProps.oneOf as JsonSchema[];
        const expectedBranches = expectedProps.oneOf as JsonSchema[];
        expect(actualBranches).toHaveLength(2);
        expect(expectedBranches).toHaveLength(2);
        for (const action of actions) {
          const actualBranch = actualBranches.find(function findAction(candidate) { return candidate.properties.action.const === action; })!;
          const expectedBranch = expectedBranches.find(function findAction(candidate) { return candidate.properties.action.const === action; })!;
          expect(Object.keys(actualBranch.properties).sort()).toEqual(Object.keys(expectedBranch.properties).sort());
          expect([...actualBranch.required].sort()).toEqual([...expectedBranch.required].sort());
          expect(actualBranch.additionalProperties).toBe(false);
          expect(resolveSchema(actualBranch.properties, schema)).toEqual(resolveSchema(expectedBranch.properties, expectedProps));
          if (action === "continue_chat") {
            expect(actualBranch.required).toEqual(expect.arrayContaining(["action", "fields", "text"]));
            expect(actualBranch.properties.fields).toBeDefined();
          } else {
            expect(actualBranch.required).toEqual(expect.arrayContaining(["action", "text"]));
            expect(actualBranch.properties.fields).toBeUndefined();
          }
        }
        const actionSchema = branchProperties.on.properties.press.properties.action;
        expect(actionSchema.enum).toEqual(actions);
        expect(UI_COMPONENT_SCHEMAS.Button.safeParse({ action: "continue_chat", fields: [], text: "继续" }).success).toBe(true);
        expect(UI_COMPONENT_SCHEMAS.Button.safeParse({ action: "reset_state", text: "重置" }).success).toBe(true);
        expect(UI_COMPONENT_SCHEMAS.Button.safeParse({ action: "continue_chat", text: "继续" }).success).toBe(false);
        expect(UI_COMPONENT_SCHEMAS.Button.safeParse({ action: "reset_state", text: "重置", fields: [] }).success).toBe(false);
        expect(UI_COMPONENT_SCHEMAS.Button.safeParse({ action: "reset_state", text: "重置", custom: true }).success).toBe(false);
      } else {
        expect(Object.keys(actualProps.properties).sort()).toEqual(Object.keys(expectedProps.properties).sort());
        expect([...(actualProps.required ?? [])].sort()).toEqual([...(expectedProps.required ?? [])].sort());
        expect(actualProps.additionalProperties).toBe(false);
        expect(resolveSchema(actualProps.properties, schema)).toEqual(resolveSchema(expectedProps.properties, expectedProps));
      }

      if (["Stack", "Grid", "Card"].includes(name)) {
        expect(outerNames).toEqual(["children", "props", "type", "visible"]);
        expect(branchProperties.children.items.type).toBe("string");
        expect(branchProperties.children.maxItems).toBe(16);
      } else if (name === "Tabs") {
        expect(outerNames).toEqual(["props", "slots", "type", "visible"]);
        expect(branchProperties.slots.properties.items.maxItems).toBe(12);
      } else if (name === "Disclosure") {
        expect(outerNames).toEqual(["props", "slots", "type", "visible"]);
        expect(branchProperties.slots.properties.content.maxItems).toBe(12);
      } else if (name === "Button") {
        expect(outerNames).toEqual(["on", "props", "type", "visible"]);
        expect(branch.required).toContain("on");
        expect(branchProperties.on.required).toContain("press");
      } else {
        expect(outerNames).toEqual(["props", "type", "visible"]);
      }
    }
  });

  it("同一 validator 接受行程与预算样例及 18 类输入，Button 双写归一后仍可重新投影", function examplesAndProjection() {
    const description = createRenderUiTool(function collect() {}).description;
    const marker = "以下两个最小输入例分别展示行程与预算这类独立任务";
    const start = description.indexOf(marker);
    const jsonStart = description.indexOf("\n", start) + 1;
    const end = description.indexOf("\n组件props JSON Schema：", jsonStart);
    const examples = JSON.parse(description.slice(jsonStart, end)) as Array<Record<string, unknown>>;
    expect(examples).toHaveLength(2);
    expect(examples.map(function title(example) { return example.title; })).toEqual(["当天行程", "方案预算对照"]);
    for (const example of examples) validateUiDocumentInput(example);

    const input = makeAllComponentInput();
    expect(uiSpecInputSchema.safeParse(input.spec).success).toBe(true);
    const normalized = validateUiDocumentInput(input);
    const button = normalized.spec.elements["node-button"];
    expect(button.props.action).toBe("continue_chat");
    expect(button.on).toEqual({ press: { action: "continue_chat" } });

    const numberInput = normalized.spec.elements["node-numberinput"].props;
    expect(numberInput.statePath).toBeUndefined();
    expect(numberInput.value).toEqual({ $bindState: "/amount" });
    const document = createUiDocument(normalized, `ui_${"a".repeat(32)}`);
    expect(projectUiDocument(document)).toEqual(document);
    expect(projectBuiltUiDocument(document)).toEqual(document);
    expect(validateBuiltUiDocumentInput(input)).toEqual(normalized);

    const missingButtonOn = structuredClone(input);
    delete (missingButtonOn.spec as JsonSchema).elements["node-button"].on;
    expect(uiSpecInputSchema.safeParse(missingButtonOn.spec).success).toBe(false);
    expect(function rejectMissingButtonOn() { validateUiDocumentInput(missingButtonOn); }).toThrow();
    expect(function rejectMissingBuiltButtonOn() { validateBuiltUiDocumentInput(missingButtonOn); }).toThrow();

    const mismatchedProps = structuredClone(input);
    (mismatchedProps.spec as JsonSchema).elements["node-text"].props = { direction: "column", gap: 4 };
    expect(uiSpecInputSchema.safeParse(mismatchedProps.spec).success).toBe(false);
    const invalidProjected = structuredClone(document);
    invalidProjected.spec.elements["node-numberinput"].props.value = { $bindState: "/missing" };
    expect(function rejectInvalidProjectedState() { projectUiDocument(invalidProjected); }).toThrow();
  });

  /** 证明Tabs面板可由slots.items到达，且孤立草稿仍被原validator拒绝。 */
  it("Tabs slots.items 面板可达并拒绝未引用节点", function tabsReachability() {
    const input = {
      title: "合成分层讲解",
      fallbackText: "用普通文字说明这个概念。",
      spec: {
        root: "tabs",
        elements: {
          tabs: { type: "Tabs", props: { items: [{ key: "overview", label: "概念" }, { key: "example", label: "例子" }] }, slots: { items: ["overview-panel", "example-panel"] } },
          "overview-panel": { type: "Text", props: { value: "合成概念说明", size: "sm", tone: "ink" } },
          "example-panel": { type: "Text", props: { value: "合成例子说明", size: "sm", tone: "ink" } },
        },
      },
    };

    expect(validateUiDocumentInput(input).spec.elements["overview-panel"]).toMatchObject({
      type: "Text",
      props: { value: "合成概念说明" },
    });

    const withOrphan = structuredClone(input);
    (withOrphan.spec.elements as Record<string, unknown>).placeholder = {
      type: "Text",
      props: { value: "未引用草稿", size: "sm", tone: "ink" },
    };
    /** 由现有 Core validator 证明新增孤立键仍然失败。 */
    function rejectOrphan(): void {
      validateUiDocumentInput(withOrphan);
    }
    expect(rejectOrphan).toThrow("UI elements 含不可达节点");
  });

  it("state 引用、final/series selector、有限值与 savingsGrowth 范围由 Core 再校验", function calculationsAndBounds() {
    const input = makeCalculationInput();
    const normalized = validateUiDocumentInput(input);
    const projected = createUiDocument(normalized, `ui_${"b".repeat(32)}`);
    expect(projectUiDocument(projected)).toEqual(projected);
    expect(normalized.spec.elements.value.props.value).toMatchObject({ $computed: "savingsGrowth", args: { select: "final" } });
    expect(normalized.spec.elements.chart.props.series).toMatchObject({ $computed: "savingsGrowth", args: { select: "series" } });

    const finalValue = UI_COMPUTED_FUNCTIONS.savingsGrowth({ P: 10000, C: 500, R: 0.04, Y: 10, select: "final" });
    const series = UI_COMPUTED_FUNCTIONS.savingsGrowth({ P: 10000, C: 500, R: 0.04, Y: 10, select: "series" }) as Array<{ points: Array<{ x: number; y: number }> }>;
    expect(typeof finalValue).toBe("number");
    expect(series[0].points).toHaveLength(11);
    expect(series[0].points.at(-1)?.y).toBe(finalValue);

    const metricSeriesSelector = structuredClone(input);
    (metricSeriesSelector.spec as JsonSchema).elements.value.props.value.args.select = "series";
    expect(function rejectMetricSeries() { validateUiDocumentInput(metricSeriesSelector); }).toThrow();
    const chartFinalSelector = structuredClone(input);
    (chartFinalSelector.spec as JsonSchema).elements.chart.props.series.args.select = "final";
    expect(function rejectChartFinal() { validateUiDocumentInput(chartFinalSelector); }).toThrow();
    const missingState = structuredClone(input);
    (missingState.spec as JsonSchema).elements.value.props.value.args.P.$state = "/missing";
    expect(function rejectMissingState() { validateUiDocumentInput(missingState); }).toThrow();

    const outOfRangeYear = structuredClone(input);
    (outOfRangeYear.spec as JsonSchema).state.years = 61;
    expect(function rejectYearRange() { validateUiDocumentInput(outOfRangeYear); }).toThrow();
    const outOfRangePrincipal = structuredClone(input);
    (outOfRangePrincipal.spec as JsonSchema).state.principal = 1e12 + 1;
    (outOfRangePrincipal.spec as JsonSchema).elements.principal.props.max = 1e12 + 2;
    expect(function rejectSavingsRange() { validateUiDocumentInput(outOfRangePrincipal); }).toThrow();
    const fractionalYear = structuredClone(input);
    (fractionalYear.spec as JsonSchema).state.years = 1.5;
    expect(function rejectFractionalYear() { validateUiDocumentInput(fractionalYear); }).toThrow();
    const infiniteState = structuredClone(input);
    (infiniteState.spec as JsonSchema).state.rate = Number.POSITIVE_INFINITY;
    expect(function rejectInfiniteState() { validateUiDocumentInput(infiniteState); }).toThrow();
    const infiniteMetric = structuredClone(input);
    (infiniteMetric.spec as JsonSchema).elements.value.props.value = Number.POSITIVE_INFINITY;
    expect(function rejectInfiniteMetric() { validateUiDocumentInput(infiniteMetric); }).toThrow();
  });
});
