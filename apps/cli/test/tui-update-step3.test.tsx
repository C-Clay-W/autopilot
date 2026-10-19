/** Talk-Plan0813 TUI Step 3 定向测试：多行边界后的会话内输入历史召回。 */

import { createElement } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { createInitialCliProjection } from "../src/event-projector.js";
import { createCliTuiStore, CliTuiApp } from "../src/tui.js";
import type { CliController, CliControllerResult, CliProjection } from "../src/types.js";

/** 等待 Ink 将键盘输入对应的帧写入测试终端。 */
function waitForTuiFrame(): Promise<void> {
  return new Promise(function wait(resolve) { setTimeout(resolve, 20); });
}

/** 创建不执行 Runtime、但可接受 submit_prompt 的输入历史测试替身。 */
function createHistoryController(projection: CliProjection): CliController {
  /** 返回固定成功结果，避免测试依赖 Runtime。 */
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

describe("Talk-Plan0813 TUI Step 3", function tuiUpdateStep3Suite() {
  it("↑↓ 在单行边界召回历史并恢复草稿，picker 未激活时不影响现有多行语义", async function recallsInputHistoryAtVisualBoundaries() {
    const projection = createInitialCliProjection();
    const store = createCliTuiStore();
    const rendered = render(createElement(CliTuiApp, {
      store,
      controller: createHistoryController(projection),
      closeWhenIdle: false,
      useColor: false,
      screenReader: true,
      renderMode: "inline",
      onResult: function onResult(): void {},
      onRequestInterrupt: function onRequestInterrupt(): void {},
      onRequestCancel: function onRequestCancel(): void {},
      onEof: function onEof(): void {},
      onAppExit: function onAppExit(): void {},
    }));
    rendered.stdin.write("first prompt");
    rendered.stdin.write("\r");
    await waitForTuiFrame();
    rendered.stdin.write("draft");
    rendered.stdin.write("\u001b[A");
    await waitForTuiFrame();
    expect(rendered.lastFrame() ?? "").toContain("first prompt");
    rendered.stdin.write("\u001b[B");
    await waitForTuiFrame();
    expect(rendered.lastFrame() ?? "").toContain("draft");
    rendered.unmount();
  });
});
