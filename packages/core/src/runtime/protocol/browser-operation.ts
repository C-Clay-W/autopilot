// 固定浏览器动作解析供Core工具与可信宿主共用，不允许任意脚本或身份字段。
import { z } from "zod";
import { isIP } from "node:net";
import type { BrowserOperation } from "./browser-capability";

const page = { pageId: z.string().uuid(), revision: z.number().int().nonnegative() };
const ref = z.string().regex(/^@e\d{1,8}$/);
const value = z.string().max(16384);
const url = z.string().max(8192).refine(function address(value) { try { const parsed = new URL(value); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !/[\x00-\x20\x7f]/.test(value); } catch { return false; } });
export const browserOperationSchema = z.union([
  z.object({ type: z.literal("list") }).strict(),
  z.object({ type: z.literal("open"), url }).strict(),
  z.object({ type: z.literal("document"), path: z.string().min(1).max(4096).refine(function file(value) { return !/[\x00-\x1f\x7f]/.test(value) && !/^file:/i.test(value); }) }).strict(),
  z.object({ type: z.literal("downloads"), ...page }).strict(),
  z.object({ type: z.literal("cancel-download"), ...page, id: z.string().uuid() }).strict(),
  z.object({ type: z.literal("wait"), ...page, condition: z.literal("load"), timeout: z.number().int().min(1).max(30000) }).strict(),
  z.object({ type: z.literal("navigate"), ...page, url }).strict(),
  z.object({ type: z.enum(["select", "close", "release", "back", "forward", "reload", "snapshot", "screenshot"]), ...page }).strict(),
  z.object({ type: z.literal("click"), ...page, ref }).strict(),
  z.object({ type: z.enum(["fill", "select-option"]), ...page, ref, value }).strict(),
  z.object({ type: z.literal("press"), ...page, key: z.string().regex(/^(?:(?:Control|Alt|Shift|Meta)\+){0,4}(?:[a-zA-Z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/) }).strict(),
  z.object({ type: z.literal("scroll"), ...page, direction: z.enum(["up", "down", "left", "right"]), amount: z.number().int().min(1).max(10000) }).strict(),
  z.object({ type: z.literal("check"), ...page, ref, checked: z.boolean() }).strict(),
  z.object({ type: z.literal("dialog"), ...page, accept: z.boolean(), text: value }).strict(),
]);

/** 跨宿主入口复用同一严格单动作验证。 */
export function parseBrowserOperation(value: unknown): BrowserOperation {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  if (typeof input?.url === "string" && /^file:/i.test(input.url)) throw new Error("BROWSER_FILE_URL_USE_DOCUMENT");
  if (input?.type === "document" && typeof input.path === "string" && !/\.(?:md|markdown|html?)$/i.test(input.path)) throw new Error("BROWSER_DOCUMENT_UNSUPPORTED");
  const result = browserOperationSchema.safeParse(value);
  if (!result.success) throw new Error("BROWSER_ACTION_INVALID");
  return result.data;
}

/** 只将常规 HTTP(S) 域名作为公开导航候选，排除 IP、本机与常见内部域。 */
export function isPublicBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      hostname.includes(".") && !isIP(hostname) &&
      ![".localhost", ".local", ".internal", ".home.arpa"].some(function local(suffix) { return hostname.endsWith(suffix); });
  } catch { return false; }
}

/** 宿主有真实网页 URL 时复核观察目标，Core 分类时仍由宿主决定目标访问。 */
export function isPublicBrowserRead(operation: BrowserOperation, pageUrl?: string): boolean {
  if (operation.type === "open" || operation.type === "navigate") return isPublicBrowserUrl(operation.url);
  return operation.type === "list" || ["snapshot", "screenshot", "wait"].includes(operation.type) &&
    (pageUrl === undefined || isPublicBrowserUrl(pageUrl));
}
