/** Desktop 受管子进程通道；与 Parallel 状态 pipe 分离，不解析终端文本或接受 Renderer 身份。 */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ManagedRuntimeCommand, ManagedRuntimeIdentity } from "./managed-runtime-service";

/** 仅受信 Host 持有 worker 路径、运行环境及人类调用入口。 */
export class ManagedRuntimeHost {
  readonly identity: ManagedRuntimeIdentity;
  private child?: ChildProcess;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(sessionId?: string) => void>();
  private ready = false;
  orchestrationTools = false;
  private toolHandlers = new Map<string, (binding: { sessionId: string; turnId: string }, operation: string, input: unknown, signal: AbortSignal) => Promise<unknown>>();
  private toolRequests = new Map<string, AbortController>();
  constructor(hostId: string) { this.identity = { protocol: 1, hostId, owner: randomUUID(), generation: randomUUID() }; }

  /** IPC 握手完成即可复用 Worker，首个 Session 登记事实前也可接收请求。 */
  isConnected(): boolean { return this.ready && this.child?.connected === true; }

  /** 拉起受信 bootstrap，握手仅证明此进程已就绪，不恢复历史 Turn。 */
  async start(workerPath: string, options: { env?: NodeJS.ProcessEnv; execArgv?: string[]; execPath?: string } = {}): Promise<void> {
    if (this.child) throw new Error("MANAGED_ALREADY_STARTED");
    const host = this;
    const child = fork(workerPath, [], { ...options, env: { ...process.env, ...options.env, AUTOPILOT_MANAGED_IDENTITY: JSON.stringify(this.identity) }, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    this.child = child;
    await new Promise<void>(function handshake(resolve, reject) {
      const timer = setTimeout(function timeout() { reject(new Error("MANAGED_HANDSHAKE_TIMEOUT")); child.kill(); }, 15000);
      child.once("error", function failed() { clearTimeout(timer); reject(new Error("MANAGED_PROCESS_ERROR")); });
      child.on("message", function message(value) {
        if (!value || typeof value !== "object" || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) return;
        const frame = value as ManagedRuntimeIdentity & { kind?: string; id?: string; result?: unknown; error?: string; sessionId?: string };
        if (frame.protocol !== 1 || frame.hostId !== host.identity.hostId || frame.owner !== host.identity.owner || frame.generation !== host.identity.generation) return;
        if (frame.kind === "startup_error" && !host.ready) { clearTimeout(timer); reject(new Error(typeof frame.error === "string" && /^[A-Z][A-Z_]{1,80}$/.test(frame.error) ? frame.error : "MANAGED_BOOTSTRAP_FAILED")); return; }
        if (frame.kind === "tool" && host.ready) { void host.receiveTool(value); }
        else if (frame.kind === "tool_cancel" && typeof frame.id === "string") host.toolRequests.get(frame.id)?.abort();
        else if (frame.kind === "ready") { host.orchestrationTools = (value as { orchestration?: boolean }).orchestration === true; host.ready = true; clearTimeout(timer); resolve(); }
        else if (frame.kind === "changed" && host.ready && typeof frame.sessionId === "string") for (const listener of host.listeners) listener(frame.sessionId);
        else if (frame.kind === "reply" && typeof frame.id === "string") {
          const request = host.pending.get(frame.id);
          if (!request) return;
          host.pending.delete(frame.id); clearTimeout(request.timer);
          if (frame.error) request.reject(new Error(frame.error)); else request.resolve(frame.result);
        }
      });
      child.once("exit", function exited() {
        clearTimeout(timer); host.ready = false;
        reject(new Error("MANAGED_PROCESS_EXITED"));
        for (const request of host.pending.values()) { clearTimeout(request.timer); request.reject(new Error("MANAGED_REPLY_UNKNOWN")); }
        host.pending.clear();
        for (const tool of host.toolRequests.values()) tool.abort();
        for (const listener of host.listeners) listener();
      });
    });
  }

  /** 变化只是核查提示，消费确认取决于 Host 持久读取；订阅清理不取消执行。 */
  subscribe(listener: (sessionId?: string) => void): () => void { this.listeners.add(listener); const listeners = this.listeners; return function unsubscribe() { listeners.delete(listener); }; }

  /** 只允许受信装配注册反向 RPC；绑定来自子进程 Runtime，不来自模型参数。 */
  registerToolHandler(scope: string, handler: (binding: { sessionId: string; turnId: string }, operation: string, input: unknown, signal: AbortSignal) => Promise<unknown>): () => void {
    if (this.toolHandlers.has(scope)) throw new Error("ORCHESTRATION_ALREADY_ATTACHED");
    this.toolHandlers.set(scope, handler);
    const handlers = this.toolHandlers;
    return function unregister() { if (handlers.get(scope) === handler) handlers.delete(scope); };
  }

  /** 回包不阻塞命令通道，模型工具只能调用封闭的宿主处理器。 */
  private async receiveTool(value: unknown): Promise<void> {
    const frame = value as { id: string; sessionId: string; turnId: string; operation: string; input: unknown };
    if (![frame.id, frame.sessionId, frame.turnId].every(function valid(v) { return typeof v === "string" && /^[\w-]{1,128}$/.test(v); }) || this.toolRequests.has(frame.id)) return;
    const abort = new AbortController();
    this.toolRequests.set(frame.id, abort);
    try {
      let result: unknown;
      for (const handler of this.toolHandlers.values()) {
        result = await handler({ sessionId: frame.sessionId, turnId: frame.turnId }, frame.operation, frame.input, abort.signal);
        if (result !== undefined) break;
      }
      if (result === undefined) throw new Error("ORCHESTRATION_SCOPE_DENIED");
      if (this.child?.connected) this.child.send({ kind: "tool_reply", ...this.identity, id: frame.id, result });
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "ORCHESTRATION_TOOL_FAILED";
      if (this.child?.connected) this.child.send({ kind: "tool_reply", ...this.identity, id: frame.id, error: code });
    } finally { this.toolRequests.delete(frame.id); }
  }

  /** 受信人类入口显式传 human；模型入口只能使用缺省 host 权限。 */
  command(input: Omit<ManagedRuntimeCommand, keyof ManagedRuntimeIdentity>, human = false): Promise<unknown> {
    if (!this.isConnected()) return Promise.reject(new Error("MANAGED_NOT_CONNECTED"));
    const host = this;
    const id = randomUUID();
    return new Promise(function request(resolve, reject) {
      const timer = setTimeout(function timeout() { host.pending.delete(id); reject(new Error("MANAGED_REPLY_UNKNOWN")); }, 15000);
      host.pending.set(id, { resolve, reject, timer });
      host.child!.send({ kind: "command", id, command: { ...input, ...host.identity }, human }, function sent(error) {
        if (error) { clearTimeout(timer); host.pending.delete(id); reject(new Error("MANAGED_REPLY_UNKNOWN")); }
      });
    });
  }

  /** 显式结束所属子进程；退出事实由订阅单独处理，不生成 Core 终态。 */
  stop(): void { for (const tool of this.toolRequests.values()) tool.abort(); if (this.child?.connected) this.child.disconnect(); }
}
