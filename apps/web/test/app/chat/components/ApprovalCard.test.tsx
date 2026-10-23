/**
 * ApprovalCard 回归：宿主执行审批卡不得承诺精确影响范围，也不得把通用 unisolated
 * 反推成 Windows 宿主执行（Talk-Plan1022 CR R4/C4）。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalItem } from "@autopilot-agent/presentation";
import ApprovalCard from "@/app/chat/components/ApprovalCard";

/** 构造待审批项；display 由调用方提供 Core 冻结事实。 */
function createApproval(display: ApprovalItem["display"]): ApprovalItem {
  return {
    id: "approval:a-1",
    kind: "approval",
    turnId: "t-1",
    approvalId: "a-1",
    callId: "c-1",
    toolName: "run_command",
    state: "required",
    constraint: "cmd:v2",
    display,
  };
}

/** 以静态标记渲染审批卡，避免引入浏览器环境。 */
function render(display: ApprovalItem["display"]): string {
  return renderToStaticMarkup(<ApprovalCard approval={createApproval(display)} onDecision={function noop() {}} />);
}

describe("ApprovalCard 宿主执行事实", function approvalCardSuite() {
  it("宿主外部命令：显示未隔离与范围不可精确限定，不出现精确目标承诺", function hostExternalCommandHasNoPreciseScope() {
    const markup = render({
      operation: "command",
      effect: "external",
      destructive: false,
      resource: "node",
      unknownScope: true,
      executionMode: "unisolated",
      hostExecution: true,
      allowedDecisions: ["allow_once", "deny"],
    });

    expect(markup).toContain("Windows 宿主执行");
    expect(markup).toContain("未启用沙箱隔离");
    expect(markup).toContain("可能同时影响其他文件");
    expect(markup).not.toContain("授权仅覆盖上方列出的精确目标");
  });

  it("macOS danger-full-access 的 unisolated 卡不冒称 Windows 宿主执行", function genericUnisolatedIsNotHostExecution() {
    const markup = render({
      operation: "command",
      effect: "external",
      destructive: false,
      resource: "node",
      executionMode: "unisolated",
      allowedDecisions: ["allow_once", "deny"],
    });

    expect(markup).not.toContain("Windows 宿主执行");
    expect(markup).toContain("授权仅覆盖上方列出的精确目标");
  });

  it("直接文件工具保留精确授权措辞", function directFileToolKeepsPreciseScope() {
    const markup = renderToStaticMarkup(
      <ApprovalCard
        approval={{ ...createApproval({
          operation: "write",
          effect: "external",
          destructive: false,
          resource: "outside/a.txt",
          allowedDecisions: ["allow_once", "deny"],
        }), toolName: "write_file" }}
        onDecision={function noop() {}}
      />,
    );

    expect(markup).toContain("授权仅覆盖上方列出的精确目标");
    expect(markup).not.toContain("Windows 宿主执行");
  });
});
