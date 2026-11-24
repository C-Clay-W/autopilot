// 每页认证 CDP 代理只转发给创建时绑定的 debugger，不公开 Electron 全局调试端口。
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

export interface PageDebugger { attach(version: string): void; isAttached(): boolean; detach(): void; sendCommand(method: string, params?: object): Promise<unknown>; on(event: "message", listener: (event: unknown, method: string, params: unknown) => void): unknown; removeListener(event: "message", listener: (event: unknown, method: string, params: unknown) => void): unknown }

/** synthetic target/session 固定到单一网页，所有外来目标和浏览器级破坏命令拒绝。 */
export class BrowserCdp {
  private server?: Server;
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  private secret = randomBytes(32).toString("hex");
  private active = false;
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private timings: Array<{ method: string; startedAt: number; elapsedMs: number; outcome: "pending" | "ok" | "failed" }> = [];
  private listener: (event: unknown, method: string, params: unknown) => void;
  url = "";
  /** 事件只向本页已认证连接发送，不暴露宿主对象。 */
  constructor(private target: PageDebugger, private pageId: string, private info: () => { url: string; title: string }) {
    const self = this;
    this.listener = function message(_event, method, params) { for (const socket of self.sockets.clients) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ method, params, sessionId: self.pageId })); };
  }
  /** 随机 loopback 端口加随机路径鉴权，拒绝来自网页的 Origin。 */
  async start(): Promise<void> {
    if (this.closed) throw new Error("BROWSER_CDP_DENIED");
    if (!this.target.isAttached()) this.target.attach("1.3");
    this.target.on("message", this.listener);
    const self = this;
    this.server = createServer(function deny(_request, response) { response.writeHead(404); response.end(); });
    this.server.on("upgrade", function upgrade(request, socket, head) {
      if (self.closed || request.headers.origin || request.url !== `/${self.secret}`) { socket.destroy(); return; }
      self.sockets.handleUpgrade(request, socket, head, function connected(client) {
        client.on("error", function ignore() {});
        client.on("message", function receive(data) {
          let frame: { id?: unknown; method?: unknown; params?: unknown; sessionId?: unknown };
          try { frame = JSON.parse(data.toString()); } catch { client.close(); return; }
          if (!Number.isSafeInteger(frame.id) || typeof frame.method !== "string" || frame.params !== undefined && (!frame.params || typeof frame.params !== "object" || Array.isArray(frame.params))) { client.close(); return; }
          const task = self.dispatch(frame.method, (frame.params ?? {}) as Record<string, unknown>, frame.sessionId).then(function result(result) { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id: frame.id, result })); }, function denied() { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id: frame.id, error: { code: -32000, message: "BROWSER_CDP_DENIED" } })); });
          self.pending.add(task); void task.finally(function done() { self.pending.delete(task); });
        });
      });
    });
    await new Promise<void>(function listen(resolve, reject) { self.server!.once("error", reject); self.server!.listen(0, "127.0.0.1", function ready() { self.server!.removeListener("error", reject); if (self.closed) { self.server!.close(); reject(new Error("BROWSER_CDP_DENIED")); } else resolve(); }); });
    this.url = `ws://127.0.0.1:${(this.server.address() as { port: number }).port}/${this.secret}`;
  }
  /** 只有当前宿主动作可使用转发通道；关闭后旧能力不能复活。 */
  setActive(active: boolean): void { if (!this.closed) this.active = active; }
  /** 先拒绝新转发，再等候已提交命令；超时不能声称页面已安全交接。 */
  async idle(): Promise<void> {
    this.active = false;
    if (!this.pending.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all([...this.pending]), new Promise<never>(function deadline(_resolve, reject) { timer = setTimeout(function expired() { reject(new Error("BROWSER_CDP_OUTCOME_UNKNOWN")); }, 3000); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  /** Target 方法本地模拟，网页域只在动作执行期间向绑定 debugger 转发。 */
  async dispatch(method: string, params: Record<string, unknown>, sessionId?: unknown): Promise<unknown> {
    if (this.closed || !this.active || sessionId !== undefined && sessionId !== this.pageId) throw new Error("BROWSER_CDP_DENIED");
    const info = { targetId: this.pageId, type: "page", ...this.info(), attached: true, canAccessOpener: false };
    if (method === "Target.getTargets") return { targetInfos: [info] };
    if (method === "Target.getTargetInfo") { if (params.targetId !== undefined && params.targetId !== this.pageId) throw new Error("BROWSER_CDP_DENIED"); return { targetInfo: info }; }
    if (method === "Target.attachToTarget") { if (params.targetId !== this.pageId) throw new Error("BROWSER_CDP_DENIED"); return { sessionId: this.pageId }; }
    if (["Target.setDiscoverTargets", "Target.setAutoAttach", "Target.detachFromTarget"].includes(method)) { if (params.sessionId !== undefined && params.sessionId !== this.pageId) throw new Error("BROWSER_CDP_DENIED"); return {}; }
    if (method === "Browser.getVersion") return { protocolVersion: "1.3", product: `Chrome/${process.versions.chrome ?? "145.0.0.0"}`, userAgent: "", jsVersion: "" };
    if (method === "Browser.setDownloadBehavior") return {};
    if (!/^(?:Page|Runtime|DOM|DOMSnapshot|Accessibility|Input|Network|Emulation|Log|Performance)\./.test(method) || ["Page.close", "Page.navigate", "Page.navigateToHistoryEntry", "Page.reload", "Page.crash", "Page.addScriptToEvaluateOnNewDocument", "DOM.setFileInputFiles", "Network.setCookie", "Network.setCookies", "Network.clearBrowserCookies", "Network.clearBrowserCache"].includes(method)) throw new Error("BROWSER_CDP_DENIED");
    const entry = { method: /^[A-Za-z]+\.[A-Za-z]+$/.test(method) ? method : "invalid", startedAt: Date.now(), elapsedMs: 0, outcome: "pending" as "pending" | "ok" | "failed" };
    this.timings.push(entry); if (this.timings.length > 16) this.timings.shift();
    const started = Date.now();
    try { const result = await this.target.sendCommand(method, params); entry.outcome = "ok"; return result; }
    catch (error) { entry.outcome = "failed"; throw error; }
    finally { entry.elapsedMs = Date.now() - started; }
  }
  /** 最近方法不含参数、地址或正文，仅用于错误收尾诊断。 */
  diagnostics(): Array<{ method: string; elapsedMs: number; outcome: string }> { return this.timings.map(function copy(item) { return { method: item.method, elapsedMs: item.outcome === "pending" ? Date.now() - item.startedAt : item.elapsedMs, outcome: item.outcome }; }); }
  /** 先撤销转发并断开连接，销毁页面由宿主负责，不关闭其他网页或主窗口。 */
  close(): Promise<void> { this.closing ??= this.closeOwned(); return this.closing; }
  /** 并发关闭共享结果，未收割的命令不能被第二次关闭误报成功。 */
  private async closeOwned(): Promise<void> {
    this.closed = true; this.active = false;
    for (const socket of this.sockets.clients) socket.terminate();
    this.sockets.close();
    this.target.removeListener("message", this.listener);
    if (this.server?.listening) { const server = this.server; await new Promise<void>(function close(resolve) { server.close(function closed() { resolve(); }); }); }
    await this.idle();
    this.url = "";
  }
}
