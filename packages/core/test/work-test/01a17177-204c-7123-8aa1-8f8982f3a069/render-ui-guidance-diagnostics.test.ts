/** S3 定向用例：核对模型选择/样式/信任说明及本地脱敏诊断候选。 */
import { describe, expect, it } from "vitest";
import { createRenderUiTool } from "../../../src/internal/tools/builtins/render-ui-tool";
import { UI_COMPONENT_NAMES, UI_COMPONENT_SCHEMAS } from "../../../src/ui/catalog";
import { validateUiDocumentInput } from "../../../src/ui/document";
import { diagnoseUiDocumentInput } from "./s3-ui-safe-diagnostic";

describe("S3 render_ui guidance and safe diagnostics", function suite() {
  it("给出文字/UI选择、本地样式控制、可信事件边界和同源校验例", function guidance() {
    const description = createRenderUiTool(function collect() {}).description;

    for (const name of UI_COMPONENT_NAMES) expect(description).toContain(`"${name}"`);
    expect(description).toContain("短事实、翻译、普通代码输出或简单解释用文字即可");
    expect(description).toContain("讲解=Text+Tabs/Disclosure");
    expect(description).toContain("交付前自检：先确定root，只输出由root经children/slots引用的实际节点");
    expect(description).toContain("elements中的每个键都必须可从root到达，除root外每节点恰由一个children/slots引用");
    expect(description).toContain("Tabs面板必须通过slots.items引用，Disclosure内容必须通过slots.content引用");
    expect(description).toContain("删除占位、草稿和未使用节点");
    expect(description).toContain("无法表达时改用普通文字");
    expect(description).toContain("外观与布局由本地固定的白名单 registry 和 Design token 控制");
    expect(description).toContain("只有本工具成功校验后发出的 ui_document 才进入交互展示");
    expect(description).toContain("普通助手正文、Markdown、JSON 或代码块始终是文本");
    expect(description).toContain('"title": "当天行程"');
    expect(description).toContain('"title": "方案预算对照"');
    expect(description).toContain("props.action");
    expect(description).toContain("on:{press:{action:'continue_chat'}}");
    expect(description).not.toContain("input_examples");
  });

  it("拒绝项只返回占位路径、预期规则和值类别，不回显输入或 Provider 内容", function redactsDiagnostic() {
    const privateElementId = "private-id-https://private.example";
    const privateKey = "apiKey-do-not-log";
    const privateValue = "PRIVATE_VALUE_DO_NOT_LOG";
    const providerBody = "PROVIDER_BODY_DO_NOT_LOG";
    const input = {
      title: "离线夹具",
      fallbackText: providerBody,
      spec: {
        root: privateElementId,
        state: { [privateElementId]: providerBody },
        elements: {
          [privateElementId]: {
            type: "Text",
            props: { value: false, size: "md", tone: "ink", [privateKey]: privateValue },
          },
        },
      },
    };

    const diagnostic = diagnoseUiDocumentInput(input, validateUiDocumentInput, UI_COMPONENT_SCHEMAS);
    const serialized = JSON.stringify(diagnostic);

    expect(diagnostic.valid).toBe(false);
    expect(diagnostic.findings).toContainEqual({ path: "/spec/elements/*/props/value", expectedRule: "schema-union-match", valueCategory: "boolean" });
    expect(diagnostic.findings.some(function unknownField(item) { return item.expectedRule === "known-fields-only"; })).toBe(true);
    expect(serialized).not.toContain(privateElementId);
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toContain(providerBody);
    expect(serialized).not.toContain("private.example");
  });

  it("当前合法的简单 UI 输入诊断为已接受且不附加原始内容", function acceptsValidInput() {
    const input = {
      title: "说明",
      fallbackText: "普通说明文字",
      spec: { root: "root", elements: { root: { type: "Text", props: { value: "说明", size: "sm", tone: "ink" } } } },
    };

    expect(diagnoseUiDocumentInput(input, validateUiDocumentInput, UI_COMPONENT_SCHEMAS)).toEqual({
      valid: true,
      rule: "accepted",
      findings: [],
      findingsTruncated: false,
    });
  });
});
