/** Chat 页面壳回归测试：消息区独占滚动，页面根不得因嵌套视口高度出现整体滚动。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const chatDirectory = path.resolve(__dirname, "../../../app/chat");

/** 读取聊天布局源码，锁定页面高度边界。 */
function readChatSource(fileName: string): string {
  return readFileSync(path.join(chatDirectory, fileName), "utf8");
}

describe("chat layout", function chatLayoutSuite() {
  it("根壳禁止页面整体滚动，子页面继承父容器高度", function keepsScrollingInsideMessageArea() {
    const layoutSource = readChatSource("layout.tsx");
    const pageSource = readChatSource("page.tsx");

    expect(layoutSource).toContain('className="fixed inset-0 overflow-hidden flex"');
    expect(layoutSource).toContain('h-full min-h-0 w-65 min-w-65 bg-bg');
    expect(layoutSource).toContain('className="flex-1 min-h-0 overflow-hidden flex flex-col min-w-0 h-full"');
    expect(pageSource).toContain('className="flex-1 min-h-0 flex flex-col bg-bg"');
    expect(pageSource).toContain('className="flex flex-1 min-h-0 flex-col"');
    expect(pageSource).not.toContain('className="flex-1 flex flex-col h-screen bg-bg"');
  });
});
