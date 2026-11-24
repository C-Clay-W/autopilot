// Desktop 本机只读状态接收器，认证绑定 Shell 代次，内存登记与 Core 执行权限相互独立。
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { DesktopStatusLines, isDesktopStatusFrame, DESKTOP_STATUS_QUEUE_BYTES, type DesktopSessionStatus, type DesktopStatusFrame, type DesktopWorkspaceStatus } from "@autopilot-agent/adapters";

export interface DesktopApStatus {
  apInstanceId: string; lifecycle: "starting" | "ready" | "exiting";
  connection: "connected" | "disconnected" | "stale" | "exited" | "syncing";
  workspace?: DesktopWorkspaceStatus; sessions: DesktopSessionStatus[];
}
interface Instance {
  value: DesktopApStatus; socket?: Socket; seq: number; seen: number;
  staging?: { id: string; part: number; lifecycle: "starting" | "ready"; workspace?: DesktopWorkspaceStatus; sessions: Map<string, DesktopSessionStatus> };
}
interface PaneRegistration { generation: number; token: string; instances: Map<string, Instance> }

/** 服务与窗格凭据仅属于当前 Desktop 实例，快照永不包含端点或 token。 */
export class ApStatusHost {
  readonly desktopInstanceId = randomUUID();
  private endpoint?: string;
  private directory?: { path: string; ino: number };
  private server?: Server;
  private panes = new Map<string, PaneRegistration>();
  private sockets = new Set<Socket>();
  private unauthenticated = 0;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private changed: () => void) {}

  /** Win 使用随机 pipe，Mac 使用自建 0700 临时目录中的 0600 UDS。 */
  async start(platform: NodeJS.Platform = process.platform): Promise<void> {
    try {
      if (platform === "win32") this.endpoint = `\\\\.\\pipe\\autopilot-status-${this.desktopInstanceId}`;
      else {
        const path = await mkdtemp(join(tmpdir(), "ap-status-"));
        await chmod(path, 0o700);
        this.directory = { path, ino: (await lstat(path)).ino };
        this.endpoint = join(path, "s");
      }
      const host = this;
      this.server = createServer(function connected(socket) { host.accept(socket); });
      await new Promise<void>(function listening(resolve, reject) {
        host.server!.once("error", reject);
        host.server!.listen(host.endpoint!, function ready() { host.server!.removeListener("error", reject); resolve(); });
      });
      if (platform !== "win32") await chmod(this.endpoint, 0o600);
      this.server.on("error", function unavailable() { host.endpoint = undefined; for (const socket of host.sockets) socket.destroy(); host.changed(); });
      this.timer = setInterval(function expire() {
        let changed = false;
        for (const pane of host.panes.values()) for (const instance of pane.instances.values()) {
          if (["connected", "syncing"].includes(instance.value.connection) && Date.now() - instance.seen >= 15000) { instance.value.connection = "stale"; changed = true; instance.socket?.destroy(); }
        }
        if (changed) host.changed();
      }, 1000);
      this.timer.unref();
    } catch { await this.stop(); }
  }
  /** 新 Shell 代次覆盖凭据，并撤销上一代所有连接。 */
  register(paneId: string, generation: number): Record<string, string> {
    this.release(paneId);
    const pane: PaneRegistration = { generation, token: randomBytes(32).toString("hex"), instances: new Map() };
    this.panes.set(paneId, pane);
    if (!this.endpoint) return {};
    return { AUTOPILOT_DESKTOP_STATUS_ENDPOINT: this.endpoint, AUTOPILOT_DESKTOP_STATUS_TOKEN: pane.token, AUTOPILOT_DESKTOP_STATUS_INSTANCE_ID: this.desktopInstanceId, AUTOPILOT_DESKTOP_STATUS_PANE_ID: paneId, AUTOPILOT_DESKTOP_STATUS_GENERATION: String(generation) };
  }
  /** 删除窗格时撤销凭据和全部连接，不跨代次复用登记。 */
  release(paneId: string): void {
    const pane = this.panes.get(paneId);
    this.panes.delete(paneId);
    for (const instance of pane?.instances.values() ?? []) instance.socket?.destroy();
  }
  /** Shell 退出只改变进程关联可信度，不合成任何任务终态。 */
  shellExited(paneId: string, generation: number): void {
    const pane = this.panes.get(paneId);
    if (pane?.generation !== generation) return;
    for (const instance of pane.instances.values()) {
      if (instance.value.connection !== "exited") instance.value.connection = "disconnected";
      instance.socket?.destroy();
    }
    this.changed();
  }
  /** 返回完全安全的事实副本，缺通道与缺 AP 均保守显示不可确认。 */
  snapshot(paneId: string): DesktopApStatus[] { return [...this.panes.get(paneId)?.instances.values() ?? []].map(function copy(instance) { return structuredClone(instance.value); }); }
  available(): boolean { return this.endpoint !== undefined; }

  /** 未认证连接仅短时占用资源，认证成功后没有 AP 总数配额。 */
  private accept(socket: Socket): void {
    if (this.unauthenticated >= 64) { socket.destroy(); return; }
    this.sockets.add(socket); this.unauthenticated++;
    let authenticated = false;
    let instance: Instance | undefined;
    let registration: PaneRegistration | undefined;
    let paneId: string | undefined;
    const host = this;
    const decoder = new DesktopStatusLines();
    const timeout = setTimeout(function expired() { socket.destroy(); }, 2000);
    timeout.unref();
    /** 固定回复同样受写缓冲保护，慢客户端断开后由全量快照恢复。 */
    function reply(type: "accepted" | "ack" | "resync_required", seq: number): void {
      if (socket.writableLength >= DESKTOP_STATUS_QUEUE_BYTES) { socket.destroy(); return; }
      socket.write(JSON.stringify({ type, seq }) + "\n");
    }
    socket.on("data", function receive(chunk: Buffer) {
      try {
        for (const value of decoder.push(chunk)) {
          if (!isDesktopStatusFrame(value)) throw new Error("STATUS_FRAME_INVALID");
          if (!authenticated) {
            if (value.type !== "hello" || value.desktopInstanceId !== host.desktopInstanceId) throw new Error("STATUS_IDENTITY_INVALID");
            const pane = host.panes.get(value.paneId);
            if (!pane || pane.generation !== value.generation || pane.token !== value.token) throw new Error("STATUS_IDENTITY_INVALID");
            const previous = pane.instances.get(value.apInstanceId);
            if (previous && value.seq <= previous.seq || previous?.value.connection === "exited") throw new Error("STATUS_IDENTITY_INVALID");
            instance = { value: { apInstanceId: value.apInstanceId, lifecycle: previous?.value.lifecycle ?? "starting", connection: "syncing", sessions: previous?.value.sessions ?? [], workspace: previous?.value.workspace }, seq: value.seq, seen: Date.now(), socket };
            pane.instances.set(value.apInstanceId, instance);
            previous?.socket?.destroy();
            registration = pane; paneId = value.paneId; authenticated = true; host.unauthenticated--; clearTimeout(timeout);
            host.changed(); reply("accepted", value.seq); continue;
          }
          if (!instance || !registration || registration !== host.panes.get(paneId!) || instance.socket !== socket || registration.instances.get(value.apInstanceId) !== instance || value.desktopInstanceId !== host.desktopInstanceId || value.paneId !== paneId || value.generation !== registration.generation || value.type === "hello") throw new Error("STATUS_IDENTITY_INVALID");
          if (value.seq <= instance.seq) { reply("ack", value.seq); continue; }
          if (value.seq !== instance.seq + 1) { instance.value.connection = "syncing"; host.changed(); reply("resync_required", instance.seq); socket.destroy(); return; }
          instance.seq = value.seq; instance.seen = Date.now();
          host.apply(instance, value, registration);
          reply("ack", value.seq);
        }
      } catch { socket.destroy(); }
    });
    socket.on("error", function failed() { socket.destroy(); });
    socket.on("close", function disconnected() {
      clearTimeout(timeout); host.sockets.delete(socket);
      if (!authenticated) host.unauthenticated--;
      if (instance?.socket === socket && host.panes.get(paneId!) === registration) {
        instance.socket = undefined; instance.staging = undefined;
        if (instance.value.connection !== "exited" && instance.value.connection !== "stale") instance.value.connection = "disconnected";
        host.changed();
      }
    });
  }
  /** 只有同一版本的全部批次收齐才提交会话集合，心跳不能清除 unknown。 */
  private apply(instance: Instance, frame: DesktopStatusFrame, pane: PaneRegistration): void {
    if (instance.value.connection === "exited") throw new Error("STATUS_INSTANCE_EXITED");
    if (frame.type === "heartbeat") return;
    if (frame.type === "ap_exiting") {
      if (instance.staging || instance.value.connection !== "connected") instance.value.sessions = instance.value.sessions.map(function uncertain(session) { return { ...session, freshness: "unknown" }; });
      instance.value.lifecycle = "exiting"; instance.value.connection = "exited"; instance.staging = undefined;
      // 已确认退出只留最近一份摘要，不移除其他活跃或未确认实例。
      for (const [id, other] of pane.instances) if (other !== instance && other.value.connection === "exited") pane.instances.delete(id);
      this.changed(); return;
    }
    if (frame.type !== "snapshot") throw new Error("STATUS_FRAME_INVALID");
    if (frame.part === 0) {
      instance.staging = { id: frame.snapshotId, part: 0, lifecycle: frame.lifecycle, workspace: frame.workspace, sessions: new Map() };
      if (!frame.final) { instance.value.connection = "syncing"; this.changed(); }
    }
    const staging = instance.staging;
    if (!staging || staging.id !== frame.snapshotId || staging.part !== frame.part || staging.lifecycle !== frame.lifecycle || JSON.stringify(staging.workspace) !== JSON.stringify(frame.workspace)) throw new Error("STATUS_SNAPSHOT_INVALID");
    for (const session of frame.sessions) {
      if (staging.sessions.has(session.sessionId)) throw new Error("STATUS_SNAPSHOT_INVALID");
      staging.sessions.set(session.sessionId, session);
    }
    staging.part++;
    if (!frame.final) return;
    const next: DesktopApStatus = { apInstanceId: frame.apInstanceId, lifecycle: staging.lifecycle, connection: "connected", workspace: staging.workspace, sessions: [...staging.sessions.values()] };
    instance.staging = undefined;
    if (JSON.stringify(instance.value) !== JSON.stringify(next)) { instance.value = next; this.changed(); }
  }
  /** 停机关闭自有连接，UDS 目录仅在 inode 未变且为空时移除。 */
  async stop(): Promise<void> {
    clearInterval(this.timer); this.endpoint = undefined;
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening) {
      const server = this.server;
      await new Promise<void>(function closed(resolve) { server.close(function done() { resolve(); }); });
    }
    this.server = undefined;
    if (this.directory) {
      try { if ((await lstat(this.directory.path)).ino === this.directory.ino) await rmdir(this.directory.path); } catch { /* 不移除替换路径或非空目录。 */ }
      this.directory = undefined;
    }
  }
}
