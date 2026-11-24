// AP CLI的固定浏览器入口直接连接受管宿主，不创建Provider或独立浏览器。
import { request as httpRequest, type ClientRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { parseBrowserOperation, type BrowserCapability, type BrowserOperation } from "@autopilot-agent/core";

const browserErrorCodes = new Set<string>([
  "BROWSER_ACTION_INVALID", "BROWSER_AGENT_INVALID", "BROWSER_AUTH_REQUIRED", "BROWSER_BUSY",
  "BROWSER_CALLER_DISCONNECTED", "BROWSER_CALL_INVALID", "BROWSER_CALL_REPLAY", "BROWSER_CALL_REQUIRED",
  "BROWSER_CANCELLED", "BROWSER_CDP_DENIED", "BROWSER_CDP_OUTCOME_UNKNOWN", "BROWSER_DENIED",
  "BROWSER_DESKTOP_REQUIRED", "BROWSER_DIALOG_UNAVAILABLE", "BROWSER_DOCUMENT_CHANGED", "BROWSER_DOCUMENT_PATH_INVALID",
  "BROWSER_DOCUMENT_TIMEOUT", "BROWSER_DOCUMENT_TOO_LARGE", "BROWSER_DOCUMENT_UNAVAILABLE", "BROWSER_DOCUMENT_UNSUPPORTED",
  "BROWSER_DOWNLOAD_UNAVAILABLE", "BROWSER_DRIVER_ACCESS_DENIED", "BROWSER_DRIVER_CLEANUP_FAILED", "BROWSER_DRIVER_FAILED",
  "BROWSER_DRIVER_INTEGRITY_INVALID", "BROWSER_DRIVER_MISSING", "BROWSER_DRIVER_PLATFORM_UNAVAILABLE", "BROWSER_DRIVER_RESOURCE_INVALID",
  "BROWSER_DRIVER_STOP_FAILED", "BROWSER_DRIVER_UNAVAILABLE", "BROWSER_DRIVER_VERSION_INVALID", "BROWSER_ENDPOINT_INVALID",
  "BROWSER_FILE_URL_USE_DOCUMENT", "BROWSER_MAIN_SESSION_REQUIRED", "BROWSER_MANAGED_CLI_REQUIRED", "BROWSER_NATIVE_BINDING_FAILED",
  "BROWSER_NATIVE_SHELL_UNSUPPORTED", "BROWSER_NATIVE_TOOL_BINDING_REQUIRED", "BROWSER_NATIVE_TURN_REQUIRED", "BROWSER_OUTCOME_UNKNOWN",
  "BROWSER_PAGE_CHANGED", "BROWSER_PAGE_INITIALIZING", "BROWSER_PAGE_INIT_TIMEOUT", "BROWSER_PAGE_UNAVAILABLE",
  "BROWSER_PERMIT_INVALID", "BROWSER_PREFERENCES_INVALID", "BROWSER_REQUEST_FAILED", "BROWSER_REQUEST_INVALID",
  "BROWSER_RESPONSE_INVALID", "BROWSER_RESULT_TOO_LARGE", "BROWSER_ROUTE_INVALID", "BROWSER_SCREENSHOT_INVALID",
  "BROWSER_SCREENSHOT_TIMEOUT", "BROWSER_SESSION_INVALID", "BROWSER_SKILL_CHANGED", "BROWSER_SKILL_CUSTOM_OR_UNAVAILABLE",
  "BROWSER_TURN_ENDED", "BROWSER_TURN_INVALID", "BROWSER_TURN_UNAVAILABLE", "BROWSER_UNAVAILABLE",
  "BROWSER_URL_INVALID", "BROWSER_USER_TURN_UNAVAILABLE", "BROWSER_WATCH_EXISTS", "BROWSER_WORKSPACE_ROOT_REQUIRED",
]);

/** 仅保留源码定义的完整固定码，拒绝任意前缀正文、路径和伪造扩展码。 */
export function getBrowserErrorCode(value: unknown): string | undefined {
  try {
    const code = value instanceof Error ? value.message : value;
    return typeof code === "string" && browserErrorCodes.has(code) ? code : undefined;
  } catch { return undefined; }
}

/** 只接受Desktop随机loopback HTTP地址，不读取任意网络配置。 */
function endpoint(value: string | undefined): string {
  if (!value) throw new Error("BROWSER_DESKTOP_REQUIRED");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("BROWSER_ENDPOINT_INVALID"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("BROWSER_ENDPOINT_INVALID");
  return url.origin;
}

/** 单次HTTP请求不重试；取消或失联不能冒充动作未执行。 */
export function browserRequest(address: string, token: string, path: string, value: unknown, signal?: AbortSignal): Promise<unknown> {
  return new Promise(function send(resolve, reject) {
    const request = httpRequest(endpoint(address) + path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal }, function response(response) {
      let output = "";
      response.on("data", function data(chunk) { output += chunk.toString(); if (Buffer.byteLength(output) > 8 * 1024 * 1024) request.destroy(new Error("BROWSER_RESULT_TOO_LARGE")); });
      response.on("end", function end() {
        let result;
        try { result = JSON.parse(output); } catch { reject(new Error("BROWSER_RESPONSE_INVALID")); return; }
        if (!result || result.ok !== true) { reject(new Error(getBrowserErrorCode(result?.error) || (result?.error === "有其他智能体正在操控，请等待后再试" ? "BROWSER_BUSY" : "BROWSER_REQUEST_FAILED"))); return; }
        resolve(result.result);
      });
      response.on("error", function failed() { reject(new Error(signal?.aborted ? "BROWSER_CANCELLED" : "BROWSER_OUTCOME_UNKNOWN")); });
    });
    request.on("error", function failed(error) { reject(new Error(signal?.aborted ? "BROWSER_CANCELLED" : getBrowserErrorCode(error) || "BROWSER_OUTCOME_UNKNOWN")); });
    request.setTimeout(600_000, function expired() { request.destroy(new Error("BROWSER_OUTCOME_UNKNOWN")); });
    request.end(JSON.stringify(value));
  });
}

/** 原生连接持有无业务流量的进程监视通道，进程退出时宿主立即撤销回合。 */
export function createDesktopBrowserCapability(env: NodeJS.ProcessEnv = process.env): BrowserCapability | undefined {
  if (!env.AUTOPILOT_BROWSER_ENDPOINT || !env.AUTOPILOT_BROWSER_NATIVE_TOKEN) return undefined;
  const address = endpoint(env.AUTOPILOT_BROWSER_ENDPOINT);
  const initialToken = env.AUTOPILOT_BROWSER_NATIVE_TOKEN;
  const runId = randomUUID();
  let connection: Promise<string> | undefined;
  let watch: ClientRequest | undefined;
  const turns = new Set<string>();
  /** 本进程只登记一次，断开不自动重建已丢失的许可。 */
  async function connect(): Promise<string> {
    const registered = await browserRequest(address, initialToken, "/connect-native", { runId }) as { token: string };
    await new Promise<void>(function monitor(resolve, reject) {
      watch = httpRequest(address + "/watch", { method: "POST", headers: { Authorization: `Bearer ${registered.token}`, "Content-Type": "application/json" } }, function ready(response) {
        if (response.statusCode !== 200) { response.resume(); reject(new Error("BROWSER_AUTH_REQUIRED")); return; }
        response.resume(); response.socket?.unref(); resolve();
      });
      watch.on("error", function failed() { reject(new Error("BROWSER_UNAVAILABLE")); }); watch.end("{}");
    });
    return registered.token;
  }
  return {
    confirmsDocument: true,
    managesApprovals: true,
    /** Core可信绑定作为原生回合登记；命令行browser入口不能调用该路径。 */
    async request(binding, callId, operation, signal, authorization) {
      connection ??= connect(); const token = await connection;
      const turnId = `${binding.sessionId}:${binding.turnId}`;
      if (!turns.has(turnId)) { await browserRequest(address, token, "/turn/begin", { turnId, sessionId: binding.sessionId }, signal); turns.add(turnId); }
      return browserRequest(address, token, "/request", { turnId, callId, operation, authorization }, signal);
    },
    /** 真实终态等待宿主撤销；失联时关闭监视通道使宿主fail-closed。 */
    async endTurn(binding) {
      const turnId = `${binding.sessionId}:${binding.turnId}`;
      if (!connection || !turns.has(turnId)) return;
      try { await browserRequest(address, await connection, "/turn/end", { turnId }); turns.delete(turnId); }
      catch (error) { watch?.destroy(); throw error; }
    },
  };
}

/** 固定命令组：动作名与单个JSON对象，许可只由原生工具适配器注入。 */
export function parseBrowserArgs(args: readonly string[]): { operation: BrowserOperation; permit?: string } {
  if (args.length !== 2 && args.length !== 4 || args.length === 4 && (args[2] !== "--permit" || !/^[a-f0-9]{64}$/.test(args[3]))) throw new Error("浏览器用法：ap browser <动作> '<JSON参数>'");
  let input;
  try { input = JSON.parse(args[1]); } catch { throw new Error("BROWSER_ACTION_INVALID"); }
  if (!input || typeof input !== "object" || Array.isArray(input) || "type" in input) throw new Error("BROWSER_ACTION_INVALID");
  return { operation: parseBrowserOperation({ type: args[0], ...input }), ...(args[3] ? { permit: args[3] } : {}) };
}

/** 第三方命令只能消费单次许可，不接受自报身份/回合或native凭据。 */
export async function executeBrowserCommand(operation: BrowserOperation, permit: string | undefined, signal?: AbortSignal): Promise<unknown> {
  if (!permit || !process.env.AUTOPILOT_BROWSER_CALLER_TOKEN) throw new Error("BROWSER_NATIVE_TOOL_BINDING_REQUIRED");
  return browserRequest(endpoint(process.env.AUTOPILOT_BROWSER_ENDPOINT), process.env.AUTOPILOT_BROWSER_CALLER_TOKEN, "/call", { permit, operation }, signal);
}
