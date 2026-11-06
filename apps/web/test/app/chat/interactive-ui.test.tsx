/** S2 Web 定向验证：库真实服务端渲染与纯计算，不冒充浏览器 DOM/键盘验收。 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStateStore, JSONUIProvider, Renderer, type Spec } from "@json-render/react";
import { projectUiDocument, UI_COMPONENT_NAMES } from "@autopilot-agent/core/ui";
import { createSavingsFixture } from "../../../../../packages/presentation/test/interactive-ui.fixture";
import InteractiveUIBlock, { readRenderableDocument } from "@/app/chat/components/interactive-ui/InteractiveUIBlock";
import { computedFunctions, readNumericInput } from "@/app/chat/components/interactive-ui/computed-functions";
import { UiDocumentContext, uiRegistry } from "@/app/chat/components/interactive-ui/registry";
import type { UiDocumentItem } from "@autopilot-agent/presentation";

/** 用独立库 store 渲染同一文档，复用真实 Renderer 而非手写表达式解释器。 */
function renderWithStore(document: ReturnType<typeof createSavingsFixture>, store: ReturnType<typeof createStateStore>) {
  return renderToStaticMarkup(createElement(UiDocumentContext.Provider, { value: document }, createElement(JSONUIProvider, { registry: uiRegistry, store, functions: computedFunctions, children: createElement(Renderer, { registry: uiRegistry, spec: document.spec as Spec }) })));
}

/** 创建与共享 reducer 相同的实例模型。 */
function item(document: ReturnType<typeof createSavingsFixture>): UiDocumentItem {
  return { id: "ui:test", kind: "ui_document", sessionId: "session", turnId: "turn", uiId: document.uiId, title: document.title, fallbackText: document.fallbackText, document };
}

describe("S2 interactive UI renderer", function suite() {
  it("完整储蓄 spec 通过真实 json-render 渲染，绑定与计算在实例 store 内变化", function localState() {
    const document = createSavingsFixture();
    const first = createStateStore({ ...document.spec.state });
    const second = createStateStore({ ...document.spec.state });
    const before = renderWithStore(document, first);
    expect(Object.keys(uiRegistry).sort()).toEqual([...UI_COMPONENT_NAMES].sort());
    expect(before).toContain("3,400");
    expect(before).toContain('value="1000"');
    expect(before).toContain("查看图表数据");
    expect(before).toContain("当前无法发送");
    expect(before).toMatch(/<button[^>]*disabled=""[^>]*>按当前参数继续分析/);
    const updated = projectUiDocument({ ...document, spec: { ...document.spec, state: { ...document.spec.state, principal: 2000 } } });
    first.set("/principal", updated.spec.state!.principal);
    expect(renderWithStore(document, first)).toContain("4,400");
    expect(renderWithStore(document, second)).toContain("3,400");
    expect(renderWithStore(document, createStateStore({ ...document.spec.state }))).toContain("3,400");
    expect(document.spec.state!.principal).toBe(1000);
  });

  it("输入与计算有界，零利率口径正确，非法状态不通过 Core 再校验", function boundaries() {
    expect(readNumericInput("", 0, 100, 1)).toBeUndefined();
    expect(readNumericInput("Infinity", 0, 100, 1)).toBeUndefined();
    expect(readNumericInput("101", 0, 100, 1)).toBeUndefined();
    expect(readNumericInput("1.5", 0, 100, 1)).toBeUndefined();
    expect(readNumericInput("0.003", 0, 0.3, 0.001)).toBe(0.003);
    expect(computedFunctions.savingsGrowth({ P: 1000, C: 100, R: 0, Y: 2, select: "final" })).toBe(3400);
    expect(computedFunctions.savingsGrowth({ P: 1e12, C: 1e9, R: 0.3, Y: 60, select: "final" })).toBeNull();
    expect(computedFunctions.weightedAverage({ pairs: [{ value: 1, weight: 0 }] })).toBeNull();
    expect(computedFunctions.sum({ values: [1, 2, 3] })).toBe(6);
    const document = createSavingsFixture();
    expect(function invalidState() { projectUiDocument({ ...document, spec: { ...document.spec, state: { ...document.spec.state, years: 0 } } }); }).toThrow();
  });

  it("非法文档与未知版本局部回退，同级有效块与文字仍能渲染", function fallback() {
    const document = createSavingsFixture();
    for (const bad of [{ ...document, schemaVersion: 99 }, { ...document, spec: { root: "script", elements: { script: { type: "script", props: { html: "RAW_NODE" } } } } }]) {
      expect(readRenderableDocument(bad)).toBeUndefined();
    }
    const invalid: UiDocumentItem = { ...item(document), document: undefined, fallbackText: "安全回退说明" };
    const html = renderToStaticMarkup(createElement("div", null, "原有正文", createElement(InteractiveUIBlock, { item: invalid }), createElement(InteractiveUIBlock, { item: item(document) })));
    expect(html).toContain("原有正文");
    expect(html).toContain("安全回退说明");
    expect(html).toContain("3,400");
    expect(html).not.toContain("RAW_NODE");
    expect(html).toContain("刷新后恢复初始值");
  });

  it("同一回复的多个 UI 块按顺序渲染且各自使用文档初始状态", function multipleBlocks() {
    const firstDocument = createSavingsFixture();
    const secondDocument = projectUiDocument({
      ...firstDocument,
      uiId: `ui_${"1".repeat(32)}`,
      title: "另一个预算方案",
      spec: { ...firstDocument.spec, state: { ...firstDocument.spec.state, principal: 2000 } },
    });
    const html = renderToStaticMarkup(createElement("div", null,
      createElement(InteractiveUIBlock, { item: item(firstDocument) }),
      createElement(InteractiveUIBlock, { item: item(secondDocument) }),
    ));

    expect(html.indexOf(`aria-label="${firstDocument.title}"`)).toBeLessThan(html.indexOf(`aria-label="${secondDocument.title}"`));
    expect(html).toContain("3,400");
    expect(html).toContain("4,400");
  });
});
