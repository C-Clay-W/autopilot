/** 受管 AP 附着入口：在真实 PTY 复用完整 Ink TUI，通过认证通道操作原会话。 */
import { createConnection } from "node:net";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createManagedCliController, type ManagedCliRequest, type ManagedCliSnapshot } from "./managed-controller.js";
import { createCliTuiStore, runCliTui, runCliTrustDialog } from "./tui.js";
import type { CliExitCode } from "./types.js";

/** 私有能力仅用于认证；TUI和Controller不创建第二个Runtime或自由Session。 */
export async function runManagedAttach(): Promise<CliExitCode> {
  const port = Number(process.env.AUTOPILOT_MANAGED_PORT); const token = process.env.AUTOPILOT_MANAGED_TOKEN;
  const role = process.env.AUTOPILOT_MANAGED_ROLE === "executor" ? "executor" : "controller";
  delete process.env.AUTOPILOT_MANAGED_TOKEN; delete process.env.AUTOPILOT_MANAGED_PORT; delete process.env.AUTOPILOT_MANAGED_ROLE;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token || !process.stdin.isTTY || !process.stdout.isTTY) return 1;
  const socket = createConnection({ host: "127.0.0.1", port });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const store = createCliTuiStore(); const signals = new EventEmitter();
  let buffer = ""; let closed = false; let cursor: string | undefined; let status = ""; let observedSessionId: string | undefined;
  /** 唯一请求身份保持到回包；未知提交不自动重试。 */
  function request(operation: Parameters<ManagedCliRequest>[0], extra: Record<string, unknown> = {}): Promise<unknown> {
    if (closed) return Promise.reject(new Error("受管会话连接中断；请重新连接终端，原 Run 继续保留。"));
    const id = randomUUID();
    return new Promise(function wait(resolve, reject) { pending.set(id, { resolve, reject }); socket.write(JSON.stringify({ id, token, operation, ...extra }) + "\n"); });
  }
  const controller = createManagedCliController(request, function notice(text) { store.addNotice(text); }, role);
  socket.setEncoding("utf8");
  socket.on("data", function receive(data) {
    buffer += data; if (buffer.length > 2 * 1024 * 1024) { socket.destroy(); return; }
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const frame = JSON.parse(line); const item = pending.get(frame.id); if (!item) continue; pending.delete(frame.id); if (frame.error) item.reject(new Error(frame.error)); else item.resolve(frame.result); }
      catch { socket.destroy(); }
    }
  });
  socket.on("error", function failed() { store.addNotice("主控连接失败，不会另开自由会话。"); });
  socket.on("close", function disconnected() { closed = true; for (const item of pending.values()) item.reject(new Error("连接中断，提交状态未知；不自动重发。")); pending.clear(); signals.emit("SIGTERM"); });
  /** 原终端信号只结束客户端，不能停止Run。 */
  function interrupt() { signals.emit("SIGINT"); }
  /** 应用关闭时交原TUI恢复终端。 */
  function terminate() { signals.emit("SIGTERM"); }
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  /** 持久事件通过原Controller/Store进入完整TUI；无事件时不重放历史或逐行刷屏。 */
  function update(value: ManagedCliSnapshot) {
    if (value.sessionId && value.sessionId !== observedSessionId) { observedSessionId = value.sessionId; cursor = undefined; }
    if (role === "executor" && value.task) store.recordTask(value.task.id, value.task.content);
    if (value.status !== status) { status = value.status; store.addNotice(status); }
    for (const rejection of value.queueRejections ?? []) store.rejectPendingPrompt(rejection.inputId, rejection.message);
    controller.update(value); store.syncProjection(controller.getProjection());
    cursor = value.page?.nextCursor ?? value.page?.cursor ?? cursor;
  }
  try {
    let initial = await request("read") as ManagedCliSnapshot & { trustRequired?: boolean };
    if (initial.trustRequired) {
      await request("ready");
      const decision = await runCliTrustDialog({ workspaceRoot: initial.workspaceRoot!, streams: { stdout: process.stdout, stdin: process.stdin }, signalSource: signals, env: process.env });
      if (decision !== "granted") return 0;
      await request("input", { text: "/trust", requestId: randomUUID() });
      initial = await request("read") as typeof initial;
    }
    if (!initial.sessionId || !initial.workspaceRoot) throw new Error("受管会话尚未连接，请重试。");
    update(initial);
    const running = runCliTui({ controller, store, managedPromptBackground: true, sessionId: initial.sessionId, workspaceRoot: initial.workspaceRoot, streams: { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }, signalSource: signals, closeWhenIdle: false, env: process.env });
    await request("ready");
    /** 串行只读分页；输入编辑在Ink本地完成，不等待网络回包。 */
    async function poll() {
      while (!closed) {
        try { const value = await request("read", { cursor }) as ManagedCliSnapshot; update(value); if (value.page?.nextCursor) continue; }
        catch (error) { if (!closed) store.addNotice(error instanceof Error ? error.message : "主控读取失败"); }
        await new Promise(function delay(resolve) { setTimeout(resolve, 750); });
      }
    }
    void poll();
    return (await running).exitCode;
  } catch (error) { process.stderr.write((error instanceof Error ? error.message : "主控连接失败") + "\n"); return 1; }
  finally { closed = true; socket.destroy(); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); }
}
