/** 分隔条方向与显示门槛契约：右栏（Diff）左移加宽，左栏（预览）右移加宽，预览不受 768px 视口限制（AC-6/9）。 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DiffSidebarDivider, { dividerWidthFromDrag, dividerWidthFromKey } from "@/app/chat/components/DiffSidebarDivider";

const noop = function noop(): void {};

describe("分隔条方向换算", function directionSuite() {
  it("Diff 右栏：指针左移加宽，ArrowLeft 加宽", function diffDirection() {
    expect(dividerWidthFromDrag(500, -20, "left")).toBe(520);
    expect(dividerWidthFromDrag(500, 20, "left")).toBe(480);
    expect(dividerWidthFromKey(500, "ArrowLeft", 20, "left")).toBe(520);
    expect(dividerWidthFromKey(500, "ArrowRight", 20, "left")).toBe(480);
    // 默认 widenOn 即 Diff 行为，旧调用不传参数时方向不变。
    expect(dividerWidthFromDrag(500, -20)).toBe(520);
    expect(dividerWidthFromKey(500, "ArrowLeft", 20)).toBe(520);
  });

  it("预览左栏：指针右移加宽，ArrowRight 加宽", function previewDirection() {
    expect(dividerWidthFromDrag(500, 20, "right")).toBe(520);
    expect(dividerWidthFromDrag(500, -20, "right")).toBe(480);
    expect(dividerWidthFromKey(500, "ArrowRight", 20, "right")).toBe(520);
    expect(dividerWidthFromKey(500, "ArrowLeft", 20, "right")).toBe(480);
  });

  it("非方向键交给调用方处理", function ignoresOtherKeys() {
    expect(dividerWidthFromKey(500, "Home", 20, "right")).toBeUndefined();
    expect(dividerWidthFromKey(500, "End", 20, "left")).toBeUndefined();
    expect(dividerWidthFromKey(500, "Tab", 20, "right")).toBeUndefined();
  });
});

describe("分隔条显示门槛", function gatingSuite() {
  it("Diff 默认受桌面视口约束，窄屏隐藏", function diffViewportGated() {
    const markup = renderToStaticMarkup(<DiffSidebarDivider width={420} onChange={noop} />);
    expect(markup).toContain("hidden");
    expect(markup).toContain("md:block");
    expect(markup).toContain("cursor-col-resize");
  });

  it("预览传 viewportGated=false 时不受视口约束，容器够宽即可操作", function previewContainerGated() {
    const markup = renderToStaticMarkup(<DiffSidebarDivider width={320} onChange={noop} label="调整预览区域宽度" widenOn="right" viewportGated={false} />);
    expect(markup).not.toContain("md:block");
    expect(markup).not.toContain("hidden");
    expect(markup).toContain("cursor-col-resize");
    expect(markup).toContain('role="separator"');
  });
});
