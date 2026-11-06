/** 验证 render_ui 的目录说明、按需选择规则和实际 Core 校验过的样例。 */
import { describe, expect, it } from "vitest";
import { createRenderUiTool } from "../../../src/internal/tools/builtins/render-ui-tool";
import { UI_COMPONENT_NAMES } from "../../../src/ui/catalog";
import { validateUiDocumentInput } from "../../../src/ui/document";

describe("render_ui generation guidance", function suite() {
  it("从单一 Core 目录说明全部类型并界定独立 UI 块的按需生成", function describesCatalogAndSelection() {
    const description = createRenderUiTool(function collect() {}).description;

    expect(description).toContain(`仅可使用下列${UI_COMPONENT_NAMES.length}类`);
    for (const name of UI_COMPONENT_NAMES) expect(description).toContain(`"${name}"`);
    expect(description).toContain("一次成功调用只交付一个独立UI块");
    expect(description).toContain("同一Turn可按主题需要重复调用");
    expect(description).toContain("0到3个块");
    expect(description).toContain("普通代码输出或简单解释用文字即可");
    expect(description).toContain("不要强行使用Tabs或图表");
    expect(description).toContain("Steps初值须为0起且小于步骤数的整数");
    expect(description).toContain("ChoiceGroup选项值须唯一且初值须匹配一个选项");
    expect(description).toContain("filterColumnKey须指向已声明且各行都有值的同类型字符串/数值列");
    expect(description).toContain("Steps供用户本地切换讲解步骤且不代表Agent执行进度");
    expect(description).not.toContain("下列14类");
  });

  it("说明中的行程和预算样例均由当前 Core validator 接受", function validatesGuidanceExamples() {
    const description = createRenderUiTool(function collect() {}).description;
    const marker = description.indexOf("以下两个最小输入例");
    const start = description.indexOf("\n[", marker) + 1;
    const end = description.indexOf("\n组件props JSON Schema：", start);
    const inputs = JSON.parse(description.slice(start, end)) as unknown[];
    const documents = inputs.map(function validate(input) { return validateUiDocumentInput(input); });
    const types = new Set(documents.flatMap(function componentTypes(document) {
      return Object.values(document.spec.elements).map(function component(element) { return element.type; });
    }));
    const resetButton = documents.flatMap(function elements(document) { return Object.values(document.spec.elements); })
      .find(function reset(element) { return element.type === "Button" && element.props.action === "reset_state"; });

    expect(documents).toHaveLength(2);
    expect(documents.map(function title(document) { return document.title; })).toEqual(["当天行程", "方案预算对照"]);
    expect([...types]).toEqual(expect.arrayContaining(["ItemList", "Timeline", "Steps", "ChoiceGroup"]));
    expect(resetButton).toMatchObject({
      props: { action: "reset_state" },
      on: { press: { action: "reset_state" } },
    });
  });
});
