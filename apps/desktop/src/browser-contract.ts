// 内置浏览器的固定 DTO；网页和 renderer 均不能指定驱动路径、CDP 目标或调用身份。
import type { BrowserApproval } from "./browser-access";
export const BROWSER_CHANNEL = "desktop:browser";
export interface BrowserPage { id: string; owner: string; ownerLabel?: string; workspace: string; desktopWorkspaceId?: string | null; url: string; title: string; loading: boolean; back: boolean; forward: boolean; error?: string; revision: number; paused: boolean; occupied?: string; dialog?: { type: string; message: string; defaultValue: string } }
export interface BrowserDownload { id: string; pageId: string; name: string; received: number; total: number; state: "progressing" | "completed" | "cancelled" | "interrupted" }
export interface BrowserHistory { url: string; title: string; visited: number }
export interface BrowserPreferences { permission: "follow_ap" | "once" | "always"; historyDays: 0 | 7 | 30 | 90; askDownload: boolean; downloadDirectory?: string }
export interface BrowserSaved { preferences: BrowserPreferences; history: BrowserHistory[] }
export interface BrowserSkillStatus { id: "agents" | "claude" | "codebuddy"; label: string; path: string; state: "missing" | "current" | "update" | "custom" | "unavailable" }
export interface BrowserIntegrationStatus { driver: { version: string; available: boolean; reason?: string }; skills: BrowserSkillStatus[] }
export interface BrowserSnapshot { pages: BrowserPage[]; active: string | null; expanded: boolean; downloads: BrowserDownload[]; history: BrowserHistory[]; notice?: string; approvals?: BrowserApproval[] }
export type BrowserAction = { type: "snapshot" } | { type: "screenshot" } | { type: "click"; ref: string } | { type: "fill"; ref: string; value: string } | { type: "press"; key: string } | { type: "scroll"; direction: "up" | "down" | "left" | "right"; amount: number } | { type: "select-option"; ref: string; value: string } | { type: "check"; ref: string; checked: boolean };
export type BrowserCommand = { type: "open"; url: string } | { type: "navigate"; pageId: string; url: string } | { type: "select" | "close" | "back" | "forward" | "reload" | "stop" | "takeover" | "resume" | "copy"; pageId: string } | { type: "expand"; expanded: boolean } | { type: "dialog"; pageId: string; accept: boolean; text: string } | { type: "cancel-download"; id: string };
export interface BrowserBounds { x: number; y: number; width: number; height: number; hidden: boolean }
export interface BrowserBridge { integration(): Promise<BrowserIntegrationStatus>; installSkill(id: BrowserSkillStatus["id"]): Promise<void>; snapshot(workspaceId: string | null): Promise<BrowserSnapshot>; command(command: BrowserCommand, workspaceId: string | null): Promise<void>; bounds(bounds: BrowserBounds, workspaceId: string | null): Promise<void>; settings(): Promise<BrowserPreferences>; preferences(value: BrowserPreferences): Promise<void>; clearHistory(): Promise<void>; chooseDownloadDirectory(): Promise<void>; answerApproval(id: string, choice: "once" | "always" | "deny"): Promise<void> }

/** 只接受普通网站与 localhost，禁止 file/javascript/凭据型地址进入网页承载。 */
export function browserUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) throw new Error("BROWSER_URL_INVALID");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("BROWSER_URL_INVALID");
  return url.href;
}

/** 单动作白名单同时限制参数和额外字段，不能把脚本藏进未知属性。 */
export function isBrowserAction(value: unknown): value is BrowserAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const fields: Record<string, string[]> = { snapshot: [], screenshot: [], click: ["ref"], fill: ["ref", "value"], press: ["key"], scroll: ["direction", "amount"], "select-option": ["ref", "value"], check: ["ref", "checked"] };
  if (typeof v.type !== "string" || !Object.hasOwn(fields, v.type) || Object.keys(v).some(function extra(key) { return key !== "type" && !fields[v.type as string].includes(key); })) return false;
  if (fields[v.type].includes("ref") && (typeof v.ref !== "string" || !/^@e\d{1,8}$/.test(v.ref))) return false;
  if (fields[v.type].includes("value") && (typeof v.value !== "string" || v.value.length > 16384)) return false;
  if (v.type === "press" && (typeof v.key !== "string" || !/^(?:(?:Control|Alt|Shift|Meta)\+){0,4}(?:[a-zA-Z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/.test(v.key))) return false;
  if (v.type === "scroll" && (!["up", "down", "left", "right"].includes(v.direction as string) || !Number.isSafeInteger(v.amount) || (v.amount as number) < 1 || (v.amount as number) > 10000)) return false;
  return v.type !== "check" || typeof v.checked === "boolean";
}

/** renderer 命令仅能操作公开页面身份，严格拒绝多余键。 */
export function isBrowserCommand(value: unknown): value is BrowserCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const fields: Record<string, string[]> = { open: ["url"], navigate: ["pageId", "url"], select: ["pageId"], close: ["pageId"], back: ["pageId"], forward: ["pageId"], reload: ["pageId"], stop: ["pageId"], takeover: ["pageId"], resume: ["pageId"], copy: ["pageId"], expand: ["expanded"], dialog: ["pageId", "accept", "text"], "cancel-download": ["id"] };
  if (typeof v.type !== "string" || !Object.hasOwn(fields, v.type) || Object.keys(v).some(function extra(key) { return key !== "type" && !fields[v.type as string].includes(key); }) || fields[v.type].some(function missing(key) { return !(key in v); })) return false;
  if (fields[v.type].includes("pageId") && (typeof v.pageId !== "string" || !/^[0-9a-f-]{36}$/.test(v.pageId))) return false;
  if (v.type === "cancel-download" && (typeof v.id !== "string" || !/^[0-9a-f-]{36}$/.test(v.id))) return false;
  if (fields[v.type].includes("url")) { try { browserUrl(v.url); } catch { return false; } }
  if (v.type === "expand" && typeof v.expanded !== "boolean") return false;
  return v.type !== "dialog" || typeof v.accept === "boolean" && typeof v.text === "string" && v.text.length <= 16384;
}

/** 原生 View 坐标限定在窗口内容区内，拒绝 NaN 与任意超大尺寸。 */
export function isBrowserBounds(value: unknown): value is BrowserBounds {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 5 && typeof v.hidden === "boolean" && ["x", "y", "width", "height"].every(function bounded(key) { return Number.isSafeInteger(v[key]) && (v[key] as number) >= 0 && (v[key] as number) <= 20000; });
}
