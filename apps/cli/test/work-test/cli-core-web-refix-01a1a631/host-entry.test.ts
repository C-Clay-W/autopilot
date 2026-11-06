/** S1 正式宿主装配和人类CLI绑定命令回归；采样受控，存储隔离。 */
import { expect, it } from "vitest";
import { createAgentRuntime, createMemoryPorts } from "@autopilot-agent/core";
import { LOCAL_HUMAN_PRINCIPAL_ID } from "@autopilot-agent/adapters";
import { createCliThreadHost } from "../../../src/thread-host.js";
import { createWebThreadHost } from "../../../../web/lib/workspace-host/web-thread-host";
import { parseArgv, renderHelp } from "../../../src/parser.js";
import { executeThreadCommand } from "../../../src/thread-commands.js";

/** 有界等待真实Runner完成自有投递。 */
async function until(probe: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await probe()) return;
    await new Promise(function wait(resolve) { setTimeout(resolve, 25); });
  }
  throw new Error("controlled runner timeout");
}

it("S1 CLI/Web正式Host双在线分别消费自身档位，CLI纯文本能力保持", async function actualHosts() {
  const workspaceRoot = "E:/refix-controlled";
  const ports = createMemoryPorts(workspaceRoot);
  const seed = createAgentRuntime({ ports });
  const project = await seed.projects.create({ name: "controlled", workspaceRoot });
  const capability = { workspaceId: "workspace", stateRootId: "state", projectId: project.id, allowedTools: [], modelCatalog: [], humanPrincipalId: LOCAL_HUMAN_PRINCIPAL_ID };
  const calls: string[] = [];
  /** 记录实际执行宿主与工具目录，不访问Provider。 */
  function runtimeFor(kind: "cli" | "web") {
    return createAgentRuntime({ ports, enableUserQuestions: kind === "web", defaultRunConfig: { workspaceRoot, threads: { ...capability, executionHost: `${kind}-work-v1` }, modelSampler: { async sample(_messages, tools) { calls.push(kind); expect(tools.some(function question(tool) { return tool.function.name === "ask_user_question"; })).toBe(kind === "web"); return { content: "done", toolCalls: [], reasoningSummary: "controlled" }; } } } });
  }
  const cliRuntime = runtimeFor("cli");
  const webRuntime = runtimeFor("web");
  const cliHost = createCliThreadHost({ workspaceId: "workspace", stateRootId: "state", runtime: cliRuntime, ports });
  const webHost = createWebThreadHost({ workspaceId: "workspace", stateRootId: "state", projectId: project.id, workspaceRoot, runtime: webRuntime, ports, capability: { ...capability, executionHost: "web-work-v1" } });
  try {
    const root = await cliRuntime.sessions.create({ projectId: project.id, title: "cli-root" });
    const cli = cliRuntime.threads.bind({ ...capability, executionHost: "cli-work-v1", actor: { kind: "human", principalId: LOCAL_HUMAN_PRINCIPAL_ID } });
    const group = await cli.enable({ protocolVersion: 1, rootThreadId: root.id, requestId: "enable" });
    const child = await cli.create({ protocolVersion: 1, groupId: group.group.groupId, parentThreadId: root.id, requestId: "child" });
    await cli.send({ protocolVersion: 1, groupId: group.group.groupId, threadId: child.threadId, requestId: "run-cli", mode: "run", content: "controlled" });
    webHost.ensureStarted();
    cliHost.start();
    await until(async function completed() { return (await ports.sessionStore.get(child.threadId))?.status === "completed"; });
    expect(calls).toEqual(["cli"]);
    const webRoot = await webRuntime.sessions.create({ projectId: project.id, title: "web-root" });
    const web = webHost.facade();
    const webGroup = await web.enable({ protocolVersion: 1, rootThreadId: webRoot.id, requestId: "web-enable" });
    await web.send({ protocolVersion: 1, groupId: webGroup.group.groupId, threadId: webRoot.id, requestId: "run-web", mode: "run", content: "controlled" });
    webHost.kick();
    await until(async function completed() { return (await ports.sessionStore.get(webRoot.id))?.status === "completed"; });
    expect(calls).toEqual(["cli", "web"]);
  } finally {
    await cliHost.stop();
    await webHost.stop();
  }
});

it("S1 bind-host正常argv到Core CAS入口，help说明参数并拒绝未知档位", async function humanCommand() {
  const ports = createMemoryPorts();
  const runtime = createAgentRuntime({ ports });
  const root = await runtime.sessions.create({ title: "legacy" });
  const threads = runtime.threads.bind({ workspaceId: "workspace", stateRootId: "state", projectId: root.projectId!, allowedTools: [], modelCatalog: [], actor: { kind: "human", principalId: "user" } });
  const enabled = await threads.enable({ protocolVersion: 1, rootThreadId: root.id, requestId: "enable" });
  const groupId = enabled.group.groupId;
  const snapshot = await threads.list({ protocolVersion: 1, groupId });
  const args = ["thread", "bind-host", "--group", groupId, "--thread", root.id, "--expected-revision", String(snapshot.revision), "--execution-host", "cli-work-v1"];
  const parsed = parseArgv(args);
  expect(parsed.kind).toBe("command");
  if (parsed.kind !== "command" || parsed.invocation.command.type !== "thread") throw new Error("missing command");
  const result = await executeThreadCommand(parsed.invocation.command.command, { threads, readFile: async function read() { throw new Error("unused"); }, readStdin: async function read() { throw new Error("unused"); }, write: function write() {}, signal: new AbortController().signal });
  expect(result.result).toMatchObject({ threadId: root.id, executionHost: "cli-work-v1" });
  expect(renderHelp()).toContain("thread bind-host");
  expect(parseArgv([...args.slice(0, -1), "untrusted"])).toMatchObject({ kind: "error" });
});

