/** TUI 备用屏视口滚动状态机；纯状态无副作用，供后续渲染层消费。 */

/** 完整时间线相对于可视窗口的滚动状态。 */
export interface ScrollViewportState {
  scrollTop: number;
  totalHeight: number;
  viewportHeight: number;
  pinnedToBottom: boolean;
}

/** 创建钉底的初始视口状态，并统一收敛非法高度。 */
export function createScrollViewportState(totalHeight = 0, viewportHeight = 0): ScrollViewportState {
  const normalizedTotalHeight = Math.max(0, totalHeight);
  const normalizedViewportHeight = Math.max(0, viewportHeight);
  return {
    scrollTop: getScrollViewportMaxTop(normalizedTotalHeight, normalizedViewportHeight),
    totalHeight: normalizedTotalHeight,
    viewportHeight: normalizedViewportHeight,
    pinnedToBottom: true,
  };
}

/** 计算指定内容与视口高度下允许的最大首行偏移。 */
export function getScrollViewportMaxTop(totalHeight: number, viewportHeight: number): number {
  return Math.max(0, Math.max(0, totalHeight) - Math.max(0, viewportHeight));
}

/** 向上滚动并解除钉底；即使已经在顶部也保持解除状态。 */
export function scrollViewportUp(state: ScrollViewportState, lines: number): ScrollViewportState {
  return {
    ...state,
    scrollTop: Math.max(0, state.scrollTop - Math.max(0, lines)),
    pinnedToBottom: false,
  };
}

/** 直接将视口定位到内容顶部并解除钉底。 */
export function scrollViewportToTop(state: ScrollViewportState): ScrollViewportState {
  return {
    ...state,
    scrollTop: 0,
    pinnedToBottom: false,
  };
}

/** 向下滚动；只有到达底部后的额外滚动量才重新钉底。 */
export function scrollViewportDown(state: ScrollViewportState, lines: number): ScrollViewportState {
  const maxTop = getScrollViewportMaxTop(state.totalHeight, state.viewportHeight);
  const requestedTop = state.scrollTop + Math.max(0, lines);
  return {
    ...state,
    scrollTop: Math.min(maxTop, requestedTop),
    pinnedToBottom: state.pinnedToBottom || requestedTop > maxTop,
  };
}

/** 直接将视口定位到内容底部并恢复钉底。 */
export function scrollViewportToBottom(state: ScrollViewportState): ScrollViewportState {
  return {
    ...state,
    scrollTop: getScrollViewportMaxTop(state.totalHeight, state.viewportHeight),
    pinnedToBottom: true,
  };
}

/** 更新内容或终端尺寸；非钉底时以当前可见首行为锚并仅做边界收敛。 */
export function resizeScrollViewport(state: ScrollViewportState, totalHeight: number, viewportHeight: number): ScrollViewportState {
  const normalizedTotalHeight = Math.max(0, totalHeight);
  const normalizedViewportHeight = Math.max(0, viewportHeight);
  const maxTop = getScrollViewportMaxTop(normalizedTotalHeight, normalizedViewportHeight);
  return {
    ...state,
    totalHeight: normalizedTotalHeight,
    viewportHeight: normalizedViewportHeight,
    scrollTop: state.pinnedToBottom ? maxTop : Math.min(Math.max(0, state.scrollTop), maxTop),
  };
}
