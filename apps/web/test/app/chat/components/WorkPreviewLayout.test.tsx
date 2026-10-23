/** 预览布局静态契约：双栏比例、分隔条语义、窄屏保留消息区组件与面板槽位稳定（AC-6）。 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import WorkPreviewLayout from "@/app/chat/components/WorkPreviewLayout";

const noop = function noop(): void {};
const panel = <aside id="work-preview-panel">panel</aside>;
const children = <div id="left-column">messages</div>;

/** 渲染指定宽度与状态的布局 HTML。 */
function render(containerWidth: number, active: boolean, narrow: boolean): string {
  return renderToStaticMarkup(<WorkPreviewLayout containerWidth={containerWidth} leftRatio={50} onLeftRatioChange={noop} active={active} narrow={narrow} panel={panel}>{children}</WorkPreviewLayout>);
}

describe("WorkPreviewLayout", function suite() {
  it("未打开时保持原 flex-1 单栏，不渲染面板与分隔条", function inactive() {
    const html = render(1000, false, false);
    expect(html).toContain("flex-1");
    expect(html).toContain("left-column");
    expect(html).not.toContain("work-preview-panel");
    expect(html).not.toContain("调整预览区域宽度");
  });

  it("双栏按会话比例定宽左栏并渲染分隔条，aria 上报百分比", function dualPane() {
    const html = render(1008, true, false);
    expect(html).toContain("width:500px");
    expect(html).toContain("调整预览区域宽度");
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("work-preview-panel");
  });

  it("窄屏单栏保留消息区组件（仅隐藏可见性）并只显示面板", function narrowKeepsMessagesMounted() {
    const html = render(390, true, true);
    // 消息区仍在树上（Composer 草稿/消息 DOM 不重建），只是被 hidden 属性隐藏。
    expect(html).toContain("left-column");
    expect(html).toContain("hidden");
    expect(html).toContain("work-preview-panel");
    expect(html).not.toContain("调整预览区域宽度");
  });

  it("容器 648/700/767/768px 均启用可操作双栏，647px 无分隔条", function gatesByContainerWidth() {
    for (const width of [648, 700, 767, 768]) {
      const html = render(width, true, false);
      expect(html).toContain("调整预览区域宽度");
      // 预览分隔条由容器能力控制，不再叠加 768px 视口门槛。
      expect(html).not.toContain("md:block");
    }
    const narrowContainer = render(647, true, true);
    expect(narrowContainer).not.toContain("调整预览区域宽度");
  });

  it("宽窄切换不迁移面板与消息区槽位，只有关闭才卸载面板", function keepsSlotsStable() {
    const dual = render(1008, true, false);
    const narrow = render(390, true, true);
    const closed = render(1008, false, false);

    // 面板父节点与消息区槽位在宽/窄两种布局下完全一致：React 按位置复用实例，不重建 iframe。
    expect(dual).toContain('<div class="flex min-h-0 min-w-0 flex-1 flex-col"><aside id="work-preview-panel">');
    expect(narrow).toContain('<div class="flex min-h-0 min-w-0 flex-1 flex-col"><aside id="work-preview-panel">');
    expect(dual.indexOf("left-column")).toBeLessThan(dual.indexOf("work-preview-panel"));
    expect(narrow.indexOf("left-column")).toBeLessThan(narrow.indexOf("work-preview-panel"));
    // 关闭面板才卸载；消息区在三种状态下都存在。
    expect(closed).not.toContain("work-preview-panel");
    expect(closed).toContain("left-column");
    expect(closed).not.toContain("hidden");
  });
});
