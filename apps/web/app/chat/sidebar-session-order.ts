/** 会话侧栏采用平级最近活动排序；创建来源只作追溯，不产生树层级。 */
/** 排序所需的会话摘要。 */
export interface SidebarOrderableItem { session: { id: string; updatedAt: number } }
/** 既有来源投影，保留调用签名，不用于排序授权。 */
export interface SidebarParentLookup { parentThreadId: string | null }
/** 按会话自身最近活动排序，同时间保持已有顺序，不按血缘提升整棵子树。 */
export function orderSessionsByParent<T extends SidebarOrderableItem>(items: readonly T[], _membershipByThread: ReadonlyMap<string, SidebarParentLookup>): T[] {
  return [...items].sort(function recent(a, b) { return b.session.updatedAt - a.session.updatedAt; });
}
/** 所有普通会话平级展示，来源链不决定缩进。 */
export function resolveSessionDepth(_threadId: string, _membershipByThread: ReadonlyMap<string, SidebarParentLookup>, _visibleThreadIds: ReadonlySet<string>): number { return 0; }
