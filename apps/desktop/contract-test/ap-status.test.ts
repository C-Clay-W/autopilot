// Desktop 状态通道与安全聚合合同回归，使用真实本机 pipe/socket 和受控事实，不使用 Provider。
import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApStatusHost, type DesktopApStatus } from "../src/ap-status-host";
import { ParallelHost } from "../src/parallel-host";
import { arrange, restoreWorkspace, savedWorkspace, sessionTask, summarizeAp, type Pane } from "../src/workspace";
import { shellSpec } from "../src/terminal-host";
import type { DesktopSessionStatus } from "@autopilot-agent/adapters";
import { createDesktopStatus } from "../../cli/src/desktop-status";

const session: DesktopSessionStatus = { sessionId: "session-1", turnId: "turn-1", selected: true, relation: "locallyDriven", freshness: "fresh", status: "completed", execution: "inactive", result: "completed", lastSeq: 10 };

test("Parallel PTY 声明 xterm 能力并隔离父终端颜色开关", function parallelTerminalCapabilities() {
  const parent = { TERM: "dumb", NO_COLOR: "1", CLICOLOR: "0", FORCE_COLOR: "0" };
  for (const node of ["node", null]) {
    const spec = shellSpec("win32", node, "cli", "bootstrap", parent);
    assert.equal(spec.env.TERM, "xterm-256color");
    assert.equal(spec.env.NO_COLOR, undefined);
    assert.equal(spec.env.CLICOLOR, undefined);
    assert.equal(spec.env.FORCE_COLOR, undefined);
  }
  assert.equal(parent.TERM, "dumb");
  assert.equal(parent.NO_COLOR, "1");
});

/** 创建单帧等待 ACK 的真实本机客户端，凭据仅在测试内存中使用。 */
async function client(env: Record<string, string>, apInstanceId: string, initialSeq = 0) {
  const socket = createConnection(env.AUTOPILOT_DESKTOP_STATUS_ENDPOINT);
  socket.on("error", function unavailable() {});
  await once(socket, "connect");
  const lines = createInterface({ input: socket });
  let seq = initialSeq;
  /** 固定身份随帧发送，不允许测试客户端改写路由。 */
  async function send(payload: Record<string, unknown>) {
    const reply = once(lines, "line");
    socket.write(JSON.stringify({ protocolVersion: 1, desktopInstanceId: env.AUTOPILOT_DESKTOP_STATUS_INSTANCE_ID, paneId: env.AUTOPILOT_DESKTOP_STATUS_PANE_ID, generation: Number(env.AUTOPILOT_DESKTOP_STATUS_GENERATION), apInstanceId, seq: ++seq, ...payload }) + "\n");
    return JSON.parse((await reply)[0]);
  }
  await send({ type: "hello", token: env.AUTOPILOT_DESKTOP_STATUS_TOKEN, cliVersion: "0.3.0" });
  return { socket, send, close: function close() { lines.close(); socket.destroy(); } };
}
/** 为同一固定快照构造连续批次。 */
function snapshot(part: number, final: boolean, sessions: DesktopSessionStatus[] = []) {
  return { type: "snapshot", snapshotId: "snapshot-1", part, final, lifecycle: "ready", workspace: { workspaceId: "workspace-1", stateRootId: "state-1", projectId: "project-1", displayName: "project" }, sessions };
}

test("本机认证、完整批次、同 Shell 超过16 AP、重连、代次撤销与隐私", { timeout: 15000 }, async function nativeChannel() {
  const host = new ApStatusHost(function changed() {});
  const clients: Awaited<ReturnType<typeof client>>[] = [];
  await host.start();
  assert.equal(host.available(), true);
  const env = host.register("pane-1", 1);
  try {
    const first = await client(env, "ap-1"); clients.push(first);
    await first.send(snapshot(0, false, [session]));
    assert.equal(host.snapshot("pane-1")[0].connection, "syncing");
    assert.equal(host.snapshot("pane-1")[0].sessions.length, 0);
    await first.send(snapshot(1, true, [{ ...session, sessionId: "session-2", turnId: "turn-2", status: "running", result: undefined, execution: "active" }]));
    assert.equal(host.snapshot("pane-1")[0].sessions.length, 2);
    for (let index = 2; index <= 17; index++) clients.push(await client(env, `ap-${index}`));
    assert.equal(host.snapshot("pane-1").length, 17);
    const replacement = await client(env, "ap-1", 3); clients.push(replacement);
    await replacement.send(snapshot(0, true, [session]));
    assert.equal(host.snapshot("pane-1").find(function first(ap) { return ap.apInstanceId === "ap-1"; })?.connection, "connected");
    const safe = JSON.stringify(host.snapshot("pane-1"));
    assert.equal(safe.includes(env.AUTOPILOT_DESKTOP_STATUS_TOKEN), false);
    assert.equal(safe.includes(env.AUTOPILOT_DESKTOP_STATUS_ENDPOINT), false);
    await replacement.send(snapshot(0, false, []));
    await replacement.send({ type: "ap_exiting" });
    const incompleteExit = host.snapshot("pane-1").find(function first(ap) { return ap.apInstanceId === "ap-1"; })!;
    assert.equal(incompleteExit.connection, "exited");
    assert.equal(sessionTask(incompleteExit, incompleteExit.sessions[0]), "unknown");
    const exited = once(replacement.socket, "close");
    host.register("pane-1", 2);
    await exited;
    assert.deepEqual(host.snapshot("pane-1"), []);
    const unauthorized = createConnection(env.AUTOPILOT_DESKTOP_STATUS_ENDPOINT);
    unauthorized.on("error", function refused() {});
    await once(unauthorized, "connect");
    const denied = once(unauthorized, "close");
    unauthorized.write(JSON.stringify({ protocolVersion: 1, desktopInstanceId: env.AUTOPILOT_DESKTOP_STATUS_INSTANCE_ID, paneId: "pane-1", generation: 1, apInstanceId: "old-ap", seq: 1, type: "hello", token: env.AUTOPILOT_DESKTOP_STATUS_TOKEN, cliVersion: "0.3.0" }) + "\n");
    await denied;
    assert.deepEqual(host.snapshot("pane-1"), []);
  } finally { for (const item of clients) item.close(); await host.stop(); }
});

test("状态映射保留恢复和未知，父完成子运行去重，断线不伪造退出", function mapping() {
  const ap: DesktopApStatus = { apInstanceId: "ap-1", lifecycle: "ready", connection: "connected", workspace: { workspaceId: "workspace-1", stateRootId: "state-1", projectId: "project-1", displayName: "project" }, sessions: [session] };
  assert.equal(sessionTask(ap, session), "completed");
  assert.equal(sessionTask({ ...ap, connection: "disconnected" }, session), "unknown");
  assert.equal(sessionTask(ap, { ...session, result: undefined, waiting: "approval", interaction: "decided", continuation: "failed" }), "recovery_failed");
  assert.equal(sessionTask(ap, { ...session, result: "interrupted", recoverable: true }), "recoverable");
  assert.equal(sessionTask(ap, { ...session, result: "limit_reached" }), "limited");
  const child = { ...session, sessionId: "child-1", turnId: "child-turn", result: undefined, execution: "active" as const, status: "running" as const };
  ap.sessions.push(child);
  const pane: Pane = { id: "pane-1", number: 1, generation: 1, process: "shell", task: "unknown", aps: [ap, { ...ap, apInstanceId: "ap-2" }] };
  assert.equal(summarizeAp([pane]).unfinished, 1);
  assert.equal(summarizeAp([pane]).connected, 2);
  pane.aps![1] = { ...ap, apInstanceId: "ap-2", sessions: [{ ...child, freshness: "unknown" }] };
  assert.equal(summarizeAp([pane]).unfinished, 0);
  assert.equal(summarizeAp([pane]).unknown, 1);
});

test("真实 CLI 出口与 Host 完成分批同步，后台恢复身份可发现，退出有限刷新", { timeout: 15000 }, async function reporterIntegration() {
  const host = new ApStatusHost(function changed() {});
  await host.start();
  const reporter = createDesktopStatus(host.register("pane-1", 1));
  assert.ok(reporter);
  let completed = false;
  const workspace = { workspaceId: "workspace-1", stateRootId: "state-1", projectId: "project-1", displayName: "project" };
  reporter.bind({
    workspace,
    selected: function selected() { return "session-0"; },
    entries: function entries() { return Array.from({ length: 270 }, function entry(_, index) { return { sessionId: `session-${index}`, opened: true }; }); },
    executions: function executions() { return [{ threadId: "resumed-background", turnId: "resumed-turn" }]; },
    read: async function read(sessionId) { return { executionView: { sessionId, turnId: `${sessionId}-turn`, status: completed ? "completed" : "running", execution: completed ? "inactive" : "active", result: completed ? "completed" : undefined, lastSeq: completed ? 2 : 1 } }; },
  });
  try {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline && host.snapshot("pane-1")[0]?.sessions.filter(function fresh(row) { return row.freshness === "fresh"; }).length !== 271) await new Promise(function wait(resolve) { setTimeout(resolve, 30); });
    const ap = host.snapshot("pane-1")[0];
    assert.equal(ap.sessions.length, 271);
    assert.equal(ap.sessions.find(function resumed(row) { return row.sessionId === "resumed-background"; })?.relation, "locallyDriven");
    completed = true;
    await reporter.flush();
    await reporter.stop();
    const final = host.snapshot("pane-1")[0];
    assert.equal(final.connection, "exited");
    assert.equal(final.sessions.find(function selected(row) { return row.selected; })?.result, "completed");
  } finally { await reporter.stop(); await host.stop(); }
});

test("超过64窗格和Tab及深度的合法布局可恢复，运行凭据不持久化", function layoutScale() {
  const panes = Array.from({ length: 70 }, function pane(_, index) { return { id: `pane-${index}`, number: index + 1 }; });
  let layout = arrange([panes[0].id], "row")!;
  for (const pane of panes.slice(1)) layout = { kind: "split", axis: "row", ratio: 0.5, first: layout, second: { kind: "leaf", id: pane.id } };
  const tabs = Array.from({ length: 65 }, function tab(_, index) { return { id: `tab-${index}`, desktopWorkspaceId: "group-1", agent: "ap", name: "project", directory: null, panes: index === 0 ? panes : [], layout: index === 0 ? layout : null, focused: null, expanded: null, nextNumber: 71 }; });
  const stored = { version: 2, workspaces: [{ id: "group-1", name: "工作区 1", number: 1, directory: "project", activeTab: "tab-0" }], activeWorkspace: "group-1", nextWorkspaceNumber: 2, defaultAgent: "ap", tabs };
  const restored = restoreWorkspace(stored);
  assert.equal(restored.tabs.length, 65); assert.equal(restored.tabs[0].panes.length, 70);
  restored.tabs[0].panes[0].aps = [{ apInstanceId: "private-instance", lifecycle: "ready", connection: "connected", sessions: [session] }];
  assert.equal(JSON.stringify(savedWorkspace(restored)).includes("private-instance"), false);
  assert.throws(function duplicate() { restoreWorkspace({ ...stored, tabs: [tabs[0], tabs[0]] }); });
});

test("Workspace分块保持版本且完整收齐，Win/Mac Shell 清除继承旧凭据", async function pagesAndPlatforms() {
  const directory = await mkdtemp(join(tmpdir(), "ap-status-test-"));
  try {
    const host = new ParallelHost(join(directory, "layout.json"), { launch: async function unused() { throw new Error("unused"); }, spawn: function unusedSpawn() { throw new Error("unused"); }, stop: async function unusedStop() {}, confirm: async function confirm() { return true; } });
    const selected = await host.registerDirectory(directory);
    for (let index = 0; index < 65; index++) await host.command({ type: "create", requestId: `request-${index}`, mode: "freedom", directory: selected.path, agent: "ap", desktopWorkspaceId: null });
    let page = host.snapshotPage(); const chunks = [page.chunk]; const revision = page.revision;
    host.statusChanged();
    while (!page.final) { page = host.snapshotPage(page.snapshotId, chunks.join("").length); assert.equal(page.revision, revision); chunks.push(page.chunk); }
    assert.equal(JSON.parse(chunks.join("")).tabs.length, 65);
    for (const platform of ["win32", "darwin"]) {
      const spec = shellSpec(platform, "node", "cli", "bootstrap", { AUTOPILOT_DESKTOP_STATUS_TOKEN: "old-secret", AUTOPILOT_DESKTOP_STATUS_ENDPOINT: "old-endpoint" });
      assert.equal(spec.env.AUTOPILOT_DESKTOP_STATUS_TOKEN, undefined); assert.equal(spec.env.AUTOPILOT_DESKTOP_STATUS_ENDPOINT, undefined);
    }
    // Mac 原生权限留实机验证，这里只核验 UDS 私有目录与清理分支存在。
    const source = await readFile(join(process.cwd(), "src/ap-status-host.ts"), "utf8");
    assert.match(source, /chmod\(path, 0o700\)/); assert.match(source, /chmod\(this.endpoint, 0o600\)/); assert.match(source, /\.ino === this.directory.ino/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
