/** 主模型选择回归：离线检查可见下拉与自定义入口，复用真实组件回调而不启动浏览器。 */
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ModelConnectionFields from "@/app/settings/ModelConnectionFields";
import type { MainSettingsInput } from "@/lib/settings/credential-settings";

type ControlProps = { id?: string; children?: ReactNode; value?: string; onChange?: (event: { target: { value: string } }) => void };

/** 在纯组件返回的元素树中定位表单控件，以执行其真实 onChange 回调。 */
function findControl(node: ReactNode, id: string): ReactElement<ControlProps> | undefined {
  if (!isValidElement<ControlProps>(node)) return undefined;
  if (node.props.id === id) return node;
  for (const child of Children.toArray(node.props.children)) {
    const control = findControl(child, id);
    if (control) return control;
  }
  return undefined;
}

const main: MainSettingsInput = { provider: "custom", apiProtocol: "openai-responses", compatibilityPreset: "openai", baseUrl: "https://main.fixture/v1", model: "gpt-6-luna", availableModels: ["gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra"], effort: "xhigh" };

describe("ModelConnectionFields model selection", function suite() {
  it("当前连接的全部候选以可见下拉展示，切换模型保留连接与候选并重置 effort", function selectsConfiguredModel() {
    const onChange = vi.fn();
    const fields = ModelConnectionFields({ value: main, onChange });
    const html = renderToStaticMarkup(fields);
    expect(html).toContain('<select id="main-model"');
    for (const model of main.availableModels!) expect(html).toContain(`value="${model}"`);
    expect(html).not.toContain("datalist");
    expect(findControl(fields, "main-model")?.props.value).toBe("gpt-6-luna");
    findControl(fields, "main-model")?.props.onChange?.({ target: { value: "gpt-6.1-sol" } });
    expect(onChange).toHaveBeenCalledWith({ ...main, model: "gpt-6.1-sol", effort: "auto" });
  });

  it("手填入口保留完整自定义 ID 和既有候选，未登记的当前模型可继续编辑", function editsCustomModel() {
    const onChange = vi.fn();
    findControl(ModelConnectionFields({ value: main, onChange }), "main-model")?.props.onChange?.({ target: { value: "" } });
    const customDraft = onChange.mock.calls[0][0] as MainSettingsInput;
    const customFields = ModelConnectionFields({ value: customDraft, onChange });
    expect(findControl(customFields, "main-custom-model")?.props.value).toBe("");
    findControl(customFields, "main-custom-model")?.props.onChange?.({ target: { value: "vendor/custom-model" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...main, model: "vendor/custom-model", effort: "auto" });
    const restored = ModelConnectionFields({ value: { ...main, model: "already-custom" }, onChange });
    expect(findControl(restored, "main-model")?.props.value).toBe("");
    expect(findControl(restored, "main-custom-model")?.props.value).toBe("already-custom");
  });
});
