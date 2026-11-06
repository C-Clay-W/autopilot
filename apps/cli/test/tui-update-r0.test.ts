/** Talk-Plan0813 TUI R0：终端渲染模式优先级与可注入平台契约。 */

import { describe, expect, it } from "vitest";
import { resolveTuiRenderModePolicy } from "../src/tui.js";

describe("Talk-Plan0813 TUI R0 render-mode contract", function tuiUpdateR0Suite() {
  it("交互统一inline主屏，FULLSCREEN不启用备用屏", function defaultsToInline() {
    expect(resolveTuiRenderModePolicy({ env: {}, platform: "linux" })).toBe("inline");
    expect(resolveTuiRenderModePolicy({ env: { AUTOPILOT_TUI_FULLSCREEN: "1" }, platform: "linux" })).toBe("inline");
  });

  it("screen reader 和旧 inline 开关优先于 FULLSCREEN", function preservesInlineOverrides() {
    expect(resolveTuiRenderModePolicy({ env: { INK_SCREEN_READER: "true", AUTOPILOT_TUI_FULLSCREEN: "1" }, platform: "linux" })).toBe("inline");
    expect(resolveTuiRenderModePolicy({ env: { AUTOPILOT_INLINE_TUI: "1", AUTOPILOT_TUI_FULLSCREEN: "1" }, platform: "linux" })).toBe("inline");
  });

  it("win32同样使用inline主屏与终端原生滚动", function supportsWindowsInline() {
    expect(resolveTuiRenderModePolicy({ env: { AUTOPILOT_TUI_FULLSCREEN: "1" }, platform: "win32" })).toBe("inline");
  });
});
