/** Talk-Plan0813 TUI R0：终端渲染模式优先级与可注入平台契约。 */

import { describe, expect, it } from "vitest";
import { resolveTuiRenderModePolicy } from "../src/tui.js";

describe("Talk-Plan0813 TUI R0 render-mode contract", function tuiUpdateR0Suite() {
  it("默认使用 inline，只有非 win32 显式请求 FULLSCREEN 才进入备用屏", function defaultsToInlineWithOptInFullscreen() {
    expect(resolveTuiRenderModePolicy({ env: {}, platform: "linux" })).toBe("inline");
    expect(resolveTuiRenderModePolicy({ env: { AUTOPILOT_TUI_FULLSCREEN: "1" }, platform: "linux" })).toBe("alternate-screen");
  });

  it("screen reader 和旧 inline 开关优先于 FULLSCREEN", function preservesInlineOverrides() {
    expect(resolveTuiRenderModePolicy({ env: { INK_SCREEN_READER: "true", AUTOPILOT_TUI_FULLSCREEN: "1" }, platform: "linux" })).toBe("inline");
    expect(resolveTuiRenderModePolicy({ env: { AUTOPILOT_INLINE_TUI: "1", AUTOPILOT_TUI_FULLSCREEN: "1" }, platform: "linux" })).toBe("inline");
  });

  it("win32 即使显式请求 FULLSCREEN 也安全回落 inline", function fallsBackOnWin32() {
    expect(resolveTuiRenderModePolicy({ env: { AUTOPILOT_TUI_FULLSCREEN: "1" }, platform: "win32" })).toBe("inline");
  });
});
