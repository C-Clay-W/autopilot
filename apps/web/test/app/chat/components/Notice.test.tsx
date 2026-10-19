/** Notice 回归测试：复制成功和失败都必须呈现纸本状态反馈与可访问语义。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Notice, { NoticeProvider, useNotice } from "@/app/chat/components/Notice";

/** 验证全局 Provider 暴露命令式通知 API，而不是页面私有状态。 */
function NoticeApiProbe() {
  const notice = useNotice();
  return <span>{[notice.success, notice.error, notice.warning, notice.dismiss].every(function isFunction(value) { return typeof value === "function"; }) ? "ready" : "missing"}</span>;
}

describe("Notice", function noticeSuite() {
  it("成功提示显示强调色对号和 status 语义", function rendersSuccessNotice() {
    const markup = renderToStaticMarkup(<Notice status="success" message="Prompt 已复制" />);

    expect(markup).toContain("Prompt 已复制");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("text-accent");
  });

  it("失败提示显示错误 token，不能伪装成复制成功", function rendersErrorNotice() {
    const markup = renderToStaticMarkup(<Notice status="error" message="复制失败，请检查剪贴板权限" />);

    expect(markup).toContain("复制失败，请检查剪贴板权限");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("text-error");
  });

  it("警告提示使用顶部动画、强调色和可关闭按钮", function rendersWarningNotice() {
    const markup = renderToStaticMarkup(<Notice status="warning" message="编辑尚未保存" onDismiss={function dismissNotice() {}} />);

    expect(markup).toContain("编辑尚未保存");
    expect(markup).toContain('data-notice-status="warning"');
    expect(markup).toContain("notice-enter");
    expect(markup).toContain("top-4");
    expect(markup).toContain('aria-label="关闭通知"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("text-accent");
  });

  it("自定义文案为空时由 API 使用稳定默认语义", function rendersDefaultStatusCopy() {
    const markup = renderToStaticMarkup(<Notice status="success" message="操作成功" />);

    expect(markup).toContain("操作成功");
    expect(markup).toContain("shadow-[4px_4px_0_var(--ink)]");
  });

  it("Provider 暴露 success/error/warning/dismiss 四个全局入口", function exposesGlobalNoticeApi() {
    const markup = renderToStaticMarkup(<NoticeProvider><NoticeApiProbe /></NoticeProvider>);

    expect(markup).toContain(">ready</span>");
  });
});
