/**
 * runtime/contract-test/bootstrap.contract.test.ts — Bootstrap / Trust 契约测试
 *
 * 验证 RuntimeBootstrapService 的分阶段初始化：
 * - safeBootstrap 不加载能力。
 * - establishTrust 在未信任工作区抛出 WorkspaceTrustError。
 * - createRuntime 在 trust 建立后才会调用 CapabilityLoader。
 */

import { describe, it, expect, vi } from "vitest";
import { createRuntimeBootstrapService, createSafeBootstrapConfig, WorkspaceTrustError } from "../bootstrap";
import { createMemoryPorts, MemoryWorkspaceAdapter } from "../adapters/memory";
import { createDefaultModelSamplerFactory, parseMcpConfig } from "../../index";
import type { CapabilityLoader } from "../bootstrap";

function createTestTrustPolicy(initialStatus: "trusted" | "denied" | "pending" = "pending") {
  const states = new Map<string, typeof initialStatus>();
  return {
    async getTrustStatus(workspaceRoot: string) {
      const status = states.get(workspaceRoot) ?? initialStatus;
      return {
        workspaceRoot,
        status,
        source: "default" as const,
      };
    },
    async isTrusted(workspaceRoot: string) {
      return (states.get(workspaceRoot) ?? initialStatus) === "trusted";
    },
    async grantTrust(workspaceRoot: string) {
      states.set(workspaceRoot, "trusted");
      return { workspaceRoot, status: "trusted" as const, source: "default" as const };
    },
    async denyTrust(workspaceRoot: string) {
      states.set(workspaceRoot, "denied");
      return { workspaceRoot, status: "denied" as const, source: "default" as const };
    },
    async revokeTrust(workspaceRoot: string) {
      states.set(workspaceRoot, "pending");
      return { workspaceRoot, status: "pending" as const, source: "default" as const };
    },
  };
}

describe("RuntimeBootstrapService contract test", function bootstrapContractSuite() {
  it("safeBootstrap 只返回 SafeBootstrapConfig，不加载能力", async function safeBootstrapOnly() {
    const loader: CapabilityLoader = {
      loadProvider: vi.fn(),
      loadMcp: vi.fn(),
      loadWeb: vi.fn(),
      loadDatabaseSearch: vi.fn(),
      loadSkills: vi.fn(),
    };

    const service = createRuntimeBootstrapService({
      config: createSafeBootstrapConfig({ host: "test" }),
      workspaceAdapter: new MemoryWorkspaceAdapter("/tmp/ws"),
      trustPolicy: createTestTrustPolicy("trusted"),
      capabilityLoader: loader,
      createPorts: () => createMemoryPorts(),
    });

    const config = await service.safeBootstrap();
    expect(config.host).toBe("test");
    expect(loader.loadProvider).not.toHaveBeenCalled();
    expect(loader.loadMcp).not.toHaveBeenCalled();
    expect(loader.loadWeb).not.toHaveBeenCalled();
    expect(loader.loadDatabaseSearch).not.toHaveBeenCalled();
    expect(loader.loadSkills).not.toHaveBeenCalled();
  });

  it("establishTrust 对未信任工作区抛出 WorkspaceTrustError", async function trustDenied() {
    const service = createRuntimeBootstrapService({
      config: createSafeBootstrapConfig({ host: "test" }),
      workspaceAdapter: new MemoryWorkspaceAdapter("/tmp/ws"),
      trustPolicy: createTestTrustPolicy("pending"),
      createPorts: () => createMemoryPorts(),
    });

    await expect(service.establishTrust()).rejects.toBeInstanceOf(WorkspaceTrustError);
  });

  it("createRuntime 只在 trust 后调用 CapabilityLoader", async function runtimeAfterTrust() {
    const loadProvider = vi.fn().mockResolvedValue(createDefaultModelSamplerFactory());
    const loadMcp = vi.fn().mockResolvedValue(parseMcpConfig({ mcpServers: { test: { command: "node" } } }));
    const loadSkills = vi.fn().mockResolvedValue(undefined);
    const loadRag = vi.fn().mockResolvedValue(undefined);
    const loadWeb = vi.fn().mockResolvedValue(undefined);
    const loadDatabaseSearch = vi.fn().mockResolvedValue(undefined);
    const loader = { loadProvider, loadMcp, loadRag, loadWeb, loadDatabaseSearch, loadSkills };

    const service = createRuntimeBootstrapService({
      config: createSafeBootstrapConfig({ host: "test" }),
      workspaceAdapter: new MemoryWorkspaceAdapter("/tmp/ws"),
      trustPolicy: createTestTrustPolicy("trusted"),
      capabilityLoader: loader,
      createPorts: () => createMemoryPorts(),
    });

    await service.establishTrust();
    const runtime = await service.createRuntime("/tmp/ws");

    expect(runtime.turns).toBeDefined();
    expect(loadProvider).toHaveBeenCalledWith("/tmp/ws");
    expect(loadMcp).toHaveBeenCalledWith("/tmp/ws");
    expect(loadRag).not.toHaveBeenCalled();
    expect(loadWeb).toHaveBeenCalledWith("/tmp/ws");
    expect(loadDatabaseSearch).toHaveBeenCalledWith("/tmp/ws");
    expect(loadSkills).toHaveBeenCalledWith("/tmp/ws");
  });

  it("未信任工作区不会触发 Provider / MCP 加载", async function untrustedNoProviderMcp() {
    const loadProvider = vi.fn().mockResolvedValue(createDefaultModelSamplerFactory());
    const loadMcp = vi.fn().mockResolvedValue(undefined);
    const loader: CapabilityLoader = { loadProvider, loadMcp };

    const service = createRuntimeBootstrapService({
      config: createSafeBootstrapConfig({ host: "test" }),
      workspaceAdapter: new MemoryWorkspaceAdapter("/tmp/ws"),
      trustPolicy: createTestTrustPolicy("denied"),
      capabilityLoader: loader,
      createPorts: () => createMemoryPorts(),
    });

    await expect(service.bootstrap()).rejects.toBeInstanceOf(WorkspaceTrustError);
    expect(loadProvider).not.toHaveBeenCalled();
    expect(loadMcp).not.toHaveBeenCalled();
  });

  it("未信任工作区直接创建 Runtime 时也不会加载任何能力或 Port", async function directRuntimeStillRequiresTrust() {
    const loader: CapabilityLoader = {
      loadProvider: vi.fn(),
      loadMcp: vi.fn(),
      loadWeb: vi.fn(),
      loadDatabaseSearch: vi.fn(),
      loadSkills: vi.fn(),
      loadContext: vi.fn(),
      loadInputInbox: vi.fn(),
    };
    const createPorts = vi.fn(function createTestPorts() { return createMemoryPorts(); });
    const service = createRuntimeBootstrapService({
      config: createSafeBootstrapConfig({ host: "test" }),
      workspaceAdapter: new MemoryWorkspaceAdapter("/tmp/ws"),
      trustPolicy: createTestTrustPolicy("denied"),
      capabilityLoader: loader,
      createPorts,
    });

    await expect(service.createRuntime("/tmp/ws")).rejects.toBeInstanceOf(WorkspaceTrustError);
    expect(createPorts).not.toHaveBeenCalled();
    expect(loader.loadProvider).not.toHaveBeenCalled();
    expect(loader.loadMcp).not.toHaveBeenCalled();
    expect(loader.loadWeb).not.toHaveBeenCalled();
    expect(loader.loadDatabaseSearch).not.toHaveBeenCalled();
    expect(loader.loadSkills).not.toHaveBeenCalled();
    expect(loader.loadContext).not.toHaveBeenCalled();
    expect(loader.loadInputInbox).not.toHaveBeenCalled();
  });

  it("bootstrap 完整流程：denied → grant → bootstrap 成功", async function grantThenBootstrap() {
    const policy = createTestTrustPolicy("denied");
    const loadSkills = vi.fn().mockResolvedValue(undefined);

    const service = createRuntimeBootstrapService({
      config: createSafeBootstrapConfig({ host: "test" }),
      workspaceAdapter: new MemoryWorkspaceAdapter("/tmp/ws"),
      trustPolicy: policy,
      capabilityLoader: { loadSkills },
      createPorts: () => createMemoryPorts(),
    });

    await expect(service.bootstrap()).rejects.toBeInstanceOf(WorkspaceTrustError);

    await policy.grantTrust("/tmp/ws");
    const runtime = await service.bootstrap();

    expect(runtime.turns).toBeDefined();
    expect(loadSkills).toHaveBeenCalledWith("/tmp/ws");
  });

  it("skipTrustCheck 为 true 时绕过信任检查", async function skipTrust() {
    const loadSkills = vi.fn().mockResolvedValue(undefined);

    const service = createRuntimeBootstrapService({
      config: createSafeBootstrapConfig({ host: "test", skipTrustCheck: true }),
      workspaceAdapter: new MemoryWorkspaceAdapter("/tmp/ws"),
      trustPolicy: createTestTrustPolicy("denied"),
      capabilityLoader: { loadSkills },
      createPorts: () => createMemoryPorts(),
    });

    const runtime = await service.bootstrap();
    expect(runtime.turns).toBeDefined();
    expect(loadSkills).toHaveBeenCalled();
  });
});
