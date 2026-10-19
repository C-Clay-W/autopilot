/**
 * user-config-directory.test.ts — 首次业务命令的用户配置目录安全契约。
 *
 * 使用临时 Home 验证首次、重复、并发、路径和拒绝策略，不接触开发者真实 Home。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureUserConfigDirectory, UserConfigDirectoryError } from "../src/node/settings/user-config-directory";

const temporaryRoots: string[] = [];

/** 创建测试独占临时根，并在每例结束时递归清理。 */
function createTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-user-config-"));
  temporaryRoots.push(root);
  return root;
}

/** 返回指定 stable code 的目录错误断言。 */
function expectDirectoryError(action: () => void, code: UserConfigDirectoryError["code"]): void {
  expect(action).toThrow(UserConfigDirectoryError);
  try {
    action();
  } catch (error) {
    expect((error as UserConfigDirectoryError).code).toBe(code);
    expect((error as Error).message).toBe(code);
  }
}

/** 清除本例临时目录与 Node fs mock。 */
afterEach(function cleanTemporaryRoots() {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("user config directory", function userConfigDirectorySuite() {
  it("首次创建空配置根，且不创建 settings.json", function createsOnlyConfigDirectory() {
    const homeDirectory = path.join(createTemporaryRoot(), "用户 home with space");
    const configDirectory = ensureUserConfigDirectory({ homeDirectory });

    expect(configDirectory).toBe(path.join(homeDirectory, ".autopilot"));
    expect(fs.statSync(configDirectory).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(configDirectory, "settings.json"))).toBe(false);
  });

  it("重复和并发调用保留既有内容", function isIdempotentAndConcurrent() {
    const homeDirectory = path.join(createTemporaryRoot(), "home");
    const configDirectory = ensureUserConfigDirectory({ homeDirectory });
    const sentinel = path.join(configDirectory, "keep.txt");
    fs.writeFileSync(sentinel, "keep");

    const directories = Array.from({ length: 8 }, function ensureFromConcurrentCaller() {
      return ensureUserConfigDirectory({ homeDirectory });
    });

    expect(new Set(directories)).toEqual(new Set([configDirectory]));
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("拒绝同名普通文件与配置根链接", function rejectsFileAndLink() {
    const root = createTemporaryRoot();
    const fileHome = path.join(root, "file-home");
    fs.mkdirSync(fileHome);
    fs.writeFileSync(path.join(fileHome, ".autopilot"), "not a directory");
    expectDirectoryError(function ensureFileRoot() {
      ensureUserConfigDirectory({ homeDirectory: fileHome });
    }, "AUTOPILOT_CONFIG_ROOT_NOT_DIRECTORY");

    const linkHome = path.join(root, "link-home");
    const target = path.join(root, "outside");
    fs.mkdirSync(linkHome);
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(linkHome, ".autopilot"), process.platform === "win32" ? "junction" : "dir");
    expectDirectoryError(function ensureLinkedRoot() {
      ensureUserConfigDirectory({ homeDirectory: linkHome });
    }, "AUTOPILOT_CONFIG_ROOT_UNSAFE_LINK");
  });

  it("允许系统已解析的 Home 链接，但配置根仍创建在其真实 Home 内", function allowsResolvedHomeLink() {
    const root = createTemporaryRoot();
    const actualHome = path.join(root, "actual-home");
    const linkedHome = path.join(root, "linked-home");
    fs.mkdirSync(actualHome);
    fs.symlinkSync(actualHome, linkedHome, process.platform === "win32" ? "junction" : "dir");

    ensureUserConfigDirectory({ homeDirectory: linkedHome });

    expect(fs.statSync(path.join(actualHome, ".autopilot")).isDirectory()).toBe(true);
  });

  it("拒绝空或相对 Home，且不回退到 cwd", function rejectsUnresolvedHome() {
    expectDirectoryError(function ensureEmptyHome() {
      ensureUserConfigDirectory({ homeDirectory: "" });
    }, "AUTOPILOT_HOME_UNRESOLVED");
    expectDirectoryError(function ensureRelativeHome() {
      ensureUserConfigDirectory({ homeDirectory: "relative-home" });
    }, "AUTOPILOT_HOME_UNRESOLVED");
  });

  it("将不可写或只读文件系统错误收敛为稳定不可用码", function normalizesUnavailableDirectoryErrors() {
    const homeDirectory = path.join(createTemporaryRoot(), "home");
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "mkdirSync").mockImplementation(function denyMkdir() { throw error; });

    expectDirectoryError(function ensureUnavailableRoot() {
      ensureUserConfigDirectory({ homeDirectory });
    }, "AUTOPILOT_CONFIG_ROOT_UNAVAILABLE");
  });
});
