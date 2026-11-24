// 浏览器偏好与历史的纯数据边界，兼容旧布局且不引入主进程模块。
import { browserUrl, type BrowserSaved, type BrowserPreferences } from "./browser-contract";

/** 偏好边界只接收固定选项，不把任意磁盘字段传入宿主。 */
export function isBrowserPreferences(value: unknown): value is BrowserPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(function key(key) { return ["permission", "historyDays", "askDownload", "downloadDirectory"].includes(key); }) && ["follow_ap", "once", "always"].includes(v.permission as string) && [0, 7, 30, 90].includes(v.historyDays as number) && typeof v.askDownload === "boolean" && (v.downloadDirectory === undefined || typeof v.downloadDirectory === "string" && v.downloadDirectory.length > 0 && v.downloadDirectory.length <= 32768 && !/[\x00-\x1f]/.test(v.downloadDirectory));
}

/** 旧布局没有浏览器字段时沿用出厂值，历史过期/重复/无效项不恢复。 */
export function restoreBrowserSaved(value?: unknown, now = Date.now()): BrowserSaved {
  const v = value as Partial<BrowserSaved> | undefined;
  const preferences: BrowserPreferences = isBrowserPreferences(v?.preferences) ? { ...v.preferences } : { permission: "follow_ap", historyDays: 30, askDownload: false };
  const seen = new Set<string>();
  const history: BrowserSaved["history"] = [];
  if (preferences.historyDays && Array.isArray(v?.history)) for (const entry of [...v.history].sort(function recent(a, b) { return (b?.visited ?? 0) - (a?.visited ?? 0); })) {
    if (!entry || typeof entry.url !== "string" || typeof entry.title !== "string" || !Number.isFinite(entry.visited) || entry.visited > now || entry.visited < now - preferences.historyDays * 86400000) continue;
    const url = browserHistoryUrl(entry.url);
    if (!url || seen.has(url)) continue;
    seen.add(url); history.push({ url, title: entry.title.slice(0, 256), visited: entry.visited });
  }
  return { preferences, history };
}

/** 历史沿用敏感字段遮盖思路，保留正常路由参数，不把所有 query 一刀切删除。 */
export function browserHistoryUrl(value: string): string | undefined {
  try {
    const url = new URL(browserUrl(value));
    for (const key of [...url.searchParams.keys()]) if (/^(?:access_token|refresh_token|id_token|token|password|passwd|secret|credential|authorization|api[_-]?key|code|signature|session[_-]?id)$/i.test(key)) url.searchParams.delete(key);
    // hash 可包含登录响应；普通站内锚点不影响入口恢复。
    url.hash = ""; return url.href;
  } catch { return undefined; }
}

