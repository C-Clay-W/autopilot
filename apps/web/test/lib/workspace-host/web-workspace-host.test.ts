/** web-workspace-host.test.ts — Web Workspace Host 的 token、Trust 与 Runtime 隔离回归。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeTrustPolicy, resolveNodeStateRoot } from "@autopilot-agent/adapters";
import { createLocalDirectoryPickerForPlatform, createWebWorkspaceHost, type WebWorkspaceContext } from "@/lib/workspace-host/web-workspace-host";

const temporaryRoots: string[] = [];

/** 创建测试独占临时目录。 */
function createTemporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rag-next-web-workspace-${prefix}-`));
  temporaryRoots.push(root);
  return root;
}

/** 构造只用于 Host 缓存测试的 Runtime Context，不调用真实 Runtime。 */
function createTestContext(workspaceId: string): WebWorkspaceContext {
  return {
    workspaceId,
    workspaceRoot: "",
    runtime: {} as WebWorkspaceContext["runtime"],
    projectId: `project-${workspaceId}`,
    compositionRoot: {} as WebWorkspaceContext["compositionRoot"],
  };
}

/** 清理每个测试创建的临时目录。 */
afterEach(function cleanTemporaryRoots() {
  while (temporaryRoots.length) {
    const root = temporaryRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("WebWorkspaceHost", function webWorkspaceHostSuite() {
  it("只为 Windows 与 macOS 声明本机 chooser，其他平台不降级为路径输入", function supportsDesktopNativePickers() {
    expect(createLocalDirectoryPickerForPlatform("win32")).toEqual(expect.any(Function));
    expect(createLocalDirectoryPickerForPlatform("darwin")).toEqual(expect.any(Function));
    expect(createLocalDirectoryPickerForPlatform("linux")).toBeUndefined();
  });

  it("token 只能消费一次，未 Trust 时不创建 Runtime", async function consumesSelectionOnlyOnce() {
    const globalStateRoot = createTemporaryRoot("global");
    const workspaceRoot = createTemporaryRoot("workspace");
    const createContext = vi.fn();
    const host = createWebWorkspaceHost({ globalStateRoot, directoryPicker: async function pick() { return workspaceRoot; }, createContext });

    const selection = await host.beginDirectorySelection();
    expect(selection).toBeDefined();
    const result = await host.inspectSelection(selection!.selectionToken);
    expect(result).toMatchObject({ displayName: path.basename(workspaceRoot), trustStatus: "pending" });
    expect(createContext).not.toHaveBeenCalled();
    await expect(host.inspectSelection(selection!.selectionToken)).rejects.toMatchObject({ code: "DIRECTORY_SELECTION_EXPIRED" });
  });

  it("allow 后为同一 workspace 并发 bootstrap 去重，失败时允许重试", async function deduplicatesAndRetriesBootstrap() {
    const globalStateRoot = createTemporaryRoot("global");
    const workspaceRoot = createTemporaryRoot("workspace");
    const createContext = vi.fn(async function createFailingContext(input: { workspaceId: string }) {
      if (createContext.mock.calls.length === 1) throw new Error("bootstrap failed");
      return createTestContext(input.workspaceId);
    });
    const host = createWebWorkspaceHost({ globalStateRoot, directoryPicker: async function pick() { return workspaceRoot; }, createContext });

    const selection = await host.beginDirectorySelection();
    const challenge = await host.inspectSelection(selection!.selectionToken);
    expect("challengeId" in challenge).toBe(true);
    await expect(host.submitTrust({ challengeId: (challenge as { challengeId: string }).challengeId, decision: "allow" })).rejects.toThrow("bootstrap failed");

    const workspaceId = (await host.listWorkspaces())[0].workspaceId;
    const [first, second] = await Promise.all([host.getContext(workspaceId), host.getContext(workspaceId)]);
    expect(first).toBe(second);
    expect(createContext).toHaveBeenCalledTimes(2);
  });

  it("不同 workspace 具有不同稳定 stateRoot 与 Runtime Context", async function isolatesWorkspaceContexts() {
    const globalStateRoot = createTemporaryRoot("global");
    const firstRoot = createTemporaryRoot("first");
    const secondRoot = createTemporaryRoot("second");
    const createContext = vi.fn(async function createContextForWorkspace(input: { workspaceId: string }) {
      return createTestContext(input.workspaceId);
    });
    const firstTrust = createNodeTrustPolicy({ stateRoot: resolveNodeStateRoot({ workspaceRoot: firstRoot, globalStateRoot }) });
    const secondTrust = createNodeTrustPolicy({ stateRoot: resolveNodeStateRoot({ workspaceRoot: secondRoot, globalStateRoot }) });
    await firstTrust.grantTrust(firstRoot);
    await secondTrust.grantTrust(secondRoot);
    const selections = [firstRoot, secondRoot];
    const host = createWebWorkspaceHost({
      globalStateRoot,
      directoryPicker: async function pick() { return selections.shift(); },
      createContext,
    });

    const firstSelection = await host.beginDirectorySelection();
    const firstSummary = await host.inspectSelection(firstSelection!.selectionToken);
    const secondSelection = await host.beginDirectorySelection();
    const secondSummary = await host.inspectSelection(secondSelection!.selectionToken);
    const first = await host.getContext((firstSummary as { workspaceId: string }).workspaceId);
    const second = await host.getContext((secondSummary as { workspaceId: string }).workspaceId);

    expect(first.workspaceId).not.toBe(second.workspaceId);
    expect(resolveNodeStateRoot({ workspaceRoot: firstRoot, globalStateRoot })).not.toBe(resolveNodeStateRoot({ workspaceRoot: secondRoot, globalStateRoot }));
    expect(createContext).toHaveBeenCalledTimes(2);
  });

  /** 已绑定工作区每次取 Context 仍须复查 Trust，缓存不能绕过撤销。 */
  it("Stage7 已绑定 Context 可复用，Trust 撤销后缓存失效且重新授权才恢复", async function revokesCachedContext() {
    const globalStateRoot = createTemporaryRoot("stage7-global");
    const workspaceRoot = createTemporaryRoot("stage7-workspace");
    const trust = createNodeTrustPolicy({ stateRoot: resolveNodeStateRoot({ workspaceRoot, globalStateRoot }) });
    const createContext = vi.fn(async function createBoundContext(input: { workspaceId: string }) { return createTestContext(input.workspaceId); });
    const host = createWebWorkspaceHost({ globalStateRoot, directoryPicker: async function pickFixture() { return workspaceRoot; }, createContext });
    await expect(host.getContext("unselected")).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    const selection = await host.beginDirectorySelection();
    const challenge = await host.inspectSelection(selection!.selectionToken);
    expect(createContext).not.toHaveBeenCalled();
    const summary = await host.submitTrust({ challengeId: (challenge as { challengeId: string }).challengeId, decision: "allow" });
    const original = await host.getContext(summary.workspaceId);
    expect(await host.getContext(summary.workspaceId)).toBe(original);
    expect(createContext).toHaveBeenCalledOnce();
    await trust.revokeTrust(workspaceRoot);
    await expect(host.getContext(summary.workspaceId)).rejects.toMatchObject({ code: "WORKSPACE_NOT_TRUSTED" });
    expect(createContext).toHaveBeenCalledOnce();
    await trust.grantTrust(workspaceRoot);
    expect(await host.getContext(summary.workspaceId)).not.toBe(original);
    expect(createContext).toHaveBeenCalledTimes(2);
  });

  it("canonical 重复目录只登记一次，缺失目录不会生成 token", async function deduplicatesAndRejectsMissingDirectory() {
    const globalStateRoot = createTemporaryRoot("global");
    const workspaceRoot = createTemporaryRoot("workspace");
    const createContext = vi.fn(async function createContextForWorkspace(input: { workspaceId: string }) {
      return createTestContext(input.workspaceId);
    });
    const trust = createNodeTrustPolicy({ stateRoot: resolveNodeStateRoot({ workspaceRoot, globalStateRoot }) });
    await trust.grantTrust(workspaceRoot);
    const selections = [workspaceRoot, path.join(workspaceRoot, "."), path.join(globalStateRoot, "missing")];
    const host = createWebWorkspaceHost({
      globalStateRoot,
      directoryPicker: async function pick() { return selections.shift(); },
      createContext,
    });

    const first = await host.beginDirectorySelection();
    await host.inspectSelection(first!.selectionToken);
    const second = await host.beginDirectorySelection();
    await host.inspectSelection(second!.selectionToken);
    await expect(host.beginDirectorySelection()).rejects.toMatchObject({ code: "DIRECTORY_INVALID" });
    expect((await host.listWorkspaces()).map(function toId(item) { return item.workspaceId; })).toHaveLength(1);
  });

  it("过期 selection 只返回安全错误，不接受目录路径", async function rejectsExpiredSelection() {
    const globalStateRoot = createTemporaryRoot("global");
    const workspaceRoot = createTemporaryRoot("workspace");
    let currentTime = 1;
    const host = createWebWorkspaceHost({
      globalStateRoot,
      now: function getCurrentTime() { return currentTime; },
      selectionTtlMs: 10,
      directoryPicker: async function pick() { return workspaceRoot; },
    });

    const selection = await host.beginDirectorySelection();
    currentTime = 11;
    await expect(host.inspectSelection(selection!.selectionToken)).rejects.toMatchObject({ code: "DIRECTORY_SELECTION_EXPIRED" });
  });

  it("picker 请求中断后释放 busy 状态", async function releasesBusyAfterRequestAbort() {
    const globalStateRoot = createTemporaryRoot("global");
    const workspaceRoot = createTemporaryRoot("workspace");
    let invocation = 0;
    const directoryPicker = vi.fn(function pick(signal?: AbortSignal) {
      invocation += 1;
      if (invocation === 1) {
        return new Promise<string | undefined>(function waitForAbort(resolve) {
          signal?.addEventListener("abort", function resolveAbortedPicker() { resolve(undefined); }, { once: true });
        });
      }
      return Promise.resolve(workspaceRoot);
    });
    const host = createWebWorkspaceHost({ globalStateRoot, directoryPicker });
    const requestController = new AbortController();
    const pending = host.beginDirectorySelection(requestController.signal);
    await expect(host.beginDirectorySelection()).rejects.toMatchObject({ code: "DIRECTORY_PICKER_BUSY" });
    requestController.abort();
    await expect(pending).resolves.toBeUndefined();
    await expect(host.beginDirectorySelection()).resolves.toMatchObject({ displayName: path.basename(workspaceRoot) });
  });

  it("picker 超时后释放 busy 状态", async function releasesBusyAfterPickerTimeout() {
    const globalStateRoot = createTemporaryRoot("global");
    const workspaceRoot = createTemporaryRoot("workspace");
    let invocation = 0;
    const directoryPicker = vi.fn(function pick() {
      invocation += 1;
      if (invocation === 1) return new Promise<string | undefined>(function waitForever() {});
      return Promise.resolve(workspaceRoot);
    });
    const host = createWebWorkspaceHost({ globalStateRoot, directoryPicker, directoryPickerTimeoutMs: 10 });
    await expect(host.beginDirectorySelection()).resolves.toBeUndefined();
    await expect(host.beginDirectorySelection()).resolves.toMatchObject({ displayName: path.basename(workspaceRoot) });
  });
});
