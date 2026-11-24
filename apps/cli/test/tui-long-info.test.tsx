/** 长控制消息复用报告覆盖视图，窄屏滚动与Esc不得改变执行或草稿。 */
import { render } from "ink-testing-library";
import { describe, it, expect } from "vitest";
import { CliTuiApp } from "../src/tui/app.js";
import { createCliTuiStore } from "../src/tui/store.js";
import type { CliControllerResult } from "../src/controller.js";
import { createManagedCliController } from "../src/managed-controller.js";

/** 等待 Ink 完成订阅与输入帧，不使用真实终端或Provider。 */
async function frame() { await new Promise(function wait(resolve) { setTimeout(resolve, 50); }); }
/** 装配真实TUI与受管Controller，仅替换传输。 */
function setup(response: string, dedicated?: Partial<CliControllerResult>) {
  const calls: string[] = []; let cancelled = 0;
  const store = createCliTuiStore();
  const controller = createManagedCliController(async function request(operation, extra) { if (operation === "cli") return extra?.action && dedicated ? { kind: "ok", exitCode: 0, lines: [response], ...dedicated } : undefined; calls.push(String(extra?.text)); return response; }, function notice(text) { store.addNotice(text); });
  const view = render(<CliTuiApp availableColumns={36} availableRows={16} store={store} controller={controller} closeWhenIdle={false} useColor={false} screenReader={false} renderMode="alternate-screen" onResult={function result(value) { for (const line of value.lines) store.addNotice(line); }} onRequestInterrupt={function interrupt() { cancelled++; }} onRequestCancel={function cancel() { cancelled++; }} onEof={function eof() {}} onAppExit={function exit() {}} />);
  return { ...view, store, calls, cancelled: function count() { return cancelled; } };
}
describe("完整信息报告", function reports() {
  it("长help自动完整阅读，窄屏中文换行与翻页可达结尾，Esc不取消", async function help() {
    const text = Array.from({ length: 24 }, function line(_, i) { return `第${i}行中文帮助 /agent assignment approve approval-${i}`; }).join("\n") + "\n帮助结束标记";
    const view = setup(text);
    try {
      await frame(); view.stdin.write("/help"); view.stdin.write("\r"); await frame(); await frame();
      expect(view.calls).toEqual(["/help"]); expect(view.lastFrame()).toContain("Esc 返回聊天");
      for (let i = 0; i < 12; i++) { view.stdin.write("\u001b[6~"); await frame(); }
      expect(view.lastFrame()).toContain("帮助结束标记");
      view.stdin.write("\u001b"); await frame(); expect(view.lastFrame()).not.toContain("Esc 返回聊天"); expect(view.cancelled()).toBe(0);
    } finally { view.unmount(); }
  });
  it("完整信息包含四条以外的通知，关闭后保留草稿，短info保持原位", async function draft() {
    const view = setup("短提示");
    try {
      await frame(); view.store.addNotice("最早通知保留"); for (let i = 0; i < 8; i++) view.store.addNotice(`后续通知${i}`); await frame();
      view.stdin.write("尚未发送的草稿"); await frame(); view.stdin.write("\u0007"); await frame();
      expect(view.lastFrame()).toContain("最早通知保留"); expect(view.lastFrame()).toContain("Esc 返回聊天");
      view.stdin.write("\u001b"); await frame(); expect(view.lastFrame()).toContain("尚未发送的草稿"); expect(view.calls).toEqual([]); expect(view.cancelled()).toBe(0);
    } finally { view.unmount(); }
    const short = setup("短提示");
    try { await frame(); short.stdin.write("/help"); short.stdin.write("\r"); await frame(); expect(short.lastFrame()).toContain("info: 短提示"); expect(short.lastFrame()).not.toContain("Esc 返回聊天"); } finally { short.unmount(); }
  });
  it("长普通文本不覆盖Jobs、Context或模型权限专用视图", async function dedicatedViews() {
    const cases: { command: string; result: Partial<CliControllerResult>; marker: string }[] = [
      { command: "/jobs", result: { jobView: { mode: "list", list: { jobs: [] } } }, marker: "Background jobs" },
      { command: "/context", result: { contextView: { usage: null, expanded: false } }, marker: "Context: unknown" },
      { command: "/model", result: { modelOptions: [{ provider: "fixture", modelId: "dedicated-model", selected: true }] }, marker: "dedicated-model" },
      { command: "/permissions", result: { permissionOptions: [{ mode: "ask", label: "专用权限选项", description: "保留原选择器", selected: true }] }, marker: "专用权限选项" },
    ];
    for (const item of cases) {
      const view = setup("普通文本不应覆盖专用视图".repeat(30), item.result);
      try {
        await frame(); view.stdin.write(item.command); view.stdin.write("\r"); await frame(); await frame();
        expect(view.lastFrame()).toContain(item.marker); expect(view.lastFrame()).not.toContain("PgUp PgDn");
      } finally { view.unmount(); }
    }
  });

});
