// CLI 状态投影回归，验证交互决定、终态和无受管环境的出口行为。
import { describe, expect, it } from "vitest";
import { createDesktopStatus, projectDesktopSession } from "../src/desktop-status.js";
import type { TurnExecutionView } from "@autopilot-agent/core";
import { ApStatusHost } from "../../desktop/src/ap-status-host";
import { sessionTask } from "../../desktop/src/workspace";

/** 有界等待真实本机通道接收状态，超时保留具体断言。 */
async function waitForStatus(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await new Promise(function delay(resolve) { setTimeout(resolve, 10); });
  expect(check()).toBe(true);
}

describe("CLI Desktop 状态投影", function desktopStatus() {
  it("普通外部 CLI 缺环境时不创建出口", function externalCli() { expect(createDesktopStatus({})).toBeUndefined(); });
  it("只复制权威白名单，决定已保存不伪造完成，正文永不透传", function interaction() {
    const executionView: TurnExecutionView = { sessionId: "session-1", turnId: "turn-1", status: "waiting_approval", execution: "inactive", waiting: "approval", lastSeq: 8, interaction: { state: "decided", continuation: { controlId: "control-1", state: "failed", failureCode: "CONTINUE_FAILED" } } };
    const projected = projectDesktopSession("session-1", { executionView }, "locallyDriven", false);
    expect(projected).toMatchObject({ interaction: "decided", continuation: "failed", waiting: "approval", execution: "inactive" });
    expect(projected.result).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain("control-1");
  });
  it("只确认无 Turn 待命，缺视图的历史终态待确认", function missingView() {
    expect(projectDesktopSession("session-1", { status: "completed" }, "opened", true).freshness).toBe("unknown");
    expect(projectDesktopSession("session-1", { status: "idle" }, "opened", true).freshness).toBe("fresh");
  });
  it.each(["旧seq", "错会话", "读取失败", "完成态读取失败", "空摘要", "读取超时", "选择变化", "新Turn登记", "正常完成", "新Turn完成"])("退出刷新防回退 · %s", async function exitObservation(mode) {
    const host = new ApStatusHost(function changed() {});
    await host.start();
    const reporter = createDesktopStatus(host.register("pane-1", 1))!;
    let exiting = false;
    let selectedId = "session-1";
    const running: TurnExecutionView = { sessionId: "session-1", turnId: "turn-1", status: "running", execution: "active", lastSeq: 20 };
    if (mode === "完成态读取失败") { running.status = "completed"; running.execution = "inactive"; running.result = "completed"; }
    reporter.bind({
      workspace: { workspaceId: "workspace-1", stateRootId: "state-1", projectId: "project-1", displayName: "fixture" },
      selected: function selected() { return selectedId; },
      entries: function entries() { return [{ sessionId: "session-1", opened: true }]; },
      executions: function executions() { return []; },
      read: async function read() {
        if (!exiting) return { executionView: running };
        if (mode === "读取失败" || mode === "完成态读取失败") throw new Error("fixture read failed");
        if (mode === "空摘要") return null;
        if (mode === "读取超时") return new Promise<{ executionView: TurnExecutionView }>(function stalled() {});
        await Promise.resolve();
        if (mode === "选择变化") selectedId = "session-2";
        if (mode === "新Turn登记") reporter.track("session-1");
        const completed: TurnExecutionView = { ...running, sessionId: mode === "错会话" ? "other-session" : "session-1", turnId: mode === "新Turn完成" ? "turn-2" : "turn-1", status: "completed", execution: "inactive", result: "completed", lastSeq: mode === "旧seq" ? 10 : mode === "新Turn完成" ? 1 : 21 };
        return { executionView: completed };
      },
    });
    try {
      await waitForStatus(function ready() { return host.snapshot("pane-1")[0]?.sessions[0]?.lastSeq === 20; });
      exiting = true;
      await reporter.flush();
      await reporter.stop();
      await waitForStatus(function settled() { return ["exited", "disconnected"].includes(host.snapshot("pane-1")[0]?.connection); });
      const ap = host.snapshot("pane-1")[0];
      const completed = mode === "正常完成" || mode === "新Turn完成";
      expect(sessionTask(ap, ap.sessions[0])).toBe(completed ? "completed" : "unknown");
      expect(ap.sessions[0].freshness).toBe(completed ? "fresh" : "unknown");
      expect(ap.sessions[0].lastSeq).toBe(mode === "新Turn完成" ? 1 : completed ? 21 : 20);
      if (!completed) expect(ap.sessions[0].result).toBe(running.result);
    } finally { await reporter.stop(); await host.stop(); }
  });
});
