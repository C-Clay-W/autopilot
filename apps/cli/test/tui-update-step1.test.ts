/** Talk-Plan0813 TUI Step 1 契约测试：备用屏生命周期和显式降级只在启动期生效。 */

import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createRoutedTuiStdin, createTuiTerminalLifecycle, resolveTuiRenderMode } from "../src/tui.js";

describe("Talk-Plan0813 TUI Step 1", function tuiUpdateStep1Suite() {
  it("交互 TTY 默认 inline，非 win32 显式 FULLSCREEN 才进入备用屏", function resolvesRenderModeOnce() {
    expect(resolveTuiRenderMode({}, "win32")).toBe("inline");
    expect(resolveTuiRenderMode({ AUTOPILOT_TUI_FULLSCREEN: "1" }, "linux")).toBe("alternate-screen");
    expect(resolveTuiRenderMode({ AUTOPILOT_INLINE_TUI: "1", AUTOPILOT_TUI_FULLSCREEN: "1" }, "linux")).toBe("inline");
    expect(resolveTuiRenderMode({ INK_SCREEN_READER: "true", AUTOPILOT_TUI_FULLSCREEN: "1" }, "linux")).toBe("inline");
    expect(resolveTuiRenderMode({ SCREEN_READER: "1" }, "linux")).toBe("inline");
  });

  it("备用屏按完整顺序进入并只恢复一次，包含鼠标、paste、focus 和 1049", function restoresAlternateScreenIdempotently() {
    let output = "";
    const lifecycle = createTuiTerminalLifecycle({ write(chunk) { output += chunk; } }, "alternate-screen");
    lifecycle.enter();
    lifecycle.enter();
    lifecycle.restore();
    lifecycle.restore();
    expect(output).toBe("\u001b[?1049h\u001b[2J\u001b[H\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h\u001b[?2004h\u001b[?1004h\u001b[?1006l\u001b[?1003l\u001b[?1002l\u001b[?1000l\u001b[?2004l\u001b[?1004l\u001b[?1049l");
  });

  it("备用屏可在 Ink 初始化或重新聚焦后幂等重申鼠标模式", function reassertsMouseTracking() {
    let output = "";
    const lifecycle = createTuiTerminalLifecycle({ write(chunk) { output += chunk; } }, "alternate-screen");
    lifecycle.reassert();
    lifecycle.enter();
    lifecycle.reassert();
    lifecycle.restore();
    lifecycle.reassert();
    expect(output.match(/\u001b\[\?1006h/gu)).toHaveLength(2);
    expect(output.match(/\u001b\[\?1006l/gu)).toHaveLength(1);
  });

  it("inline 降级保留既有 paste/focus 输入语义且绝不启用鼠标或备用屏", function preservesInlineInputSemantics() {
    let output = "";
    const lifecycle = createTuiTerminalLifecycle({ write(chunk) { output += chunk; } }, "inline");
    lifecycle.enter();
    lifecycle.restore();
    expect(output).toBe("\u001b[?2004h\u001b[?1004h\u001b[?2004l\u001b[?1004l");
    expect(output).not.toContain("1002");
    expect(output).not.toContain("1006");
    expect(output).not.toContain("1049");
  });

  it("输入分流流转发真实 TTY 的 raw-mode 与 ref 生命周期，供 Ink 正常挂载", function preservesInkStdinLifecycle() {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?(enabled: boolean): void; ref?(): void; unref?(): void };
    let refCount = 0;
    let unrefCount = 0;
    input.isTTY = true;
    input.setRawMode = function setRawMode(): void {};
    input.ref = function ref(): void { refCount += 1; };
    input.unref = function unref(): void { unrefCount += 1; };

    const routed = createRoutedTuiStdin(input as unknown as NodeJS.ReadStream) as PassThrough & { isTTY?: boolean; setRawMode?(enabled: boolean): void; ref?(): void; unref?(): void };
    expect(routed.isTTY).toBe(true);
    expect(typeof routed.setRawMode).toBe("function");
    expect(typeof routed.ref).toBe("function");
    expect(typeof routed.unref).toBe("function");
    routed.ref?.();
    routed.unref?.();
    expect(refCount).toBe(1);
    expect(unrefCount).toBe(1);
  });
});
