/** Stage4 定向验证：产品导航、互斥来源、后台状态隔离与不可用控件语义。 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CHAT_SCOPE, conversationUrl, readConversationTarget, sessionApiUrl, toggleChatRetrieval } from "@/app/chat/conversation-target";
import { createSessionTaskManager, createWorkspaceSessionKey } from "@/app/chat/session-task-store";
import { ChatRetrievalControls, ProductModeTabs } from "@/app/chat/components/ChatModeControls";

describe("Stage4 产品边界", function suite() {
  it("默认 Chat 与旧 Work 深链按产品分流，伪造保留作用域不能串产品", function routesProducts() {
    expect(readConversationTarget(new URLSearchParams()).scope).toBe(CHAT_SCOPE);
    expect(readConversationTarget(new URLSearchParams("workspaceId=ws&sessionId=s"))).toMatchObject({ productMode: "work", scope: "ws", sessionId: "s" });
    expect(readConversationTarget(new URLSearchParams("mode=work&workspaceId=%40chat&sessionId=s"))).toMatchObject({ productMode: "work", scope: "", sessionId: "" });
    expect(sessionApiUrl("", "s")).toBeNull();
    expect(sessionApiUrl(CHAT_SCOPE, "s", "/messages")).toBe("/api/chat/sessions/s/messages");
    expect(sessionApiUrl("ws", "s", "/messages")).toBe("/api/workspaces/ws/sessions/s/messages");
  });

  it("来源完整转移保持互斥，新草稿 URL 不携带原 Session 或工作区", function switchesSource() {
    for (const [current, clicked, expected] of [["none", "web", "web"], ["none", "rag", "rag"], ["web", "web", "none"], ["web", "rag", "rag"], ["rag", "web", "web"], ["rag", "rag", "none"]] as const) expect(toggleChatRetrieval(current, clicked)).toBe(expected);
    const url = new URL(conversationUrl(CHAT_SCOPE, "", "web", "fresh"), "http://localhost");
    expect([...url.searchParams.keys()]).toEqual(["mode", "retrieval", "draft"]);
    expect(readConversationTarget(url.searchParams)).toMatchObject({ scope: CHAT_SCOPE, sessionId: "", retrievalMode: "web" });
  });

  it("同名 Chat/Work 共用 manager 但迟到事件与列表刷新互不覆盖", function isolatesBackgroundState() {
    const manager = createSessionTaskManager();
    const base = { id: "same", title: "会话", createdAt: 1, updatedAt: 1, status: "active" as const, runtimeStatus: "idle" as const };
    manager.syncWorkspaceSessions(CHAT_SCOPE, [{ ...base, productMode: "chat", chatRetrievalMode: "rag" }]);
    manager.syncWorkspaceSessions("ws", [{ ...base, productMode: "work" }]);
    const chatKey = createWorkspaceSessionKey(CHAT_SCOPE, "same"), workKey = createWorkspaceSessionKey("ws", "same");
    manager.selectSession(workKey);
    manager.beginSession(chatKey, "chat-turn");
    manager.applyTerminalEvent(chatKey, "turn_completed");
    expect(manager.getSessionSnapshot(chatKey)).toMatchObject({ terminalNotice: "success", session: { chatRetrievalMode: "rag" } });
    expect(manager.getSessionSnapshot(workKey)).toMatchObject({ phase: "idle", terminalNotice: null });
    manager.syncWorkspaceSessions("ws", []);
    expect(manager.getSessionSnapshot(chatKey)).not.toBeNull();
  });

  it("联网和 RAG 均可切换且选中态互斥，Tabs 只让当前产品进入 Tab 顺序", function accessibleRetrievalControls() {
    const noop = function noAction() {};
    const sources = renderToStaticMarkup(<ChatRetrievalControls mode="none" persisted={false} onChange={noop} />);
    expect(sources.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(sources).not.toContain('disabled=""');
    for (const mode of ["web", "rag"] as const) {
      const active = renderToStaticMarkup(<ChatRetrievalControls mode={mode} persisted onChange={noop} />);
      expect(active.match(/aria-pressed="true"/g)).toHaveLength(1);
      expect(active.match(/aria-pressed="false"/g)).toHaveLength(1);
      expect(active).not.toContain('disabled=""');
      if (mode === "web") expect(active).toContain("否则仅可读取已知公开链接");
    }
    const tabs = renderToStaticMarkup(<ProductModeTabs mode="chat" onChange={noop} />);
    expect(tabs).toContain('aria-selected="true"');
    expect(tabs.match(/tabindex="0"/g)).toHaveLength(1);
  });
});
