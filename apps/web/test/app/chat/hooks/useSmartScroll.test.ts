/** 智能滚动状态机测试：锁定 Pinned、FreeScroll 与统一未读计数语义。 */
import { describe, expect, it } from "vitest";
import {
  getSmartScrollStateOnContentChange,
  getSmartScrollStateOnViewportChange,
  isNearBottom,
  isProgrammaticScrollWindow,
  type SmartScrollState,
} from "@/app/chat/hooks/useSmartScroll";

describe("smart scroll", function smartScrollSuite() {
  it("只依据容器底部距离判定 Pinned", function detectsPinnedViewport() {
    expect(isNearBottom(1000, 452, 500)).toBe(true);
    expect(isNearBottom(1000, 400, 500)).toBe(false);
  });

  it("FreeScroll 中的新进展不会强制滚动并统一累计未读", function countsUnreadProgress() {
    const free: SmartScrollState = { mode: "free", unreadCount: 2 };
    const next = getSmartScrollStateOnContentChange(free);

    expect(next).toEqual({ state: { mode: "free", unreadCount: 3 }, shouldScroll: false });
  });

  it("回到底部后恢复 Pinned 并清空未读", function resetsWhenPinnedAgain() {
    expect(getSmartScrollStateOnViewportChange({ mode: "free", unreadCount: 3 }, true)).toEqual({ mode: "pinned", unreadCount: 0 });
    expect(getSmartScrollStateOnContentChange({ mode: "pinned", unreadCount: 0 }).shouldScroll).toBe(true);
  });

  it("程序滚动窗口内的事件不作为用户意图解读，窗口过期后恢复分类", function ignoresScrollDuringProgrammaticWindow() {
    expect(isProgrammaticScrollWindow(1000, 1100)).toBe(true);
    expect(isProgrammaticScrollWindow(1100, 1100)).toBe(false);
    expect(isProgrammaticScrollWindow(1200, 1100)).toBe(false);
  });
});
