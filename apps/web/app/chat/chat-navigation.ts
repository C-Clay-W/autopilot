/** chat-navigation.ts — Chat 查询参数导航工具。
 *
 * Chat 页面只改变 workspaceId/sessionId 查询参数；使用原生 History API
 * 让 Next Router 同步 URL 状态但不为每次切换启动新的 RSC 导航请求。
 *
 * 桌面 exe 或 macOS App 适配注意：宿主环境可能没有浏览器 `window`，
 * 也就没有 History API；届时应由宿主提供导航适配层。本轮 Web 版本暂不处理。
 */

/** 在当前 Chat 页面内更新查询参数，避免被运行中的 SSE 长请求阻塞。 */
export function navigateChat(url: string, replace = false): void {
  if (replace) {
    window.history.replaceState(null, "", url);
    return;
  }
  window.history.pushState(null, "", url);
}
