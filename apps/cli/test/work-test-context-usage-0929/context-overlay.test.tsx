/** /context 覆盖视图回归：打开覆盖层渲染报告与退出提示、Esc 关闭回聊天且不触发 Turn 取消。 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { CliController, CliControllerResult } from "../../src/controller.js";
import { createInitialCliProjection } from "../../src/event-projector.js";
import { CliTuiApp, createCliTuiStore } from "../../src/tui.js";
import type { CliAction } from "../../src/types.js";
import { createUsageFixture } from "./fixtures.js";

/** 创建只在 show_context 时返回覆盖视图 DTO 的 TUI Controller double。 */
function createContextController(calls: CliAction[]): CliController {
  const projection = createInitialCliProjection();
  const usage = createUsageFixture();
  /** 生成带当前安全投影的 Controller 结果。 */
  function result(extra: Partial<CliControllerResult> = {}): CliControllerResult {
    return { kind: "ok", exitCode: 0, lines: [], projection, ...extra };
  }
  return {
    async dispatch(action) {
      calls.push(action);
      if (action.type === "show_context") return result({ contextView: { usage, expanded: false } });
      return result();
    },
    async consume() { return result(); },
    async resume() { return result(); },
    getProjection() { return projection; },
    setSession() {},
    setEventListener() {},
  };
}

/** 渲染标准测试宿主；onRequestCancel 会把 cancel_turn 记入 calls 用于断言 Esc 语义。 */
function renderApp(calls: CliAction[], store: ReturnType<typeof createCliTuiStore>) {
  return render(<CliTuiApp
    store={store}
    controller={createContextController(calls)}
    closeWhenIdle={false}
    useColor={false}
    screenReader={true}
    onResult={function syncResult(result) { store.syncProjection(result.projection); }}
    onRequestInterrupt={function ignoreInterrupt() {}}
    onRequestCancel={function recordCancel() { calls.push({ type: "cancel_turn" }); }}
    onEof={function ignoreEof() {}}
    onAppExit={function ignoreExit() {}}
  />);
}

describe("/context 覆盖视图", function contextOverlaySuite() {
  it("打开覆盖层渲染报告与灰色退出提示，不固化进 transcript", async function opensOverlayWithoutTranscript() {
    const calls: CliAction[] = [];
    const store = createCliTuiStore();
    const rendered = renderApp(calls, store);

    rendered.stdin.write("/context");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForOverlay(resolve) { setTimeout(resolve, 20); });

    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("Context Usage");
    expect(frame).toContain("Esc 返回聊天");
    expect(store.getSnapshot().transcript).toHaveLength(0);
    rendered.unmount();
  });

  it("Esc 只关闭覆盖层回到聊天，不触发 Turn 取消且输入恢复可用", async function closesOverlayWithoutCancellingTurn() {
    const calls: CliAction[] = [];
    const store = createCliTuiStore();
    const rendered = renderApp(calls, store);

    rendered.stdin.write("/context");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForOverlay(resolve) { setTimeout(resolve, 20); });
    rendered.stdin.write("\u001b");
    await new Promise<void>(function waitForClose(resolve) { setTimeout(resolve, 20); });

    expect(rendered.lastFrame() ?? "").not.toContain("Context Usage");
    expect(rendered.lastFrame() ?? "").not.toContain("Esc 返回聊天");
    rendered.stdin.write("hi");
    await new Promise<void>(function waitForPrompt(resolve) { setTimeout(resolve, 20); });
    expect(rendered.lastFrame() ?? "").toContain("hi");
    expect(calls).toEqual([{ type: "show_context", all: false }]);
    rendered.unmount();
  });
});
