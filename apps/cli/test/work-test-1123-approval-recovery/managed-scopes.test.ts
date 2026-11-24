/** 受管 Controller 的角色、请求集合与恢复反馈；普通 CLI 与 Parallel 不参与。 */
import { expect, test, vi } from "vitest";
import { createManagedCliController, type ManagedCliSnapshot } from "../../src/managed-controller.js";

const decisions = ["allow_once", "allow_session", "allow_workspace", "deny"] as const;
for (const role of ["executor", "controller"] as const) {
  for (const decision of decisions) {
    test(`1123 ${role} 提交原请求 ${decision}，确认反馈与新快照撤卡一致`, async function scoped() {
      const notices: string[] = [];
      const request = vi.fn(async function reply() { return { kind: "ok", exitCode: 0, lines: ["已批准，正在恢复原任务…"] }; });
      const controller = createManagedCliController(request, function notice(text) { notices.push(text); }, role);
      const snapshot: ManagedCliSnapshot = { status: "fixture", sessionId: "session", cancelToken: "token", pendingApproval: { turnId: "turn", approval: { approvalId: "approval", toolName: "write_file", reason: "写入", constraint: "path:proof.html", display: { operation: "新建文件", effect: "workspace", destructive: false, allowedDecisions: [...decisions] } } } };
      controller.update(snapshot);
      expect(controller.getProjection().pendingApproval?.allowedDecisions).toEqual(decisions);
      expect(controller.getProjection().pendingApproval?.reason).toContain(role === "executor" ? "本执行者会话" : "本主控会话");
      expect(controller.getProjection().pendingApproval?.reason).toContain("path:proof.html");
      const response = await controller.dispatch({ type: "approve", decision });
      expect(response.lines).toEqual(["已批准，正在恢复原任务…"]);
      expect(request).toHaveBeenCalledWith("cli", { requestId: expect.any(String), executionToken: "token", action: { type: "approve", decision, expected: { sessionId: "session", turnId: "turn", approvalId: "approval" } } });
      controller.update({ ...snapshot, pendingApproval: undefined, inspection: { turnId: "turn", execution: "inactive", status: "waiting_approval", recoverable: true }, approvalStatus: "已批准，恢复失败：会话文件替换被 Windows 拒绝" });
      expect(controller.getProjection().pendingApproval).toBeUndefined();
      expect(controller.getHostApprovalStatus?.()).toBe(notices.at(-1));
      expect(notices.at(-1)).toContain("恢复失败");
      controller.update({ ...snapshot, pendingApproval: { ...snapshot.pendingApproval!, approval: { ...snapshot.pendingApproval!.approval, approvalId: "new" } } });
      expect(controller.getHostApprovalStatus?.()).toBeUndefined();
      controller.update({ ...snapshot, pendingApproval: undefined });
      await controller.dispatch({ type: "approve", decision });
      expect(request).toHaveBeenCalledTimes(1);
      const parsed = controller.parseInput("/approval status");
      expect(parsed).toEqual({ kind: "action", action: { type: "submit_prompt", content: "/approval status" } });
    });
  }
}

test("1123 原审批仅两项时，较宽的展示字段不能扩大实际菜单", async function frozenSet() {
  const request = vi.fn();
  const controller = createManagedCliController(request, function notice() {}, "executor");
  controller.update({ status: "fixture", sessionId: "session", cancelToken: "token", pendingApproval: { turnId: "turn", approval: { approvalId: "approval", toolName: "write_file", reason: "写入", allowedDecisions: ["allow_once", "deny"], display: { operation: "新建文件", effect: "workspace", destructive: false, allowedDecisions: [...decisions] } } } });
  expect(controller.getProjection().pendingApproval?.allowedDecisions).toEqual(["allow_once", "deny"]);
  expect((await controller.dispatch({ type: "approve", decision: "allow_workspace" })).kind).toBe("error");
  expect(request).not.toHaveBeenCalled();
});
