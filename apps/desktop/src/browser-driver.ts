// 固定版本的原生 driver 仅接受宿主构造的单动作参数，永不搜索全局 PATH 或启动外部浏览器。
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, realpath, lstat, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { isBrowserAction, type BrowserAction } from "./browser-contract";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserCdp } from "./browser-cdp";

export const BROWSER_DRIVER_VERSION = "0.39.4";
/** 截图只读取宿主指定的文件并转成标准图片块，不返回驱动临时路径。 */
export async function browserScreenshot(file: string): Promise<unknown> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 5 * 1024 * 1024) throw new Error("BROWSER_SCREENSHOT_INVALID");
  const bytes = await readFile(file);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("BROWSER_SCREENSHOT_INVALID");
  return { content: [{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }] };
}
/** 驱动资源必须来自显式版本目录，缺失就返回固定错误而非下载/全局回退。 */
export async function browserDriverPath(resources: string, platform = process.platform, arch = process.arch): Promise<string> {
  if (!(platform === "win32" && arch === "x64" || platform === "darwin" && ["x64", "arm64"].includes(arch))) throw new Error("BROWSER_DRIVER_PLATFORM_UNAVAILABLE");
  const root = join(resources, "browser-driver", BROWSER_DRIVER_VERSION);
  const file = join(root, `agent-browser-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`);
  try {
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    if (manifest?.version !== BROWSER_DRIVER_VERSION) throw new Error("BROWSER_DRIVER_VERSION_INVALID");
    if (createHash("sha256").update(await readFile(file)).digest("hex") !== manifest.hashes?.[`agent-browser-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`]) throw new Error("BROWSER_DRIVER_INTEGRITY_INVALID");
    await access(file); return file;
  } catch (error) {
    if (error instanceof Error && /^BROWSER_DRIVER_(VERSION|INTEGRITY)_INVALID$/.test(error.message)) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("BROWSER_DRIVER_MISSING");
    if (code === "EACCES" || code === "EPERM") throw new Error("BROWSER_DRIVER_ACCESS_DENIED");
    throw new Error("BROWSER_DRIVER_RESOURCE_INVALID");
  }
}

/** 设置只展示固定可操作原因，底层路径和异常正文不进入IPC。 */
export function browserDriverReason(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  switch (code) {
    case "BROWSER_DRIVER_PLATFORM_UNAVAILABLE": return "当前平台无内置驱动，请使用支持的平台。";
    case "BROWSER_DRIVER_MISSING": return "驱动资源缺失，请重新准备浏览器资源或重新安装 Desktop。";
    case "BROWSER_DRIVER_ACCESS_DENIED": return "驱动资源无法读取，请检查应用文件访问权限。";
    default: return "驱动资源损坏或版本不匹配，请重新准备浏览器资源或重新安装 Desktop。";
  }
}

/** 单次执行固定 argv；截图经 stdout 返回，不能让调用者写入任意文件。 */
export function browserDriverArgs(action: BrowserAction): string[] {
  if (!isBrowserAction(action)) throw new Error("BROWSER_ACTION_INVALID");
  switch (action.type) {
    case "snapshot": return ["snapshot", "-i"];
    case "screenshot": return ["screenshot"];
    case "click": return ["click", action.ref];
    case "fill": return ["fill", action.ref, action.value];
    case "press": return ["press", action.key];
    case "scroll": return ["scroll", action.direction, String(action.amount)];
    case "select-option": return ["select", action.ref, action.value];
    case "check": return [action.checked ? "check" : "uncheck", action.ref];
  }
}

/** 根据锁定版本 commands.rs 的公开 CLI 映射生成 native daemon 单动作请求。 */
export function browserDriverRequest(action: BrowserAction, id: string): Record<string, unknown> {
  browserDriverArgs(action);
  switch (action.type) {
    case "snapshot": return { id, action: "snapshot", interactive: true };
    case "screenshot": return { id, action: "screenshot", fullPage: false };
    case "click": return { id, action: "click", selector: action.ref };
    case "fill": return { id, action: "fill", selector: action.ref, value: action.value };
    case "press": return { id, action: "press", key: action.key };
    case "scroll": return { id, action: "scroll", direction: action.direction, amount: action.amount };
    case "select-option": return { id, action: "select", selector: action.ref, values: action.value };
    case "check": return { id, action: action.checked ? "check" : "uncheck", selector: action.ref };
  }
}

/** 每页直接拥有原生 daemon 子进程，避免上游 CLI 自动重试及 detached helper 泄漏。 */
export class BrowserDriver {
  private directory?: string;
  private session = randomUUID().slice(0, 12);
  private child?: ChildProcess;
  private stopped = false;
  private running = false;
  private stopping?: Promise<void>;
  constructor(private executable: string, private cdp: BrowserCdp) {}
  /** 直接启动锁定版本 daemon，地址仅从本次随机目录读取，不做默认端口回退。 */
  private async endpoint(signal: AbortSignal): Promise<string | { host: string; port: number }> {
    if (!this.child) {
      this.directory = await mkdtemp(join(tmpdir(), "ap-browser-"));
      const home = join(this.directory, "home");
      await mkdir(home, { mode: 0o700 });
      const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TMP: this.directory, TEMP: this.directory, AGENT_BROWSER_SOCKET_DIR: this.directory, AGENT_BROWSER_SESSION: this.session, AGENT_BROWSER_DAEMON: "1", AGENT_BROWSER_CDP: this.cdp.url, AGENT_BROWSER_NO_AUTO_DIALOG: "1" };
      this.child = spawn(this.executable, [], { env, cwd: this.directory, windowsHide: true, stdio: "ignore" });
      this.child.on("error", function ignore() {});
    }
    const file = join(this.directory!, this.session + (process.platform === "win32" ? ".port" : ".sock"));
    // 仅等待自有 daemon 就绪，不重发浏览器动作。
    for (let attempt = 0; attempt < 100; attempt++) {
      if (this.stopped || signal.aborted || this.child.exitCode !== null || !this.child.pid) throw new Error("BROWSER_DRIVER_UNAVAILABLE");
      try {
        if (process.platform !== "win32") { await access(file); return file; }
        const port = Number(await readFile(file, "utf8"));
        if (Number.isSafeInteger(port) && port > 0 && port < 65536) return { host: "127.0.0.1", port };
      } catch { /* 启动器尚未写入端点文件。 */ }
      await delay(50, undefined, { signal });
    }
    throw new Error("BROWSER_DRIVER_UNAVAILABLE");
  }
  /** 请求发送一次，失联/取消保守报告结果未知并收割本页 daemon。 */
  async execute(action: BrowserAction, signal: AbortSignal): Promise<unknown> {
    if (this.stopped || signal.aborted) throw new Error("BROWSER_CANCELLED");
    if (this.running) throw new Error("BROWSER_BUSY");
    const request = browserDriverRequest(action, randomUUID());
    this.running = true; this.cdp.setActive(true);
    try {
      const endpoint = await this.endpoint(signal);
      const screenshot = action.type === "screenshot" ? join(this.directory!, `${request.id}.png`) : undefined;
      if (screenshot) { request.path = screenshot; request.format = "png"; }
      const result = await new Promise(function exchange(resolve, reject) {
        const socket = typeof endpoint === "string" ? createConnection(endpoint) : createConnection(endpoint);
        let output = ""; let completed = false;
        /** 请求在途不重试，调用者负责停止旧执行。 */
        function abort() { socket.destroy(new Error("BROWSER_OUTCOME_UNKNOWN")); }
        socket.setTimeout(30000, abort);
        signal.addEventListener("abort", abort, { once: true });
        socket.on("connect", function send() { if (signal.aborted) abort(); else socket.write(JSON.stringify(request) + "\n"); });
        socket.on("data", function receive(chunk) {
          output += chunk.toString();
          if (Buffer.byteLength(output) > 8 * 1024 * 1024) { abort(); return; }
          if (!output.includes("\n")) return;
          try {
            const response = JSON.parse(output.slice(0, output.indexOf("\n")));
            if (response.id !== request.id || typeof response.success !== "boolean") throw new Error();
            completed = true; socket.end();
            if (!response.success) reject(new Error("BROWSER_DRIVER_FAILED")); else resolve(response.data);
          } catch { abort(); }
        });
        socket.on("error", function failed() { reject(new Error("BROWSER_OUTCOME_UNKNOWN")); });
        socket.on("close", function close() { signal.removeEventListener("abort", abort); if (!completed) reject(new Error("BROWSER_OUTCOME_UNKNOWN")); });
      });
      await this.cdp.idle();
      if (!screenshot) return result;
      try { return await browserScreenshot(screenshot); }
      finally { await unlink(screenshot); }
    } catch (error) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.stop(), new Promise<never>(function cleanupDeadline(_resolve, reject) { cleanupTimer = setTimeout(function expired() { reject(new Error("BROWSER_DRIVER_CLEANUP_FAILED")); }, 6500); })]);
      } catch { console.warn("AP browser cleanup", { code: "BROWSER_DRIVER_CLEANUP_FAILED", cdp: this.cdp.diagnostics() }); }
      finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
      throw error;
    }
    finally { this.cdp.setActive(false); this.running = false; }
  }
  /** 只终止本对象持有的子进程，确认退出后清理经过绝对路径校验的自有临时目录。 */
  stop(): Promise<void> {
    this.stopping ??= this.stopOwnedProcess();
    return this.stopping;
  }
  /** 并发取消共享同一收割任务，失败仍保留失败状态，不能误报已停止。 */
  private async stopOwnedProcess(): Promise<void> {
    this.stopped = true;
    let cdpFailure: unknown;
    try { await this.cdp.close(); } catch (error) { cdpFailure = error; }
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(function stop(resolve, reject) {
        const timer = setTimeout(function failed() { reject(new Error("BROWSER_DRIVER_STOP_FAILED")); }, 3000);
        child.once("close", function closed() { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
    if (this.directory) {
      const actual = await realpath(this.directory);
      const root = await realpath(tmpdir());
      if (actual === resolve(this.directory) && actual.startsWith(root + sep + "ap-browser-")) { await rm(actual, { recursive: true, force: true }); this.directory = undefined; }
    }
    if (cdpFailure) throw cdpFailure;
  }
}

/** Electron只捕获当前页视口；取消或超时后丢弃迟到图片，仍复用标准image块。 */
export async function captureBrowserScreenshot(capture: () => Promise<{ isEmpty(): boolean; getSize(): { width: number; height: number }; toPNG(): Buffer }>, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new Error("BROWSER_CANCELLED");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = function initial() {};
  try {
    const image = await Promise.race([capture(), new Promise<never>(function bounded(_resolve, reject) {
      cancel = function abort() { reject(new Error("BROWSER_CANCELLED")); };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      timer = setTimeout(function expired() { reject(new Error("BROWSER_SCREENSHOT_TIMEOUT")); }, 10_000);
    })]);
    signal.throwIfAborted();
    const size = image.getSize();
    if (image.isEmpty() || size.width * size.height > 16_000_000) throw new Error("BROWSER_SCREENSHOT_INVALID");
    const bytes = image.toPNG();
    if (bytes.length > 5 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("BROWSER_SCREENSHOT_INVALID");
    return { content: [{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }] };
  } finally { if (timer) clearTimeout(timer); signal.removeEventListener("abort", cancel); }
}
