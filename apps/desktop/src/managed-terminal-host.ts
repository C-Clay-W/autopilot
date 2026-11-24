/** 真实 PTY 承载 AP 受管终端薄客户端；认证 socket 只能操作宿主绑定的会话。 */
import { createServer, type Server, type Socket } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { OutputBuffer, preparePtyResize, stopPty } from "./terminal-host";
import type { Pane } from "./workspace";
interface Client { binding: TerminalBinding; pty: IPty; output: OutputBuffer; generation: number; exited: boolean; server: Server; sockets: Set<Socket>; termination: Promise<void>; resizePipe?: string }
interface TerminalBinding { viewId: string; runId?: string; sessionId?: string; target?: ManagedExecutorTarget; readonly revoked: boolean; readonly attached: boolean; readonly showingTrust: boolean; ready: Promise<boolean>; runReady: Promise<boolean>; revoke(): void }
export interface ManagedCloseTarget { id: string; viewId: string; sessionId?: string }
export interface ManagedExecutorTarget { runId: string; assignmentId: string; sessionId: string }
export interface ManagedTerminalFrame {
  operation: string; text?: string; requestId?: string; cursor?: string; turnId?: string; executionToken?: string; questionId?: string;
  action?: import("@autopilot-agent/cli/dist/types.js").CliAction;
}
/** 终端重开只重建客户端；Runtime 和 Run 始终由原宿主管理。 */
export class ManagedTerminalHost {
  private clients = new Map<string, Client>();
  private opening = new Map<string, Promise<Pane>>();
  private switching = new Map<string, Promise<void>>();
  private connections = new Map<string, TerminalBinding>();
  private closing = new Map<string, Promise<boolean>>();
  private closeRequests = new Map<string, Promise<boolean>>();
  private detaching = new Map<string, Promise<void>>();
  constructor(private launch: (env: Record<string, string>) => Promise<IPty>, private request: (workspaceId: string, frame: ManagedTerminalFrame, runId?: string, target?: ManagedExecutorTarget, isCurrent?: () => boolean) => Promise<unknown>,
    private lifecycle?: { selected(workspaceId: string): Promise<string | undefined>; executor?(workspaceId: string, runId: string, assignmentId: string): Promise<ManagedExecutorTarget>; prepareClose?(workspaceId: string, runId: string, targets: ManagedCloseTarget[], remaining: () => boolean, isCurrent: () => boolean, lastRecorded: () => void): Promise<false | "inactive" | "active">; ready(workspaceId: string, runId: string): void; closed(workspaceId: string): void }) {}

  /** 撤销旧输入、切换导航与允许新 attach 共用同一个工作区边界。 */
  switchRun(workspaceId: string, change: () => Promise<void>): Promise<void> {
    const host = this;
    const next = (this.switching.get(workspaceId) ?? Promise.resolve()).catch(function previousFailed() {}).then(async function switchSelection() {
      await host.reset(workspaceId);
      await change();
    }).finally(function done() { if (host.switching.get(workspaceId) === next) host.switching.delete(workspaceId); });
    this.switching.set(workspaceId, next);
    for (const [key, binding] of this.connections) if (key === workspaceId || key.startsWith(workspaceId + ":")) binding.revoke();
    return next;
  }
  /** 切换 Run 时仅撤销旧客户端能力与投影，不停止任何受管执行。 */
  async reset(workspaceId: string): Promise<void> {
    const keys = new Set([...this.clients.keys(), ...this.opening.keys()]);
    await Promise.all(Array.from(keys).filter(function owned(key) { return key === workspaceId || key.startsWith(workspaceId + ":"); }).map(this.resetClient.bind(this)));
  }
  /** 整批核对当前绑定，经预检后同步撤销该批薄客户端。 */
  closeViews(workspaceId: string, runId: string, ids: string[]): Promise<boolean> {
    const host = this;
    const signature = JSON.stringify([workspaceId, runId, [...ids].sort()]);
    const duplicate = this.closeRequests.get(signature);
    if (duplicate) return duplicate;
    const targets = ids.map(function capture(id) {
      const key = id === "controller" ? workspaceId : workspaceId + ":" + id;
      const binding = host.connections.get(key);
      return { id, key, binding, revoked: binding?.revoked, sessionId: binding?.target?.sessionId ?? binding?.sessionId, client: host.clients.get(key) };
    });
    const closingKeys = new Set(targets.map(function location(target) { return target.key; }));
    /** 核对原位置及连接对象，旧操作不能关闭已替换的客户端。 */
    function isCurrent() {
      return !host.switching.has(workspaceId) && targets.every(function exact(target) {
        return target.binding?.runId === runId && target.binding === host.connections.get(target.key) && target.revoked === target.binding.revoked && target.client === host.clients.get(target.key)
          && !host.opening.has(target.key) && !host.detaching.has(target.key);
      });
    }
    /** 统计本 Run 关闭批次之外已认证且 PTY 仍存活的主控和分屏。 */
    function remaining() {
      return [...host.connections].some(function open([key, binding]) {
        if (closingKeys.has(key) || (key !== workspaceId && !key.startsWith(workspaceId + ":"))) return false;
        return binding.runId === runId && !binding.revoked && binding.attached && !host.opening.has(key) && host.clients.get(key)?.exited === false;
      });
    }
    const next = (this.closing.get(workspaceId) ?? Promise.resolve()).catch(function previousFailed() {}).then(async function closeBatch() {
      if (!isCurrent() || !host.lifecycle?.prepareClose) throw new Error("ORCHESTRATION_VIEW_CLOSE_STALE");
      let lastRecorded = false;
      const prepared = await host.lifecycle.prepareClose(workspaceId, runId, targets.map(function identity({ id, sessionId, binding }) { return { id, sessionId, viewId: binding!.viewId }; }), remaining, isCurrent, function recorded() { lastRecorded = true; });
      if (!prepared) return false;
      if (!isCurrent()) throw new Error("ORCHESTRATION_VIEW_CLOSE_STALE");
      if (!remaining()) {
        if (prepared === "active") throw new Error("ORCHESTRATION_LAST_ACTIVE_TERMINAL");
        if (!lastRecorded) throw new Error("ORCHESTRATION_VIEW_CLOSE_STALE");
      }
      for (const target of targets) {
        target.binding?.revoke();
        if (!target.client) continue;
        const cleanup = host.disconnectClient(target.client).catch(function cleanupFailed() { /* 再次挂载时仍会回收同代客户端。 */ }).finally(function forget() { host.detaching.delete(target.key); });
        host.detaching.set(target.key, cleanup);
      }
      return true;
    }).finally(function finished() {
      host.closeRequests.delete(signature);
      if (host.closing.get(workspaceId) === next) host.closing.delete(workspaceId);
    });
    this.closeRequests.set(signature, next);
    this.closing.set(workspaceId, next);
    return next;
  }
  /** 关闭单个薄客户端，保留其持久执行及下一代编号。 */
  private async resetClient(key: string): Promise<void> {
    const detaching = this.detaching.get(key);
    if (detaching) await detaching;
    this.connections.get(key)?.revoke();
    await this.opening.get(key)?.catch(function failedBeforeAttach() { /* 旧客户端启动失败也允许继续切换。 */ });
    const client = this.clients.get(key); if (!client) return;
    this.connections.get(key)?.revoke();
    await this.disconnectClient(client);
  }
  /** 回收捕获的本代客户端，不再按位置重新解析。 */
  private async disconnectClient(client: Client): Promise<void> {
    client.server.close(); for (const socket of client.sockets) socket.destroy();
    if (!client.exited) {
      // 先让失去 socket 的 Ink 客户端自行退出，再回收尚存的本代进程树。
      await this.awaitExit(client);
      if (!client.exited) {
        try { await stopPty(client); }
        catch (error) { await this.awaitExit(client); if (!client.exited) throw error; }
      }
    }
  }
  /** 通过已启动客户端自己的退出事件判断，覆盖 taskkill 与自然退出竞态。 */
  private async awaitExit(client: Client): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([client.termination, new Promise<void>(function delay(resolve) { timer = setTimeout(resolve, 250); })]); }
    finally { clearTimeout(timer); }
  }
  /** 同一目标的并发挂载合并，执行者身份只能由宿主从所选 Run 解析。 */
  async ensure(workspaceId: string, runId?: string, assignmentId?: string): Promise<Pane> {
    const switching = this.switching.get(workspaceId);
    const host = this;
    if (switching) return switching.then(function attach() { return host.ensure(workspaceId, runId, assignmentId); });
    const target = assignmentId && runId ? await this.lifecycle?.executor?.(workspaceId, runId, assignmentId) : undefined;
    if (assignmentId && !target) throw new Error("ORCHESTRATION_EXECUTION_MISMATCH");
    if (this.switching.has(workspaceId)) throw new Error("MANAGED_TERMINAL_STALE");
    const key = target ? workspaceId + ":" + target.assignmentId : workspaceId;
    const detaching = this.detaching.get(key);
    if (detaching) return detaching.then(function attach() { return host.ensure(workspaceId, runId, assignmentId); });
    const pending = this.opening.get(key);
    if (pending) {
      await pending;
      return this.ensure(workspaceId, runId, assignmentId);
    }
    const previous = this.clients.get(key);
    const binding = previous?.binding;
    if (previous && !previous.exited && binding && !binding.revoked && binding === this.connections.get(key) && binding.target?.sessionId === target?.sessionId) {
      if (!runId || binding.runId === runId && !binding.showingTrust) return this.pane(key, previous);
      if (!target && (!binding.runId || binding.runId === runId)) {
        // 首次 read 可能先发布 Run；复用本代握手，认证后才向具名调用者返回。
        await this.waitReady(workspaceId, key, previous, binding.runReady);
        if (binding.runId === runId) return this.pane(key, previous);
        if (runId !== await this.lifecycle?.selected(workspaceId)) throw new Error("ORCHESTRATION_RUN_MISMATCH");
        if (this.connections.get(key) !== binding || this.switching.has(workspaceId)) throw new Error("MANAGED_TERMINAL_STALE");
      }
    }
    const next = this.open(workspaceId, key, runId, target).finally(function finish() { host.opening.delete(key); });
    this.opening.set(key, next); return next;
  }
  /** 输出生命周期只代表 PTY 客户端，不冒充主控执行状态。 */
  private pane(id: string, client: Client): Pane { return { id, number: 1, generation: client.generation, agent: "ap", process: client.exited ? "exited" : "shell", task: "unknown" }; }
  /** 每代新建不可猜测能力并限制帧长、字段和未认证连接。 */
  private async open(workspaceId: string, key: string, requestedRunId?: string, target?: ManagedExecutorTarget): Promise<Pane> {
    const selected = await this.lifecycle?.selected(workspaceId);
    if (requestedRunId && requestedRunId !== selected) throw new Error("ORCHESTRATION_RUN_MISMATCH");
    if (this.switching.has(workspaceId)) throw new Error("MANAGED_TERMINAL_STALE");
    const old = this.clients.get(key); this.connections.get(key)?.revoke();
    old?.server.close(); for (const socket of old?.sockets ?? []) socket.destroy();
    if (old && !old.exited) {
      await this.awaitExit(old);
      if (!old.exited) await stopPty(old);
      if (this.switching.has(workspaceId)) throw new Error("MANAGED_TERMINAL_STALE");
    }
    const token = randomBytes(32).toString("hex"); const sockets = new Set<Socket>(); const host = this;
    let ready!: (ready: boolean) => void, runReady!: (ready: boolean) => void;
    let revoked = false, browserRunId: string | undefined, attachedSocket: Socket | undefined;
    let attachedForRun = false;
    const binding: TerminalBinding = { viewId: randomUUID(), runId: selected, target, get revoked() { return revoked; }, get attached() { return attachedForRun && !!attachedSocket && !attachedSocket.destroyed; }, get showingTrust() { return !!attachedSocket && !attachedForRun; }, runReady: new Promise<boolean>(function authenticated(resolve) { runReady = resolve; }), ready: new Promise<boolean>(function attach(resolve) { ready = resolve; }), revoke: function revoke() {
      if (revoked) return;
      revoked = true; ready(false); runReady(false);
      if (!target && host.connections.get(key) === binding && browserRunId) host.lifecycle?.closed(workspaceId);
    } };
    this.connections.set(key, binding);
    const server = createServer(function connected(socket) {
      sockets.add(socket); socket.setEncoding("utf8"); socket.setTimeout(10000, function timeout() { socket.destroy(); });
      let buffer = ""; let chain = Promise.resolve();
      let observed: { runId?: string; sessionId?: string; trustRequired?: boolean } | undefined;
      socket.on("error", function failed() { socket.destroy(); });
      socket.on("close", function closed() { sockets.delete(socket); if (attachedSocket === socket) binding.revoke(); });
      socket.on("data", function data(chunk) {
        buffer += chunk; if (buffer.length > 32 * 1024 * 1024) { socket.destroy(); return; }
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let frame: any;
          try { frame = JSON.parse(line); } catch { socket.destroy(); return; }
          if (!frame || frame.token !== token || typeof frame.id !== "string" || !/^[\w-]{1,128}$/.test(frame.id) || !["read", "input", "cli", "cancel", "ready"].includes(frame.operation) || Object.keys(frame).some(function extra(k) { return !["token", "id", "operation", "text", "requestId", "cursor", "action", "turnId", "executionToken", "questionId"].includes(k); }) || frame.cursor !== undefined && (typeof frame.cursor !== "string" || frame.cursor.length > 4096) || frame.operation === "input" && (typeof frame.text !== "string" || frame.text.length > 16000 || typeof frame.requestId !== "string" || !/^[\w-]{1,128}$/.test(frame.requestId))) { socket.destroy(); return; }
          if (frame.executionToken !== undefined && (typeof frame.executionToken !== "string" || !/^[a-f0-9]{64}$/u.test(frame.executionToken)) || frame.questionId !== undefined && (frame.operation !== "cli" || frame.action?.type !== "submit_prompt" || typeof frame.questionId !== "string" || !/^[\w-]{1,128}$/u.test(frame.questionId))) { socket.destroy(); return; }
          socket.setTimeout(0);
          if (frame.operation === "cancel" && (typeof frame.requestId !== "string" || !/^[\w-]{1,128}$/u.test(frame.requestId)
            || typeof frame.turnId !== "string" || !/^[\w-]{1,128}$/u.test(frame.turnId)
            || typeof frame.executionToken !== "string" || !/^[a-f0-9]{64}$/u.test(frame.executionToken)
            || Object.keys(frame).some(function extra(k) { return !["token", "id", "operation", "requestId", "turnId", "executionToken"].includes(k); }))) { socket.destroy(); return; }
          /** 异步解析完成后仍须遵循当前连接能力。 */
          function isCurrent() { return !revoked && !socket.destroyed && !host.switching.has(workspaceId) && host.connections.get(key) === binding; }
          /** 只读和精确取消独立于长恢复及输入队列。 */
          async function handle() {
            try {
              if (!isCurrent()) throw new Error("MANAGED_TERMINAL_STALE");
              if (frame.operation === "ready") {
                if (Object.keys(frame).some(function extra(key) { return !["token", "id", "operation"].includes(key); })) throw new Error("MANAGED_TERMINAL_NOT_READY");
                if (!observed?.trustRequired && (!observed?.sessionId || !observed.runId || observed.runId !== binding.runId || observed.sessionId !== binding.sessionId)) throw new Error("MANAGED_TERMINAL_NOT_READY");
                if (target && observed?.sessionId !== target.sessionId) throw new Error("MANAGED_TERMINAL_NOT_READY");
                if (attachedSocket && attachedSocket !== socket) throw new Error("MANAGED_TERMINAL_STALE");
                if (!target && observed.runId && observed.runId !== browserRunId) { browserRunId = observed.runId; host.lifecycle?.ready(workspaceId, browserRunId); }
                attachedSocket = socket;
                attachedForRun = !observed.trustRequired && !!observed.sessionId && observed.runId === binding.runId;
                if (attachedForRun) runReady(true);
                ready(true);
                socket.write(JSON.stringify({ id: frame.id, result: true }) + "\n");
                return;
              }
              const result = await host.request(workspaceId, frame, binding.runId, target, isCurrent);
              if (!isCurrent()) return;
              if (frame.operation === "read" && result && typeof result === "object") {
                observed = result;
                binding.runId ??= observed.runId;
                binding.sessionId ??= observed.sessionId;
              }
              socket.write(JSON.stringify({ id: frame.id, result }) + "\n");
            }
            catch (error) { if (!socket.destroyed) socket.write(JSON.stringify({ id: frame.id, error: error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "MANAGED_TERMINAL_OPERATION_FAILED" }) + "\n"); }
          }
          if (frame.operation === "cancel" || frame.operation === "read" || frame.operation === "cli" && !frame.action) void handle(); else chain = chain.then(handle);
        }
      });
    });
    await new Promise<void>(function listen(resolve, reject) { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    try {
      const port = (server.address() as { port: number }).port;
      const resizePipe = process.platform === "win32" ? `\\\\.\\pipe\\autopilot-desktop-${randomUUID()}` : undefined;
      const pty = await this.launch({ AUTOPILOT_MANAGED_PORT: String(port), AUTOPILOT_MANAGED_TOKEN: token, AUTOPILOT_MANAGED_ROLE: target ? "executor" : "controller", TERM_PROGRAM: "autopilot-desktop", ...(resizePipe ? { AUTOPILOT_DESKTOP_RESIZE_PIPE: resizePipe } : {}) });
      let exited!: () => void;
      const termination = new Promise<void>(function stopped(resolve) { exited = resolve; });
      const client: Client = { binding, pty, server, sockets, output: new OutputBuffer(), generation: (old?.generation ?? 0) + 1, exited: false, termination, resizePipe };
      this.clients.set(key, client);
      pty.onData(function output(data) { client.output.append(data); });
      pty.onExit(function exit() { client.exited = true; exited(); binding.revoke(); server.close(); for (const socket of sockets) socket.destroy(); });
      return this.pane(key, client);
    } catch (error) { binding.revoke(); server.close(); for (const socket of sockets) socket.destroy(); throw error; }
  }
  /** Renderer 只操作本工作区已登记的终端位置及精确代次。 */
  io(workspaceId: string, generation: number, operation: string, a?: unknown, b?: unknown, location = workspaceId): unknown {
    if (location !== workspaceId && !location.startsWith(workspaceId + ":")) throw new Error("DESKTOP_IPC_DENIED");
    const client = this.clients.get(location);
    const sizeOperation = operation === "resize" || operation === "prepareResize";
    if (sizeOperation && !(Number.isSafeInteger(a) && Number.isSafeInteger(b) && (a as number) >= 2 && (a as number) <= 1000 && (b as number) >= 1 && (b as number) <= 1000)) throw new Error("DESKTOP_IPC_DENIED");
    if (!client || client.generation !== generation || this.switching.has(workspaceId)) {
      if (sizeOperation) return operation === "prepareResize" ? null : undefined;
      throw new Error("MANAGED_TERMINAL_STALE");
    }
    if (operation === "waitReady") return this.waitReady(workspaceId, location, client);
    if (operation === "read" && Number.isSafeInteger(a) && (a as number) >= 0) return client.output.read(a as number);
    if (operation === "write" && typeof a === "string" && a.length <= 65536) { if (client.exited || client.binding.revoked || client.binding !== this.connections.get(location)) throw new Error("MANAGED_TERMINAL_EXITED"); client.pty.write(a); return; }
    if (sizeOperation) {
      if (operation === "prepareResize") {
        const host = this;
        return preparePtyResize(client, a as number, b as number).catch(function invalidate(error) {
          if (host.switching.has(workspaceId) || host.clients.get(location) !== client || host.connections.get(location)?.revoked) return null;
          throw error;
        });
      }
      if (!client.exited) client.pty.resize(a as number, b as number);
      return;
    }
    throw new Error("DESKTOP_IPC_DENIED");
  }
  /** 只等待本代客户端完成认证快照与 TUI 装配，失败后允许新建客户端重试。 */
  private async waitReady(workspaceId: string, key: string, client: Client, milestone = client.binding.ready): Promise<void> {
    const binding = client.binding;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([milestone, new Promise<boolean>(function timeout(resolve) { timer = setTimeout(function expired() { resolve(false); }, 15000); })]);
      if (!ready || client.exited || binding?.revoked || binding !== this.connections.get(key)) {
        if (!binding.revoked && !this.switching.has(workspaceId) && binding === this.connections.get(key) && client === this.clients.get(key)) {
          binding.revoke();
          const cleanup = this.disconnectClient(client);
          this.detaching.set(key, cleanup);
          try { await cleanup; } finally { if (this.detaching.get(key) === cleanup) this.detaching.delete(key); }
        }
        throw new Error("MANAGED_TERMINAL_NOT_READY");
      }
    } finally { clearTimeout(timer); }
  }
  /** 应用退出关闭薄客户端；正常切换和视图卸载不调用此方法。 */
  async close(): Promise<void> {
    for (const [workspaceId, client] of this.clients) {
      this.connections.get(workspaceId)?.revoke();
      client.server.close(); for (const socket of client.sockets) socket.destroy();
      const deadline = Date.now() + 3000;
      while (!client.exited && Date.now() < deadline) await new Promise(function wait(resolve) { setTimeout(resolve, 25); });
      if (!client.exited) await stopPty(client);
    }
  }
}
