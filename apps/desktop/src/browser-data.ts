// 浏览器历史净化与下载名称保留，纯数据边界可脱离 Electron 定向验证。
import { existsSync, openSync, closeSync } from "node:fs";
import { basename, extname, join } from "node:path";
export { browserHistoryUrl, isBrowserPreferences, restoreBrowserSaved } from "./browser-history";

/** 原子保留下载文件名，避免并行下载或同名文件被覆盖。 */
export function reserveDownload(directory: string, requested: string, approve?: (path: string) => boolean): string {
  const name = basename(requested).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i, "_$&").replace(/[. ]+$/, "").slice(0, 180) || "download";
  const extension = extname(name); const stem = name.slice(0, name.length - extension.length);
  for (let n = 0; n < 10000; n++) {
    const path = join(directory, n ? `${stem} (${n})${extension}` : name);
    if (approve && existsSync(path)) continue;
    if (approve && !approve(path)) throw new Error("BROWSER_DOWNLOAD_DENIED");
    try { closeSync(openSync(path, "wx", 0o600)); return path; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  throw new Error("下载文件名冲突，请更换保存目录。");
}

