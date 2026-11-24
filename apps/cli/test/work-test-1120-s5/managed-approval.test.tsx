/** 以 Ink 真实按键驱动执行者的受管审批，不运行 Provider 或真实工具。 */
import { render } from "ink-testing-library";
import { expect, test, vi } from "vitest";
import { createManagedCliController, type ManagedCliSnapshot } from "../../src/managed-controller.js";
import { CliTuiApp } from "../../src/tui/app.js";
import { createCliTuiStore } from "../../src/tui/store.js";

const approval: ManagedCliSnapshot = { status: "AP 执行者", sessionId: "executor", cancelToken: "generation-token", pendingApproval: { turnId: "turn", approval: { approvalId: "approval", toolName: "write_file", reason: "修改文件", display: { operation: "修改文件", effect: "workspace", destructive: false, allowedDecisions: ["allow_once", "allow_session", "allow_workspace", "deny"] } } } };

test("执行者方向键与 Enter 只提交当前批准范围，等待和保存在终端即时显示", async function approvalEnter() {
  let saved!: (reply: unknown) => void;
  const response = new Promise<unknown>(function hold(resolve) { saved = resolve; });
  const calls: unknown[] = [];
  const controller = createManagedCliController(async function request(operation, fields) {
    if (operation !== "cli" || !fields?.action) return { model: "fixture-model", effort: "medium", permissionMode: "ask", workspaceRoot: "fixture" };
    calls.push(fields);
    return response;
  }, function notice() {}, "executor");
  const store = createCliTuiStore();
  controller.update(approval);
  store.syncProjection(controller.getProjection());
  const view = render(<CliTuiApp controller={controller} store={store} useColor={false} screenReader renderMode="inline" closeWhenIdle={false} onResult={function result(value) { store.syncProjection(value.projection); }} onRequestInterrupt={function interrupt() {}} onRequestCancel={function cancel() {}} onEof={function eof() {}} onAppExit={function exit() {}} />);
  try {
    await vi.waitFor(function visible() { expect(view.lastFrame()).toContain("允许本次"); });
    expect(view.lastFrame()).toContain("本次会话允许");
    expect(view.lastFrame()).toContain("此工作区允许");
    view.stdin.write("\u001b[B");
    view.stdin.write("\u001b[B");
    view.stdin.write("\u001b[B");
    view.stdin.write("\r");
    view.stdin.write("\r");
    await vi.waitFor(function submitting() { expect(view.lastFrame()).toContain("正在提交审批决定"); });
    expect(calls).toEqual([{ executionToken: "generation-token", requestId: expect.any(String), action: { type: "approve", decision: "deny", expected: { sessionId: "executor", turnId: "turn", approvalId: "approval" } } }]);
    controller.update(approval);
    expect(controller.getProjection().pendingApproval).toBeUndefined();
    saved({ kind: "ok", exitCode: 0, lines: ["审批决定已保存，继续结果待核查。"] });
    await vi.waitFor(function confirmed() { expect(view.lastFrame()).toContain("审批决定已保存，继续结果待核查"); });
    expect(view.lastFrame()).not.toContain("正在提交审批决定");
    const failed = "已拒绝，恢复失败：会话文件替换被 Windows 拒绝";
    controller.update({ ...approval, pendingApproval: undefined, approvalStatus: failed, inspection: { status: "waiting_approval", execution: "inactive", recoverable: true, turnId: "turn" } });
    store.syncProjection(controller.getProjection());
    await vi.waitFor(function updated() { expect(view.lastFrame()).toContain(failed); });
    expect(view.lastFrame()).not.toContain("继续结果待核查");
    controller.update({ ...approval, pendingApproval: { ...approval.pendingApproval!, approval: { ...approval.pendingApproval!.approval, approvalId: "next" } } });
    store.syncProjection(controller.getProjection());
    await vi.waitFor(function next() { expect(view.lastFrame()).toContain("允许本次"); });
    expect(view.lastFrame()).not.toContain(failed);
  } finally { saved({ kind: "error", exitCode: 1, lines: [] }); view.unmount(); }
});

test("受管执行者按冻结集合拒绝旧身份和未声明的会话级或工作区级决定", async function staleApproval() {
  const request = vi.fn();
  const controller = createManagedCliController(request, function notice() {}, "executor");
  controller.update({ ...approval, pendingApproval: { ...approval.pendingApproval!, approval: { ...approval.pendingApproval!.approval, display: { ...approval.pendingApproval!.approval.display!, allowedDecisions: ["allow_once", "deny"] } } } });
  expect((await controller.dispatch({ type: "approve", decision: "allow_workspace" })).kind).toBe("error");
  expect((await controller.dispatch({ type: "approve", decision: "allow_once", expected: { sessionId: "executor", turnId: "old-turn", approvalId: "approval" } })).kind).toBe("error");
  controller.update({ ...approval, pendingApproval: undefined });
  expect(controller.getProjection().pendingApproval).toBeUndefined();
  expect((await controller.dispatch({ type: "approve", decision: "allow_once" })).kind).toBe("error");
  expect(request).not.toHaveBeenCalled();
});
