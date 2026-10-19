/** CLI Composition Root contract test：验证显式 stateRoot、trust 后 manifest 和无 Web 依赖装配。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NODE_STATE_SCHEMA_VERSION } from "@autopilot-agent/adapters";
import { parseMcpConfig, resolveAutopilotSettings, type AgentMessage, type AgentModelToolDefinition, type ModelSampler } from "@autopilot-agent/core";
import type { NodeSettingsLoader } from "@autopilot-agent/adapters";
import { createCliCompositionRoot, type CliCapabilityLoader } from "../src/composition-root.js";

const temporaryRoots: string[] = [];
const originalLocalAppData = process.env.LOCALAPPDATA;

/** 创建测试独占的临时根目录。 */
function createTemporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rag-next-cli-${prefix}-`));
  temporaryRoots.push(root);
  return root;
}

/** 将宿主级 Registry 隔离到当前测试临时目录，禁止测试污染真实用户列表。 */
beforeEach(function isolateGlobalWorkspaceRegistry() {
  process.env.LOCALAPPDATA = createTemporaryRoot("local-app-data");
});

afterEach(function cleanTemporaryRoots() {
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("CLI Composition Root", function cliCompositionRootSuite() {
  it("只在 trust 后初始化显式 stateRoot，并能装配 Core Runtime", async function createsRuntimeAfterTrust() {
    const stateRoot = createTemporaryRoot("state");
    const workspaceRoot = createTemporaryRoot("workspace");
    const composition = createCliCompositionRoot({
      stateRoot,
      workspaceRoot,
      config: {
        host: "test",
        debug: false,
        logLevel: "silent",
        workspaceRoot,
        skipTrustCheck: true,
        context: {},
      },
    });

    expect(composition.stateRoot).toBe(fs.realpathSync.native(stateRoot));
    expect(fs.existsSync(path.join(stateRoot, "schema.json"))).toBe(false);
    const { workspaceRoot: trustedRoot } = await composition.establishTrust();
    const runtime = await composition.createRuntime(trustedRoot);
    expect(await runtime.projects.list()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(stateRoot, "schema.json"), "utf8"))).toEqual({ schemaVersion: NODE_STATE_SCHEMA_VERSION });
  });

  it("Trust 后创建项目 .autopilot/tmp，重复初始化幂等且不生成 settings 文件", async function createsProjectAutopilotRuntimeDirectory() {
    const stateRoot = createTemporaryRoot("project-autopilot-state");
    const workspaceRoot = createTemporaryRoot("project-autopilot-workspace");
    const composition = createCliCompositionRoot({
      stateRoot,
      workspaceRoot,
      config: { host: "test", debug: false, logLevel: "silent", workspaceRoot, skipTrustCheck: true, context: {} },
    });
    const { workspaceRoot: trustedRoot } = await composition.establishTrust();

    composition.ensureProjectAutopilotDirectory(trustedRoot);
    composition.ensureProjectAutopilotDirectory(trustedRoot);

    expect(fs.statSync(path.join(workspaceRoot, ".autopilot")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(workspaceRoot, ".autopilot", "tmp")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(workspaceRoot, ".autopilot", "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(workspaceRoot, ".autopilot", "settings.local.json"))).toBe(false);
  });

  it("CLI MCP 清单把缺省 execution 展示为 host/unisolated，授权状态跟随当前配置 hash", async function listsDefaultHostMcpMode() {
    const stateRoot = createTemporaryRoot("mcp-default-host-state");
    const workspaceRoot = createTemporaryRoot("mcp-default-host-workspace");
    const capabilityLoader: CliCapabilityLoader = {
      async loadMcp() {
        return parseMcpConfig({ mcpServers: { fixture: { command: "node" } } });
      },
    };
    const composition = createCliCompositionRoot({
      stateRoot,
      workspaceRoot,
      capabilityLoader,
      config: { host: "test", debug: false, logLevel: "silent", workspaceRoot, skipTrustCheck: true, context: {} },
    });
    const { workspaceRoot: trustedRoot } = await composition.establishTrust();

    const beforeApproval = await composition.listMcp(trustedRoot);
    expect(beforeApproval).toMatchObject([{ serverName: "fixture", approved: false, executionMode: "host", isolation: "unisolated" }]);
    await composition.approveMcp(trustedRoot, "fixture");
    expect(await composition.listMcp(trustedRoot)).toMatchObject([{ serverName: "fixture", approved: true, executionMode: "host", isolation: "unisolated" }]);
  });

  it("Project/Local 模型未在 User allowlist 声明时不投影为可运行模型", async function rejectsUnallowlistedScopedModel() {
    const stateRoot = createTemporaryRoot("settings-state");
    const workspaceRoot = createTemporaryRoot("settings-workspace");
    fs.mkdirSync(path.join(workspaceRoot, ".autopilot"));
    fs.writeFileSync(path.join(workspaceRoot, ".autopilot", "settings.local.json"), JSON.stringify({
      availableModels: ["provider-pro"],
      model: "provider-pro",
      effortLevel: "high",
    }));
    const settings = resolveAutopilotSettings([{
      scope: "local",
      value: { availableModels: ["provider-pro"], model: "provider-pro", effortLevel: "high" },
    }]);
    const settingsLoader: NodeSettingsLoader = {
      load: vi.fn(function loadSettings() { return { paths: { user: "C:/redacted", project: "C:/redacted", local: "C:/redacted" }, settings }; }),
      watch: vi.fn(function watchSettings() { return function stopWatching() {}; }),
    };
    const composition = createCliCompositionRoot({
      stateRoot,
      workspaceRoot,
      settingsLoader,
      config: { host: "test", debug: false, logLevel: "silent", workspaceRoot, skipTrustCheck: true, context: {} },
    });

    const { workspaceRoot: trustedRoot } = await composition.establishTrust();
    await composition.createRuntime(trustedRoot);

    expect(composition.getRuntimeStatusDefaults()).toMatchObject({
      reasoningProfile: { effort: "high" },
      modelCapabilities: [],
    });
  });

  it("Settings 投影不读取 LOOP_LLM_*，只接受 CC JSON 快照", function ignoresLegacyEnvironmentForSettingsStatus() {
    const stateRoot = createTemporaryRoot("legacy-status-state");
    const workspaceRoot = createTemporaryRoot("legacy-status-workspace");
    const composition = createCliCompositionRoot({
      stateRoot,
      workspaceRoot,
      env: { LOOP_LLM_MODEL: "legacy-provider/legacy-model" },
      config: { host: "test", debug: false, logLevel: "silent", workspaceRoot, skipTrustCheck: true, context: {} },
    });

    expect(composition.getRuntimeStatusDefaults()).toEqual({ modelCapabilities: [] });
  });

  it("同一 settings 快照把主模型、max 与压缩参数传入 CLI 下一 Turn", async function projectsSharedSettingsIntoNextTurn() {
    const stateRoot = createTemporaryRoot("stage4-state");
    const workspaceRoot = createTemporaryRoot("stage4-workspace");
    const settings = {
      maxTurns: 500,
      modelRef: { provider: "firstParty", modelId: "main-pro[1m]" },
      reasoningProfile: { effort: "max" },
      availableModels: ["main-pro[1m]", "main-fast"],
      modelCandidates: ["main-pro[1m]", "main-fast"],
      modelOverrides: {},
      providerRoutes: {},
      rag: {},
      sandbox: { allowedDomains: [], deniedRead: [], deniedWrite: [] },
      diagnostics: [],
      firstParty: { credentialRef: { provider: "firstParty", key: "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN" }, baseUrl: "https://main.fixture/anthropic", maxOutputTokens: 65536, compactWindow: 786432, timeoutMs: 120000, thinkingEnabled: true },
    } as any;
    const settingsLoader: NodeSettingsLoader = {
      load: vi.fn(function loadSettings() { return { paths: { user: "C:/redacted", project: "C:/redacted", local: "C:/redacted" }, settings }; }),
      watch: vi.fn(function watchSettings() { return function stopWatching() {}; }),
    };
    let factoryInput: any;
    let receivedTools: any[] = [];
    const capabilityLoader: CliCapabilityLoader = {
      loadProvider: function loadProvider() {
        return {
          create: function create(input) {
            factoryInput = input;
            return { async sample(_messages, tools) { receivedTools = tools; return { content: "完成", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" as const }; } };
          },
          getSupportedProviders: function getSupportedProviders() { return ["firstParty"]; },
        };
      },
    };
    const composition = createCliCompositionRoot({
      stateRoot,
      workspaceRoot,
      settingsLoader,
      capabilityLoader,
      config: { host: "test", debug: false, logLevel: "silent", workspaceRoot, skipTrustCheck: true, context: {} },
    });

    const { workspaceRoot: trustedRoot } = await composition.establishTrust();
    const runtime = await composition.createRuntime(trustedRoot);
    const session = await runtime.sessions.create({});
    for await (const _event of runtime.turns.start({ sessionId: session.id, content: "验证配置" })) { /* 消费完整模拟 Turn。 */ }

    expect((await runtime.turns.getState({ sessionId: session.id })).turn?.frozenRunConfig.maxSteps).toBe(500);

    expect(receivedTools.some(function isVision(tool) { return tool.function.name === "vision_analyze"; })).toBe(true);
    expect(factoryInput).toMatchObject({
      ref: { provider: "firstParty", modelId: "main-pro[1m]" },
      reasoningProfile: { effort: "max" },
      sampleOptions: { model: "main-pro[1m]", thinking: "enabled", reasoningEffort: "max", maxTokens: 65536 },
      providerConfig: { apiProtocol: "anthropic-messages", baseUrl: "https://main.fixture/anthropic", compactThresholdTokens: 786432, timeoutMs: 120000, sampleOptions: { thinking: "enabled", reasoningEffort: "max", maxTokens: 65536 } },
    });
  });

  it("CC settings 同时驱动通用模型目录与显式 Doctor 连通性探测", async function projectsSettingsCatalogAndConnectivity() {
    const stateRoot = createTemporaryRoot("catalog-state");
    const workspaceRoot = createTemporaryRoot("catalog-workspace");
    const settings = resolveAutopilotSettings([{
      scope: "user",
      value: {
        env: { ANTHROPIC_AUTH_TOKEN: "test-token" },
        model: "provider-flash",
        availableModels: ["provider-flash", "provider-pro"],
      },
    }]);
    const settingsLoader: NodeSettingsLoader = {
      load: vi.fn(function loadSettings() {
        return { paths: { user: "C:/redacted", project: "C:/redacted", local: "C:/redacted" }, settings };
      }),
      watch: vi.fn(function watchSettings() { return function stopWatching() {}; }),
    };
    const connectivityFetch = vi.fn(async function probeConnectivity() { return new Response(null, { status: 404 }); });
    const composition = createCliCompositionRoot({
      stateRoot,
      workspaceRoot,
      settingsLoader,
      connectivityFetch,
      config: { host: "test", debug: false, logLevel: "silent", workspaceRoot, skipTrustCheck: true, context: {} },
    });

    const { workspaceRoot: trustedRoot } = await composition.establishTrust();
    await composition.grantTrust(trustedRoot);
    const checks = await composition.doctor(trustedRoot, true);

    expect(connectivityFetch).toHaveBeenCalledTimes(1);
    expect(checks).toContainEqual({ name: "provider_connectivity", status: "PASS", detail: "endpoint reachable" });
    expect(composition.getRuntimeStatusDefaults().modelCapabilities).toEqual([
      { provider: "firstParty", modelId: "provider-flash", requestableEfforts: ["none", "low", "medium", "high", "max"] },
      { provider: "firstParty", modelId: "provider-pro", requestableEfforts: ["none", "low", "medium", "high", "max"] },
    ]);
  });

  it("第三方 route 的模型、凭据与 Doctor endpoint 保持同一路由，未声明 OpenAI profile 时仅允许 none", async function projectsProviderRouteSettings() {
    const stateRoot = createTemporaryRoot("route-state");
    const workspaceRoot = createTemporaryRoot("route-workspace");
    const settings = resolveAutopilotSettings([{
      scope: "user",
      value: {
        model: "gateway-route/gateway-chat",
        providerRoutes: {
          "gateway-route": {
            id: "gateway-route",
            apiProtocol: "openai-chat-completions",
            baseUrl: "https://gateway.example/v1/",
            credentialRef: { provider: "gateway-route", key: "ROUTE_KEY" },
            models: [{ id: "gateway-chat" }, { id: "gateway-fast" }],
          },
        },
      },
    }]);
    const settingsLoader: NodeSettingsLoader = {
      load: vi.fn(function loadSettings() { return { paths: { user: "C:/redacted", project: "C:/redacted", local: "C:/redacted" }, settings }; }),
      watch: vi.fn(function watchSettings() { return function stopWatching() {}; }),
    };
    const connectivityFetch = vi.fn(async function probeRouteConnectivity() { return new Response(null, { status: 204 }); });
    const composition = createCliCompositionRoot({
      stateRoot,
      workspaceRoot,
      env: { GATEWAY_ROUTE_ROUTE_KEY: "fixture-route-key" },
      settingsLoader,
      connectivityFetch,
      config: { host: "test", debug: false, logLevel: "silent", workspaceRoot, skipTrustCheck: true, context: {} },
    });

    const { workspaceRoot: trustedRoot } = await composition.establishTrust();
    await composition.grantTrust(trustedRoot);
    const checks = await composition.doctor(trustedRoot, true);

    expect(connectivityFetch).toHaveBeenCalledWith("https://gateway.example/v1", expect.objectContaining({ method: "HEAD" }));
    expect(checks).toContainEqual({ name: "credential", status: "PASS", detail: "configured" });
    expect(checks).toContainEqual({ name: "provider_connectivity", status: "PASS", detail: "endpoint reachable" });
    expect(composition.getRuntimeStatusDefaults()).toMatchObject({ modelRef: { provider: "gateway-route", modelId: "gateway-chat" } });
    expect(composition.getRuntimeStatusDefaults().modelCapabilities).toEqual([
      { provider: "gateway-route", modelId: "gateway-chat", requestableEfforts: ["none"] },
      { provider: "gateway-route", modelId: "gateway-fast", requestableEfforts: ["none"] },
    ]);
  });

  /** 验证 Doctor 解析中性 Search CredentialRef，并把探测交给 Provider 边界。 */
  it("诊断 Web Search 配置、凭据与 Provider 连通性", async function diagnosesWebSearchConfiguration() {
    const stateRoot = createTemporaryRoot("web-search-doctor-state");
    const workspaceRoot = createTemporaryRoot("web-search-doctor-workspace");
    const settings = resolveAutopilotSettings([{
      scope: "user",
      value: { webSearch: { provider: "openai-compatible", baseUrl: "https://search.fixture/v1", model: "search-model", credentialRef: { provider: "openai-compatible", key: "SEARCH" } } },
    }]);
    const settingsLoader: NodeSettingsLoader = {
      /** 返回只含 Search CredentialRef 的受信设置快照。 */
      load: vi.fn(function loadSettings() {
        return { paths: { user: "/missing/user-settings.json", project: "/missing/project-settings.json", local: "/missing/local-settings.json" }, settings };
      }),
      /** 本测试不触发热重载，只返回无资源停止函数。 */
      watch: vi.fn(function watchSettings() {
        /** 停止函数不持有 watcher。 */
        return function stopWatching() {};
      }),
    };
    const probeWebSearchConnectivity = vi.fn(
      /** 返回 Provider 边界已脱敏的可达状态。 */
      async function probeSearchProvider() { return "reachable" as const; },
    );
    const composition = createCliCompositionRoot({
      stateRoot,
      workspaceRoot,
      env: { OPENAI_COMPATIBLE_SEARCH: "fixture-search-key" },
      settingsLoader,
      capabilityLoader: { probeWebSearchConnectivity },
      config: { host: "test", debug: false, logLevel: "silent", workspaceRoot, skipTrustCheck: true, context: {} },
    });

    const { workspaceRoot: trustedRoot } = await composition.establishTrust();
    await composition.grantTrust(trustedRoot);
    const checks = await composition.doctor(trustedRoot, true);

    expect(checks).toContainEqual(expect.objectContaining({ name: "web_search", status: "PASS", detail: expect.stringContaining("configured") }));
    expect(checks).toContainEqual({ name: "web_search_connectivity", status: "PASS", detail: "endpoint reachable" });
    expect(probeWebSearchConnectivity).toHaveBeenCalledWith(trustedRoot, expect.any(AbortSignal));
  });

  it("没有 availableModels 的 Claude Code 默认 alias 仍投影为多个可选模型", async function projectsCcDefaultAliasesAsModelCatalog() {
    const stateRoot = createTemporaryRoot("alias-catalog-state");
    const workspaceRoot = createTemporaryRoot("alias-catalog-workspace");
    const settings = resolveAutopilotSettings([{
      scope: "user",
      value: {
        env: {
          ANTHROPIC_AUTH_TOKEN: "test-token",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "provider-pro",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "provider-fast",
        },
        model: "haiku",
      },
    }]);
    const settingsLoader: NodeSettingsLoader = {
      load: vi.fn(function loadSettings() { return { paths: { user: "C:/redacted", project: "C:/redacted", local: "C:/redacted" }, settings }; }),
      watch: vi.fn(function watchSettings() { return function stopWatching() {}; }),
    };
    const composition = createCliCompositionRoot({
      stateRoot,
      workspaceRoot,
      settingsLoader,
      config: { host: "test", debug: false, logLevel: "silent", workspaceRoot, skipTrustCheck: true, context: {} },
    });

    const { workspaceRoot: trustedRoot } = await composition.establishTrust();
    await composition.createRuntime(trustedRoot);
    expect(composition.getRuntimeStatusDefaults().modelCapabilities?.map(function getModelId(item) { return item.modelId; })).toEqual(["provider-fast", "provider-pro"]);
  });

  it("工作区候选按显式 workspaceRoot → env → cwd 解析，缺省不再向上探测 monorepo", async function resolvesWorkspaceCandidatePriority() {
    const stateRoot = createTemporaryRoot("cand-state");
    const explicit = createTemporaryRoot("cand-explicit");
    const envDir = createTemporaryRoot("cand-env");
    const cwdDir = createTemporaryRoot("cand-cwd");

    // 显式 --workspace-root 优先于环境变量与 cwd。
    const explicitComposition = createCliCompositionRoot({
      stateRoot,
      workspaceRoot: explicit,
      cwd: cwdDir,
      env: { AGENT_WORKSPACE_ROOT: envDir },
      config: { host: "test", debug: false, logLevel: "silent", skipTrustCheck: true, context: {} },
    });
    expect((await explicitComposition.establishTrust()).workspaceRoot).toBe(fs.realpathSync.native(explicit));

    // AGENT_WORKSPACE_ROOT 优先于 cwd。
    const envComposition = createCliCompositionRoot({
      stateRoot,
      cwd: cwdDir,
      env: { AGENT_WORKSPACE_ROOT: envDir },
      config: { host: "test", debug: false, logLevel: "silent", skipTrustCheck: true, context: {} },
    });
    expect((await envComposition.establishTrust()).workspaceRoot).toBe(fs.realpathSync.native(envDir));

    // 缺省回落到启动 cwd；cwd 无 monorepo 标记时也不再向上探测。
    const cwdComposition = createCliCompositionRoot({
      stateRoot,
      cwd: cwdDir,
      env: {},
      config: { host: "test", debug: false, logLevel: "silent", skipTrustCheck: true, context: {} },
    });
    expect((await cwdComposition.establishTrust()).workspaceRoot).toBe(fs.realpathSync.native(cwdDir));
  });

  it("Trust 前解析与授予不加载能力，createRuntime 后才加载", async function loadsCapabilitiesOnlyAfterTrust() {
    const stateRoot = createTemporaryRoot("trust-gate-state");
    const workspaceRoot = createTemporaryRoot("trust-gate-workspace");
    const loadSkills = vi.fn(async function spyLoadSkills() { return undefined; });
    const capabilityLoader = { loadSkills } as unknown as CliCapabilityLoader;
    const composition = createCliCompositionRoot({
      stateRoot,
      workspaceRoot,
      capabilityLoader,
      config: { host: "test", debug: false, logLevel: "silent", skipTrustCheck: true, context: {} },
    });

    const before = await composition.resolveTrust();
    expect(before.workspaceRoot).toBe(fs.realpathSync.native(workspaceRoot));
    expect(loadSkills).not.toHaveBeenCalled();

    await composition.grantTrust(before.workspaceRoot);
    expect((await composition.getTrustStatus(before.workspaceRoot)).status).toBe("trusted");
    expect(loadSkills).not.toHaveBeenCalled();

    await composition.createRuntime(before.workspaceRoot);
    expect(loadSkills).toHaveBeenCalledWith(fs.realpathSync.native(workspaceRoot));
  });

  it("忽略自定义 capability loader 的 loadRag，不把它带入 CLI Runtime", async function ignoresRagCapabilityLoader() {
    const stateRoot = createTemporaryRoot("rag-loader-state");
    const workspaceRoot = createTemporaryRoot("rag-loader-workspace");
    const loadRag = vi.fn(function forbiddenCliRagLoader() {
      throw new Error("CLI must not call loadRag");
    });
    const loadWeb = vi.fn(
      /** 返回仅含 Fetch 的受控 Web capability，证明 CLI 丢弃 RAG 时不会误删 Web。 */
      function loadCliWebCapability() {
        return {
          fetch: {
            /** 本测试不执行工具，只提供完整协议形状。 */
            async fetch(input: { url: string }) {
              return { url: input.url, finalUrl: input.url, content: "fixture", contentType: "text/plain", truncated: false };
            },
          },
        };
      },
    );
    const capabilityLoader = { loadRag, loadWeb } as unknown as CliCapabilityLoader;
    const composition = createCliCompositionRoot({
      stateRoot,
      workspaceRoot,
      capabilityLoader,
      config: { host: "test", debug: false, logLevel: "silent", workspaceRoot, skipTrustCheck: true, context: {} },
    });

    const { workspaceRoot: trustedRoot } = await composition.establishTrust();
    const runtime = await composition.createRuntime(trustedRoot);

    expect(runtime.projects).toBeDefined();
    expect(loadRag).not.toHaveBeenCalled();
    expect(loadWeb).toHaveBeenCalledWith(trustedRoot);
  });

  it("不注册 ask_user_question，并把 CLI 纯文本澄清边界注入 Provider 行为规范", async function configuresTextOnlyClarification() {
    const stateRoot = createTemporaryRoot("question-state");
    const workspaceRoot = createTemporaryRoot("question-workspace");
    let sampledMessages: AgentMessage[] = [];
    let visibleTools: AgentModelToolDefinition[] = [];
    const sampler: ModelSampler = {
      behaviorProfile: { id: "fixture", instructions: "provider fixture" },
      async sample(messages, tools, _options, onDelta) {
        sampledMessages = messages;
        visibleTools = tools;
        onDelta?.("请说明目标范围");
        return { content: "请说明目标范围", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" };
      },
    };
    const capabilityLoader: CliCapabilityLoader = {
      loadProvider: function loadProvider() {
        return {
          create: function create() { return sampler; },
          getSupportedProviders: function getSupportedProviders() { return ["fixture"]; },
        };
      },
    };
    const composition = createCliCompositionRoot({
      stateRoot,
      workspaceRoot,
      capabilityLoader,
      config: { host: "test", debug: false, logLevel: "silent", workspaceRoot, skipTrustCheck: true, context: {} },
    });

    const { workspaceRoot: trustedRoot } = await composition.establishTrust();
    const runtime = await composition.createRuntime(trustedRoot);
    const project = await runtime.projects.create({ workspaceRoot: trustedRoot, name: "CLI clarification" });
    const session = await runtime.sessions.create({ projectId: project.id });
    for await (const _event of runtime.turns.start({ sessionId: session.id, content: "帮我做一下" })) {
      // 消费完整 Turn，令 mock sampler 收到首次 system 指令。
    }

    expect(visibleTools.map(function getToolName(tool) { return tool.function.name; })).not.toContain("ask_user_question");
    expect(sampledMessages.flatMap(function getText(message) {
      return message.content.flatMap(function collectText(block) { return block.type === "text" ? [block.text] : []; });
    }).join("\n")).toContain("当前宿主是 CLI");
    expect(sampledMessages.flatMap(function getText(message) {
      return message.content.flatMap(function collectText(block) { return block.type === "text" ? [block.text] : []; });
    }).join("\n")).toContain(".autopilot/tmp");
  });
});
