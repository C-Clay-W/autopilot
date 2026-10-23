/** 结果尾部预览操作静态契约：切换按钮状态、完整 copyUrl 与复制入口。 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import WorkPreviewResultActions from "@/app/chat/components/WorkPreviewResultActions";
import type { TurnPreviewDelivery } from "@/app/chat/work-preview-state";

const DELIVERY: TurnPreviewDelivery = { previewId: "pvw-1", callId: "call-1", hostLabel: "127.0.0.1:5173", copyUrl: "http://127.0.0.1:5173/demo/page", openWhen: "now" };
const noop = function noop(): void {};

describe("WorkPreviewResultActions", function suite() {
  it("面板未显示本结果时显示打开预览，aria-expanded 为 false 并关联面板", function closedState() {
    const html = renderToStaticMarkup(<WorkPreviewResultActions delivery={DELIVERY} open={false} busy={false} onToggle={noop} />);
    expect(html).toContain("打开预览");
    expect(html).not.toContain("关闭预览");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="work-preview-panel"');
  });

  it("面板正显示本结果时显示关闭预览，aria-expanded 为 true", function openState() {
    const html = renderToStaticMarkup(<WorkPreviewResultActions delivery={DELIVERY} open busy={false} onToggle={noop} />);
    expect(html).toContain("关闭预览");
    expect(html).toContain('aria-expanded="true"');
  });

  it("完整 copyUrl 可见可选，不折叠为域名；busy 时按钮禁用", function fullUrlAndBusy() {
    const html = renderToStaticMarkup(<WorkPreviewResultActions delivery={DELIVERY} open={false} busy onToggle={noop} />);
    expect(html).toContain("http://127.0.0.1:5173/demo/page");
    expect(html).toContain("复制链接");
    expect(html).toContain("disabled");
  });
});
