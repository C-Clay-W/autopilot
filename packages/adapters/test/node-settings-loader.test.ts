/**
 * node-settings-loader.test.ts — Step 3.5 跨平台路径与热重载契约
 *
 * 验证路径不依赖字面 USERPROFILE、Project/Local 合并顺序，以及损坏配置的完整降级读取。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeSettingsLoader, resolveNodeSettingsPaths } from "../src/node/settings/node-settings-loader";

const temporaryRoots: string[] = [];

/** 创建独立临时 workspace，测试结束后由 afterEach 清理。 */
function createTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-settings-"));
  temporaryRoots.push(root);
  return root;
}

/** 模拟 Node 目录事件，隔离受限运行环境的 fs.watch 句柄配额并覆盖 Loader 的事件过滤逻辑。 */
function mockFileWatch(): (fileName: string) => void {
  const callbacks: Array<(eventType: string, fileName: string | Buffer | null) => void> = [];
  vi.spyOn(fs, "watch").mockImplementation((...args: unknown[]) => {
    const callback = args.find(function findCallback(argument) { return typeof argument === "function"; });
    if (typeof callback !== "function") throw new Error("fs.watch fixture 缺少回调");
    callbacks.push(callback as (eventType: string, fileName: string | Buffer | null) => void);
    return {
      close: vi.fn(),
      on: vi.fn(function returnWatcher() { return this; }),
      unref: vi.fn(function returnWatcher() { return this; }),
    } as unknown as fs.FSWatcher;
  });
  return function emitFileChange(fileName: string): void {
    for (const callback of callbacks) callback("rename", fileName);
  };
}

/** 在测试结束后安全清理本测试创建的临时目录。 */
afterEach(function removeTemporaryRoots() {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("Node settings loader", function nodeSettingsLoaderSuite() {
  it("使用 Node path API 解析 User/Project/Local 路径", function resolvesPortablePaths() {
    const paths = resolveNodeSettingsPaths(path.join("workspace", "project"), path.join("home", "tester"));
    expect(paths.user).toBe(path.join("home", "tester", ".autopilot", "settings.json"));
    expect(paths.project).toBe(path.resolve("workspace", "project", ".autopilot", "settings.json"));
    expect(paths.local).toBe(path.resolve("workspace", "project", ".autopilot", "settings.local.json"));
  });

  it("在 win32 与 macOS(posix) fixture 下解析相同的三层语义", function resolvesWindowsAndMacosPaths() {
    const windows = resolveNodeSettingsPaths("C:\\workspace\\project", "C:\\Users\\tester", path.win32);
    expect(windows).toEqual({
      user: "C:\\Users\\tester\\.autopilot\\settings.json",
      project: "C:\\workspace\\project\\.autopilot\\settings.json",
      local: "C:\\workspace\\project\\.autopilot\\settings.local.json",
    });
    const macos = resolveNodeSettingsPaths("/Users/tester/project", "/Users/tester", path.posix);
    expect(macos).toEqual({
      user: "/Users/tester/.autopilot/settings.json",
      project: "/Users/tester/project/.autopilot/settings.json",
      local: "/Users/tester/project/.autopilot/settings.local.json",
    });
  });

  it("Local 覆盖 Project 和 User，损坏 JSON 只降级该来源", function loadsTolerantScopes() {
    const root = createTemporaryRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(home, ".autopilot"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".autopilot"), { recursive: true });
    fs.writeFileSync(path.join(home, ".autopilot", "settings.json"), JSON.stringify({ model: "provider-user", availableModels: ["provider-user", "provider-local"] }));
    fs.writeFileSync(path.join(workspace, ".autopilot", "settings.json"), "{");
    fs.writeFileSync(path.join(workspace, ".autopilot", "settings.local.json"), JSON.stringify({ model: "provider-local", effortLevel: "low" }));
    const loaded = createNodeSettingsLoader({ homeDirectory: home }).load(workspace);
    expect(loaded.settings.modelRef).toEqual({ provider: "firstParty", modelId: "provider-local" });
    expect(loaded.settings.reasoningProfile).toEqual({ effort: "low" });
    expect(loaded.settings.diagnostics.some((item) => item.code === "SETTINGS_JSON_INVALID" && item.scope === "project")).toBe(true);
  });

  it("原子 rename 后 debounce 完整重读 Local settings", async function reloadsAfterAtomicRename() {
    const root = createTemporaryRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const settingsDirectory = path.join(workspace, ".autopilot");
    fs.mkdirSync(path.join(home, ".autopilot"), { recursive: true });
    fs.writeFileSync(path.join(home, ".autopilot", "settings.json"), JSON.stringify({ availableModels: ["provider-pro"] }));
    fs.mkdirSync(settingsDirectory, { recursive: true });
    const emitFileChange = mockFileWatch();
    const loader = createNodeSettingsLoader({ homeDirectory: home, debounceMs: 20 });
    const reloaded = new Promise<string | undefined>(function waitForReload(resolve, reject) {
      const timeout = setTimeout(function rejectOnTimeout() { reject(new Error("settings watch timeout")); }, 2_000);
      const stop = loader.watch(workspace, function handleReload(next) {
        clearTimeout(timeout);
        stop();
        resolve(next.settings.modelRef?.modelId);
      });
    });
    const temporary = path.join(settingsDirectory, "settings.local.json.tmp");
    const target = path.join(settingsDirectory, "settings.local.json");
    fs.writeFileSync(temporary, JSON.stringify({ model: "provider-pro" }));
    fs.renameSync(temporary, target);
    emitFileChange(path.basename(target));
    await expect(reloaded).resolves.toBe("provider-pro");
  });

  it("删除后重建 settings 仍会重新读取", async function reloadsAfterDeleteAndRecreate() {
    const root = createTemporaryRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const settingsDirectory = path.join(workspace, ".autopilot");
    const target = path.join(settingsDirectory, "settings.local.json");
    fs.mkdirSync(path.join(home, ".autopilot"), { recursive: true });
    fs.writeFileSync(path.join(home, ".autopilot", "settings.json"), JSON.stringify({ availableModels: ["provider-flash", "provider-pro"] }));
    fs.mkdirSync(settingsDirectory, { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ model: "provider-flash" }));
    const emitFileChange = mockFileWatch();
    const loader = createNodeSettingsLoader({ homeDirectory: home, debounceMs: 20 });
    const values: Array<string | undefined> = [];
    const reloaded = new Promise<void>(function waitForReload(resolve, reject) {
      const timeout = setTimeout(function rejectOnTimeout() { reject(new Error("settings delete/recreate timeout")); }, 2_000);
      const stop = loader.watch(workspace, function handleReload(next) {
        values.push(next.settings.modelRef?.modelId);
        if (values.length !== 2) return;
        clearTimeout(timeout);
        stop();
        resolve();
      });
    });
    fs.rmSync(target);
    emitFileChange(path.basename(target));
    await new Promise(function waitForDelete(resolve) { setTimeout(resolve, 60); });
    fs.writeFileSync(target, JSON.stringify({ model: "provider-pro" }));
    emitFileChange(path.basename(target));
    await reloaded;
    expect(values).toEqual([undefined, "provider-pro"]);
  });

  it("拒绝 settings 文件或配置根链接，不跟随到链接目标", function rejectsUnsafeSettingsLinks() {
    const root = createTemporaryRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside-settings.json");
    const userDirectory = path.join(home, ".autopilot");
    fs.mkdirSync(userDirectory, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(outside, JSON.stringify({ model: "outside" }));
    try {
      fs.symlinkSync(outside, path.join(userDirectory, "settings.json"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const loaded = createNodeSettingsLoader({ homeDirectory: home }).load(workspace);

    expect(loaded.settings.modelRef).toBeUndefined();
    expect(loaded.settings.diagnostics).toContainEqual({ scope: "user", code: "SETTINGS_FILE_UNSAFE_LINK" });
  });
});
