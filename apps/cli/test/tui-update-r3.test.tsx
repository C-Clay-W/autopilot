/** Talk-Plan0813 TUI R3：备用屏键盘视口兜底与上下文抢键契约。 */

import { createElement } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { createInitialCliProjection } from "../src/event-projector.js";
import { scrollViewportToTop, createScrollViewportState, scrollViewportUp } from "../src/scroll-viewport.js";
import { CliTuiApp, createCliTuiStore } from "../src/tui.js";
import type { CliController, CliControllerResult, CliProjection } from "../src/types.js";

/** 创建不触达 Runtime 的备用屏键盘测试替身。 */
function createKeyboardController(projection: CliProjection): CliController {
  function result(): CliControllerResult {
    return { kind: "ok", exitCode: 0, lines: [], projection };
  }
  return {
    async dispatch(): Promise<CliControllerResult> { return result(); },
    async consume(): Promise<CliControllerResult> { return result(); },
    async resume(): Promise<CliControllerResult> { return result(); },
    getProjection(): CliProjection { return projection; },
    setSession(): void {},
    setEventListener(): void {},
  };
}

/** 等待 Ink 将键盘动作提交到测试帧。 */
function waitForTuiFrame(): Promise<void> {
  return new Promise(function wait(resolve): void { setTimeout(resolve, 60); });
}

/** 创建拥有足够历史行的活动 Turn，保证键盘滚动结果可观察。 */
function createKeyboardScrollFixture(): { projection: CliProjection; store: ReturnType<typeof createCliTuiStore> } {
  const projection = createInitialCliProjection();
  projection.status = "running";
  projection.turnId = "turn-r3-keyboard";
  const store = createCliTuiStore();
  store.acceptEvent({ type: "turn_started", seq: 1, turnId: projection.turnId, stepCount: 0 }, projection);
  for (let index = 1; index <= 80; index += 1) {
    store.acceptEvent({ type: "answer_delta", seq: index + 1, turnId: projection.turnId, delta: `line-${String(index).padStart(2, "0")}\n` }, projection);
  }
  return { projection, store };
}

/** 渲染实际 alternate-screen 分支，供键盘边界测试复用。 */
function renderKeyboardFixture(projection: CliProjection, store: ReturnType<typeof createCliTuiStore>): ReturnType<typeof render> {
  return render(createElement(CliTuiApp, {
    store,
    controller: createKeyboardController(projection),
    closeWhenIdle: false,
    useColor: false,
    screenReader: false,
    renderMode: "alternate-screen",
    reducedMotion: true,
    onResult: function onResult(): void {},
    onRequestInterrupt: function onRequestInterrupt(): void {},
    onRequestCancel: function onRequestCancel(): void {},
    onEof: function onEof(): void {},
    onAppExit: function onAppExit(): void {},
  }));
}

describe("Talk-Plan0813 TUI R3 alternate keyboard fallback", function tuiUpdateR3Suite() {
  it("gotoTop 解除钉底，且滚动状态始终保持边界内", function supportsGotoTopAction() {
    const state = scrollViewportUp(createScrollViewportState(100, 20), 5);
    expect(scrollViewportToTop(state)).toMatchObject({ scrollTop: 0, pinnedToBottom: false });
  });

  it("备用屏支持半视口 PgUp/PgDn 与 Ctrl+Home/End 顶底跳转", async function handlesViewportKeyboardFallback() {
    const fixture = createKeyboardScrollFixture();
    const rendered = renderKeyboardFixture(fixture.projection, fixture.store);
    await waitForTuiFrame();
    expect(rendered.lastFrame() ?? "").toContain("line-80");

    rendered.stdin.write("\u001b[5~");
    await waitForTuiFrame();
    expect(rendered.lastFrame() ?? "").not.toContain("line-80");

    rendered.stdin.write("\u001b[7^");
    await waitForTuiFrame();
    expect(rendered.lastFrame() ?? "").toContain("line-01");

    rendered.stdin.write("\u001b[8^");
    await waitForTuiFrame();
    expect(rendered.lastFrame() ?? "").toContain("line-80");
    rendered.unmount();
  });

  it("命令建议和审批激活时让位，不抢占 PgUp", async function preservesContextKeyPriority() {
    const commandFixture = createKeyboardScrollFixture();
    const commandRendered = renderKeyboardFixture(commandFixture.projection, commandFixture.store);
    await waitForTuiFrame();
    commandRendered.stdin.write("/");
    await waitForTuiFrame();
    await waitForTuiFrame();
    const commandFrame = commandRendered.lastFrame() ?? "";
    commandRendered.stdin.write("\u001b[5~");
    await waitForTuiFrame();
    expect(commandRendered.lastFrame() ?? "").toBe(commandFrame);
    commandRendered.unmount();

    const approvalFixture = createKeyboardScrollFixture();
    approvalFixture.projection.status = "waiting_approval";
    approvalFixture.projection.pendingApproval = {
      approvalId: "approval-r3-keyboard",
      toolName: "run_command",
      reason: "需要审批",
      risk: "command",
    };
    approvalFixture.store.acceptEvent({
      type: "approval_required",
      seq: 100,
      turnId: approvalFixture.projection.turnId!,
      approvalId: "approval-r3-keyboard",
      toolName: "run_command",
      reason: "需要审批",
      risk: "command",
    }, approvalFixture.projection);
    const approvalRendered = renderKeyboardFixture(approvalFixture.projection, approvalFixture.store);
    await waitForTuiFrame();
    const approvalFrame = approvalRendered.lastFrame() ?? "";
    approvalRendered.stdin.write("\u001b[5~");
    await waitForTuiFrame();
    expect(approvalRendered.lastFrame() ?? "").toBe(approvalFrame);
    approvalRendered.unmount();
  });
});
