/** Web Composition Root 默认 Runtime 缓存回归：缓存归属 Root，失败后必须完整重建。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeError } from "@autopilot-agent/core";

const mocks = vi.hoisted(function createCompositionRootMocks() {
  const settingsLoader = {
    /** 返回 Web composition 使用的空安全 settings 快照。 */
    load: function loadSettings() {
      return {
        paths: {},
        settings: { availableModels: [], modelCandidates: [], modelOverrides: {}, firstParty: {}, providerRoutes: {}, diagnostics: [] },
      };
    },
  };
  const loadWeb = vi.fn();
  return {
    bootstrap: vi.fn(),
    createRuntimeBootstrapService: vi.fn(),
    settingsLoader,
    loadWeb,
    createNodeCapabilityLoader: vi.fn(
      /** 返回包含 Search loader 的共享 Node capability 替身。 */
      function createCapabilityLoader() { return { loadWeb }; },
    ),
    createRagAgent: vi.fn(function createRagAgent() { return { getRagCapability: function getRagCapability() { return { prepareRagSearch: vi.fn() }; } }; }),
    createDatabaseSnapshot: vi.fn(function createDatabaseSnapshot() { return { getReadCapability: function getReadCapability() { return { snapshotQuery: vi.fn() }; } }; }),
    createDatabaseSearchCapability: vi.fn(function createDatabaseSearchCapability() { return { search: vi.fn() }; }),
  };
});

vi.mock("@autopilot-agent/adapters", function mockAdapters() {
  return {
    createNodeCapabilityLoader: mocks.createNodeCapabilityLoader,
    createNodeRuntimePorts: vi.fn(),
    createNodeSettingsLoader: vi.fn(
      /** 返回与 Node capability loader 共享的同一 settings loader。 */
      function createSettingsLoader() { return mocks.settingsLoader; },
    ),
    createNodeTrustPolicy: vi.fn(function createTrustPolicy() { return {}; }),
    createNodeWorkspaceAdapter: vi.fn(function createWorkspaceAdapter() {
      return {
        resolveWorkspaceRoot: function resolveWorkspaceRoot() { return "workspace-root"; },
        canonicalizeWorkspaceRoot: function canonicalizeWorkspaceRoot(workspaceRoot: string) { return workspaceRoot; },
      };
    }),
    initializeNodeStateRoot: vi.fn(),
    resolveNodeStateRoot: vi.fn(function resolveStateRoot() { return "state-root"; }),
  };
});

vi.mock("@/lib/core-loader", function mockCoreLoader() {
  return {
    loadCore: function loadCoreMock() {
      return {
        AgentRuntimeError,
        createSafeBootstrapConfig: function createSafeBootstrapConfig() { return { workspaceRoot: "workspace-root" }; },
        createRuntimeBootstrapService: mocks.createRuntimeBootstrapService,
        createDefaultModelSamplerFactory: vi.fn(),
        createRAGAgent: mocks.createRagAgent,
        getDefaultDatabaseSource: function getDefaultDatabaseSource() { return { database: "fixture" }; },
        createDatabaseSnapshot: mocks.createDatabaseSnapshot,
        createDatabaseSearchCapability: mocks.createDatabaseSearchCapability,
      };
    },
  };
});

describe("Web Composition Root 默认 Runtime", function compositionRootRuntimeSuite() {
  beforeEach(function resetDefaultRuntimeCache() {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.createRuntimeBootstrapService.mockReturnValue({ bootstrap: mocks.bootstrap });
  });

  afterEach(function restoreEnvironment() {
    vi.unstubAllEnvs();
  });

  it("无工作区上下文时拒绝默认请求，不 bootstrap Runtime", async function requiresExplicitWorkspace() {
    const { getSharedWebRuntime } = await import("@/lib/composition-root");
    await expect(getSharedWebRuntime()).rejects.toMatchObject({ code: "WORKSPACE_REQUIRED" });
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });

  it("Work Root 只装配 Web 与独立数据库，不装配 RAG", async function loadsIndependentRagWebAndDatabaseCapabilities() {
    mocks.loadWeb.mockReturnValueOnce({ fetch: { fetch: vi.fn() } });
    const { createWebCompositionRoot } = await import("@/lib/composition-root");
    createWebCompositionRoot();
    const options = mocks.createRuntimeBootstrapService.mock.calls[0][0];
    const loader = options.capabilityLoader;

    expect(loader.loadRag).toBeUndefined();
    expect(loader.loadWeb("workspace-root")).toMatchObject({ fetch: { fetch: expect.any(Function) } });
    expect(loader.loadDatabaseSearch("workspace-root")).toMatchObject({ search: expect.any(Function) });
    expect(mocks.createRagAgent).not.toHaveBeenCalled();
    expect(mocks.createDatabaseSearchCapability).toHaveBeenCalledTimes(1);
  });

  /** 验证默认 Web Root 把同一受信 settings loader 注入共享 Node Web capability。 */
  it("通过共享 Node loader 装配 User-only Web Search", async function wiresNodeWebCapabilityLoader() {
    const { createWebCompositionRoot } = await import("@/lib/composition-root");
    createWebCompositionRoot();
    const options = mocks.createRuntimeBootstrapService.mock.calls[0][0];

    expect(mocks.createNodeCapabilityLoader).toHaveBeenCalledWith(expect.objectContaining({
      stateRoot: "state-root",
      settingsLoader: mocks.settingsLoader,
    }));
    expect(options.capabilityLoader.loadWeb).toBe(mocks.loadWeb);
  });

  it("Work 不再读取或冻结 Rerank 配置", async function freezesSafeRerankDefaults() {
    vi.stubEnv("RERANK_BASE_URL", "https://dashscope.aliyuncs.com");
    vi.stubEnv("RERANK_API_KEY", "secret-not-persisted");
    vi.stubEnv("RERANK_TEXT_MODEL", "text-fixture");
    vi.stubEnv("RERANK_VISION_MODEL", "vision-fixture");
    const { createWebCompositionRoot } = await import("@/lib/composition-root");
    createWebCompositionRoot();
    const options = mocks.createRuntimeBootstrapService.mock.calls[0][0];
    const defaults = options.defaultRunConfig.getRuntimeDefaults();
    expect(defaults.rerankPolicy).toBeUndefined();
    expect(JSON.stringify(defaults)).not.toContain("secret-not-persisted");
  });
});
