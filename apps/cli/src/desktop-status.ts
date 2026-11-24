// CLI 受管状态出口，Core 只读查询决定事实，独立本机连接失败不影响任务或标准输出。
import { AUTOPILOT_VERSION } from "./tui/constants.js";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { DesktopStatusLines, DESKTOP_STATUS_FRAME_BYTES, isDesktopStatusId, isDesktopStatusReply, type DesktopSessionStatus, type DesktopStatusIdentity, type DesktopWorkspaceStatus } from "@autopilot-agent/adapters";
import type { Session, TurnExecutionView } from "@autopilot-agent/core";

export interface DesktopStatusSource {
  workspace: DesktopWorkspaceStatus;
  selected(): string;
  entries(): Array<{ sessionId: string; opened: boolean }>;
  executions(): Array<{ threadId: string; turnId: string }>;
  read(sessionId: string, signal: AbortSignal): Promise<{ status?: Session["status"]; executionView?: TurnExecutionView | null } | null>;
  recovery?(sessionId: string, turnId: string): Promise<{ sessionId: string; turnId: string; recoverable: boolean } | null>;
}
/** 明确白名单复制，Core 交互对象和错误正文永不进入通道。 */
export function projectDesktopSession(sessionId: string, summary: { status?: Session["status"]; executionView?: TurnExecutionView | null }, relation: DesktopSessionStatus["relation"], selected: boolean): DesktopSessionStatus {
  const view = summary.executionView;
  if (!view) return { sessionId, selected, relation, freshness: summary.status === "idle" ? "fresh" : "unknown", status: "idle", lastSeq: 0 };
  return { sessionId, turnId: view.turnId, selected, relation, freshness: "fresh", status: view.status, execution: view.execution, waiting: view.waiting, result: view.result, interaction: view.interaction?.state, continuation: (view.interaction?.continuation ?? view.continuation)?.state, lastSeq: view.lastSeq };
}

/** 缺受管环境立即返回，不分配连接或定时器。 */
export function createDesktopStatus(env: NodeJS.ProcessEnv = process.env): { bind(source: DesktopStatusSource): void; track(sessionId: string): void; flush(): Promise<void>; stop(): Promise<void> } | undefined {
  const prefix = "AUTOPILOT_DESKTOP_STATUS_";
  const endpoint = env[`${prefix}ENDPOINT`];
  const token = env[`${prefix}TOKEN`];
  const desktopInstanceId = env[`${prefix}INSTANCE_ID`];
  const paneId = env[`${prefix}PANE_ID`];
  const generation = Number(env[`${prefix}GENERATION`]);
  if (!endpoint || !token || !/^[0-9a-f]{64}$/.test(token) || !isDesktopStatusId(desktopInstanceId) || !isDesktopStatusId(paneId) || !Number.isSafeInteger(generation) || generation < 1) return undefined;
  const identity: DesktopStatusIdentity = { desktopInstanceId, paneId, generation, apInstanceId: randomUUID() };
  const records = new Map<string, { value: DesktopSessionStatus; checked: number; generation: number }>();
  const driven = new Set<string>();
  let source: DesktopStatusSource | undefined;
  let socket: Socket | undefined;
  let stopped = false;
  let reading = false;
  let cursor = 0;
  let seq = 0;
  let retry = 100;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let pending: { seq: number; complete(ok: boolean): void } | undefined;
  let sending = false;
  let dirty = true;
  let lastSent = "";
  const abort = new AbortController();

  /** 登记身份只安排查询，不把本地启动通知解释成运行或完成。 */
  function track(sessionId: string): void {
    driven.add(sessionId);
    const record = records.get(sessionId);
    if (record) record.generation++;
    else records.set(sessionId, { value: { sessionId, selected: false, relation: "locallyDriven", freshness: "unknown", status: "idle", lastSeq: 0 }, checked: 0, generation: 0 });
    dirty = true;
  }
  /** 普通与退出读取共用提交边界，旧请求、错会话与落后事实不能恢复可信度。 */
  function commitObservation(id: string, generation: number, value?: DesktopSessionStatus, executionSessionId?: string): void {
    const record = records.get(id);
    if (!record || record.generation !== generation) return;
    if (!value || executionSessionId !== undefined && executionSessionId !== id || record.value.turnId && !value.turnId || value.turnId === record.value.turnId && value.lastSeq < record.value.lastSeq) record.value.freshness = "unknown";
    else { record.value = value; record.checked = Date.now(); }
    dirty = true;
  }
  /** 单连接每次只发一帧，ACK 超时直接重连，不累积发送队列。 */
  async function send(payload: Record<string, unknown>): Promise<boolean> {
    const connection = socket;
    if (!connection || connection.destroyed || pending) return false;
    const frame = { ...identity, protocolVersion: 1, seq: ++seq, ...payload };
    const line = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(line) > DESKTOP_STATUS_FRAME_BYTES) { connection.destroy(); return false; }
    return new Promise<boolean>(function awaitAck(resolve) {
      const timeout = setTimeout(function expired() { connection.destroy(); }, 2000);
      timeout.unref();
      pending = { seq, complete: function complete(ok) { clearTimeout(timeout); pending = undefined; resolve(ok); } };
      connection.write(line);
    });
  }
  /** 固定版本快照分批发送，发送期间的新变化合并到下一份快照。 */
  async function publish(): Promise<boolean> {
    if (sending || stopped || !socket || pending) return false;
    sending = true;
    try {
      const sessions = (source ? [...records.values()] : []).map(function current(record) {
        return { ...record.value, selected: source?.selected() === record.value.sessionId, freshness: Date.now() - record.checked <= 15000 ? record.value.freshness : "unknown" as const };
      });
      const content = JSON.stringify({ workspace: source?.workspace, sessions });
      if (!dirty && content === lastSent) return await send({ type: "heartbeat" });
      dirty = false;
      const snapshotId = randomUUID();
      let part = 0;
      let offset = 0;
      do {
        if (stopped) return false;
        const batch: DesktopSessionStatus[] = [];
        let bytes = 1024;
        while (offset < sessions.length && batch.length < 128 && bytes + Buffer.byteLength(JSON.stringify(sessions[offset])) < DESKTOP_STATUS_FRAME_BYTES - 1024) {
          const session = sessions[offset++]; batch.push(session); bytes += Buffer.byteLength(JSON.stringify(session));
        }
        if (!await send({ type: "snapshot", snapshotId, part: part++, final: offset === sessions.length, lifecycle: source ? "ready" : "starting", ...(source ? { workspace: source.workspace } : {}), sessions: batch })) return false;
      } while (offset < sessions.length);
      lastSent = content;
      return true;
    } finally { sending = false; }
  }
  /** 有界四路查询公平推进全部目标，失败或陈旧事实显式未知。 */
  async function refresh(): Promise<void> {
    if (!source || reading || stopped) return;
    reading = true;
    try {
      for (const execution of source.executions()) track(execution.threadId);
      const opened = new Set<string>();
      for (const entry of source.entries()) {
        if (entry.opened) opened.add(entry.sessionId);
        if (!records.has(entry.sessionId)) records.set(entry.sessionId, { value: { sessionId: entry.sessionId, selected: false, relation: "relatedObserved", freshness: "unknown", status: "idle", lastSeq: 0 }, checked: 0, generation: 0 });
      }
      const ids = [...records.keys()];
      const batch = Array.from({ length: Math.min(128, ids.length) }, function fair(_, index) { return ids[(cursor + index) % ids.length]; });
      cursor = ids.length ? (cursor + batch.length) % ids.length : 0;
      let next = 0;
      /** 每个目标最多一次读取在途，超时仅中止观察。 */
      async function worker(): Promise<void> {
        while (next < batch.length && !stopped && !abort.signal.aborted) {
          const id = batch[next++];
          const record = records.get(id)!;
          const generation = ++record.generation;
          const observedSource = source!;
          const queryAbort = new AbortController();
          const timeout = setTimeout(function timeoutRead() { queryAbort.abort(); }, 2000);
          /** 全局退出同步终止本轮只读查询。 */
          function cancelRead() { queryAbort.abort(); }
          abort.signal.addEventListener("abort", cancelRead, { once: true });
          try {
            const summary = await observedSource.read(id, queryAbort.signal);
            if (stopped || queryAbort.signal.aborted || source !== observedSource || !summary) { commitObservation(id, generation); continue; }
            const value = projectDesktopSession(id, summary, driven.has(id) ? "locallyDriven" : opened.has(id) ? "opened" : "relatedObserved", source!.selected() === id);
            if (value.turnId && value.result === "interrupted") {
              if (value.turnId === record.value.turnId && value.lastSeq === record.value.lastSeq && record.value.recoverable !== undefined) value.recoverable = record.value.recoverable;
              else {
                const recovery = await source!.recovery?.(id, value.turnId);
                if (recovery?.sessionId === id && recovery.turnId === value.turnId) value.recoverable = recovery.recoverable;
              }
            }
            if (stopped || queryAbort.signal.aborted || source !== observedSource) { commitObservation(id, generation); continue; }
            commitObservation(id, generation, value, summary.executionView?.sessionId);
          } catch { commitObservation(id, generation); }
          finally { clearTimeout(timeout); abort.signal.removeEventListener("abort", cancelRead); }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, batch.length) }, worker));
    } finally { reading = false; }
  }
  /** 旧连接回调核对对象，重连始终从完整快照开始。 */
  function connect(): void {
    if (stopped) return;
    let connection: Socket;
    try { connection = createConnection(endpoint!); }
    catch {
      reconnect = setTimeout(connect, retry + Math.random() * 100); reconnect.unref(); retry = Math.min(5000, retry * 2);
      return;
    }
    socket = connection;
    connection.unref();
    const lines = new DesktopStatusLines();
    connection.on("connect", function hello() { void send({ type: "hello", token, cliVersion: AUTOPILOT_VERSION }); });
    connection.on("data", function receive(chunk: Buffer) {
      if (socket !== connection) return;
      try {
        for (const value of lines.push(chunk)) {
          if (!isDesktopStatusReply(value)) throw new Error("STATUS_REPLY_INVALID");
          if (value.type === "resync_required") { connection.destroy(); return; }
          if (pending?.seq !== value.seq) continue;
          pending.complete(true);
          if (value.type === "accepted") { retry = 100; dirty = true; void publish(); }
        }
      } catch { connection.destroy(); }
    });
    connection.on("error", function unavailable() { connection.destroy(); });
    connection.on("close", function disconnected() {
      if (socket !== connection) return;
      socket = undefined;
      pending?.complete(false);
      if (!stopped) { reconnect = setTimeout(connect, retry + Math.random() * 100); reconnect.unref(); retry = Math.min(5000, retry * 2); }
    });
  }
  const timer = setInterval(function update() { void refresh(); void publish(); }, 1000);
  timer.unref();
  connect();
  return {
    bind: function bind(value) { for (const record of records.values()) record.generation++; source = value; track(value.selected()); void refresh(); },
    track,
    flush: async function flush() {
      clearInterval(timer); abort.abort();
      if (!source || stopped) return;
      const observedSource = source;
      const id = observedSource.selected();
      const record = records.get(id) ?? { value: { sessionId: id, selected: true, relation: "opened" as const, freshness: "unknown" as const, status: "idle" as const, lastSeq: 0 }, checked: 0, generation: 0 };
      records.set(id, record);
      const generation = ++record.generation;
      commitObservation(id, generation);
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const read = observedSource.read(id, controller.signal);
        const summary = await Promise.race([read, new Promise<null>(function deadline(resolve) { timeout = setTimeout(function expired() { controller.abort(); resolve(null); }, 500); })]);
        if (summary && !controller.signal.aborted && source === observedSource && observedSource.selected() === id) {
          const value = projectDesktopSession(id, summary, driven.has(id) ? "locallyDriven" : "opened", true);
          const previous = records.get(id)?.value;
          if (previous?.turnId === value.turnId && previous?.lastSeq === value.lastSeq) value.recoverable = previous?.recoverable;
          commitObservation(id, generation, value, summary.executionView?.sessionId);
        }
      } catch { commitObservation(id, generation); }
      finally { clearTimeout(timeout); }
      const deadline = Date.now() + 250;
      while ((sending || pending) && Date.now() < deadline) await new Promise(function delay(resolve) { setTimeout(resolve, 10); });
      const published = await Promise.race([publish(), new Promise<boolean>(function bounded(resolve) { setTimeout(function expired() { resolve(false); }, Math.max(0, deadline - Date.now())); })]);
      // 最终降级事实未完整送达时保留断线，不让退出通知恢复旧摘要的可信度。
      if (!published || source !== observedSource || observedSource.selected() !== id || record.generation !== generation) socket?.destroy();
    },
    stop: async function stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer); clearTimeout(reconnect); abort.abort();
      // 退出只有限等待在途状态帧，原业务停机结果已由 Core 持久化。
      const deadline = Date.now() + 250;
      while (pending && Date.now() < deadline) await new Promise(function delay(resolve) { setTimeout(resolve, 10); });
      if (!pending) {
        const flush = send({ type: "ap_exiting" });
        await Promise.race([flush, new Promise(function limit(resolve) { setTimeout(resolve, 100); })]);
      }
      socket?.destroy(); pending?.complete(false);
    },
  };
}
