/** Intelligent UI 的单一组件目录、计算白名单与纯数据校验器；不依赖 Node、React 或 DOM。 */
import { z } from "zod";

export const UI_MAX_DOCUMENT_BYTES = 64 * 1024;
export const UI_MAX_ELEMENTS = 128;
export const UI_MAX_TREE_DEPTH = 12;
export const UI_MAX_STATE_KEYS = 24;
export const UI_MAX_STATE_BYTES = 16 * 1024;
/** 供模型说明、结构 schema 与运行时 validator 共用的固定生成上限。 */
export const UI_MAX_CHILDREN = 16;
export const UI_MAX_SLOT_CHILDREN = 12;
export const UI_MAX_COMPUTED_ITEMS = 200;
/** savingsGrowth 的固定输入范围同时用于模型说明和服务端参数校验。 */
export const UI_SAVINGS_GROWTH_BOUNDS = Object.freeze({
  P: { min: 0, max: 1e12, integer: false },
  C: { min: 0, max: 1e9, integer: false },
  R: { min: 0, max: 0.3, integer: false },
  Y: { min: 1, max: 60, integer: true },
});

export const UI_COMPONENT_NAMES = [
  "Stack", "Grid", "Card", "Text", "Metric", "Tabs", "Disclosure",
  "NumberInput", "Slider", "Select", "DataTable", "LineChart", "BarChart", "Button",
  "ItemList", "Timeline", "Steps", "ChoiceGroup", "Flowchart",
] as const;

export const UI_COMPUTED_FUNCTION_NAMES = ["savingsGrowth", "weightedAverage", "sum"] as const;

export type UiComponentName = typeof UI_COMPONENT_NAMES[number];
export type UiScalar = string | number | boolean;
export type UiState = Record<string, UiScalar>;

export interface UiElement {
  type: UiComponentName;
  props: Record<string, unknown>;
  children?: string[];
  slots?: Record<string, string[]>;
  visible?: unknown;
  on?: Record<string, unknown>;
}

export interface UiSpec {
  root: string;
  elements: Record<string, UiElement>;
  state?: UiState;
}

const numericLiteral = z.number().finite();
const textValueSchema = z.string().max(500);
const scalarSchema = z.union([z.string().max(200), numericLiteral, z.boolean()]);
const selectValueSchema = z.union([z.string().max(200), numericLiteral, z.boolean()]);
const stateReferenceSchema = z.object({ $state: z.string().min(2) }).strict();
const expressionNumberSchema = z.union([numericLiteral, stateReferenceSchema]);
const savingsGrowthArgsSchema = z.object({
  P: expressionNumberSchema,
  C: expressionNumberSchema,
  R: expressionNumberSchema,
  Y: expressionNumberSchema,
  select: z.enum(["final", "series"]),
}).strict();
const computedExpressionSchema = z.discriminatedUnion("$computed", [
  z.object({ $computed: z.literal("savingsGrowth"), args: savingsGrowthArgsSchema.extend({ select: z.literal("final") }) }).strict(),
  z.object({
    $computed: z.literal("weightedAverage"),
    args: z.object({
      pairs: z.array(z.object({ value: expressionNumberSchema, weight: expressionNumberSchema }).strict()).min(1).max(UI_MAX_COMPUTED_ITEMS),
    }).strict(),
  }).strict(),
  z.object({ $computed: z.literal("sum"), args: z.object({ values: z.array(expressionNumberSchema).max(UI_MAX_COMPUTED_ITEMS) }).strict() }).strict(),
]);
const savingsGrowthSeriesExpressionSchema = z.object({
  $computed: z.literal("savingsGrowth"),
  args: savingsGrowthArgsSchema.extend({ select: z.literal("series") }),
}).strict();
const dynamicTextSchema = z.union([textValueSchema, stateReferenceSchema]);
const dynamicNumberSchema = z.union([numericLiteral, stateReferenceSchema, computedExpressionSchema]);
const visibilityScalarSchema = z.union([z.string(), numericLiteral, z.boolean()]);
const visibilityComparatorSchema = z.literal(true).optional();
const visibilityConditionSchema = z.union([
  z.object({ $state: z.string().min(2), not: visibilityComparatorSchema }).strict(),
  z.object({ $state: z.string().min(2), eq: z.union([visibilityScalarSchema, stateReferenceSchema]), not: visibilityComparatorSchema }).strict(),
  z.object({ $state: z.string().min(2), neq: z.union([visibilityScalarSchema, stateReferenceSchema]), not: visibilityComparatorSchema }).strict(),
  z.object({ $state: z.string().min(2), gt: z.union([numericLiteral, stateReferenceSchema]), not: visibilityComparatorSchema }).strict(),
  z.object({ $state: z.string().min(2), gte: z.union([numericLiteral, stateReferenceSchema]), not: visibilityComparatorSchema }).strict(),
  z.object({ $state: z.string().min(2), lt: z.union([numericLiteral, stateReferenceSchema]), not: visibilityComparatorSchema }).strict(),
  z.object({ $state: z.string().min(2), lte: z.union([numericLiteral, stateReferenceSchema]), not: visibilityComparatorSchema }).strict(),
]);
const visibilitySchema = z.union([z.boolean(), visibilityConditionSchema]);

const chartPointSchema = z.object({ x: numericLiteral, y: z.union([numericLiteral, z.null()]) }).strict();
const chartSeriesSchema = z.array(z.object({
  name: z.string().max(40),
  points: z.array(chartPointSchema).max(UI_MAX_COMPUTED_ITEMS),
}).strict()).min(1).max(4);
const tableCellSchema = z.union([z.string().max(120), numericLiteral]);
const tableColumnSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,32}$/),
  label: z.string().max(40),
  align: z.enum(["left", "right"]).optional(),
}).strict();
const listItemSchema = z.object({ title: z.string().min(1).max(80), description: z.string().max(300).optional() }).strict();
const timelineItemSchema = z.object({ label: z.string().max(40), title: z.string().min(1).max(80), description: z.string().max(300).optional() }).strict();
const choiceOptionSchema = z.object({ value: scalarSchema, label: z.string().max(40), description: z.string().max(300).optional() }).strict();

const flowIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);

export const UI_COMPONENT_SCHEMAS = {
  Flowchart: z.object({
    direction: z.enum(["TB", "LR"]),
    description: z.string().min(1).max(500),
    nodes: z.array(z.object({ id: flowIdSchema, label: z.string().min(1).max(40), kind: z.enum(["process", "decision", "terminal"]).optional() }).strict()).min(1).max(24),
    edges: z.array(z.object({ id: flowIdSchema, from: flowIdSchema, to: flowIdSchema, label: z.string().max(24).optional() }).strict()).max(48),
  }).strict(),
  Stack: z.object({ direction: z.enum(["column", "row"]), gap: z.union([z.literal(4), z.literal(8), z.literal(12), z.literal(16)]) }).strict(),
  Grid: z.object({ columns: z.union([z.literal(2), z.literal(3), z.literal(4)]), gap: z.union([z.literal(4), z.literal(8), z.literal(12), z.literal(16)]) }).strict(),
  Card: z.object({ title: z.string().max(80).optional() }).strict(),
  Text: z.object({ value: dynamicTextSchema, size: z.enum(["xs", "sm", "md", "lg"]), tone: z.enum(["ink", "muted", "accent", "error"]) }).strict(),
  Metric: z.object({ label: z.string().max(40), value: dynamicNumberSchema, unit: z.string().max(10).optional(), tone: z.enum(["ink", "accent", "error"]).optional() }).strict(),
  Tabs: z.object({ items: z.array(z.object({ key: z.string().regex(/^[a-z0-9_]{1,32}$/), label: z.string().max(40) }).strict()).min(2).max(6) }).strict(),
  Disclosure: z.object({ summary: z.string().max(80), defaultOpen: z.boolean() }).strict(),
  NumberInput: z.object({ label: z.string().max(40), statePath: z.string().min(1), min: numericLiteral, max: numericLiteral, step: numericLiteral, suffix: z.string().max(10).optional() }).strict(),
  Slider: z.object({ label: z.string().max(40), statePath: z.string().min(1), min: numericLiteral, max: numericLiteral, step: numericLiteral, suffix: z.string().max(10).optional() }).strict(),
  Select: z.object({ label: z.string().max(40), statePath: z.string().min(1), options: z.array(z.object({ value: selectValueSchema, label: z.string().max(40) }).strict()).min(2).max(12) }).strict(),
  DataTable: z.object({ columns: z.array(tableColumnSchema).min(1).max(8), rows: z.array(z.record(z.string(), tableCellSchema)).max(100), caption: z.string().max(120).optional(), filterColumnKey: z.string().regex(/^[a-z0-9_]{1,32}$/).optional(), sortable: z.boolean().optional() }).strict(),
  LineChart: z.object({ title: z.string().max(80).optional(), xLabel: z.string().max(40).optional(), yLabel: z.string().max(40).optional(), unit: z.string().max(10).optional(), series: z.union([chartSeriesSchema, savingsGrowthSeriesExpressionSchema]), yMin: numericLiteral.optional(), yMax: numericLiteral.optional() }).strict(),
  BarChart: z.object({ title: z.string().max(80).optional(), xLabel: z.string().max(40).optional(), yLabel: z.string().max(40).optional(), unit: z.string().max(10).optional(), series: z.union([chartSeriesSchema, savingsGrowthSeriesExpressionSchema]), yMin: numericLiteral.optional(), yMax: numericLiteral.optional() }).strict(),
  Button: z.discriminatedUnion("action", [
    z.object({ action: z.literal("continue_chat"), fields: z.array(z.object({ label: z.string().max(40), statePath: z.string().min(1) }).strict()).max(6), text: z.string().max(40) }).strict(),
    z.object({ action: z.literal("reset_state"), text: z.string().max(40) }).strict(),
  ]),
  ItemList: z.object({ items: z.array(listItemSchema).min(1).max(20), ordered: z.boolean().optional() }).strict(),
  Timeline: z.object({ items: z.array(timelineItemSchema).min(1).max(20) }).strict(),
  Steps: z.object({ items: z.array(listItemSchema).min(2).max(8), statePath: z.string().min(1) }).strict(),
  ChoiceGroup: z.object({ label: z.string().max(40), statePath: z.string().min(1), options: z.array(choiceOptionSchema).min(2).max(8) }).strict(),
} as const;

/** 按组件类型共用 props schema，并结构化声明元素外层子节点、可见条件与事件。 */
function createUiElementInputSchema(type: UiComponentName) {
  const sharedFields = { type: z.literal(type), props: UI_COMPONENT_SCHEMAS[type], visible: visibilitySchema.optional() };
  if (type === "Stack" || type === "Grid" || type === "Card") {
    return z.object({ ...sharedFields, children: z.array(z.string()).max(UI_MAX_CHILDREN).optional() }).strict();
  }
  if (type === "Tabs") {
    return z.object({ ...sharedFields, slots: z.object({ items: z.array(z.string()).max(UI_MAX_SLOT_CHILDREN).optional() }).strict().optional() }).strict();
  }
  if (type === "Disclosure") {
    return z.object({ ...sharedFields, slots: z.object({ content: z.array(z.string()).max(UI_MAX_SLOT_CHILDREN).optional() }).strict().optional() }).strict();
  }
  if (type === "Button") {
    return z.object({
      ...sharedFields,
      on: z.object({ press: z.object({ action: z.enum(["continue_chat", "reset_state"]) }).strict() }).strict(),
    }).strict();
  }
  return z.object(sharedFields).strict();
}

/** 为每类白名单组件生成并列的元素 schema 分支，保留 type 与 props 的对应关系。 */
const uiElementInputVariants = UI_COMPONENT_NAMES.map(function createVariant(type) { return createUiElementInputSchema(type); });
const uiElementInputSchema = z.union(uiElementInputVariants as [typeof uiElementInputVariants[number], ...typeof uiElementInputVariants[number][]]);
/** 模型输入与 Core validator 共用的动态 ID map 结构；跨节点语义仍由 validateUiSpec 完整检查。 */
export const uiSpecInputSchema = z.object({
  root: z.string().min(1),
  elements: z.record(z.string(), uiElementInputSchema),
  state: z.record(z.string(), scalarSchema).optional(),
}).strict();

type NumericConstraint = { kind: "range"; min: number; max: number; step: number; integer?: boolean } | { kind: "select"; values: Array<string | number | boolean> };

/** 只接受普通对象，避免把类实例或宿主对象当作模型 JSON。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 以有界递归计算 JSON 字节数，同时拒绝循环、访问器、非 JSON 值和危险键。 */
function measureJsonBytes(value: unknown, maxBytes: number, ancestors = new Set<object>(), depth = 0): number {
  if (depth > 32) throw new Error("JSON 深度超限");
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON 数字必须有限");
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }
  if (typeof value === "string") return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (typeof value !== "object") throw new Error("只接受 JSON 数据");
  if (ancestors.has(value)) throw new Error("JSON 不得循环引用");
  ancestors.add(value);
  let byteLength = 2;
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).length !== value.length + 1) throw new Error("数组必须是稠密 JSON 数组");
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("数组成员不合法");
      byteLength += (index > 0 ? 1 : 0) + measureJsonBytes(descriptor.value, maxBytes, ancestors, depth + 1);
      if (byteLength > maxBytes) throw new Error("JSON 字节数超限");
    }
  } else {
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length) throw new Error("对象必须是普通 JSON 对象");
    const keys = Object.getOwnPropertyNames(value);
    if (keys.length !== Object.keys(value).length) throw new Error("对象不得包含非枚举字段");
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error("JSON 包含危险键");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("对象不得包含访问器");
      const serializedKey = JSON.stringify(key);
      byteLength += (index > 0 ? 1 : 0) + new TextEncoder().encode(serializedKey).byteLength + 1;
      byteLength += measureJsonBytes(descriptor.value, maxBytes, ancestors, depth + 1);
      if (byteLength > maxBytes) throw new Error("JSON 字节数超限");
    }
  }
  ancestors.delete(value);
  if (byteLength > maxBytes) throw new Error("JSON 字节数超限");
  return byteLength;
}

/** 按精确顶层 state key 解析 renderer 使用的单层 JSON Pointer。 */
function getStateKeyFromPointer(pointer: string): string {
  if (!pointer.startsWith("/") || pointer === "/" || pointer.slice(1).includes("/")) throw new Error("state 引用必须指向顶层键");
  const segment = pointer.slice(1);
  if (/~(?:[^01]|$)/.test(segment)) throw new Error("state 引用的 JSON Pointer 编码无效");
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** 解析并确认 state 引用指向当前文档已声明的顶层键。 */
function resolveStateReference(expression: unknown, state: UiState): { key: string; value: UiScalar } {
  if (!isPlainRecord(expression) || Object.keys(expression).length !== 1 || typeof expression.$state !== "string") throw new Error("state 引用不合法");
  const key = getStateKeyFromPointer(expression.$state);
  if (!Object.prototype.hasOwnProperty.call(state, key)) throw new Error("state 引用未声明");
  return { key, value: state[key] };
}

/** 确认绑定到同一 state 的所有控件都不能把数值推入计算函数范围之外。 */
function assertStateConstraints(key: string, stateValue: UiScalar, constraints: Map<string, NumericConstraint[]>, minimum: number, maximum: number, integer = false): void {
  if (typeof stateValue !== "number" || stateValue < minimum || stateValue > maximum || (integer && !Number.isInteger(stateValue))) throw new Error("计算参数超出范围");
  for (const constraint of constraints.get(key) ?? []) {
    if (constraint.kind === "range") {
      if (constraint.integer && !Number.isInteger(stateValue)) throw new Error("步骤状态必须为整数");
      if (constraint.min < minimum || constraint.max > maximum || (integer && (!Number.isInteger(constraint.min) || !Number.isInteger(constraint.max) || !Number.isInteger(constraint.step)))) throw new Error("输入控件范围与计算参数不匹配");
    } else if (constraint.values.some(function outsideRange(value) { return typeof value !== "number" || value < minimum || value > maximum || (integer && !Number.isInteger(value)); })) {
      throw new Error("Select 选项与计算参数不匹配");
    }
  }
}

/** 校验非负数参数；state 参数同时确认其输入控件不会产生负值。 */
function readNonNegativeNumber(value: unknown, state: UiState, constraints: Map<string, NumericConstraint[]>): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const reference = resolveStateReference(value, state);
  assertStateConstraints(reference.key, reference.value, constraints, 0, Number.MAX_VALUE);
  return reference.value as number;
}

/** 校验储蓄增长参数，可使用字面量或指向 state 的顶层 JSON Pointer。 */
function readSavingsParameter(value: unknown, name: "P" | "C" | "R" | "Y", state: UiState, constraints: Map<string, NumericConstraint[]>): number {
  const limits = UI_SAVINGS_GROWTH_BOUNDS[name];
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < limits.min || value > limits.max || (limits.integer && !Number.isInteger(value))) throw new Error("savingsGrowth 参数超出范围");
    return value;
  }
  const reference = resolveStateReference(value, state);
  assertStateConstraints(reference.key, reference.value, constraints, limits.min, limits.max, limits.integer);
  return reference.value as number;
}

/** 验证注册函数调用的参数白名单，并确保结果类型与目标 prop 一致。 */
function validateComputedExpression(value: Record<string, unknown>, expected: "number" | "series", state: UiState, constraints: Map<string, NumericConstraint[]>): void {
  if (Object.keys(value).some(function unknownKey(key) { return key !== "$computed" && key !== "args"; })) throw new Error("computed 表达式字段不合法");
  const name = value.$computed;
  const args = value.args;
  if (!isPlainRecord(args)) throw new Error("computed args 必须是对象");
  if (name === "savingsGrowth") {
    const required = ["P", "C", "R", "Y", "select"];
    if (Object.keys(args).length !== required.length || required.some(function missing(key) { return !Object.prototype.hasOwnProperty.call(args, key); })) throw new Error("savingsGrowth 参数不合法");
    const selection = args.select;
    if (selection !== "final" && selection !== "series") throw new Error("savingsGrowth selector 不合法");
    if ((selection === "final" && expected !== "number") || (selection === "series" && expected !== "series")) throw new Error("savingsGrowth selector 与目标 prop 类型不匹配");
    readSavingsParameter(args.P, "P", state, constraints);
    readSavingsParameter(args.C, "C", state, constraints);
    readSavingsParameter(args.R, "R", state, constraints);
    readSavingsParameter(args.Y, "Y", state, constraints);
    return;
  }
  if (expected !== "number") throw new Error("computed 函数结果类型与目标 prop 不匹配");
  if (name === "sum") {
    if (Object.keys(args).length !== 1 || !Array.isArray(args.values) || args.values.length > UI_MAX_COMPUTED_ITEMS) throw new Error("sum 参数不合法");
    for (const item of args.values) readNonNegativeNumber(item, state, constraints);
    return;
  }
  if (name === "weightedAverage") {
    if (Object.keys(args).length !== 1 || !Array.isArray(args.pairs) || args.pairs.length > UI_MAX_COMPUTED_ITEMS) throw new Error("weightedAverage 参数不合法");
    let positiveWeight = false;
    for (const item of args.pairs) {
      if (!isPlainRecord(item) || Object.keys(item).length !== 2 || !Object.prototype.hasOwnProperty.call(item, "value") || !Object.prototype.hasOwnProperty.call(item, "weight")) throw new Error("weightedAverage 项不合法");
      readNonNegativeNumber(item.value, state, constraints);
      if (readNonNegativeNumber(item.weight, state, constraints) > 0) positiveWeight = true;
    }
    if (!args.pairs.length || !positiveWeight) throw new Error("weightedAverage 权重总和必须大于零");
    return;
  }
  throw new Error("computed 函数不在白名单中");
}

/** 校验目标值、状态引用或计算表达式的返回类型。 */
function validateDynamicProp(value: unknown, expected: "string" | "number" | "series", state: UiState, constraints: Map<string, NumericConstraint[]>): void {
  if (expected === "string" && typeof value === "string") return;
  if (expected === "number" && typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e15) return;
  if (expected === "series" && Array.isArray(value)) {
    chartSeriesSchema.parse(value);
    return;
  }
  if (!isPlainRecord(value)) throw new Error("动态 prop 类型不匹配");
  if (Object.prototype.hasOwnProperty.call(value, "$state")) {
    const reference = resolveStateReference(value, state);
    if (expected === "string" && typeof reference.value === "string") return;
    if (expected === "number" && typeof reference.value === "number" && Math.abs(reference.value) < 1e15) {
      assertStateConstraints(reference.key, reference.value, constraints, -1e15, 1e15);
      return;
    }
    throw new Error("state 引用类型与目标 prop 不匹配");
  }
  if (Object.prototype.hasOwnProperty.call(value, "$computed")) {
    if (expected === "string") throw new Error("computed 函数结果不能用作文本 prop");
    validateComputedExpression(value, expected === "series" ? "series" : "number", state, constraints);
    return;
  }
  throw new Error("动态 prop 表达式不在白名单中");
}

/** 校验 visible 的单层 state 比较表达式，不开放 item/index、数组、$and 或 $or。 */
function validateVisibility(value: unknown, state: UiState): void {
  if (typeof value === "boolean") return;
  if (!isPlainRecord(value) || typeof value.$state !== "string") throw new Error("visible 只允许单层 state 条件");
  const allowed = new Set(["$state", "eq", "neq", "gt", "gte", "lt", "lte", "not"]);
  if (Object.keys(value).some(function unknownKey(key) { return !allowed.has(key); })) throw new Error("visible 条件包含未知字段");
  const comparators = ["eq", "neq", "gt", "gte", "lt", "lte"].filter(function present(key) { return Object.prototype.hasOwnProperty.call(value, key); });
  if (comparators.length > 1 || (value.not !== undefined && value.not !== true)) throw new Error("visible 仅允许一个比较符和可选 not");
  resolveStateReference({ $state: value.$state }, state);
  if (comparators.length === 0) return;
  const comparator = comparators[0];
  const target = value[comparator];
  if (["gt", "gte", "lt", "lte"].includes(comparator)) {
    if (typeof target === "number" && Number.isFinite(target)) return;
    const reference = resolveStateReference(target, state);
    if (typeof reference.value !== "number") throw new Error("visible 数值比较类型不匹配");
    return;
  }
  if (["eq", "neq"].includes(comparator)) {
    if (typeof target === "string" || typeof target === "boolean" || (typeof target === "number" && Number.isFinite(target))) return;
    const reference = resolveStateReference(target, state);
    if (typeof reference.value !== "string" && typeof reference.value !== "number" && typeof reference.value !== "boolean") throw new Error("visible 比较类型不匹配");
    return;
  }
  throw new Error("visible 比较符不合法");
}

/** 从输入组件读取 statePath，并生成 renderer 需要的 JSON Pointer 绑定。 */
function normalizeInputProps(type: "NumberInput" | "Slider" | "Select" | "Steps" | "ChoiceGroup", props: Record<string, unknown>, state: UiState, constraints: Map<string, NumericConstraint[]>): Record<string, unknown> {
  const key = props.statePath;
  if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(state, key)) throw new Error("输入控件 statePath 未声明");
  const value = state[key];
  if (type === "Select" || type === "ChoiceGroup") {
    const options = props.options as Array<{ value: string | number | boolean }>;
    if (options.some(function invalidOption(option) { return option.value === null || (typeof option.value === "number" && !Number.isFinite(option.value)); })) throw new Error("Select option 值不合法");
    if (type === "ChoiceGroup" && new Set(options.map(function optionValue(option) { return option.value; })).size !== options.length) throw new Error("ChoiceGroup option 值必须唯一");
    if (!options.some(function selected(option) { return option.value === value; })) throw new Error("Select 初始值不在 options 中");
    constraints.set(key, [...(constraints.get(key) ?? []), { kind: "select", values: options.map(function optionValue(option) { return option.value; }) }]);
  } else if (type === "Steps") {
    const items = props.items as unknown[];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= items.length) throw new Error("Steps 初始值必须为有效步骤整数");
    constraints.set(key, [...(constraints.get(key) ?? []), { kind: "range", min: 0, max: items.length - 1, step: 1, integer: true }]);
  } else {
    const minimum = props.min as number;
    const maximum = props.max as number;
    const step = props.step as number;
    if (maximum <= minimum || step <= 0 || (type === "Slider" && (maximum - minimum) / step > 1000)) throw new Error("输入控件 min/max/step 不合法");
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error("输入控件初始值超出范围");
    constraints.set(key, [...(constraints.get(key) ?? []), { kind: "range", min: minimum, max: maximum, step }]);
  }
  const normalized = { ...props };
  delete normalized.statePath;
  normalized.value = { $bindState: `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}` };
  return normalized;
}

/** 校验图表数据点按 x 升序且不重复。 */
function validateChartSeries(value: unknown): void {
  const series = chartSeriesSchema.parse(value);
  for (const item of series) {
    for (let index = 1; index < item.points.length; index++) {
      if (item.points[index].x <= item.points[index - 1].x) throw new Error("图表 x 必须升序且不重复");
    }
  }
}

/** 校验扁平元素引用构成单棵有界树，无悬空、重复、循环或不可达节点。 */
function validateElementTree(root: string, elements: Record<string, unknown>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(key: string, depth: number): void {
    if (depth > UI_MAX_TREE_DEPTH) throw new Error("UI 树深度超限");
    if (!Object.prototype.hasOwnProperty.call(elements, key)) throw new Error("UI 引用悬空");
    if (visiting.has(key)) throw new Error("UI 树包含循环");
    if (visited.has(key)) throw new Error("UI 节点不得被重复引用");
    const element = elements[key];
    if (!isPlainRecord(element)) throw new Error("UI 节点必须是对象");
    visiting.add(key);
    const refs: string[] = [];
    if (element.children !== undefined) {
      if (!Array.isArray(element.children) || element.children.length > UI_MAX_CHILDREN || element.children.some(function invalid(child) { return typeof child !== "string"; })) throw new Error("children 不合法或超限");
      refs.push(...element.children as string[]);
    }
    if (element.slots !== undefined) {
      if (!isPlainRecord(element.slots)) throw new Error("slots 必须是对象");
      for (const slotChildren of Object.values(element.slots)) {
        if (!Array.isArray(slotChildren) || slotChildren.length > UI_MAX_SLOT_CHILDREN || slotChildren.some(function invalid(child) { return typeof child !== "string"; })) throw new Error("slot children 不合法或超限");
        refs.push(...slotChildren as string[]);
      }
    }
    if (new Set(refs).size !== refs.length) throw new Error("UI 子节点不得重复");
    for (const child of refs) visit(child, depth + 1);
    visiting.delete(key);
    visited.add(key);
  }
  visit(root, 1);
  if (visited.size !== Object.keys(elements).length) throw new Error("UI elements 含不可达节点");
}

/** 校验 state、目录、引用与组件 props，并把输入控件的 statePath 收敛为 renderer 绑定。 */
export function validateUiSpec(value: unknown): UiSpec {
  measureJsonBytes(value, UI_MAX_DOCUMENT_BYTES);
  const parsed = uiSpecInputSchema.parse(value);
  const state = parsed.state ?? {};
  if (Object.keys(state).length > UI_MAX_STATE_KEYS || measureJsonBytes(state, UI_MAX_STATE_BYTES) > UI_MAX_STATE_BYTES) throw new Error("UI state 超限");
  const rawElements = parsed.elements as Record<string, unknown>;
  const elementKeys = Object.keys(rawElements);
  if (elementKeys.length < 1 || elementKeys.length > UI_MAX_ELEMENTS) throw new Error("UI elements 数量超限");
  validateElementTree(parsed.root, rawElements);
  const stateConstraints = new Map<string, NumericConstraint[]>();
  const normalizedElements: Record<string, UiElement> = {};
  for (const key of elementKeys) {
    const element = rawElements[key];
    if (!isPlainRecord(element)) throw new Error("UI 节点必须是对象");
    const allowedKeys = new Set(["type", "props", "children", "slots", "visible", "on"]);
    if (Object.keys(element).some(function unknownKey(name) { return !allowedKeys.has(name); })) throw new Error("UI 节点包含未知字段");
    if (typeof element.type !== "string" || !(UI_COMPONENT_NAMES as readonly string[]).includes(element.type)) throw new Error("UI component 不在白名单中");
    const type = element.type as UiComponentName;
    if (!isPlainRecord(element.props)) throw new Error("UI props 必须是对象");
    const propsResult = UI_COMPONENT_SCHEMAS[type].safeParse(element.props);
    if (!propsResult.success) throw new Error("UI props 不符合组件目录");
    const props = propsResult.data as Record<string, unknown>;
    const children = element.children as string[] | undefined;
    const slots = element.slots as Record<string, string[]> | undefined;
    if (["Stack", "Grid", "Card"].includes(type)) {
      if (slots !== undefined) throw new Error("此组件不支持 slots");
    } else if (type === "Tabs") {
      if (children !== undefined || (slots && Object.keys(slots).some(function unknownSlot(name) { return name !== "items"; }))) throw new Error("Tabs 仅支持 slots.items");
    } else if (type === "Disclosure") {
      if (children !== undefined || (slots && Object.keys(slots).some(function unknownSlot(name) { return name !== "content"; }))) throw new Error("Disclosure 仅支持 slots.content");
    } else if (children !== undefined || slots !== undefined) {
      throw new Error("此组件不支持 children 或 slots");
    }
    if (type === "NumberInput" || type === "Slider" || type === "Select" || type === "Steps" || type === "ChoiceGroup") {
      normalizedElements[key] = { type, props: normalizeInputProps(type, props, state, stateConstraints), ...(children ? { children } : {}), ...(slots ? { slots } : {}) };
    } else {
      normalizedElements[key] = { type, props, ...(children ? { children } : {}), ...(slots ? { slots } : {}) };
    }
    if (element.visible !== undefined) normalizedElements[key].visible = element.visible;
    if (element.on !== undefined) normalizedElements[key].on = element.on as Record<string, unknown>;
  }
  for (const key of elementKeys) {
    const element = normalizedElements[key];
    const props = element.props;
    if (element.visible !== undefined) validateVisibility(element.visible, state);
    if (element.type === "Text") validateDynamicProp(props.value, "string", state, stateConstraints);
    if (element.type === "Metric") validateDynamicProp(props.value, "number", state, stateConstraints);
    if (element.type === "LineChart" || element.type === "BarChart") {
      if (props.yMin !== undefined && props.yMax !== undefined && (props.yMax as number) <= (props.yMin as number)) throw new Error("图表 yMin/yMax 不合法");
      if (Array.isArray(props.series)) validateChartSeries(props.series);
      else validateDynamicProp(props.series, "series", state, stateConstraints);
    }
    if (element.type === "Flowchart") {
      const nodes = props.nodes as Array<{ id: string }>;
      const edges = props.edges as Array<{ id: string; from: string; to: string; label?: string }>;
      const ids = new Set(nodes.map(function id(node) { return node.id; }));
      if (ids.size !== nodes.length) throw new Error("Flowchart 节点 id 重复");
      if (new Set(edges.map(function id(edge) { return edge.id; })).size !== edges.length) throw new Error("Flowchart 连线 id 重复");
      const relations = new Set<string>();
      for (const edge of edges) {
        if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error("Flowchart 连线引用未声明节点");
        const relation = JSON.stringify([edge.from, edge.to, edge.label ?? ""]);
        if (relations.has(relation)) throw new Error("Flowchart 连线重复");
        relations.add(relation);
      }
    }
    if (element.type === "DataTable") {
      const propsColumns = props.columns as Array<{ key: string }>;
      const allowedColumns = new Set(propsColumns.map(function columnKey(column) { return column.key; }));
      const rows = props.rows as Array<Record<string, unknown>>;
      for (const row of rows) {
        if (Object.keys(row).some(function unknownColumn(key) { return !allowedColumns.has(key); })) throw new Error("DataTable row 含未知列");
      }
      if (props.filterColumnKey !== undefined) {
        const filterColumnKey = props.filterColumnKey as string;
        if (!allowedColumns.has(filterColumnKey)) throw new Error("DataTable filterColumnKey 未声明");
        let filterValueType: "string" | "number" | undefined;
        for (const row of rows) {
          if (!Object.prototype.hasOwnProperty.call(row, filterColumnKey)) throw new Error("DataTable 筛选列值缺失");
          const valueType = typeof row[filterColumnKey];
          if (valueType !== "string" && valueType !== "number") throw new Error("DataTable 筛选列只允许字符串或数值");
          if (filterValueType !== undefined && filterValueType !== valueType) throw new Error("DataTable 筛选列类型必须一致");
          filterValueType = valueType;
        }
      }
    }
    if (element.type === "Button") {
      const action = props.action;
      if (element.on === undefined || Object.keys(element.on).length !== 1 || !Object.prototype.hasOwnProperty.call(element.on, "press")) throw new Error("Button 仅支持 on.press");
      const binding = element.on.press;
      if (!isPlainRecord(binding) || Object.keys(binding).length !== 1 || binding.action !== action) throw new Error("Button action 必须与 props.action 一致");
      if (action === "continue_chat") {
        const fields = props.fields as Array<{ statePath: string }>;
        for (const field of fields) if (!Object.prototype.hasOwnProperty.call(state, field.statePath)) throw new Error("Button fields statePath 未声明");
      }
    } else if (element.on !== undefined) {
      throw new Error("只有 Button 可以绑定动作");
    }
  }
  return { root: parsed.root, elements: normalizedElements, ...(parsed.state ? { state } : {}) };
}

/** 校验已经规范化的 spec；先把输入控件绑定还原为 statePath，再复用唯一目录校验器。 */
export function validateNormalizedUiSpec(value: unknown): UiSpec {
  const specSchema = z.object({ root: z.string().min(1), elements: z.record(z.string(), z.unknown()), state: z.record(z.string(), scalarSchema).optional() }).strict();
  const parsed = specSchema.parse(value);
  const elements: Record<string, unknown> = {};
  for (const [key, rawElement] of Object.entries(parsed.elements)) {
    if (!isPlainRecord(rawElement) || !["NumberInput", "Slider", "Select", "Steps", "ChoiceGroup"].includes(String(rawElement.type)) || !isPlainRecord(rawElement.props)) {
      elements[key] = rawElement;
      continue;
    }
    const props = { ...rawElement.props };
    const binding = props.value;
    if (!isPlainRecord(binding) || Object.keys(binding).length !== 1 || typeof binding.$bindState !== "string") throw new Error("输入控件绑定不合法");
    delete props.value;
    props.statePath = getStateKeyFromPointer(binding.$bindState);
    elements[key] = { ...rawElement, props };
  }
  return validateUiSpec({ ...parsed, elements });
}

/** 检查单个动态计算数值的运行时参数和输出上限。 */
function readRuntimeNumber(value: unknown, minimum: number, maximum: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) throw new Error("计算参数超出范围");
  return value;
}

/** 确认计算结果有限且满足 Metric/chart 的共同绝对值上限。 */
function assertComputedResult(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e15) throw new Error("计算结果超出安全范围");
  return value;
}

/** 计算储蓄增长并按受限 selector 返回 final 数值或图表目录格式的逐年序列。 */
function savingsGrowth(args: Record<string, unknown>): number | Array<{ name: string; points: Array<{ x: number; y: number }> }> {
  const principal = readRuntimeNumber(args.P, UI_SAVINGS_GROWTH_BOUNDS.P.min, UI_SAVINGS_GROWTH_BOUNDS.P.max);
  const monthlyContribution = readRuntimeNumber(args.C, UI_SAVINGS_GROWTH_BOUNDS.C.min, UI_SAVINGS_GROWTH_BOUNDS.C.max);
  const annualRate = readRuntimeNumber(args.R, UI_SAVINGS_GROWTH_BOUNDS.R.min, UI_SAVINGS_GROWTH_BOUNDS.R.max);
  const years = readRuntimeNumber(args.Y, UI_SAVINGS_GROWTH_BOUNDS.Y.min, UI_SAVINGS_GROWTH_BOUNDS.Y.max, UI_SAVINGS_GROWTH_BOUNDS.Y.integer);
  const selection = args.select;
  if (selection !== "final" && selection !== "series") throw new Error("savingsGrowth selector 不合法");
  const monthlyRate = annualRate / 12;
  /** 按年计算余额并确保每个输出点处于共同数值上限内。 */
  function valueAt(year: number): number {
    const months = year * 12;
    if (monthlyRate === 0) return assertComputedResult(principal + monthlyContribution * months);
    const growth = Math.pow(1 + monthlyRate, months);
    return assertComputedResult(principal * growth + monthlyContribution * (growth - 1) / monthlyRate);
  }
  if (selection === "final") return valueAt(years);
  const points: Array<{ x: number; y: number }> = [];
  for (let year = 0; year <= years; year++) points.push({ x: year, y: valueAt(year) });
  return [{ name: "储蓄余额", points }];
}

/** 计算有界非负数值数组的总和。 */
function sum(args: Record<string, unknown>): number {
  if (!Array.isArray(args.values) || args.values.length > UI_MAX_COMPUTED_ITEMS) throw new Error("sum values 不合法");
  let total = 0;
  for (const item of args.values) total += readRuntimeNumber(item, 0, Number.MAX_VALUE);
  return assertComputedResult(total);
}

/** 计算有界非负数值对的加权平均，先归一权重以避免权重求和溢出。 */
function weightedAverage(args: Record<string, unknown>): number {
  if (!Array.isArray(args.pairs) || args.pairs.length < 1 || args.pairs.length > UI_MAX_COMPUTED_ITEMS) throw new Error("weightedAverage pairs 不合法");
  const pairs = args.pairs.map(function parsePair(item) {
    if (!isPlainRecord(item)) throw new Error("weightedAverage pair 不合法");
    return { value: readRuntimeNumber(item.value, 0, Number.MAX_VALUE), weight: readRuntimeNumber(item.weight, 0, Number.MAX_VALUE) };
  });
  const maxWeight = Math.max(...pairs.map(function weightOf(item) { return item.weight; }));
  if (maxWeight <= 0) throw new Error("weightedAverage 权重总和必须大于零");
  const scaledTotal = pairs.reduce(function addWeight(total, item) { return total + item.weight / maxWeight; }, 0);
  const average = pairs.reduce(function addValue(total, item) { return total + item.value * (item.weight / maxWeight / scaledTotal); }, 0);
  return assertComputedResult(average);
}

export const UI_COMPUTED_FUNCTIONS: Record<string, (args: Record<string, unknown>) => unknown> = Object.freeze({
  savingsGrowth: function computeSavingsGrowth(args) { return savingsGrowth(args); },
  weightedAverage: function computeWeightedAverage(args) { return weightedAverage(args); },
  sum: function computeSum(args) { return sum(args); },
});

/** 在纯数据子路径提供尺寸预检给 document.ts，限制在超限前即停止遍历。 */
export function measureUiJsonBytes(value: unknown, maxBytes = UI_MAX_DOCUMENT_BYTES): number {
  return measureJsonBytes(value, maxBytes);
}
