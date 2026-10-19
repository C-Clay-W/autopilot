/**
 * CLI 首次 Trust 对话框契约测试：冻结选项、焦点移动、确认/取消与安全文案。
 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { Key } from "ink";
import { resolveTrustDialogNavigation, TuiTrustDialog, TRUST_DIALOG_OPTIONS } from "../src/tui.js";

/** 构造最小 Ink Key 对象；只覆盖 Trust 对话框实际读取的字段。 */
function key(partial: Partial<Key>): Key {
  return {
    upArrow: false,
    downArrow: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    meta: false,
    ...partial,
  } as Key;
}

describe("CLI Trust dialog", function cliTrustDialogSuite() {
  it("选项固定为是/否两项，Yes 是唯一授权动作", function freezesOptions() {
    expect(TRUST_DIALOG_OPTIONS.map(function valueOf(option) { return option.value; })).toEqual(["grant", "decline"]);
  });

  it("↑/↓ 在两项之间钳制，Enter 确认，Esc/Ctrl+C 取消", function navigatesAndConfirms() {
    expect(resolveTrustDialogNavigation("", key({ upArrow: true }), 0).next).toBe(0);
    expect(resolveTrustDialogNavigation("", key({ downArrow: true }), 0).next).toBe(1);
    expect(resolveTrustDialogNavigation("", key({ downArrow: true }), 1).next).toBe(1);
    expect(resolveTrustDialogNavigation("", key({ upArrow: true }), 1).next).toBe(0);
    expect(resolveTrustDialogNavigation("", key({ return: true }), 0)).toEqual({ next: 0, action: "confirm" });
    expect(resolveTrustDialogNavigation("", key({ escape: true }), 1)).toEqual({ next: 1, action: "cancel" });
    expect(resolveTrustDialogNavigation("\u0003", key({ ctrl: true }), 0)).toEqual({ next: 0, action: "cancel" });
  });

  it("渲染 canonical 工作区、能力风险说明与 Yes/No", function rendersTrustCard() {
    const { lastFrame } = render(<TuiTrustDialog workspaceRoot="C:/workspace/project" selectedIndex={0} useColor={false} screenReader={true} />);
    const frame = lastFrame();
    expect(frame).toContain("访问工作区");
    expect(frame).toContain("C:/workspace/project");
    expect(frame).toContain("仅当这是你创建或信任的项目时继续");
    expect(frame).toContain("Agent 将能够在此工作区内读取、编辑和执行文件");
    expect(frame).toContain("是，我信任此工作区");
    expect(frame).toContain("否，退出");
  });
});
