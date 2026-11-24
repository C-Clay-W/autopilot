// loopback HTTP 只承载固定浏览器契约；身份由PTY登记，原生与第三方凭据分离。
import { createServer, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { parseBrowserOperation } from "@autopilot-agent/core";
import type { BrowserOperation } from "@autopilot-agent/core";
import { BrowserAccess, readBrowserAuthorization, type BrowserPrincipal } from "./browser-access";

interface Pane { id: string; generation: number; workspace: string; workspaceRoot: string; desktopWorkspaceId?: string; native: string; agent: string }
interface Caller { pane: Pane; principal: BrowserPrincipal; token: string; runId: string; watched: boolean; turns: Set<string>; owners: Map<string, BrowserPrincipal>; ended: Set<string>; calls: Set<string>; watch?: ServerResponse }
interface Permit { caller: Caller; turnId: string; callId: string; operation: BrowserOperation; used: boolean; abort?: AbortController }

/** 请求只有一次执行机会，连接断开取消对应动作；不提供重试、全局CDP或自报AP参数。 */
export class BrowserServer {
  private server?: Server;
  private panes = new Map<string, Pane>();
  private callers = new Map<string, Caller>();
  private permits = new Map<string, Permit>();
  endpoint = "";
  constructor(private access: BrowserAccess) {}
  /** 每次PTY代次创建不同凭据，普通browser命令只使用第三方单调用许可。 */
  register(id: string, generation: number, workspace: string, workspaceRoot = workspace, desktopWorkspaceId?: string): Record<string, string> {
    this.release(id);
    const pane = { id, generation, workspace, workspaceRoot, desktopWorkspaceId, native: randomBytes(32).toString("hex"), agent: randomBytes(32).toString("hex") };
    this.panes.set(id, pane);
    return { AUTOPILOT_BROWSER_ENDPOINT: this.endpoint, AUTOPILOT_BROWSER_NATIVE_TOKEN: pane.native, AUTOPILOT_BROWSER_AGENT_TOKEN: pane.agent };
  }
  /** PTY退出立即撤销该代次全部调用者，不影响其他工作区。 */
  release(id: string, generation?: number): void {
    const pane = this.panes.get(id);
    if (!pane || generation !== undefined && pane.generation !== generation) return;
    this.panes.delete(id);
    for (const caller of this.callers.values()) if (caller.pane === pane) void this.disconnect(caller).catch(function failed() { console.error("Browser caller cleanup failed"); });
  }
  /** 进程监视连接关闭即撤销其全部回合，未知结果由网页宿主保持暂停。 */
  private async disconnect(caller: Caller): Promise<void> {
    this.callers.delete(caller.token); caller.watched = false; caller.watch?.end();
    for (const [token, permit] of this.permits) if (permit.caller === caller) { permit.abort?.abort(); this.permits.delete(token); }
    await Promise.all([...caller.turns].map(function end(this: BrowserServer, turn: string) { return this.access.end(caller.owners.get(turn)?.id ?? caller.principal.id, turn); }.bind(this)));
    caller.turns.clear();
  }
  /** 只在随机loopback端口监听，拒绝Origin/非固定路由/超长请求。 */
  async start(): Promise<void> {
    const self = this;
    this.server = createServer(function request(request, response) {
      if (request.headers.origin || request.method !== "POST") { response.writeHead(403); response.end(); return; }
      let input = "";
      request.on("data", function data(chunk) { input += chunk.toString(); if (Buffer.byteLength(input) > 65536) request.destroy(); });
      request.on("end", async function complete() {
        const abort = new AbortController();
        response.on("close", function closed() { if (!response.writableEnded) abort.abort(); });
        try {
          const token = request.headers.authorization?.replace(/^Bearer /, "");
          if (!token) throw new Error("BROWSER_AUTH_REQUIRED");
          let value;
          try { value = JSON.parse(input || "{}"); } catch { throw new Error("BROWSER_REQUEST_INVALID"); }
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BROWSER_REQUEST_INVALID");
          const result = await self.route(request.url ?? "", token, value, response, abort.signal);
          if (request.url === "/watch") return;
          if (!response.destroyed) { response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify({ ok: true, result })); }
        } catch (error) {
          if (!response.destroyed) { response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ ok: false, error: error instanceof Error && /^(?:BROWSER_[A-Z0-9_]{1,96}|有其他智能体正在操控，请等待后再试)$/.test(error.message) ? error.message : "BROWSER_REQUEST_FAILED" })); }
        }
      });
    });
    await new Promise<void>(function listen(resolve, reject) { self.server!.once("error", reject); self.server!.listen(0, "127.0.0.1", function ready() { self.server!.removeListener("error", reject); resolve(); }); });
    this.endpoint = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  /** 路由身份来自已登记凭据，调用参数不能切换native/third-party身份。 */
  private async route(path: string, token: string, value: Record<string, unknown>, response: ServerResponse, signal: AbortSignal): Promise<unknown> {
    if (path === "/connect-native" || path === "/connect-agent") {
      const native = path === "/connect-native";
      const pane = [...this.panes.values()].find(function matches(pane) { return (native ? pane.native : pane.agent) === token; });
      if (!pane || typeof value.runId !== "string" || !/^[\w-]{1,128}$/.test(value.runId)) throw new Error("BROWSER_AUTH_REQUIRED");
      if (!native && !["codex", "claude", "codebuddy", "opencode"].includes(value.agent as string)) throw new Error("BROWSER_AGENT_INVALID");
      const previous = [...this.callers.values()].find(function same(caller) { return caller.pane === pane && caller.runId === value.runId && caller.principal.kind === (native ? "ap" : "third-party"); });
      if (previous) return { token: previous.token };
      const callerToken = randomBytes(32).toString("hex");
      this.callers.set(callerToken, { pane, token: callerToken, runId: value.runId, watched: false, turns: new Set(), owners: new Map(), ended: new Set(), calls: new Set(), principal: { id: randomUUID(), kind: native ? "ap" : "third-party", label: native ? "Autopilot" : String(value.agent), workspace: pane.workspace, workspaceRoot: pane.workspaceRoot, desktopWorkspaceId: pane.desktopWorkspaceId } });
      return { token: callerToken };
    }
    const caller = this.callers.get(token);
    if (!caller || this.panes.get(caller.pane.id) !== caller.pane) throw new Error("BROWSER_AUTH_REQUIRED");
    if (path === "/watch") {
      if (caller.watched) throw new Error("BROWSER_WATCH_EXISTS");
      caller.watched = true; caller.watch = response;
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" }); response.write("data: ready\n\n");
      const self = this; response.once("close", function disconnected() { void self.disconnect(caller).catch(function failed() { console.error("Browser caller cleanup failed"); }); }); return;
    }
    if (!caller.watched) throw new Error("BROWSER_CALLER_DISCONNECTED");
    if (path === "/call") {
      const permit = typeof value.permit === "string" ? this.permits.get(value.permit) : undefined;
      if (!permit || permit.used || permit.caller !== caller) throw new Error("BROWSER_PERMIT_INVALID");
    }
    const turnId = path === "/call" && typeof value.permit === "string" ? this.permits.get(value.permit)?.turnId : value.turnId;
    if (typeof turnId !== "string" || !/^[\w:.-]{1,256}$/.test(turnId)) throw new Error("BROWSER_TURN_INVALID");
    let principal = caller.owners.get(turnId) ?? caller.principal;
    if ((path === "/turn/begin" || path === "/turn/replace") && caller.principal.kind === "ap") {
      if (typeof value.sessionId !== "string" || !/^[\w.-]{1,128}$/.test(value.sessionId) || !turnId.startsWith(value.sessionId + ":")) throw new Error("BROWSER_SESSION_INVALID");
      principal = { ...caller.principal, id: caller.principal.id + ":" + value.sessionId };
    }
    if (path === "/turn/begin") { if (caller.ended.has(turnId)) throw new Error("BROWSER_TURN_ENDED"); this.access.begin(principal, turnId); caller.owners.set(turnId, principal); caller.turns.add(turnId); return {}; }
    if (path === "/turn/suspend") {
      for (const [id, permit] of this.permits) if (permit.caller === caller && permit.turnId === turnId) { permit.abort?.abort(); this.permits.delete(id); }
      await this.access.suspend(principal.id, turnId); return {};
    }
    if (path === "/turn/replace") {
      if (caller.ended.has(turnId)) throw new Error("BROWSER_TURN_ENDED");
      for (const previous of caller.turns) if (previous !== turnId) { caller.ended.add(previous); await this.access.end(caller.owners.get(previous)?.id ?? caller.principal.id, previous); caller.turns.delete(previous); }
      for (const [id, permit] of this.permits) if (permit.caller === caller && permit.turnId !== turnId) { permit.abort?.abort(); this.permits.delete(id); }
      this.access.begin(principal, turnId); caller.owners.set(turnId, principal); caller.turns.add(turnId); return {};
    }
    if (path === "/turn/end") {
      caller.ended.add(turnId);
      for (const [id, permit] of this.permits) if (permit.caller === caller && permit.turnId === turnId) { permit.abort?.abort(); this.permits.delete(id); }
      await this.access.end(principal.id, turnId); caller.turns.delete(turnId); return {};
    }
    if (!caller.turns.has(turnId)) throw new Error("BROWSER_TURN_UNAVAILABLE");
    if (path === "/permit/revoke") { for (const [id, permit] of this.permits) if (permit.caller === caller && permit.turnId === turnId && permit.callId === value.callId) { permit.abort?.abort(); this.permits.delete(id); } return {}; }
    if (path === "/permit") {
      if (caller.principal.kind !== "third-party" || typeof value.callId !== "string" || !value.callId || value.callId.length > 256) throw new Error("BROWSER_CALL_INVALID");
      const operation = parseBrowserOperation(value.operation);
      const call = JSON.stringify([turnId, value.callId]);
      if (caller.calls.has(call)) throw new Error("BROWSER_CALL_REPLAY");
      caller.calls.add(call);
      const permit = randomBytes(32).toString("hex");
      this.permits.set(permit, { caller, turnId, callId: value.callId, operation, used: false }); return { permit };
    }
    const operation = parseBrowserOperation(value.operation);
    if (path === "/request") {
      if (caller.principal.kind !== "ap" || typeof value.callId !== "string" || !value.callId) throw new Error("BROWSER_CALL_INVALID");
      const call = JSON.stringify([turnId, value.callId]);
      if (caller.calls.has(call)) throw new Error("BROWSER_CALL_REPLAY");
      caller.calls.add(call);
    } else if (path === "/call") {
      const permit = typeof value.permit === "string" ? this.permits.get(value.permit) : undefined;
      if (!permit || permit.used || permit.caller !== caller || permit.turnId !== turnId || JSON.stringify(operation) !== JSON.stringify(permit.operation)) throw new Error("BROWSER_PERMIT_INVALID");
      permit.used = true;
      const abort = new AbortController(); permit.abort = abort;
      /** 请求连接或原生工具生命周期任一取消都撤销这一许可的在途动作。 */
      function cancel() { abort.abort(); }
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      try { return await this.access.request(principal.id, turnId, operation, abort.signal); }
      finally { signal.removeEventListener("abort", cancel); permit.abort = undefined; }
    } else throw new Error("BROWSER_ROUTE_INVALID");
    return this.access.request(principal.id, turnId, operation, signal, readBrowserAuthorization(value.authorization));
  }
  /** 退出只回收本服务资源，不触碰任何外部CLI安装。 */
  async stop(): Promise<void> {
    this.panes.clear(); await Promise.all([...this.callers.values()].map(function close(this: BrowserServer, caller: Caller) { return this.disconnect(caller); }.bind(this)));
    if (this.server) { const server = this.server; await new Promise<void>(function closed(resolve) { server.close(function done() { resolve(); }); server.closeAllConnections(); }); }
    this.endpoint = "";
  }
}
