/** ChatPageHeader 焦点回归：Escape 关闭面板并把焦点请求送回 Context 控件。 */
import { describe, expect, it, vi } from "vitest";
import { closeContextPanelOnEscape } from "@/app/chat/components/ChatPageHeader";

describe("ChatPageHeader Context panel focus", function contextPanelFocusSuite() {
  it("Escape 关闭面板并聚焦 Context 按钮目标", function restoresContextFocusAfterEscape() {
    let panelOpen = false;
    let focusedTarget = "context";
    const panelButton = { focus: vi.fn(function focusPanelButton() { focusedTarget = "panel"; }) };
    const contextButton = { focus: vi.fn(function focusContextButton() { focusedTarget = "context"; }) } as Pick<HTMLButtonElement, "focus">;
    function closePanel(): void {
      panelOpen = false;
    }

    panelOpen = true;
    panelButton.focus();
    closeContextPanelOnEscape({ key: "Escape" }, closePanel, contextButton);

    expect(panelOpen).toBe(false);
    expect(panelButton.focus).toHaveBeenCalledOnce();
    expect(contextButton.focus).toHaveBeenCalledOnce();
    expect(focusedTarget).toBe("context");
  });

  it("非 Escape 按键不关闭面板或移动焦点", function ignoresOtherKeys() {
    const closePanel = vi.fn();
    const contextButton = { focus: vi.fn() } as Pick<HTMLButtonElement, "focus">;

    closeContextPanelOnEscape({ key: "Enter" }, closePanel, contextButton);

    expect(closePanel).not.toHaveBeenCalled();
    expect(contextButton.focus).not.toHaveBeenCalled();
  });
});
