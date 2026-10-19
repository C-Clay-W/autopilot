/** Chat 查询参数导航回归测试：切换不应启动 App Router 的服务器导航。 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { navigateChat } from "@/app/chat/chat-navigation";

describe("navigateChat", function navigateChatSuite() {
  afterEach(function restoreBrowserGlobals() {
    vi.unstubAllGlobals();
  });

  it("使用 pushState 更新会话 URL", function pushesChatUrl() {
    const pushState = vi.fn();
    vi.stubGlobal("window", { history: { pushState, replaceState: vi.fn() } });

    navigateChat("/chat?workspaceId=workspace-a&sessionId=session-b");

    expect(pushState).toHaveBeenCalledWith(null, "", "/chat?workspaceId=workspace-a&sessionId=session-b");
  });

  it("支持删除后的 replaceState 回退", function replacesChatUrl() {
    const replaceState = vi.fn();
    vi.stubGlobal("window", { history: { pushState: vi.fn(), replaceState } });

    navigateChat("/chat?workspaceId=workspace-a", true);

    expect(replaceState).toHaveBeenCalledWith(null, "", "/chat?workspaceId=workspace-a");
  });
});
