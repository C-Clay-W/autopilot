/** 预览面板静态契约：沙箱档、referrer、工具栏动作与阶段提示（真实加载/焦点由 M11/M13 验收）。 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import WorkPreviewPanel from "@/app/chat/components/WorkPreviewPanel";
import { closedPreview, previewFailed, previewTargetReady } from "@/app/chat/work-preview-state";

const TRUSTED = previewTargetReady({ source: "tool_delivery", previewId: "pvw-1", turnId: "t1", hostLabel: "127.0.0.1:5173", navigationUrl: "http://127.0.0.1:5173/demo", sandboxProfile: "trusted_local", serviceState: "ready", canStop: true });
const PUBLIC = previewTargetReady({ source: "user_link", hostLabel: "example.com", navigationUrl: "https://example.com/x", sandboxProfile: "strict_public", serviceState: "unchecked", canStop: false });

const noop = function noop(): void {};

describe("WorkPreviewPanel", function suite() {
  it("受信本地档使用 allow-scripts allow-same-origin，固定 no-referrer 与标题", function trustedSandbox() {
    const html = renderToStaticMarkup(<WorkPreviewPanel state={TRUSTED} narrow={false} onLoad={noop} onEmbeddingTimeout={noop} onRefresh={noop} onClose={noop} onStop={noop} />);
    expect(html).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("预览：127.0.0.1:5173");
    expect(html).toContain('id="work-preview-panel"');
  });

  it("公网严格档不含 allow-same-origin，无停止按钮", function publicSandbox() {
    const html = renderToStaticMarkup(<WorkPreviewPanel state={PUBLIC} narrow={false} onLoad={noop} onEmbeddingTimeout={noop} onRefresh={noop} onClose={noop} onStop={noop} />);
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toContain("停止服务");
  });

  it("canStop 的工具交付显示停止服务；关闭/刷新/新标签页入口齐全", function toolbarActions() {
    const html = renderToStaticMarkup(<WorkPreviewPanel state={TRUSTED} narrow={false} onLoad={noop} onEmbeddingTimeout={noop} onRefresh={noop} onClose={noop} onStop={noop} />);
    expect(html).toContain("停止服务");
    expect(html).toContain("刷新");
    expect(html).toContain("关闭");
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("narrow 模式关闭按钮显示为返回任务", function narrowBackLabel() {
    const html = renderToStaticMarkup(<WorkPreviewPanel state={TRUSTED} narrow onLoad={noop} onEmbeddingTimeout={noop} onRefresh={noop} onClose={noop} onStop={noop} />);
    expect(html).toContain("返回任务");
  });

  it("resolving 与 unavailable 阶段不渲染 iframe；unavailable 提供新标签页与安全文案", function phaseBodies() {
    const resolving = renderToStaticMarkup(<WorkPreviewPanel state={closedPreview() && { phase: "resolving", target: null }} narrow={false} onLoad={noop} onEmbeddingTimeout={noop} onRefresh={noop} onClose={noop} onStop={noop} />);
    expect(resolving).not.toContain("<iframe");
    expect(resolving).toContain("正在解析预览目标…");
    const failed = previewFailed(TRUSTED, "预览引用已过期，请从结果重新打开");
    const html = renderToStaticMarkup(<WorkPreviewPanel state={failed} narrow={false} onLoad={noop} onEmbeddingTimeout={noop} onRefresh={noop} onClose={noop} onStop={noop} />);
    expect(html).not.toContain("<iframe");
    expect(html).toContain("预览引用已过期");
    expect(html).toContain("在新标签页打开");
  });
});
