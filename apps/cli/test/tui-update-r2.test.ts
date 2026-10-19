/** Talk-Plan0813 TUI R2：默认 inline、win32 安全回落与启动提示契约。 */

import { describe, expect, it } from "vitest";
import { getTuiRenderModeFallbackNotice, resolveTuiRenderMode, resolveTuiRenderModePolicy } from "../src/tui.js";

describe("Talk-Plan0813 TUI R2 render-mode fallback", function tuiUpdateR2Suite() {
  it("默认 inline，非 win32 只有 FULLSCREEN opt-in 才进入备用屏", function defaultsToInlineSafely() {
    expect(resolveTuiRenderModePolicy({ env: {}, platform: "win32" })).toBe("inline");
    expect(resolveTuiRenderMode({}, "linux")).toBe("inline");
    expect(resolveTuiRenderMode({ AUTOPILOT_TUI_FULLSCREEN: "1" }, "linux")).toBe("alternate-screen");
    expect(resolveTuiRenderMode({ AUTOPILOT_TUI_FULLSCREEN: "1" }, "win32")).toBe("inline");
  });

  it("win32 FULLSCREEN 只产生稳定的一次性回落提示，移除开关后无提示", function exposesStableFallbackNotice() {
    expect(getTuiRenderModeFallbackNotice({ env: { AUTOPILOT_TUI_FULLSCREEN: "1" }, platform: "win32" })).toBe("AUTOPILOT_TUI_FULLSCREEN is unsupported on win32; using inline mode. Remove AUTOPILOT_TUI_FULLSCREEN to cancel this request.\n");
    expect(getTuiRenderModeFallbackNotice({ env: {}, platform: "win32" })).toBeUndefined();
    expect(getTuiRenderModeFallbackNotice({ env: { AUTOPILOT_TUI_FULLSCREEN: "1" }, platform: "linux" })).toBeUndefined();
  });
});
