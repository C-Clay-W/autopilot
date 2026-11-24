// 终端复制键路由：本地选区优先，AP 与 OpenCode 备用屏支持内部选区请求。
/** 判断复制键是否由宿主处理，普通 Ctrl+C 继续交给 PTY 中断或内部选区复制。 */
export function terminalCopyAction(event: { key: string; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }, selected: boolean, apAlternate: boolean, openCodeAlternate = false): "copy" | "request" | undefined {
  if (event.isComposing || event.altKey || event.key.toLowerCase() !== "c") return;
  if (event.metaKey && !event.ctrlKey || event.ctrlKey && !event.metaKey) {
    if (selected) return "copy";
    if ((event.shiftKey || event.metaKey) && apAlternate) return "request";
    if (event.ctrlKey && event.shiftKey && openCodeAlternate) return "request";
  }
}

/** AP粘贴交浏览器原生paste事件同步读取clipboardData，避免异步系统剪贴板被替换。 */
export function terminalNativePaste(event: { key: string; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }, ap: boolean): boolean {
  return ap && !event.isComposing && !event.altKey && event.key.toLowerCase() === "v" && (event.ctrlKey && !event.metaKey || event.metaKey && !event.ctrlKey);
}
