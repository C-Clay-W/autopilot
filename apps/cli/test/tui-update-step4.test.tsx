/** Talk-Plan0813 TUI Step 4 定向测试：无障碍和 NO_COLOR 不能破坏备用屏生命周期。 */

import { createElement } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { createTuiAnimationClock } from "../src/animation-clock.js";
import { createInitialCliActivityState, TuiActivityLine } from "../src/activity-animation.js";
import { createTuiTerminalLifecycle, resolveTuiRenderMode } from "../src/tui.js";

describe("Talk-Plan0813 TUI Step 4", function tuiUpdateStep4Suite() {
  it("NO_COLOR 只关闭颜色，不关闭备用屏、鼠标、paste 或 focus 生命周期", function preservesTerminalControlsWithoutColor() {
    let output = "";
    const lifecycle = createTuiTerminalLifecycle({ write(chunk): void { output += chunk; } }, resolveTuiRenderMode({ NO_COLOR: "1", AUTOPILOT_TUI_FULLSCREEN: "1" }, "linux"));
    lifecycle.enter();
    lifecycle.restore();

    expect(resolveTuiRenderMode({ NO_COLOR: "1", AUTOPILOT_TUI_FULLSCREEN: "1" }, "linux")).toBe("alternate-screen");
    expect(output).toContain("\u001b[?1049h");
    expect(output).toContain("\u001b[?1006h");
    expect(output).toContain("\u001b[?2004h");
    expect(output).toContain("\u001b[?1049l");
    expect(output).not.toMatch(/\u001b\[[0-9;]*m/u);
  });

  it("screen reader 走 inline 路径，且不注入备用屏或鼠标控制", function keepsScreenReaderInline() {
    let output = "";
    const lifecycle = createTuiTerminalLifecycle({ write(chunk): void { output += chunk; } }, resolveTuiRenderMode({ INK_SCREEN_READER: "true" }));
    lifecycle.enter();
    lifecycle.restore();

    expect(resolveTuiRenderMode({ INK_SCREEN_READER: "true" })).toBe("inline");
    expect(output).toContain("\u001b[?2004h");
    expect(output).toContain("\u001b[?1004h");
    expect(output).not.toContain("1049");
    expect(output).not.toContain("1002");
    expect(output).not.toContain("1006");
  });

  it("reduced-motion 使用稳定文案和静态帧，不订阅动画时钟", function keepsReducedMotionStatic() {
    let scheduled = 0;
    const clock = createTuiAnimationClock({
      now: function readClock(): number { return 240; },
      schedule: function countSchedule(): object {
        scheduled += 1;
        return {};
      },
      cancel: function ignoreCancel(): void {},
    });
    const rendered = render(createElement(TuiActivityLine, {
      activity: createInitialCliActivityState(0),
      status: "running",
      waitingForApproval: false,
      useColor: false,
      screenReader: false,
      reducedMotion: true,
      animationActive: true,
      clock,
    }));

    expect(rendered.lastFrame() ?? "").toContain("Preparing");
    expect(rendered.lastFrame() ?? "").toContain("·");
    expect(scheduled).toBe(0);
    rendered.unmount();
    clock.dispose();
  });
});
