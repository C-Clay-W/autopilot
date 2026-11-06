/** 独立 SSR 冒烟：验证新目录组件经真实 registry 生成安全语义标记；不模拟 DOM 交互。 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createUiDocument, validateUiDocumentInput, UI_COMPONENT_NAMES } from "@autopilot-agent/core/ui";
import type { UiDocumentItem } from "@autopilot-agent/presentation";
import InteractiveUIBlock from "@/app/chat/components/interactive-ui/InteractiveUIBlock";
import { uiRegistry } from "@/app/chat/components/interactive-ui/registry";

describe("independent interactive UI renderer SSR", function suite() {
  it("新组件与本地 reset 控件经唯一 registry 输出安全语义标记", function rendersNewComponents() {
    const document = createUiDocument(validateUiDocumentInput({
      title: "清单与方案",
      fallbackText: "清单与方案说明",
      spec: {
        root: "root",
        state: { step: 0, choice: "steady" },
        elements: {
          root: { type: "Stack", props: { direction: "column", gap: 8 }, children: ["list", "timeline", "steps", "choice", "table", "reset"] },
          list: { type: "ItemList", props: { ordered: true, items: [{ title: "第一项", description: "准备资料" }] } },
          timeline: { type: "Timeline", props: { items: [{ label: "今天", title: "出发", description: "按给定顺序展示" }] } },
          steps: { type: "Steps", props: { items: [{ title: "准备" }, { title: "确认" }], statePath: "step" } },
          choice: { type: "ChoiceGroup", props: { label: "方案", statePath: "choice", options: [{ value: "steady", label: "稳健" }, { value: "growth", label: "增长" }] } },
          table: { type: "DataTable", props: { columns: [{ key: "group", label: "类别" }, { key: "amount", label: "金额" }], rows: [{ group: "固定", amount: 2 }, { group: "弹性", amount: 1 }], filterColumnKey: "group", sortable: true } },
          reset: { type: "Button", props: { action: "reset_state", text: "重置本块" }, on: { press: { action: "reset_state" } } },
        },
      },
    }), `ui_${"d".repeat(32)}`);
    const item: UiDocumentItem = {
      id: "ui:ssr",
      kind: "ui_document",
      sessionId: "session-ssr",
      turnId: "turn-ssr",
      uiId: document.uiId,
      title: document.title,
      fallbackText: document.fallbackText,
      document,
    };

    const html = renderToStaticMarkup(createElement(InteractiveUIBlock, { item }));

    expect(Object.keys(uiRegistry).sort()).toEqual([...UI_COMPONENT_NAMES].sort());
    expect(html).toContain("第一项");
    expect(html).toContain("出发");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('type="radio"');
    expect(html).toContain('checked=""');
    expect(html).toContain("按类别筛选");
    expect(html).toMatch(/<option[^>]*value="all"[^>]*>全部<\/option>/);
    expect(html).toContain('aria-sort="none"');
    expect(html).toContain("恢复本块初始值，不会发送消息。");
  });
});
