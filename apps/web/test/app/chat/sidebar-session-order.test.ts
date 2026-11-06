/** 普通Thread平级展示：来源不影响顺序或缩进，不修改输入。 */
import { describe, expect, it } from "vitest";
import { orderSessionsByParent, resolveSessionDepth } from "@/app/chat/sidebar-session-order";

describe("平级会话排序", function flatSessions() {
  it("只按自身活动排序，创建来源不要求父先子后且所有深度为零", function flatOrder() {
    const items = [{ session: { id: "a", updatedAt: 1 } }, { session: { id: "b", updatedAt: 3 } }, { session: { id: "c", updatedAt: 2 } }];
    const source = new Map([["b", { parentThreadId: "a" }], ["c", { parentThreadId: "b" }]]);
    expect(orderSessionsByParent(items, source).map(function id(item) { return item.session.id; })).toEqual(["b", "c", "a"]);
    expect(items.map(function id(item) { return item.session.id; })).toEqual(["a", "b", "c"]);
    expect(resolveSessionDepth("c", source, new Set(["a", "b", "c"]))).toBe(0);
    expect(resolveSessionDepth("b", new Map(), new Set(["b"]))).toBe(0);
  });
});
