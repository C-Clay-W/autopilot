/** S5 Manager隐藏正文追尾与刷新取消，复用生产Controller/Store。 */
import { expect, it, vi } from "vitest";
import type { AgentRuntime, Session } from "@autopilot-agent/core";
import { createCliController } from "../../../src/controller.js";
import { createCliSessionManager } from "../../../src/tui/session-manager.js";

it("S5隐藏普通历史停止追尾，重选原游标补齐且旧刷新取消不读关联", async function hiddenAndCancelled() {
  const a = { id: "a", title: "A", productMode: "work", projectId: "project", status: "idle", persistenceMode: "durable", createdAt: 1, updatedAt: 1 } as Session;
  const b = { ...a, id: "b", title: "B" };
  const runtime = { sessions: { get: async function session(id: string) { return id === "a" ? a : b; } }, turns: {} } as unknown as AgentRuntime;
  /** Controller只观察安全历史，不调用运行入口。 */
  function controller(id: string) { return createCliController({ runtime, sessionId: id, renderer: { format: "text", render: function empty() { return ""; } } }); }
  const pages = vi.fn(async function page(id: string, input: { cursor?: string }) { return { items: [], cursor: input.cursor ?? "cursor-" + id }; });
  const relations = vi.fn(async function related() { return []; });
  let release!: () => void;
  let delay = false;
  let observedSignal: AbortSignal | undefined;
  const summary = vi.fn(async function read(_id: string, signal?: AbortSignal) { observedSignal = signal; if (delay) await new Promise<void>(function hold(resolve) { release = resolve; }); return null; });
  const manager = createCliSessionManager({ runtime, projectId: "project", initialSession: a, initialController: controller("a"), createController: controller,
    readDirectoryPage: async function directory() { return { items: [a, b] }; }, readEventPage: pages, readRelations: relations, readSummary: summary });
  try {
    await manager.loadDirectory(); await manager.select("a"); await manager.select("b");
    pages.mockClear(); await manager.refresh();
    expect(pages).toHaveBeenCalledTimes(1);
    expect(pages.mock.calls.every(function selected(call) { return call[0] === "b"; })).toBe(true);
    await manager.select("a");
    expect(pages).toHaveBeenLastCalledWith("a", { cursor: "cursor-a", limit: 100 });
    relations.mockClear(); delay = true;
    const refresh = manager.refresh();
    await Promise.resolve();
    await manager.select("b");
    expect(observedSignal?.aborted).toBe(true);
    release(); await refresh;
    expect(relations).not.toHaveBeenCalled();
  } finally { await manager.stop(); }
});
