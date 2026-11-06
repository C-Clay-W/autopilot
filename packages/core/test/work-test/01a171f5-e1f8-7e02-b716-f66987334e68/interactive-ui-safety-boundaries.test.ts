/** Core Intelligent UI 安全边界：白名单、树引用、序列化限额与有限数值。 */
import { describe, expect, it } from "vitest";
import { validateUiDocumentInput } from "../../../src/ui";

/** 将待测 spec 包装成最小合法 UI 文档外壳。 */
function documentWithSpec(spec: unknown) {
  return { title: "安全边界", fallbackText: "", spec };
}

/** 返回最小白名单 Text 节点，用于拼出合法树和变异边界。 */
function textElement(value: unknown = "正文") {
  return { type: "Text", props: { value, size: "md", tone: "ink" } };
}

/** 返回可复用纸本 Stack 节点，子节点关系由测试单独控制。 */
function stackElement(children: string[]) {
  return { type: "Stack", props: { direction: "column", gap: 4 }, children };
}

describe("Core UI security boundaries", function suite() {
  it("拒绝未知组件、函数、动作、危险 prop 与危险 JSON 键", function rejectsUnsafeVocabulary() {
    const unknownComponent = { root: "x", elements: { x: { type: "script", props: {} } } };
    const unknownFunction = { root: "x", elements: { x: { type: "Metric", props: { label: "数值", value: { $computed: "eval", args: {} } } } } };
    const unknownAction = { root: "x", elements: { x: { type: "Button", props: { action: "navigate", fields: [], text: "访问" }, on: { press: { action: "navigate" } } } } };
    const styleProp = { root: "x", elements: { x: { type: "Text", props: { value: "文本", size: "md", tone: "ink", style: { color: "red" } } } } };
    const dangerousKeyProps = JSON.parse('{"value":"文本","size":"md","tone":"ink","constructor":"unsafe"}');
    const dangerousKey = { root: "x", elements: { x: { type: "Text", props: dangerousKeyProps } } };

    for (const spec of [unknownComponent, unknownFunction, unknownAction, styleProp, dangerousKey]) {
      expect(function validateUnsafeSpec() { validateUiDocumentInput(documentWithSpec(spec)); }).toThrow();
    }
  });

  it("拒绝悬空与循环引用", function rejectsBrokenTreeReferences() {
    const dangling = { root: "root", elements: { root: stackElement(["missing"]) } };
    const cycle = { root: "a", elements: { a: stackElement(["b"]), b: stackElement(["a"]) } };
    expect(function validateDanglingTree() { validateUiDocumentInput(documentWithSpec(dangling)); }).toThrow();
    expect(function validateCyclicTree() { validateUiDocumentInput(documentWithSpec(cycle)); }).toThrow();
  });

  it("先拒绝 UTF-8 字节超限，再拒绝节点数与树深超限", function rejectsDocumentLimits() {
    const columns = Array.from({ length: 8 }, function column(_value, index) { return { key: `c${index}`, label: `列${index}` }; });
    const rows = Array.from({ length: 100 }, function row() {
      const value: Record<string, string> = {};
      for (let index = 0; index < 8; index++) value[`c${index}`] = "x".repeat(120);
      return value;
    });
    const oversized = { root: "table", elements: { table: { type: "DataTable", props: { columns, rows } } } };
    expect(function validateOversizedDocument() { validateUiDocumentInput(documentWithSpec(oversized)); }).toThrow();

    const tooManyElements: Record<string, unknown> = {};
    for (let index = 0; index < 129; index++) tooManyElements[`n${index}`] = textElement();
    expect(function validateNodeLimit() { validateUiDocumentInput(documentWithSpec({ root: "n0", elements: tooManyElements })); }).toThrow();

    const deepElements: Record<string, unknown> = {};
    for (let index = 0; index < 13; index++) deepElements[`n${index}`] = stackElement(index < 12 ? [`n${index + 1}`] : []);
    expect(function validateDepthLimit() { validateUiDocumentInput(documentWithSpec({ root: "n0", elements: deepElements })); }).toThrow();
  });

  it("拒绝 NaN、Infinity 和非有限 state", function rejectsNonFiniteNumbers() {
    const nanMetric = { root: "metric", elements: { metric: { type: "Metric", props: { label: "非有限", value: Number.NaN } } } };
    const infiniteMetric = { root: "metric", elements: { metric: { type: "Metric", props: { label: "非有限", value: Number.POSITIVE_INFINITY } } } };
    const nonFiniteState = { root: "text", elements: { text: textElement() }, state: { amount: Number.NaN } };
    for (const spec of [nanMetric, infiniteMetric, nonFiniteState]) {
      expect(function validateNonFiniteSpec() { validateUiDocumentInput(documentWithSpec(spec)); }).toThrow();
    }
  });
});
