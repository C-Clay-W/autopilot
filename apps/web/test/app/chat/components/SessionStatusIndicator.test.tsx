/** SessionStatusIndicator 测试：锁定主状态优先级、token 和可访问文字。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SessionStatusIndicator from "@/app/chat/components/SessionStatusIndicator";

describe("SessionStatusIndicator", function sessionStatusIndicatorSuite() {
  it("执行中使用八点环与稳定文字语义", function rendersRunningRing() {
    const markup = renderToStaticMarkup(<SessionStatusIndicator phase="running" terminalNotice={null} />);

    expect(markup).toContain('data-session-status="running"');
    expect(markup).toContain("session-status-ring");
    expect((markup.match(/<circle/g) ?? [])).toHaveLength(8);
    expect(markup).toContain("执行中");
    expect(markup).toContain("text-accent");
  });

  it("等待状态优先于后台终态提醒", function prioritizesWaitingState() {
    const markup = renderToStaticMarkup(<SessionStatusIndicator phase="waiting_approval" terminalNotice="success" />);

    expect(markup).toContain('data-session-status="waiting"');
    expect(markup).toContain("等待审批");
    expect(markup).not.toContain("session-status-success");
  });

  it("成功和失败提醒只使用已冻结设计 token", function rendersTerminalNotices() {
    const success = renderToStaticMarkup(<SessionStatusIndicator phase="completed" terminalNotice="success" />);
    const failure = renderToStaticMarkup(<SessionStatusIndicator phase="failed" terminalNotice="failure" />);

    expect(success).toContain('data-session-status="success"');
    expect(success).toContain("bg-success");
    expect(success).toContain("已完成，未查看");
    expect(failure).toContain('data-session-status="failure"');
    expect(failure).toContain("bg-error");
    expect(failure).toContain("执行失败，未查看");
  });

  it("limit 不会伪装成成功或失败提醒", function keepsLimitAsAttentionState() {
    const markup = renderToStaticMarkup(<SessionStatusIndicator phase="limit_reached" terminalNotice={null} />);

    expect(markup).toContain('data-session-status="interrupted"');
    expect(markup).toContain("需要继续");
    expect(markup).not.toContain("session-status-dot");
  });
});
