/**
 * MCP stdio Runtime 契约测试：授权启动、命名空间工具注册、外部审批事实与配置失效。
 *
 * Talk-Plan0917 Stage 6：审批层（grant）与沙箱层（SandboxPort.prepare）分别可观察且
 * 均需成立——grant 未命中不进入沙箱层；grant 命中但绑定缺失/能力不可执行/prepare
 * 失败时 fail-closed（MCP_SERVER_SANDBOX_FAILED），不产生任何进程；server 崩溃与
 * 正常关闭都要释放沙箱执行资源。透传 fake Port 下 JSON-RPC 走真实子进程验证。
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { getMcpServerConfigHash, getMcpServerGrantConstraint, parseMcpConfig, type McpServerConfig } from "../../runtime/protocol";
import { SANDBOX_ERROR_CODES, type SandboxExecutionRequest, type SandboxPreparedCommand } from "../../runtime/domain/sandbox-policy";
import { SandboxPortError, type SandboxPort } from "../../runtime/ports";
import { McpStdioRuntime, createMcpServerStartActionFacts } from "./mcp-runtime";

const fixture = "const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const q=JSON.parse(line);if(q.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{}}));else if(q.method==='tools/list')console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{tools:[{name:'echo.value',description:'fixture',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}]}}));else if(q.method==='tools/call')console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:q.params.arguments.value}]}}));else if(q.method==='shutdown')console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{}}));});";
const environmentFixture = "const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const q=JSON.parse(line);if(q.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{}}));else if(q.method==='tools/list')console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{tools:[{name:'read.environment',description:'fixture',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}}));else if(q.method==='tools/call')console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:JSON.stringify({TEMP:process.env.TEMP??null,temp:process.env.temp??null,keys:Object.keys(process.env).filter(key=>key.toUpperCase()==='TEMP')})}]}}));else if(q.method==='shutdown')console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{}}));});";
const crashFixture = "process.exit(1);";

type McpEnvironmentTestAccess = {
  resolveEnvironment(server: McpServerConfig): Promise<NodeJS.ProcessEnv>;
};

/** 构造只接受精确 MCP server 授权的 fixture 配置。 */
function createCapability(fixtureSource: string = fixture, execution: "sandbox" | "host" = "sandbox") {
  return parseMcpConfig({ mcpServers: { fixture: { command: process.execPath, args: ["-e", fixtureSource], execution } } });
}

/** 透传式 fake 沙箱 Port：记录 prepare/release 供断言；prepare 原样返回 argv，真实 RPC 在真实子进程上执行。 */
function createFakeSandboxPort(options: { enforcement?: "full" | "partial" | "unavailable"; prepareError?: SandboxPortError; preparedEnv?: Record<string, string> } = {}) {
  const enforcement = options.enforcement ?? "full";
  const prepared: SandboxExecutionRequest[] = [];
  const released: string[] = [];
  const port: SandboxPort = {
    async status() { return { platform: "macos", backend: "fake", enforcement }; },
    async setup() { throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "fake sandbox setup 不可用"); },
    async prepare(request: SandboxExecutionRequest): Promise<SandboxPreparedCommand> {
      if (options.prepareError) throw options.prepareError;
      prepared.push(request);
      return { executionId: request.commandId, executable: request.program, args: [...request.args], env: { ...(options.preparedEnv ?? {}) }, enforcement };
    },
    async release(executionId: string) { released.push(executionId); },
    async shutdown() {},
  };
  return { port, prepared, released };
}

/** 构造带冻结沙箱绑定的 Work 模式 runtime options。 */
function bindingFor(port: SandboxPort) {
  return { port, mode: "workspace-write" as const };
}

describe("McpStdioRuntime", () => {
  it("缺省 host 与显式 sandbox 使用不同 hash，旧默认 sandbox grant 不会授权 host", async function rejectsLegacySandboxGrantForDefaultHost() {
    const hostCapability = parseMcpConfig({ mcpServers: { fixture: { command: process.execPath, args: ["-e", fixture] } } });
    const sandboxCapability = parseMcpConfig({ mcpServers: { fixture: { command: process.execPath, args: ["-e", fixture], execution: "sandbox" } } });
    const hostServer = hostCapability.servers[0]!;
    const sandbox = createFakeSandboxPort();
    const legacySandboxHash = createHash("sha256").update(JSON.stringify({
      name: hostServer.name,
      command: hostServer.command,
      args: hostServer.args ?? [],
      cwd: hostServer.cwd ?? ".",
      env: Object.entries(hostServer.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    })).digest("hex");
    const legacySandboxConstraint = `mcp-server:${hostServer.name}:${legacySandboxHash}`;
    const runtime = new McpStdioRuntime({
      capability: hostCapability,
      workspaceRoot: process.cwd(),
      workspaceTrusted: true,
      resolvePersistentGrant: async function matchLegacySandboxGrant({ constraint }) { return constraint === legacySandboxConstraint; },
      sandbox: bindingFor(sandbox.port),
    });

    expect(hostServer.execution).toBe("host");
    expect(sandboxCapability.servers[0]?.execution).toBe("sandbox");
    expect(getMcpServerConfigHash(hostServer)).not.toBe(getMcpServerConfigHash(sandboxCapability.servers[0]!));
    await runtime.initialize();

    expect(runtime.getServerStates()).toEqual([{ serverName: "fixture", state: "configured", executionMode: "host", isolation: "unisolated" }]);
    expect(runtime.getDiagnostics()).toEqual([{ serverName: "fixture", code: "MCP_SERVER_APPROVAL_REQUIRED" }]);
    expect(sandbox.prepared).toHaveLength(0);
  });

  it("Stage3：默认 host 即使命中 server grant 仍阻塞且不注册工具", async function blocksDirectConfigAsDefaultHost() {
    const server: McpServerConfig = { name: "fixture", command: process.execPath, args: ["-e", fixture] };
    const sandbox = createFakeSandboxPort();
    let requestedConstraint: string | undefined;
    const runtime = new McpStdioRuntime({
      capability: { servers: [server] },
      workspaceRoot: process.cwd(),
      workspaceTrusted: true,
      resolvePersistentGrant: async function matchDefaultHostGrant({ constraint }) {
        requestedConstraint = constraint;
        return constraint === getMcpServerGrantConstraint(server);
      },
      sandbox: bindingFor(sandbox.port),
    });

    expect(runtime.getServerStates()).toEqual([{ serverName: "fixture", state: "configured", executionMode: "host", isolation: "unisolated" }]);
    try {
      await runtime.initialize();
      expect(runtime.getToolDefinitions()).toEqual([]);
      expect(runtime.getServerStates()).toEqual([{ serverName: "fixture", state: "failed", executionMode: "host", isolation: "unisolated" }]);
      expect(requestedConstraint).toBe(getMcpServerGrantConstraint(server));
      expect(getMcpServerConfigHash(server)).toBe(getMcpServerConfigHash(parseMcpConfig({ mcpServers: { fixture: { command: process.execPath, args: ["-e", fixture] } } }).servers[0]!));
      expect(runtime.getDiagnostics()).toEqual([{ serverName: "fixture", code: "MCP_SERVER_SANDBOX_FAILED" }]);
      expect(sandbox.prepared).toHaveLength(0);
    } finally {
      await runtime.shutdown();
    }
  });

  it("未命中精确 grant 时不启动 server，也不注册伪工具（审批层先失败，不进入沙箱层）", async () => {
    const sandbox = createFakeSandboxPort();
    const runtime = new McpStdioRuntime({ capability: createCapability(), workspaceRoot: process.cwd(), workspaceTrusted: true, sandbox: bindingFor(sandbox.port) });
    await runtime.initialize();
    expect(runtime.getToolDefinitions()).toEqual([]);
    expect(runtime.getDiagnostics()).toEqual([{ serverName: "fixture", code: "MCP_SERVER_APPROVAL_REQUIRED" }]);
    expect(sandbox.prepared).toHaveLength(0);
  });

  it("命中 grant 且沙箱就绪后完成 stdio initialize/list/call，并将工具标为外部审批", async () => {
    const sandbox = createFakeSandboxPort();
    const runtime = new McpStdioRuntime({
      capability: createCapability(),
      workspaceRoot: process.cwd(),
      workspaceTrusted: true,
      resolvePersistentGrant: async () => true,
      sandbox: bindingFor(sandbox.port),
      permissionMode: "ask",
    });
    try {
      await runtime.initialize();
      const [tool] = runtime.getToolDefinitions();
      expect(tool?.name).toBe("mcp__fixture__echo_value");
      expect(tool?.createActionFacts({ value: "ok" }, { permissionMode: "ask", agentFlow: { async search() { return []; } } })).toMatchObject({ effect: "external", risk: "external_side_effect", executionIsolation: "sandboxed", requiresApproval: true });
      await expect(tool?.execute({ value: "ok" }, { permissionMode: "ask", agentFlow: { async search() { return []; } } })).resolves.toMatchObject({ content: [{ text: "ok" }] });
      // server 启动必须经过 SandboxPort.prepare，且消费冻结 policy 的结构化 argv。
      expect(sandbox.prepared).toHaveLength(1);
      expect(sandbox.prepared[0]).toMatchObject({ program: process.execPath, policy: { mode: "workspace-write" } });
      expect(runtime.getServerStates()).toEqual([{ serverName: "fixture", state: "ready", executionMode: "sandbox", isolation: "sandboxed" }]);
    } finally {
      await runtime.shutdown();
    }
    // 正常关闭后沙箱执行资源恰好释放一次。
    expect(sandbox.released).toEqual([sandbox.prepared[0]!.commandId]);
  });

  it("Windows prepared env 按大小写不敏感规则覆盖 server.env 的 TEMP，其他平台保持原行为", async () => {
    const sandbox = createFakeSandboxPort({ preparedEnv: { TEMP: "r010-sandbox-mapped-temp" } });
    const capability = parseMcpConfig({
      mcpServers: {
        fixture: {
          command: process.execPath,
          execution: "sandbox",
          env: { temp: "r010-server-temp" },
          args: ["-e", environmentFixture],
        },
      },
    });
    const runtime = new McpStdioRuntime({
      capability,
      workspaceRoot: process.cwd(),
      workspaceTrusted: true,
      resolvePersistentGrant: async () => true,
      sandbox: bindingFor(sandbox.port),
    });

    try {
      await runtime.initialize();
      const [tool] = runtime.getToolDefinitions();
      if (!tool) throw new Error("MCP fixture tool missing");
      const result = await tool.execute({}, { permissionMode: "ask", agentFlow: { async search() { return []; } } });
      if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) throw new Error("MCP fixture content missing");
      const [content] = result.content;
      if (!content || typeof content !== "object" || !("type" in content) || content.type !== "text" || !("text" in content) || typeof content.text !== "string") throw new Error("MCP fixture text result missing");
      const observed = JSON.parse(content.text) as { TEMP: string | null; temp: string | null; keys: string[] };

      if (process.platform === "win32") {
        expect(observed).toEqual({ TEMP: "r010-sandbox-mapped-temp", temp: "r010-sandbox-mapped-temp", keys: ["TEMP"] });
      } else {
        expect(observed).toEqual({ TEMP: "r010-sandbox-mapped-temp", temp: "r010-server-temp", keys: ["TEMP", "temp"] });
      }
    } finally {
      await runtime.shutdown();
    }
  });

  it("grant 命中但沙箱绑定缺失时 fail-closed（MCP_SERVER_SANDBOX_FAILED），不注册工具不启动进程", async () => {
    const sandbox = createFakeSandboxPort();
    const runtime = new McpStdioRuntime({
      capability: createCapability(),
      workspaceRoot: process.cwd(),
      workspaceTrusted: true,
      resolvePersistentGrant: async () => true,
    });
    await runtime.initialize();
    expect(runtime.getToolDefinitions()).toEqual([]);
    expect(runtime.getDiagnostics()).toEqual([{ serverName: "fixture", code: "MCP_SERVER_SANDBOX_FAILED" }]);
    expect(runtime.getServerStates()).toEqual([{ serverName: "fixture", state: "failed", executionMode: "sandbox", isolation: "sandboxed" }]);
    expect(sandbox.prepared).toHaveLength(0);
  });

  it("沙箱能力不可执行（unavailable）时同样 fail-closed，不启动 server", async () => {
    const sandbox = createFakeSandboxPort({ enforcement: "unavailable" });
    const runtime = new McpStdioRuntime({
      capability: createCapability(),
      workspaceRoot: process.cwd(),
      workspaceTrusted: true,
      resolvePersistentGrant: async () => true,
      sandbox: bindingFor(sandbox.port),
    });
    await runtime.initialize();
    expect(runtime.getDiagnostics()).toEqual([{ serverName: "fixture", code: "MCP_SERVER_SANDBOX_FAILED" }]);
    expect(runtime.getToolDefinitions()).toEqual([]);
    expect(sandbox.prepared).toHaveLength(0);
  });

  it("prepare 抛稳定沙箱错误（POLICY_DENIED）时投影 MCP_SERVER_SANDBOX_FAILED，不透出底层文案", async () => {
    const sandbox = createFakeSandboxPort({ prepareError: new SandboxPortError(SANDBOX_ERROR_CODES.POLICY_DENIED, "sandbox denied") });
    const runtime = new McpStdioRuntime({
      capability: createCapability(),
      workspaceRoot: process.cwd(),
      workspaceTrusted: true,
      resolvePersistentGrant: async () => true,
      sandbox: bindingFor(sandbox.port),
    });
    await runtime.initialize();
    expect(runtime.getDiagnostics()).toEqual([{ serverName: "fixture", code: "MCP_SERVER_SANDBOX_FAILED" }]);
    expect(runtime.getToolDefinitions()).toEqual([]);
    expect(JSON.stringify(runtime.getDiagnostics())).not.toContain("sandbox denied");
    // prepare 失败意味着没有任何执行资源需要释放。
    expect(sandbox.released).toEqual([]);
  });

  it("server 启动即崩溃时标记 failed 并释放已 prepare 的沙箱执行资源", async () => {
    const sandbox = createFakeSandboxPort();
    const runtime = new McpStdioRuntime({
      capability: createCapability(crashFixture),
      workspaceRoot: process.cwd(),
      workspaceTrusted: true,
      resolvePersistentGrant: async () => true,
      sandbox: bindingFor(sandbox.port),
    });
    await runtime.initialize();
    expect(runtime.getServerStates()).toEqual([{ serverName: "fixture", state: "failed", executionMode: "sandbox", isolation: "sandboxed" }]);
    expect(runtime.getDiagnostics()).toEqual([{ serverName: "fixture", code: "MCP_SERVER_FAILED" }]);
    expect(sandbox.prepared).toHaveLength(1);
    expect(sandbox.released).toEqual([sandbox.prepared[0]!.commandId]);
  });

  it("server grant 绑定配置 hash，command 变化后约束必然变化", () => {
    const [server] = createCapability().servers;
    expect(createMcpServerStartActionFacts(server!).stableConstraint).not.toBe(
      createMcpServerStartActionFacts({ ...server!, args: ["--changed"] }).stableConstraint,
    );
    const [hostServer] = createCapability(fixture, "host").servers;
    expect(server?.execution).toBe("sandbox");
    expect(hostServer?.execution).toBe("host");
    expect(createMcpServerStartActionFacts(server!).stableConstraint).not.toBe(createMcpServerStartActionFacts(hostServer!).stableConstraint);
  });

  it("未Trust 的 host server 即使命中 grant 也不进入授权读取或 spawn", async () => {
    const sandbox = createFakeSandboxPort();
    let grantLookups = 0;
    const runtime = new McpStdioRuntime({
      capability: createCapability(fixture, "host"),
      workspaceRoot: process.cwd(),
      workspaceTrusted: false,
      resolvePersistentGrant: async () => { grantLookups += 1; return true; },
      sandbox: bindingFor(sandbox.port),
    });
    await runtime.initialize();
    expect(runtime.getToolDefinitions()).toEqual([]);
    expect(runtime.getDiagnostics()).toEqual([{ serverName: "fixture", code: "MCP_SERVER_DENIED" }]);
    expect(grantLookups).toBe(0);
    expect(sandbox.prepared).toHaveLength(0);
  });

  it("Stage3：显式 host 未批准则 awaiting grant，已批准也不能绕过沙箱边界", async () => {
    const sandbox = createFakeSandboxPort();
    const awaitingGrant = new McpStdioRuntime({
      capability: createCapability(fixture, "host"),
      workspaceRoot: process.cwd(),
      workspaceTrusted: true,
      resolvePersistentGrant: async () => false,
      sandbox: bindingFor(sandbox.port),
    });
    await awaitingGrant.initialize();
    expect(awaitingGrant.getToolDefinitions()).toEqual([]);
    expect(awaitingGrant.getDiagnostics()).toEqual([{ serverName: "fixture", code: "MCP_SERVER_APPROVAL_REQUIRED" }]);
    expect(sandbox.prepared).toHaveLength(0);

    const runtime = new McpStdioRuntime({
      capability: createCapability(fixture, "host"),
      workspaceRoot: process.cwd(),
      workspaceTrusted: true,
      resolvePersistentGrant: async () => true,
      sandbox: bindingFor(sandbox.port),
    });
    try {
      await runtime.initialize();
      expect(runtime.getServerStates()).toEqual([{ serverName: "fixture", state: "failed", executionMode: "host", isolation: "unisolated" }]);
      expect(runtime.getToolDefinitions()).toEqual([]);
      expect(runtime.getDiagnostics()).toEqual([{ serverName: "fixture", code: "MCP_SERVER_SANDBOX_FAILED" }]);
      expect(sandbox.prepared).toHaveLength(0);
    } finally {
      await runtime.shutdown();
    }
  });

  it("host 子进程中和 Windows libuv required vars，并保留显式大小写键/凭据优先级与非Windows行为", async () => {
    const environmentKeys = ["PATH", "SystemRoot", "SystemDrive", "ComSpec", "PATHEXT", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR", "R010_MCP_AMBIENT_SECRET", "R010_MCP_CONFIGURED"];
    const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!originalPlatform) throw new Error("process.platform descriptor missing");
    const capability = parseMcpConfig({
      mcpServers: {
        fixture: {
          command: process.execPath,
          execution: "host",
          env: {
            PATHEXT: "r010-explicit-pathext",
            ComSpec: { credentialRef: { provider: "r010-test", key: "comspec" } },
            temp: "r010-explicit-temp",
            TMP: { credentialRef: { provider: "r010-test", key: "tmp" } },
            R010_MCP_CONFIGURED: "r010-explicit-config",
          },
        },
      },
    });
    const runtime = new McpStdioRuntime({
      capability,
      credentialStore: {
        async resolve(ref) {
          expect(ref.provider).toBe("r010-test");
          if (ref.key === "comspec") return { apiKey: "r010-credential-comspec" };
          if (ref.key === "tmp") return { apiKey: "r010-credential-tmp" };
          throw new Error("unexpected fixture credential");
        },
      },
    });
    const server = capability.servers[0]!;
    const defaultServer = parseMcpConfig({ mcpServers: { fixture: { command: process.execPath, execution: "host" } } }).servers[0]!;
    const resolveEnvironment = (runtime as unknown as McpEnvironmentTestAccess).resolveEnvironment.bind(runtime);

    try {
      process.env.PATH = "r010-host-path";
      process.env.SystemRoot = "r010-host-system-root";
      process.env.SystemDrive = "r010-host-system-drive";
      process.env.ComSpec = "r010-host-comspec";
      process.env.PATHEXT = "r010-host-pathext";
      process.env.TEMP = "r010-host-temp-canary";
      process.env.TMP = "r010-host-tmp-canary";
      process.env.HOMEDRIVE = "r010-host-homedrive-canary";
      process.env.HOMEPATH = "r010-host-homepath-canary";
      process.env.LOGONSERVER = "r010-host-logonserver-canary";
      process.env.USERDOMAIN = "r010-host-userdomain-canary";
      process.env.USERNAME = "r010-host-username-canary";
      process.env.USERPROFILE = "r010-host-userprofile-canary";
      process.env.WINDIR = "r010-host-windir-canary";
      process.env.R010_MCP_AMBIENT_SECRET = "r010-ambient-secret-canary";
      Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });

      const windowsDefaultEnvironment = await resolveEnvironment(defaultServer);
      expect(windowsDefaultEnvironment).toEqual({
        PATH: "r010-host-path",
        SystemRoot: "r010-host-system-root",
        SystemDrive: "r010-host-system-drive",
        ComSpec: "r010-host-comspec",
        PATHEXT: "r010-host-pathext",
        HOMEDRIVE: "",
        HOMEPATH: "",
        LOGONSERVER: "",
        TEMP: "",
        USERDOMAIN: "",
        USERNAME: "",
        USERPROFILE: "",
        WINDIR: "",
        TMP: "",
      });

      const windowsEnvironment = await resolveEnvironment(server);
      expect(windowsEnvironment).toEqual({
        PATH: "r010-host-path",
        SystemRoot: "r010-host-system-root",
        SystemDrive: "r010-host-system-drive",
        ComSpec: "r010-credential-comspec",
        PATHEXT: "r010-explicit-pathext",
        HOMEDRIVE: "",
        HOMEPATH: "",
        LOGONSERVER: "",
        temp: "r010-explicit-temp",
        USERDOMAIN: "",
        USERNAME: "",
        USERPROFILE: "",
        WINDIR: "",
        TMP: "r010-credential-tmp",
        R010_MCP_CONFIGURED: "r010-explicit-config",
      });
      expect(Object.keys(windowsEnvironment).filter(function (key) { return key.toUpperCase() === "TEMP"; })).toEqual(["temp"]);
      expect(Object.keys(windowsEnvironment).filter(function (key) { return key.toUpperCase() === "TMP"; })).toEqual(["TMP"]);
      expect(Object.values(windowsEnvironment)).not.toContain("r010-host-temp-canary");
      expect(Object.values(windowsEnvironment)).not.toContain("r010-host-tmp-canary");
      expect(Object.values(windowsEnvironment)).not.toContain("r010-ambient-secret-canary");

      Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
      const nonWindowsEnvironment = await resolveEnvironment(server);
      expect(nonWindowsEnvironment).toEqual({
        PATH: "r010-host-path",
        ComSpec: "r010-credential-comspec",
        PATHEXT: "r010-explicit-pathext",
        temp: "r010-explicit-temp",
        TMP: "r010-credential-tmp",
        R010_MCP_CONFIGURED: "r010-explicit-config",
      });
      expect(await resolveEnvironment(defaultServer)).toEqual({ PATH: "r010-host-path" });
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      for (const key of environmentKeys) {
        const value = previousEnvironment.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
