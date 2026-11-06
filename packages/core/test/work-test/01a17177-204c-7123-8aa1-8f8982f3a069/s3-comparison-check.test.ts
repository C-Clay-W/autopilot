/** S3比较验收器离线回归：布局和命名自由，关键选择/事实/续聊功能仍须满足。 */
import { describe, expect, it } from "vitest";
import { createUiDocument, validateUiDocumentInput } from "../../../src/ui/index";
import { checkS3Comparison } from "../../helpers/s3-comparison-check";

/** 生成无Grid/Card、选项/行列逆序且内部值不为A/B的合成比较输入。 */
function fixture(key = "choice", prefix = "node") {
  const binding = `/${key}`;
  return {
    title: "方案比较", fallbackText: "比较两个给定方案。",
    spec: {
      root: `${prefix}Root`, state: { [key]: "second" },
      elements: {
        [`${prefix}Root`]: { type: "Stack", props: { direction: "column", gap: 8 }, children: ["pick", "aNote", "bNote", "facts", "send"] },
        pick: { type: "Select", props: { label: "选择", statePath: key, options: [{ label: "方案B", value: "second" }, { label: "方案A", value: "first" }] } },
        aNote: { type: "Text", props: { value: "方案A更便宜。", size: "md", tone: "ink" }, visible: { $state: binding, neq: "second" } },
        bNote: { type: "Text", props: { value: "方案B性能更高。", size: "md", tone: "ink" }, visible: { $state: binding, eq: "first", not: true } },
        facts: { type: "DataTable", props: { columns: [{ key: "power", label: "性能" }, { key: "identity", label: "方案" }, { key: "cost", label: "价格" }], rows: [{ identity: "B", cost: "150", power: 95 }, { identity: "A", cost: 100, power: "80" }] } },
        send: { type: "Button", props: { text: "继续", action: "continue_chat", fields: [{ label: "所选方案", statePath: key }] }, on: { press: { action: "continue_chat" } } },
      } as Record<string, any>,
    },
  };
}

/** 所有验收输入先经过真实Core校验和规范化，不以手造归一对象代替。 */
function check(input: ReturnType<typeof fixture>) {
  return checkS3Comparison(createUiDocument(validateUiDocumentInput(input), `ui_${"0".repeat(32)}`));
}

describe("S3 synthetic comparison functional checks", function suite() {
  it.each([["choice", "node"], ["selected_offer", "different"]])("无Grid/Card且命名变化仍通过：%s/%s", function accepts(key, prefix) {
    expect(check(fixture(key, prefix))).toEqual({ selection: true, conditionalExplanation: true, facts: true, continuation: true, passed: true });
  });

  it.each(["pick", "facts", "send"])("缺少关键功能仍拒绝：%s", function missing(id) {
    const input = fixture();
    input.spec.elements[id] = { type: "Text", props: { value: "普通说明", size: "md", tone: "ink" } };
    expect(check(input).passed).toBe(false);
  });

  it("静态说明不能代替visible随选择切换", function noVisibility() {
    const input = fixture();
    delete input.spec.elements.aNote.visible;
    delete input.spec.elements.bNote.visible;
    expect(check(input)).toMatchObject({ passed: false, failureCode: "COMPARISON_VISIBLE_EXPLANATION_MISSING" });
  });

  it("事实数值错误仍拒绝", function wrongFacts() {
    const input = fixture();
    input.spec.elements.facts.props.rows[0].power = 96;
    expect(check(input)).toMatchObject({ passed: false, failureCode: "COMPARISON_FACTS_MISMATCH" });
  });

  it("continue_chat没有选择字段仍拒绝", function missingField() {
    const input = fixture();
    input.spec.elements.send.props.fields = [];
    expect(check(input)).toMatchObject({ passed: false, failureCode: "COMPARISON_CONTINUATION_FIELD_MISSING" });
  });
});
