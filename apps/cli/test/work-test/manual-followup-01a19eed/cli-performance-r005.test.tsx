/** 状态栏并发/失效和历史派生缓存的最小合成回归，不启动真实CLI。 */
import { createElement, useEffect } from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import { createCliController, type CliController } from "../../../src/controller.js";
import { useStatusView } from "../../../src/tui/hooks/use-status-view.js";
import { TuiTranscriptItem } from "../../../src/tui/transcript.js";
import { TuiDiffBlock } from "../../../src/tui/markdown/diff.js";

/** 有界事件循环帧等待，使Ink被动effect可完成。 */
async function frame() { await new Promise(function wait(resolve) { setTimeout(resolve, 40); }); }
/** 单独挂载真实hook，不依赖App布局。 */
function StatusProbe(props: { controller: CliController; tick: number }) {
  const { statusView, refreshStatusView } = useStatusView(props.controller);
  useEffect(function refresh() { void refreshStatusView(); }, [props.controller, props.tick]);
  return createElement(Text, null, statusView?.model ?? "unknown");
}
/** 可控制异步Session返回，观察后续I/O边界。 */
function fixture() {
  const pending: Array<(value: unknown) => void> = [];
  const get = vi.fn(function session() { return new Promise(function awaitSession(resolve) { pending.push(resolve); }); });
  const usage = vi.fn(async function usage() { return { contextUsage: null, turnUsage: null }; });
  const legacy = vi.fn(async function legacy() { return null; });
  const controller = createCliController({ sessionId: "s", renderer: { render: function render() { return []; } } as never, runtime: { sessions: { get }, turns: { getUsageSnapshot: usage, getContextUsage: legacy, getTurnUsageSummary: legacy } } as never });
  return { controller, get, usage, legacy, resolve: function resolve(id = "s") { for (const complete of pending.splice(0)) complete({ id, defaultRunConfig: { modelRef: { provider: "test", modelId: id } } }); } };
}

it("Controller并发共享一次查询，单个调用方取消不影响有效订阅", async function singleFlight() {
  const f = fixture(); const cancelled = new AbortController(); const active = new AbortController();
  const first = f.controller.getStatusView!({ signal: cancelled.signal }).catch(function aborted() { return undefined; });
  const second = f.controller.getStatusView!({ signal: active.signal });
  cancelled.abort(); f.resolve(); await first;
  expect((await second).model).toBe("test/s"); expect(f.get).toHaveBeenCalledTimes(1); expect(f.usage).toHaveBeenCalledTimes(1); expect(f.legacy).not.toHaveBeenCalled();
});

it("全部调用方失效后不发后续I/O，Session切换迟到查询不会读新Session用量", async function cancelledQuery() {
  const f = fixture(); const abort = new AbortController();
  const old = f.controller.getStatusView!({ signal: abort.signal }).catch(function aborted() { return undefined; });
  abort.abort(); f.controller.setSession("new"); f.resolve(); await old; expect(f.usage).not.toHaveBeenCalled();
  const current = f.controller.getStatusView!(); f.resolve("new"); expect((await current).model).toBe("test/new"); expect(f.usage.mock.calls).toEqual([[{ sessionId: "new" }]]);
});

it("hook同批刷新合并，切换及卸载忽略迟到结果并停止后续I/O", async function lifecycle() {
  const a = fixture(); const b = fixture();
  const view = render(createElement(StatusProbe, { controller: a.controller, tick: 0 }));
  try {
    await frame(); view.rerender(createElement(StatusProbe, { controller: a.controller, tick: 1 })); await frame(); expect(a.get).toHaveBeenCalledTimes(1);
    view.rerender(createElement(StatusProbe, { controller: b.controller, tick: 0 })); await frame(); a.resolve(); b.resolve(); await frame(); expect(view.lastFrame()).toContain("test/s"); expect(a.usage).not.toHaveBeenCalled(); expect(b.get).toHaveBeenCalledTimes(1);
    view.rerender(createElement(StatusProbe, { controller: b.controller, tick: 1 })); await frame(); view.unmount(); b.resolve(); await frame(); expect(b.usage).toHaveBeenCalledTimes(1);
  } finally { view.unmount(); }
});

it("历史和diff重挂载保持稳定元素且宽度/颜色变体不混用", function renderCache() {
  const item = { kind: "turn" as const, key: "turn", turnId: "t", status: "completed" as const, events: [{ type: "answer_delta" as const, turnId: "t", seq: 1, delta: "原始回答" }] };
  const props = { item, useColor: false, columns: 80 };
  const first = TuiTranscriptItem(props); expect(TuiTranscriptItem(props)).toBe(first); expect(TuiTranscriptItem({ ...props, columns: 40 })).not.toBe(first); expect(TuiTranscriptItem(props)).toBe(first);
  const diff = { diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n", keyPrefix: "call", useColor: false };
  const rendered = TuiDiffBlock(diff); expect(TuiDiffBlock(diff)).toBe(rendered); expect(TuiDiffBlock({ ...diff, useColor: true })).not.toBe(rendered);
  const view = render(createElement(TuiDiffBlock, diff)); try { expect(view.lastFrame()).toContain("-old"); expect(view.lastFrame()).toContain("+new"); } finally { view.unmount(); }
});


it("不同Controller并行隔离且旧查询完成不覆盖当前视图", async function separateSessions() {
  const a = fixture(); const b = fixture(); b.controller.setSession("other");
  const left = a.controller.getStatusView!(); const right = b.controller.getStatusView!();
  b.resolve("other"); expect((await right).model).toBe("test/other");
  a.resolve(); expect((await left).model).toBe("test/s");
  expect(a.usage.mock.calls).toEqual([[{ sessionId: "s" }]]); expect(b.usage.mock.calls).toEqual([[{ sessionId: "other" }]]);
});


it("写入Session默认配置使旧在途查询失效，命令返回新配置", async function configRevision() {
  let permissionMode = "ask"; let finish!: (value: unknown) => void;
  const usage = vi.fn().mockImplementationOnce(function delayed() { return new Promise(function wait(resolve) { finish = resolve; }); }).mockResolvedValue({ contextUsage: null, turnUsage: null });
  const controller = createCliController({ sessionId: "s", renderer: { render: function render() { return []; } } as never, runtime: { sessions: {
    get: async function session() { return { id: "s", defaultRunConfig: { permissionMode } }; },
    setDefaultRunConfig: async function save(_id: string, config: { permissionMode: string }) { permissionMode = config.permissionMode; },
  }, turns: { getUsageSnapshot: usage } } as never });
  const old = controller.getStatusView!().catch(function invalidated() { return undefined; });
  await Promise.resolve(); await Promise.resolve();
  const command = controller.dispatch({ type: "set_permission_mode", mode: "full_access" });
  await Promise.resolve(); await Promise.resolve(); finish({ contextUsage: null, turnUsage: null });
  expect(await old).toBeUndefined(); expect((await command).statusView?.permissionMode).toBe("full_access"); expect(usage).toHaveBeenCalledTimes(2);
});
