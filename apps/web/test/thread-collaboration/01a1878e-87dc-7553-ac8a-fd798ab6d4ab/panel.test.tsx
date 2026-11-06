/** 协作面板使用真实安全详情判定启用状态的回归。 */
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { createRequire } from "node:module";
const { parseHTML } = createRequire(new URL("../../../../../packages/adapters/package.json", import.meta.url))("linkedom") as typeof import("../../../../../packages/adapters/node_modules/linkedom");
import { afterEach, describe, expect, it, vi } from "vitest";
import ThreadCollaborationPanel from "@/app/chat/components/ThreadCollaborationPanel";

/** 已启用协作组的只读投影；成员为目标会话。 */
const GROUP = {
  groupId: "group-1",
  rootThreadId: "s",
  enabled: true,
  createdAt: 1,
  allowedTools: [],
  members: [{ threadId: "s", parentThreadId: null, createdAt: 1 }],
};

/** 一条待宿主领取的协作消息。 */
const MESSAGE = { messageId: "message-1", mode: "run", deliveryStatus: "pending", deliverySeq: 1, content: "执行并回报" };

/** 构造已启用协作组的面板数据源；消息响应由用例决定。 */
function collaborationFetch(messages: () => Response) {
  return vi.fn(async function respond(url: string) {
    if (url.endsWith("/threads/groups")) return Response.json({ items: [GROUP] });
    if (url.endsWith("/threads/capabilities")) return Response.json({ allowedTools: [] });
    if (url.endsWith("/sessions")) return Response.json({ sessions: [] });
    if (url.includes("/messages?")) return messages();
    if (url.endsWith("/state")) return Response.json({ value: {}, revision: 0 });
    return Response.json({ meta: { runtimeStatus: "idle" }, canAutoStartNext: false });
  });
}

/** 挂载真实面板并等待首次读取完成，返回容器与卸载函数。 */
async function renderPanel(fetchMock: ReturnType<typeof vi.fn>) {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  const container = document.getElementById("root")!;
  const root = createRoot(container as unknown as Element);
  await act(async function mount() { root.render(createElement(ThreadCollaborationPanel, { open: true, workspaceId: "w", sessionId: "s", onClose: function close() {} })); });
  // useEffect 内的读取不返回给 act，再冲刷一次微任务确保首屏状态落地。
  await act(async function settle() {});
  return { container, unmount: async function unmount() { await act(async function remove() { root.unmount(); }); } };
}

describe("协作面板会话启用门禁", function panelSuite() {
  afterEach(function cleanup() { vi.unstubAllGlobals(); });

  it.each([
    ["idle", undefined, false],
    ["completed", undefined, false],
    ["completed", { status: "limit_reached" }, true],
    ["waiting_approval", { status: "awaiting_approval" }, true],
  ])("按详情 %s 和恢复事实显示启用资格", async function eligibility(status, agent, disabled) {
    const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(async function respond(url: string) {
      if (url.endsWith("/threads/groups")) return Response.json({ items: [] });
      if (url.endsWith("/threads/capabilities")) return Response.json({ allowedTools: [] });
      if (url.endsWith("/sessions")) return Response.json({ sessions: [{ id: "s", status: "active", runtimeStatus: status }] });
      return Response.json({ meta: { runtimeStatus: status }, agent, canAutoStartNext: status === "completed" && !agent });
    }));
    const container = document.getElementById("root")!;
    const root = createRoot(container as unknown as Element);
    try {
      await act(async function mount() { root.render(createElement(ThreadCollaborationPanel, { open: true, workspaceId: "w", sessionId: "s", onClose: function close() {} })); });
      const button = Array.from(container.querySelectorAll("button")).find(function find(item) { return item.textContent === "启用会话协作"; });
      expect(button).toBeDefined();
      expect(button!.hasAttribute("disabled")).toBe(disabled);
    } finally { await act(async function unmount() { root.unmount(); }); }
  });

  it("读取成功时展示消息列表，不误报为空", async function successMessages() {
    const panel = await renderPanel(collaborationFetch(function ok() { return Response.json({ items: [MESSAGE] }); }));
    try {
      expect(panel.container.textContent).toContain("执行并回报");
      expect(panel.container.textContent).toContain("待宿主领取");
      expect(panel.container.textContent).not.toContain("暂无协作消息");
    } finally { await panel.unmount(); }
  });

  it("读取成功但列表为空时显示暂无协作消息", async function emptyMessages() {
    const panel = await renderPanel(collaborationFetch(function empty() { return Response.json({ items: [] }); }));
    try {
      expect(panel.container.textContent).toContain("暂无协作消息。");
      expect(panel.container.querySelector("[role='alert']")).toBeNull();
    } finally { await panel.unmount(); }
  });

  it("读取失败显示明确错误，且不展示旧消息或假空", async function failedMessages() {
    let failed = false;
    const panel = await renderPanel(collaborationFetch(function respond() {
      return failed ? new Response(null, { status: 405 }) : Response.json({ items: [MESSAGE] });
    }));
    try {
      expect(panel.container.textContent).toContain("执行并回报");
      failed = true;
      const refresh = Array.from(panel.container.querySelectorAll("button")).find(function find(item) { return item.textContent === "刷新"; });
      expect(refresh).toBeDefined();
      await act(async function reload() { refresh!.click(); });
      await act(async function settle() {});
      expect(panel.container.querySelector("[role='alert']")?.textContent).toBe("无法读取协作消息");
      expect(panel.container.textContent).not.toContain("执行并回报");
      expect(panel.container.textContent).not.toContain("暂无协作消息");
    } finally { await panel.unmount(); }
  });
});
