/** Chat 页面拆分出的纯 helper：无状态、不触网络，供 page 装配层与 components/ UI 组件以唯一来源引用。 */
import { CHAT_SCOPE, sessionApiUrl } from "./conversation-target";
import type { SourceItem } from "./chat-page-types";

/** 仅开发环境展示数据库手动同步入口，生产构建隐藏。 */
export const showDevelopmentDatabaseSync = process.env.NODE_ENV !== "production";

/** 共用传输地址解析；Chat 作用域永远不发送到 Work API。 */
const getWorkspaceSessionUrl = sessionApiUrl;

/** 将 Session 附件预览绑定到 URL 中的工作区与会话双重身份。 */
export function getSessionImageUrl(workspaceId: string, sessionId: string, attachmentId: string): string | null {
  const sessionUrl = getWorkspaceSessionUrl(workspaceId, sessionId, `/${workspaceId === CHAT_SCOPE ? "attachments" : "uploads"}/${encodeURIComponent(attachmentId)}`);
  return sessionUrl;
}

/** 仅保留证据字段完整的来源，避免展示“未知文件”或无法定位的 PDF 页面。 */
export function isDisplayableSource(source: SourceItem): boolean {
  const fileName = source.metadata?.fileName?.trim();
  if (!fileName) return false;
  return !source.metadata?.imageFileName || Boolean(source.metadata.pageNumber);
}

/** 从浏览器存储恢复聊天开关；服务端预渲染时返回产品默认值。 */
export function getStoredToggle(storageKey: string, defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue;
  const storedValue = window.localStorage.getItem(storageKey);
  return storedValue === null ? defaultValue : storedValue === "true";
}

/** 将数据库同步等待时长格式化为分钟和秒，避免长同步期间页面没有可见反馈。 */
export function formatSyncElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainingSeconds = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

/** 发送受控消息后重置 textarea 的内联高度，因为清空 value 不会触发 onInput。 */
export function resetComposerHeight(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  textarea.style.height = "45px";
}

/** 区分浏览器网络/SSE 断连与服务端已返回的受控业务失败。 */
export function isTransportFailure(error: unknown): boolean {
  return error instanceof TypeError;
}

/** 只识别明确的继续命令，避免把普通新问题误判为 checkpoint 恢复。 */
export function isContinueCommand(content: string): boolean {
  return /^(继续|继续执行|继续任务)$/.test(content.trim());
}

/** 将附件字节数格式化为消息气泡内的可读大小文案。 */
export const formatSize = (bytes: number) => {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
};
