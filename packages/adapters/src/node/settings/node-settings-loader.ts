/**
 * node/settings/node-settings-loader.ts — 跨平台 Autopilot settings 文件加载与热重载
 *
 * 仅 Node Adapter 接触文件系统：User 使用 os.homedir，Project/Local 只在已信任 workspace
 * 传入后读取。监听父目录并在 debounce 后完整重读，以兼容 Windows/macOS 原子替换和 rename。
 */

import { UserConfigDirectoryError } from "./user-config-directory";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveAutopilotSettings,
  type AutopilotSettingsScope,
  type ResolvedAutopilotSettings,
  type SettingsDiagnostic,
} from "@autopilot-agent/core";

/** 三层 settings 的实际文件路径。 */
export interface NodeSettingsPaths {
  user: string;
  project: string;
  local: string;
}

/** 单次读取的 settings 快照与非敏感诊断。 */
export interface LoadedNodeSettings {
  settings: ResolvedAutopilotSettings;
  paths: NodeSettingsPaths;
}

/** Chat 的 User-only 快照不包含 Project/Local 路径，避免宿主误用工作区配置。 */
export interface LoadedNodeUserSettings {
  settings: ResolvedAutopilotSettings;
  paths: Pick<NodeSettingsPaths, "user">;
}

/** Node settings loader 的可注入选项。 */
export interface CreateNodeSettingsLoaderOptions {
  homeDirectory?: string;
  debounceMs?: number;
}

/** 路径运算的最小抽象；仅供 win32/posix fixture 验证，生产默认使用当前 Node 平台实现。 */
type NodePathApi = Pick<typeof path, "join" | "resolve">;

/** 供状态/doctor 读取的 settings 服务。 */
export interface NodeSettingsLoader {
  load(workspaceRoot: string): LoadedNodeSettings;
  watch(workspaceRoot: string, onReload: (loaded: LoadedNodeSettings) => void): () => void;
}

/** 独立增量接口，既有仅实现 Work load/watch 的宿主测试替身保持兼容。 */
export interface NodeUserSettingsLoader {
  /** 仅读取当前用户文件，不解析 cwd 或工作区路径。 */
  loadUser(): LoadedNodeUserSettings;
  /** 仅监听用户配置目录及其父目录，完整重读 User 快照。 */
  watchUser(onReload: (loaded: LoadedNodeUserSettings) => void): () => void;
}

/** 解析独立用户路径；Chat 的显式 Home 必须是绝对路径。 */
export function resolveNodeUserSettingsPath(homeDirectory: string | undefined = undefined, pathApi: Pick<typeof path, "join" | "isAbsolute"> = path): string {
  try {
    const home = homeDirectory ?? os.homedir();
    if (!pathApi.isAbsolute(home)) throw new UserConfigDirectoryError("AUTOPILOT_HOME_UNRESOLVED");
    return pathApi.join(home, ".autopilot", "settings.json");
  } catch { throw new UserConfigDirectoryError("AUTOPILOT_HOME_UNRESOLVED"); }
}

/** 用 Node path API 解析 Windows/macOS 共用的 User/Project/Local 路径。 */
export function resolveNodeSettingsPaths(workspaceRoot: string, homeDirectory = os.homedir(), pathApi: NodePathApi = path): NodeSettingsPaths {
  const root = pathApi.resolve(workspaceRoot);
  return {
    user: pathApi.join(homeDirectory, ".autopilot", "settings.json"),
    project: pathApi.join(root, ".autopilot", "settings.json"),
    local: pathApi.join(root, ".autopilot", "settings.local.json"),
  };
}

/** 检查 settings 与其配置根均为非链接的实际文件/目录，避免读取逃逸后的配置；投影写入共用。 */
export function isSafeSettingsFile(filePath: string): boolean {
  try {
    const file = fs.lstatSync(filePath);
    const configDirectory = path.dirname(filePath);
    const directory = fs.lstatSync(configDirectory);
    if (!file.isFile() || file.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink()) return false;
    const canonicalDirectory = fs.realpathSync.native(configDirectory);
    const canonicalFile = fs.realpathSync.native(filePath);
    const relative = path.relative(canonicalDirectory, canonicalFile);
    return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** 创建 settings Loader；调用者必须保证 workspaceRoot 已完成 trust。 */
export function createNodeSettingsLoader(options: CreateNodeSettingsLoaderOptions = {}): NodeSettingsLoader & NodeUserSettingsLoader {
  const debounceMs = options.debounceMs ?? 100;

  /** 读取单个 JSON 文件，损坏文件以脱敏诊断降级为空来源。 */
  function readSource(scope: AutopilotSettingsScope, filePath: string): { scope: AutopilotSettingsScope; value: unknown; diagnostics: SettingsDiagnostic[] } | undefined {
    if (!fs.existsSync(filePath)) {
      try {
        if (fs.lstatSync(filePath).isSymbolicLink()) return { scope, value: undefined, diagnostics: [{ scope, code: "SETTINGS_FILE_UNSAFE_LINK" }] };
      } catch {
        return undefined;
      }
      return undefined;
    }
    if (!isSafeSettingsFile(filePath)) return { scope, value: undefined, diagnostics: [{ scope, code: "SETTINGS_FILE_UNSAFE_LINK" }] };
    try {
      return { scope, value: JSON.parse(fs.readFileSync(filePath, "utf8")), diagnostics: [] };
    } catch {
      return { scope, value: undefined, diagnostics: [{ scope, code: "SETTINGS_JSON_INVALID" }] };
    }
  }

  /** 完整重读三层文件；不依赖 watcher 的单次 change/rename 类型。 */
  function load(workspaceRoot: string): LoadedNodeSettings {
    return loadPaths(resolveNodeSettingsPaths(workspaceRoot, options.homeDirectory));
  }

  /** 只构造 User 路径，从入口消除读取工作区的可能。 */
  function loadUser(): LoadedNodeUserSettings {
    return loadPaths({ user: resolveNodeUserSettingsPath(options.homeDirectory) });
  }

  /** 两种读取入口复用同一安全读取与 Core settings 合并，不另建解析规则。 */
  function loadPaths<T extends Pick<NodeSettingsPaths, "user">>(paths: T): { paths: T; settings: ResolvedAutopilotSettings } {
    /** 仅读取调用方明确列出的 scope，User-only 不生成其他路径。 */
    const sources = (Object.entries(paths) as Array<[AutopilotSettingsScope, string]>).map(function readEntry([scope, filePath]) {
      return readSource(scope, filePath);
    }).filter((source): source is NonNullable<typeof source> => Boolean(source));
    /** 将已读取的来源交给既有 Core 解析器。 */
    const settings = resolveAutopilotSettings(sources.map(({ scope, value }) => ({ scope, value })));
    /** 汇总安全读取和配置解析的脱敏诊断。 */
    const diagnostics = [...settings.diagnostics, ...sources.flatMap((source) => source.diagnostics)];
    return { paths, settings: { ...settings, diagnostics } };
  }

  /** 监听三个父目录，按目标 basename 过滤并 debounce 后刷新完整快照。 */
  function watch(workspaceRoot: string, onReload: (loaded: LoadedNodeSettings) => void): () => void {
    const paths = resolveNodeSettingsPaths(workspaceRoot, options.homeDirectory);
    /** Workspace 监听仍完整重读原来的三层配置。 */
    return watchPaths(Object.values(paths), function reloadWorkspace() { onReload(load(workspaceRoot)); });
  }

  /** User-only 监听入口不接受工作区参数，也不注册工作区句柄。 */
  function watchUser(onReload: (loaded: LoadedNodeUserSettings) => void): () => void {
    /** 每次用户目录事件都重新执行安全读取。 */
    return watchPaths([resolveNodeUserSettingsPath(options.homeDirectory)], function reloadUser() { onReload(loadUser()); });
  }

  /** 复用父目录监听机制，创建/删除/原子替换后都重新注册句柄。 */
  function watchPaths(watched: string[], reload: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchers: fs.FSWatcher[] = [];

    /** 对目录创建/删除后重新注册，避免原子 rename 或首次创建目录导致 watch 丢失。 */
    function installWatchers(): void {
      for (const watcher of watchers) watcher.close();
      const uniqueDirectories = [...new Set(watched.flatMap(function collectWatchDirectories(filePath) {
        const directory = path.dirname(filePath);
        return [directory, path.dirname(directory)];
      }))].filter(
        /** 不把用户配置目录的链接目标注册为监听面；父目录仍能观察链接被替换。 */
        function safeWatchDirectory(directory) { return fs.existsSync(directory) && fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(); },
      );
      watchers = uniqueDirectories.flatMap(function watchParent(directory) {
        try {
          const watcher = fs.watch(directory, function reloadOnTargetFile(_eventType, fileName) {
            if (!fileName || !watched.some((target) => path.basename(target) === fileName.toString() || path.basename(path.dirname(target)) === fileName.toString())) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(function reloadAfterDebounce() {
              reload();
              installWatchers();
            }, debounceMs);
          });
          // CLI 自身的 stdin/Ink 生命周期会保持前台进程；watcher 不应单独阻止一次性 smoke 退出。
          watcher.unref();
          watcher.on("error", function ignoreWatcherError() { /* 文件系统 watcher 失败时保留当前快照，下一次宿主重建会重新注册。 */ });
          return [watcher];
        } catch {
          return [];
        }
      });
    }

    installWatchers();
    return function stopWatchingSettings(): void {
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    };
  }

  return { load, watch, loadUser, watchUser };
}
