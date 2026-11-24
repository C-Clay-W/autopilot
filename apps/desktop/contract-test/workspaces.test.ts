// 本期工作区与第三方观察回归源码，执行统一交给独立测试会话。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { once } from "node:events";
import { ParallelHost, type HostDependencies } from "../src/parallel-host";
import { AgentStatusHost } from "../src/agent-status-host";
import { emptyWorkspace, restoreWorkspace, savedWorkspace } from "../src/workspace";
import { isWorkspaceCommand } from "../src/ipc-policy";
import { prepareAgentIntegration } from "../src/agent-integration";
import { resizePty } from "../src/terminal-host";

// 覆盖三种布局的显式选择、默认回退及重启后类型保留，不启动真实 CLI。
test("手动改选优先于新增终端默认值，未改选与旧布局继续采用默认", async function selectedAgent() {
  const directory = await mkdtemp(join(tmpdir(), "desktop-selected-agent-"));
  const file = join(directory, "layout.json");
  const writes: string[] = [];
  const dependencies: HostDependencies = {
    launch: async function launch() { return { shell: "fake", args: [], env: {} }; },
    spawn: function spawn() { return { onData: function onData() {}, onExit: function onExit() {}, resize: function resize() {}, write: function write(value: string) { writes.push(value.trim()); } } as unknown as ReturnType<HostDependencies["spawn"]>; },
    stop: async function stop() {}, confirm: async function confirm() { return true; },
  };
  try {
    const host = new ParallelHost(file, dependencies);
    await host.registerDirectory(directory);
    await host.command({ type: "terminalPreference", terminal: "codebuddy" });
    const first = await host.command({ type: "create", requestId: "first", mode: "freedom", directory, agent: "codebuddy", desktopWorkspaceId: null });
    for (const mode of ["x2", "x4", "freedom"] as const) {
      const request = { type: "create" as const, requestId: mode, mode, directory, agent: "codex" as const, agentSelected: true, desktopWorkspaceId: first.activeWorkspace };
      assert.equal(isWorkspaceCommand(request), true);
      assert.equal(isWorkspaceCommand({ ...request, agentSelected: "true" }), false);
      const created = await host.command(request);
      const tab = created.tabs.at(-1)!;
      assert.equal(tab.panes.length, mode === "x2" ? 2 : mode === "x4" ? 4 : 0);
      assert.ok(tab.panes.every(function selected(pane) { return pane.agent === "codex"; }));
      await host.command({ type: "add", tabId: tab.id, axis: "row" });
      const added = await host.command({ type: "add", tabId: tab.id, axis: "column" });
      for (const pane of added.tabs.at(-1)!.panes) resizePty(host.session(pane.id, pane.generation), 100, 28);
      assert.ok(writes.every(function selected(command) { return command === "codex"; }));
    }
    // 默认偏好后续变化仅影响未手动改选的 Tab，含缺少新增标记的历史布局。
    await host.command({ type: "terminalPreference", terminal: "shell" });
    const automatic = await host.command({ type: "create", requestId: "automatic", mode: "freedom", directory, agent: "codex", agentSelected: false, desktopWorkspaceId: first.activeWorkspace });
    await host.command({ type: "add", tabId: automatic.activeTab!, axis: "row" });
    const legacy = await host.command({ type: "add", tabId: first.activeTab!, axis: "row" });
    assert.equal(legacy.tabs[0].panes[0].agent, "shell");
    assert.equal(legacy.tabs.at(-1)!.panes[0].agent, "shell");
    const restored = new ParallelHost(file, dependencies);
    await restored.initialize();
    assert.deepEqual(savedWorkspace(restored.snapshot()), savedWorkspace(legacy));
    const manualTab = restored.snapshot().tabs[1];
    const continued = await restored.command({ type: "add", tabId: manualTab.id, axis: "row" });
    assert.equal(continued.tabs[1].panes.at(-1)!.agent, "codex");
    const corrupted = JSON.parse(await readFile(file, "utf8"));
    corrupted.tabs[1].agentSelected = "true";
    assert.throws(function invalidSelection() { restoreWorkspace(corrupted); }, /DESKTOP_LAYOUT_INVALID/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("异步创建冻结组与类型，后续切组不抢焦点，新增采用偏好且恢复保留各终端类型", async function creationRace() {
  const directory = await mkdtemp(join(tmpdir(), "desktop-create-"));
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(function started(resolve) { entered = resolve; });
  const gate = new Promise<void>(function pause(resolve) { release = resolve; });
  const agents: string[] = [];
  const dependencies: HostDependencies = {
    launch: async function launch(agent) { agents.push(agent); entered(); await gate; return { shell: "fake", args: [], env: {} }; },
    spawn: function spawn() { return { onData: function onData() {}, onExit: function onExit() {} } as unknown as ReturnType<HostDependencies["spawn"]>; },
    stop: async function stop() {}, confirm: async function confirm() { return true; },
  };
  const file = join(directory, "layout.json");
  try {
    const host = new ParallelHost(file, dependencies);
    await host.registerDirectory(directory);
    const a = await host.command({ type: "create", requestId: "a", mode: "freedom", directory, agent: "codex", desktopWorkspaceId: null });
    const b = await host.command({ type: "create", requestId: "b", mode: "freedom", directory, agent: "opencode", desktopWorkspaceId: null });
    const creating = host.command({ type: "create", requestId: "pending", mode: "x2", directory, agent: "claude", desktopWorkspaceId: a.workspaces[0].id });
    await ready;
    const switching = host.command({ type: "workspaceActivate", desktopWorkspaceId: b.workspaces[1].id });
    release();
    const created = await creating;
    const tab = created.tabs[2];
    assert.equal(tab.desktopWorkspaceId, a.workspaces[0].id);
    assert.equal(tab.agent, "claude");
    const switched = await switching;
    assert.equal(switched.activeWorkspace, b.workspaces[1].id);
    await host.command({ type: "preference", agent: "codebuddy" });
    await host.command({ type: "terminalPreference", terminal: "opencode" });
    await host.command({ type: "add", tabId: tab.id, axis: "row" });
    assert.deepEqual(agents, ["claude", "claude", "opencode"]);
    const restored = new ParallelHost(file, dependencies);
    await restored.initialize();
    assert.deepEqual(agents, ["claude", "claude", "opencode", "claude", "claude", "opencode"]);
    assert.equal(restored.snapshot().tabs[2].agent, "claude");
  } finally { release(); await rm(directory, { recursive: true, force: true }); }
});

test("同目录独立工作区、组内Tab、重命名编号、偏好与新格式重复恢复", async function navigation() {
  const directory = await mkdtemp(join(tmpdir(), "desktop-groups-"));
  const file = join(directory, "layout.json");
  const dependencies = { launch: async function unused() { throw new Error("unused"); }, spawn: function unused() { throw new Error("unused"); }, stop: async function stop() {}, confirm: async function confirm() { return true; } };
  try {
    const host = new ParallelHost(file, dependencies);
    await host.registerDirectory(directory);
    const first = await host.command({ type: "create", requestId: "first", mode: "freedom", directory, agent: "codex", desktopWorkspaceId: null });
    const group = first.workspaces[0];
    const next = await host.command({ type: "create", requestId: "next", mode: "freedom", directory, agent: "claude", desktopWorkspaceId: group.id });
    assert.equal(next.workspaces.length, 1);
    assert.equal(next.tabs.length, 2);
    await host.command({ type: "create", requestId: "other", mode: "freedom", directory, agent: "opencode", desktopWorkspaceId: null });
    await host.command({ type: "workspaceRename", desktopWorkspaceId: group.id, name: "重命名" });
    await host.command({ type: "preference", agent: "codebuddy" });
    const active = await host.command({ type: "workspaceActivate", desktopWorkspaceId: group.id });
    assert.equal(active.activeTab, next.tabs[1].id);
    assert.equal(active.workspaces.length, 2);
    assert.equal(active.nextWorkspaceNumber, 3);
    assert.equal(active.tabs[0].agent, "codex");
    const restoredHost = new ParallelHost(file, dependencies);
    await restoredHost.initialize();
    assert.deepEqual(savedWorkspace(restoredHost.snapshot()), savedWorkspace(active));
    const closed = await restoredHost.command({ type: "close", tabId: active.tabs[0].id });
    const empty = await restoredHost.command({ type: "close", tabId: next.tabs[1].id });
    assert.equal(closed.workspaces.length, 2);
    assert.equal(empty.workspaces.find(function target(item) { return item.id === group.id; })?.activeTab, null);
    assert.equal(empty.activeTab, null);
    assert.equal(empty.defaultAgent, "codebuddy");
    assert.deepEqual(restoreWorkspace({ version: 1, tabs: [] }), emptyWorkspace());
    assert.equal(isWorkspaceCommand({ type: "preference", agent: "evil" }), false);
    assert.equal(isWorkspaceCommand({ type: "workspaceRename", desktopWorkspaceId: group.id, name: "\n" }), false);
    assert.equal(isWorkspaceCommand({ type: "create", requestId: "r", directory, agent: "codex", desktopWorkspaceId: null, mode: "freedom", command: "evil" }), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("第三方认证、同代次多实例、迟到事件、短连接与退出不伪造任务", async function observed() {
  const host = new AgentStatusHost(function changed() {});
  await host.start();
  const env = host.register("pane-1", 1);
  let stamp = 0;
  const instanceId = "11111111-1111-4111-8111-111111111111";
  /** 每个事件使用独立短连接，退出由显式 CLI 生命周期提供。 */
  async function send(event: string, extra: Record<string, unknown> = {}) {
    const socket = createConnection(env.AUTOPILOT_AGENT_ENDPOINT);
    socket.on("error", function ignore() {});
    await once(socket, "connect");
    const finished = once(socket, "close");
    socket.resume();
    socket.end(JSON.stringify({ paneId: "pane-1", generation: 1, token: env.AUTOPILOT_AGENT_TOKEN, instanceId, agent: "codex", event, session: "a".repeat(64), turn: "", stamp: String(++stamp), ...extra }) + "\n");
    await finished;
  }
  try {
    await send("begin");
    await send("ready");
    assert.equal(host.snapshot("pane-1")[0].status, "idle");
    await send("submit", { turn: "b".repeat(64) });
    await send("done", { turn: "b".repeat(64) });
    await send("done", { turn: "b".repeat(64) });
    assert.equal(host.snapshot("pane-1")[0].status, "completed");
    await send("submit", { turn: "c".repeat(64) });
    await send("done", { turn: "b".repeat(64) });
    assert.equal(host.snapshot("pane-1")[0].status, "running");
    await send("waiting", { turn: "c".repeat(64) });
    assert.equal(host.snapshot("pane-1")[0].status, "waiting");
    await send("activity", { token: "forged", turn: "c".repeat(64) });
    assert.equal(host.snapshot("pane-1")[0].status, "waiting");
    await send("begin", { instanceId: "22222222-2222-4222-8222-222222222222" });
    assert.equal(host.snapshot("pane-1").length, 2);
    await send("exit");
    await send("done", { turn: "c".repeat(64) });
    assert.deepEqual(host.snapshot("pane-1").map(function id(instance) { return instance.instanceId; }), ["22222222-2222-4222-8222-222222222222"]);
    await send("begin");
    assert.equal(host.snapshot("pane-1").length, 1);
    assert.equal(JSON.stringify(host.snapshot("pane-1")).includes(env.AUTOPILOT_AGENT_TOKEN), false);
    host.shellExited("pane-1", 2);
    assert.equal(host.snapshot("pane-1").length, 1);
    host.shellExited("pane-1", 1);
    assert.equal(host.snapshot("pane-1").length, 0);
    await send("begin");
    assert.equal(host.snapshot("pane-1").length, 0);
    host.register("pane-1", 2);
    await send("begin");
    assert.equal(host.snapshot("pane-1").length, 0);
  } finally { await host.stop(); }
});

test("局部适配生成不写用户配置，四 CLI 分别保持原生能力边界", async function localInjection() {
  const directory = await mkdtemp(join(tmpdir(), "desktop-observer-"));
  try {
    const runner = await prepareAgentIntegration(directory, process.execPath);
    const source = await readFile(runner, "utf8");
    assert.match(source, /--plugin-dir/);
    assert.match(source, /OPENCODE_CONFIG_CONTENT/);
    assert.doesNotMatch(source, /dangerously-bypass-hook-trust|CODEX_HOME\s*=/);
    const hooks = JSON.parse(await readFile(join(directory, "agent-observer/codex-hooks.json"), "utf8"));
    assert.ok(hooks.hooks.Interrupt);
    assert.ok(hooks.hooks.PermissionRequest);
    assert.equal(hooks.hooks.StopFailure, undefined);
    const plugin = await readFile(join(directory, "agent-observer/opencode.mjs"), "utf8");
    assert.match(plugin, /info.parentID/);
    assert.doesNotMatch(plugin, /report\('failed'/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// 执行生成的真实 hook 命令，验证带空格和特殊字符的路径及运行到完成的观察投递。
test("Codex hook 通过原生 Shell 投递运行和完成事件", async function codexHookDelivery() {
  const directory = await mkdtemp(join(tmpdir(), "desktop-codex-hook-"));
  const host = new AgentStatusHost(function changed() {});
  const shells = process.platform === "win32" ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")] : ["/bin/sh"];
  const pwsh = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).map(function executable(path) { return join(path, "pwsh.exe"); }).find(existsSync);
  if (process.platform === "win32" && pwsh) shells.push(pwsh);
  try {
    const runner = await prepareAgentIntegration(join(directory, "测试 O'Brien $hook"), process.execPath);
    const definition = JSON.parse(await readFile(join(runner, "..", "codex-hooks.json"), "utf8"));
    await host.start();
    assert.equal(host.available(), true);
    for (const shell of shells) {
      const env = { ...process.env, ...host.register("pane-hook", 1), AUTOPILOT_AGENT_TYPE: "codex", AUTOPILOT_AGENT_RUN: randomUUID() };
      // 异步等待子进程，主进程继续接收管道事件和返回 ACK。
      async function invoke(program: string, args: string[], input = "") {
        const child = spawn(program, args, { env, windowsHide: true, timeout: 3000, stdio: "pipe" });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", function output(chunk) { stdout += chunk; });
        child.stderr.on("data", function error(chunk) { stderr += chunk; });
        const closed = once(child, "close");
        child.stdin.end(input);
        const [code] = await closed;
        assert.equal(code, 0, stderr);
        assert.equal(stderr, "");
        return stdout;
      }
      await invoke(process.execPath, ["-e", "require(process.argv[1]).report('begin')", runner]);
      assert.equal(host.snapshot("pane-hook")[0].observation, "pending");
      for (const [event, status] of [["SessionStart", "idle"], ["UserPromptSubmit", "running"], ["PermissionRequest", "waiting"], ["PostToolUse", "running"], ["Stop", "completed"]]) {
        const handler = definition.hooks[event][0].hooks[0];
        assert.equal(handler.timeout, 3);
        const args = process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", handler.command] : ["-c", handler.command];
        const output = await invoke(shell, args, JSON.stringify({ hook_event_name: event, session_id: "session-hook", ...(event === "SessionStart" ? {} : { turn_id: "turn-hook" }) }));
        assert.equal(output, event === "Stop" ? "{}" : "");
        assert.equal(host.snapshot("pane-hook")[0].observation, "enabled");
        assert.equal(host.snapshot("pane-hook")[0].status, status);
      }
    }
  } finally { await host.stop(); await rm(directory, { recursive: true, force: true }); }
});

// 直接调用链验证导航回调与PTY登记携带工作区ID，不启动真实终端或Electron。
test("browser workspace navigation forwards stable IDs and deletion lifecycle", async function browserNavigation() {
  const directory = await mkdtemp(join(tmpdir(), "desktop-browser-workspaces-"));
  const events: Array<{ active: string | null; ids: string[] }> = [];
  const registered: Array<{ directory: string; id?: string }> = [];
  const dependencies: HostDependencies = {
    launch: async function launch() { return { shell: "fake", args: [], env: {} }; },
    spawn: function spawn() { return { onData: function onData() {}, onExit: function onExit() {} } as unknown as ReturnType<HostDependencies["spawn"]>; },
    stop: async function stop() {}, confirm: async function confirm() { return true; },
    browser: { register: function register(_pane: string, _generation: number, _label: string, root: string, id?: string) { registered.push({ directory: root, id }); return {}; }, release: function release() {} } as unknown as NonNullable<HostDependencies["browser"]>,
    browserWorkspaceChanged: async function changed(active, groups) { events.push({ active, ids: groups.map(function id(group) { return group.id; }) }); },
  };
  try {
    const host = new ParallelHost(join(directory, "layout.json"), dependencies);
    await host.registerDirectory(directory);
    const a = await host.command({ type: "create", requestId: "a", mode: "x2", directory, agent: "ap", desktopWorkspaceId: null });
    const aId = a.activeWorkspace!;
    const anotherTab = await host.command({ type: "create", requestId: "a-tab", mode: "freedom", directory, agent: "ap", desktopWorkspaceId: aId });
    await host.command({ type: "activate", tabId: a.tabs[0].id });
    assert.equal(events.at(-1)?.active, aId); assert.deepEqual(events.at(-1)?.ids, [aId]);
    const b = await host.command({ type: "create", requestId: "b", mode: "x2", directory, agent: "ap", desktopWorkspaceId: null });
    const bId = b.activeWorkspace!;
    assert.notEqual(aId, bId);
    assert.deepEqual(registered.map(function id(entry) { return entry.id; }), [aId, aId, aId, bId, bId]);
    assert.ok(registered.every(function same(entry) { return entry.directory === directory; }));
    await host.command({ type: "workspaceActivate", desktopWorkspaceId: aId });
    assert.equal(events.at(-1)?.active, aId);
    await host.command({ type: "close", tabId: anotherTab.activeTab! });
    assert.deepEqual(events.at(-1)?.ids, [aId, bId]);
    await host.command({ type: "workspaceDelete", desktopWorkspaceId: aId });
    assert.deepEqual(events.at(-1), { active: bId, ids: [bId] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
