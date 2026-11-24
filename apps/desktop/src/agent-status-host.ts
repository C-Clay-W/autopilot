// 第三方只读观察通道绑定 Shell 代次和受管调用身份，不接收业务正文或控制命令。
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { isAgentType, type AgentStatus } from "./workspace";

interface ObservedSession { status: AgentStatus["status"]; active: boolean; stamp: string; turn: string; retired: Set<string> }
interface Registration { generation: number; token: string; instances: Map<string, { value: AgentStatus; sessions: Map<string, ObservedSession> }> }
/** 原生 hooks 没有统一序号，接收器只使用同一次受管调用的事件，不冒充 AP 权威序列。 */
export class AgentStatusHost {
  private endpoint?: string;
  private directory?: { path: string; ino: number };
  private server?: Server;
  private panes = new Map<string, Registration>();
  private sockets = new Set<Socket>();
  constructor(private changed: () => void) {}
  /** 随机本机 pipe/私有 UDS 复用 AP 的平台权限边界。 */
  async start(platform = process.platform): Promise<void> {
    try {
      if (platform === "win32") this.endpoint = `\\\\.\\pipe\\autopilot-agents-${randomUUID()}`;
      else {
        const path = await mkdtemp(join(tmpdir(), "ap-agents-"));
        await chmod(path, 0o700);
        this.directory = { path, ino: (await lstat(path)).ino };
        this.endpoint = join(path, "s");
      }
      const host = this;
      this.server = createServer(function connected(socket) { host.accept(socket); });
      await new Promise<void>(function listen(resolve, reject) { host.server!.once("error", reject); host.server!.listen(host.endpoint!, function ready() { host.server!.removeListener("error", reject); resolve(); }); });
      if (platform !== "win32") await chmod(this.endpoint, 0o600);
      this.server.on("error", function unavailable() { host.endpoint = undefined; for (const socket of host.sockets) socket.destroy(); host.changed(); });
    } catch { await this.stop(); }
  }
  /** 每次重建 Shell 撤销旧 token，令牌只通过环境流转。 */
  register(paneId: string, generation: number): Record<string, string> {
    this.release(paneId);
    const token = randomBytes(32).toString("hex");
    this.panes.set(paneId, { generation, token, instances: new Map() });
    return this.endpoint ? { AUTOPILOT_AGENT_ENDPOINT: this.endpoint, AUTOPILOT_AGENT_TOKEN: token, AUTOPILOT_AGENT_PANE: paneId, AUTOPILOT_AGENT_GENERATION: String(generation) } : {};
  }
  /** 删除终端撤销登记，短连接结束不改变 CLI 生命周期。 */
  release(paneId: string): void { this.panes.delete(paneId); }
  /** Shell 退出撤销凭据，保留最后已知结果并明确已退出。 */
  shellExited(paneId: string, generation: number): void {
    const pane = this.panes.get(paneId);
    if (pane?.generation !== generation) return;
    pane.token = "";
    for (const instance of pane.instances.values()) { instance.value.exited = true; if (["running", "waiting"].includes(instance.value.status)) instance.value.status = "unknown"; }
    this.changed();
  }
  /** 删除提示按本窗格仍在工作的独立 Turn 判断，其他会话的等待不遮盖它。 */
  hasWorkingTurn(paneId: string): boolean {
    if (!this.available()) return false;
    for (const instance of this.panes.get(paneId)?.instances.values() ?? []) {
      if (!instance.value.exited && instance.value.observation === "enabled" && [...instance.sessions.values()].some(function running(s) { return s.active && s.status === "running"; })) return true;
    }
    return false;
  }
  /** 已退出调用保留内部拒收标记，展示快照只返回存活实例。 */
  snapshot(paneId: string): AgentStatus[] { const hostAvailable = this.available(); return [...this.panes.get(paneId)?.instances.values() ?? []].filter(function live(instance) { return !instance.value.exited; }).map(function copy(instance) { const sessions = [...instance.sessions.entries()].filter(function known([, state]) { return !!state.turn; }); const taskId = sessions.length === 1 ? JSON.stringify([instance.value.instanceId, sessions[0][0], sessions[0][1].turn]) : undefined; return { ...instance.value, taskId, status: !hostAvailable ? "unknown" as const : instance.value.status }; }); }
  /** 缺少原生取消事件时，取消键只降低可信度，不推断中断或完成。 */
  inputUncertain(paneId: string, generation: number): void {
    const pane = this.panes.get(paneId);
    if (pane?.generation !== generation) return;
    for (const instance of pane.instances.values()) if (!instance.value.exited) {
      if (["running", "waiting"].includes(instance.value.status)) instance.value.status = "unknown";
      for (const state of instance.sessions.values()) if (state.active) state.status = "unknown";
    }
    this.changed();
  }
  /** 只反映观察服务可用性，不代表任何 CLI 已完成接入。 */
  available(): boolean { return Boolean(this.endpoint); }
  /** 每次连接只接受一条有界帧，未认证连接两秒内释放。 */
  private accept(socket: Socket): void {
    if (this.sockets.size >= 64) { socket.destroy(); return; }
    this.sockets.add(socket);
    const host = this;
    let data = "";
    socket.setTimeout(2000, function timeout() { socket.destroy(); });
    socket.on("data", function receive(chunk) {
      data += chunk.toString("utf8");
      if (Buffer.byteLength(data) > 8192) { socket.destroy(); return; }
      if (!data.includes("\n")) return;
      try { host.receive(JSON.parse(data.slice(0, data.indexOf("\n")))); socket.end("ok\n"); }
      catch { socket.destroy(); }
    });
    socket.on("error", function ignore() {});
    socket.on("close", function closed() { host.sockets.delete(socket); });
  }
  /** 身份由宿主登记，事件既不能迁组，也不能复活已退出调用。 */
  private receive(frame: Record<string, unknown>): void {
    if (Object.keys(frame).some(function unknown(key) { return !["paneId", "generation", "token", "instanceId", "agent", "event", "session", "stamp", "observation", "turn"].includes(key); })) return;
    const pane = this.panes.get(frame.paneId as string);
    if (!pane || !pane.token || frame.token !== pane.token || frame.generation !== pane.generation || !isAgentType(frame.agent) || frame.agent === "ap" || typeof frame.instanceId !== "string" || !/^[0-9a-f-]{36}$/.test(frame.instanceId) || typeof frame.stamp !== "string" || !/^\d{1,24}$/.test(frame.stamp)) return;
    const id = frame.instanceId;
    let instance = pane.instances.get(id);
    if (frame.event === "begin") {
      if (instance) return;
      // 仅清理已确认退出的摘要，其他并发调用分别展示。
      for (const [key, old] of pane.instances) if (old.value.exited && old.value.agent === frame.agent) pane.instances.delete(key);
      instance = { value: { instanceId: id, agent: frame.agent, status: "unknown", exited: false, observation: frame.observation === "disabled" ? "disabled" : "pending" }, sessions: new Map() };
      pane.instances.set(id, instance);
    } else if (instance && !instance.value.exited && instance.value.agent === frame.agent) {
      if (frame.event === "exit") {
        instance.value.exited = true;
        if (["running", "waiting"].includes(instance.value.status)) instance.value.status = "unknown";
      } else {
        if (typeof frame.session !== "string" || !/^[a-f0-9]{64}$/.test(frame.session)) return;
        const previous = instance.sessions.get(frame.session);
        if (previous && BigInt(frame.stamp) <= BigInt(previous.stamp)) return;
        const state = previous ?? { status: "unknown" as AgentStatus["status"], active: false, stamp: "0", turn: "", retired: new Set<string>() };
        if (typeof frame.turn !== "string" || frame.turn !== "" && !/^[a-f0-9]{64}$/.test(frame.turn)) return;
        if (frame.turn && state.turn !== frame.turn) {
          if (state.retired.has(frame.turn) || state.turn && frame.event !== "submit") return;
          if (state.turn) state.retired.add(state.turn);
          state.turn = frame.turn;
        }
        switch (frame.event) {
          case "ready": if (previous) return; state.status = "idle"; break;
          case "activity": if (previous && !state.active) return; state.status = "running"; state.active = true; break;
          case "submit": state.status = "running"; state.active = true; break;
          case "waiting": state.status = "waiting"; break;
          case "done": if (!state.active && ["completed", "failed", "interrupted"].includes(state.status)) return; state.status = state.active ? "completed" : "idle"; state.active = false; break;
          case "failed": if (!state.active && state.status === "failed") return; state.status = state.active ? "failed" : "unknown"; state.active = false; break;
          case "interrupted": if (!state.active && state.status === "interrupted") return; state.status = state.active ? "interrupted" : "unknown"; state.active = false; break;
          case "unknown": state.status = "unknown"; break;
          default: return;
        }
        instance.value.observation = "enabled";
        state.stamp = frame.stamp;
        instance.sessions.set(frame.session, state);
        const states = [...instance.sessions.values()].map(function status(state) { return state.status; });
        instance.value.status = states.includes("waiting") ? "waiting" : states.includes("running") ? "running" : states.includes("unknown") ? "unknown" : states.includes("failed") ? "failed" : states.includes("interrupted") ? "interrupted" : states.includes("completed") ? "completed" : "idle";
      }
    } else return;
    this.changed();
  }
  /** 仅清理自有临时目录，不递归删除替换路径。 */
  async stop(): Promise<void> {
    this.endpoint = undefined;
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening) { const server = this.server; await new Promise<void>(function stop(resolve) { server.close(function closed() { resolve(); }); }); }
    if (this.directory) { try { if ((await lstat(this.directory.path)).ino === this.directory.ino) await rmdir(this.directory.path); } catch { /* 保留非空或被替换目录。 */ } }
    this.server = undefined;
  }
}
