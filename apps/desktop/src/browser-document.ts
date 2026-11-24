// 受管本地文档只经精确文件授权读取；临时Worker与浏览器页面共同生存。
import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, realpath, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { STATIC_PREVIEW_SCRIPT } from "@autopilot-agent/core";

/** 相对路径只按受管PTY工作区解析；绝对路径允许用户明确选择的外部单文件。 */
export async function resolveBrowserDocumentFile(selected: string, workspace: string): Promise<string> {
  if (!selected || /[\x00-\x1f\x7f]/.test(selected) || /^file:/i.test(selected)) throw new Error("BROWSER_DOCUMENT_PATH_INVALID");
  if (!/\.(?:md|markdown|html?)$/i.test(selected)) throw new Error("BROWSER_DOCUMENT_UNSUPPORTED");
  if (process.platform !== "win32" && path.win32.isAbsolute(selected) && !path.posix.isAbsolute(selected)) throw new Error("BROWSER_DOCUMENT_PATH_INVALID");
  if (!path.isAbsolute(selected) && !path.isAbsolute(workspace)) throw new Error("BROWSER_WORKSPACE_ROOT_REQUIRED");
  const requested = path.isAbsolute(selected) ? selected : path.resolve(workspace, selected);
  try {
    const canonical = await realpath(requested);
    const info = await stat(canonical);
    if (!info.isFile()) throw new Error("BROWSER_DOCUMENT_UNAVAILABLE");
    if (/\.(?:md|markdown)$/i.test(canonical) && info.size > 2 * 1024 * 1024) throw new Error("BROWSER_DOCUMENT_TOO_LARGE");
    return canonical;
  } catch (error) {
    if (error instanceof Error && /^BROWSER_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error("BROWSER_DOCUMENT_UNAVAILABLE");
  }
}

/** 浏览器复核证据只接受工作区相对文档路径及 SHA-256，非文档证据按原核查处理。 */
export function isReviewDocument(artifact: string, contentVersion: string): boolean {
  return typeof artifact === "string" && /\.(?:md|markdown|html?)$/i.test(artifact) && !path.win32.isAbsolute(artifact)
    && !/[:\x00-\x1f\x7f]/.test(artifact) && artifact.split(/[\\/]/).every(function safe(part) { return !!part && part !== "." && part !== ".."; })
    && typeof contentVersion === "string" && /^[a-f0-9]{64}$/i.test(contentVersion);
}

/** 模型请求确认 canonical 文件，禁止把已冻结路径的符号链接或外部文件当作授权。 */
export async function resolveReviewDocument<T extends { artifact: string; contentVersion: string }>(selected: string, workspace: string, documents: readonly T[]): Promise<{ file: string; evidence: T }> {
  const file = await resolveBrowserDocumentFile(selected, workspace);
  const canonicalWorkspace = await realpath(workspace);
  const relative = path.relative(canonicalWorkspace, file);
  const evidence = documents.find(function match(item) {
    if (!isReviewDocument(item.artifact, item.contentVersion)) return false;
    const artifact = path.normalize(item.artifact);
    return process.platform === "win32" ? relative.toLowerCase() === artifact.toLowerCase() : relative === artifact;
  });
  if (!evidence) throw new Error("BROWSER_REVIEW_SCOPE_DENIED");
  return { file, evidence };
}

/** 只运行Core固定脚本；Worker参数不拼入代码，随机路由不暴露文件名或目录。 */
export async function openBrowserDocument(file: string, signal: AbortSignal, contentVersion?: string): Promise<{ url: string; close(): Promise<void> }> {
  if (signal.aborted) throw new Error("BROWSER_CANCELLED");
  // 独立复核在精确文件获批后冻结字节，页面服务重读同一份私有副本。
  const temporary = contentVersion ? await mkdtemp(path.join(tmpdir(), "ap-review-document-")) : undefined;
  const source = temporary ? path.join(temporary, path.basename(file)) : file;
  let worker: Worker | undefined;
  let closing: Promise<void> | undefined;
  /** 页面、初始化失败和取消共用同一回收Promise。 */
  function close(): Promise<void> {
    closing ??= (async function clean() {
      try { await worker?.terminate(); }
      finally {
        if (temporary) {
          await rm(source, { force: true });
          await rmdir(temporary);
        }
      }
    })();
    return closing;
  }
  const route = randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = function initial() {};
  try {
    if (contentVersion) {
      await copyFile(file, source);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(source, { signal })) hash.update(chunk);
      if (hash.digest("hex") !== contentVersion.toLowerCase()) throw new Error("BROWSER_DOCUMENT_CHANGED");
    }
    if (signal.aborted) throw new Error("BROWSER_CANCELLED");
    const preview = worker = new Worker(`
      const { workerData } = require('node:worker_threads');
      process.argv = [process.execPath, workerData.file, '0', workerData.route];
      ${STATIC_PREVIEW_SCRIPT}
    `, { eval: true, stdout: true, stderr: true, workerData: { file: source, route } });
    const port = await new Promise<number>(function ready(resolve, reject) {
      let output = "";
      cancel = function abort() { reject(new Error("BROWSER_CANCELLED")); };
      signal.addEventListener("abort", cancel, { once: true });
      preview.once("error", function failed() { reject(new Error("BROWSER_DOCUMENT_UNAVAILABLE")); });
      preview.once("exit", function exited() { reject(new Error("BROWSER_DOCUMENT_UNAVAILABLE")); });
      preview.stderr.resume();
      preview.stdout.on("data", function data(chunk) {
        output += chunk.toString();
        if (output.length > 1024) { reject(new Error("BROWSER_DOCUMENT_UNAVAILABLE")); return; }
        if (!output.includes("\n")) return;
        try {
          const value = JSON.parse(output.slice(0, output.indexOf("\n"))).port;
          if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error();
          resolve(value);
        } catch { reject(new Error("BROWSER_DOCUMENT_UNAVAILABLE")); }
      });
      timer = setTimeout(function deadline() { reject(new Error("BROWSER_DOCUMENT_TIMEOUT")); }, 5000);
      if (signal.aborted) cancel();
    });
    if (signal.aborted) throw new Error("BROWSER_CANCELLED");
    return { url: `http://127.0.0.1:${port}/${route}`, close };
  } catch (error) { await close(); if (signal.aborted) throw new Error("BROWSER_CANCELLED"); throw error; }
  finally { if (timer) clearTimeout(timer); signal.removeEventListener("abort", cancel); }
}
