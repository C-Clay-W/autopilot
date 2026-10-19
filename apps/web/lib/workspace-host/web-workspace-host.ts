/**
 * web-workspace-host.ts — Web 多工作区宿主边界
 *
 * 只在服务端保存 canonical 路径、Trust、Registry、目录选择令牌与每工作区 Runtime；
 * 浏览器只能经后续 Route 获得不透明 ID 和脱敏摘要。
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  canonicalizeNodePath,
  createNodeTrustPolicy,
  createNodeWorkspaceId,
  createNodeWorkspaceRegistry,
  resolveNodeStateRoot,
  type WorkspaceRegistry,
} from "@autopilot-agent/adapters";
import type { AgentRuntimeFacade, WorkspaceTrustPolicy, WorkspaceTrustStatus } from "@autopilot-agent/core";
import type { WebCompositionRoot } from "../composition-root";

/** 浏览器可见的工作区摘要；不包含 Host 路径或状态目录。 */
export interface WebWorkspaceSummary {
  workspaceId: string;
  displayName: string;
  lastOpenedAt: number;
  available: boolean;
  trustStatus: WorkspaceTrustStatus;
}

/** 目录选择的单次安全引用；Token 只能由后续 open 流程消费。 */
export interface WebDirectorySelection {
  selectionToken: string;
  displayName: string;
  expiresAt: number;
}

/** 未受信目录的显式确认挑战；challengeId 不携带目录身份。 */
export interface WebWorkspaceTrustChallenge {
  challengeId: string;
  displayName: string;
  trustStatus: "pending" | "denied" | "expired";
}

/** 每个工作区唯一的 Runtime 与 Project 归属。 */
export interface WebWorkspaceContext {
  workspaceId: string;
  /** 仅供服务器 Route 使用的 canonical 根目录，绝不投影到浏览器。 */
  workspaceRoot: string;
  runtime: AgentRuntimeFacade;
  projectId: string;
  /** 与该 Runtime 同生命周期的 Composition Root，避免 Route 重新装配到默认工作区。 */
  compositionRoot: WebCompositionRoot;
}

/** Host 可稳定映射给 Route 的安全错误码。 */
export type WebWorkspaceHostErrorCode =
  | "DIRECTORY_PICKER_UNAVAILABLE"
  | "DIRECTORY_PICKER_BUSY"
  | "DIRECTORY_SELECTION_EXPIRED"
  | "DIRECTORY_INVALID"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_NOT_TRUSTED"
  | "TRUST_CHALLENGE_EXPIRED";

/** Web Workspace Host 的安全错误；message 不包含原始路径或 chooser 输出。 */
export class WebWorkspaceHostError extends Error {
  constructor(public readonly code: WebWorkspaceHostErrorCode, message: string) {
    super(message);
    this.name = "WebWorkspaceHostError";
  }
}

/** 宿主目录选择 seam；取消时返回 undefined，signal 中止时应尽快结束 chooser，绝不让浏览器传入路径。 */
export type WebDirectoryPicker = (signal?: AbortSignal) => Promise<string | undefined>;

/** Web Workspace Host 对外服务；所有返回值均为安全 DTO 或 Runtime Context。 */
export interface WebWorkspaceHost {
  listWorkspaces(): Promise<WebWorkspaceSummary[]>;
  isDirectorySelectionAvailable(): boolean;
  beginDirectorySelection(requestSignal?: AbortSignal): Promise<WebDirectorySelection | undefined>;
  inspectSelection(selectionToken: string): Promise<WebWorkspaceTrustChallenge | WebWorkspaceSummary>;
  submitTrust(input: { challengeId: string; decision: "allow" | "deny" }): Promise<WebWorkspaceSummary>;
  getContext(workspaceId: string): Promise<WebWorkspaceContext>;
  removeWorkspace(workspaceId: string): Promise<boolean>;
}

interface PendingSelection {
  workspaceRoot: string;
  displayName: string;
  expiresAt: number;
}

interface PendingTrustChallenge extends PendingSelection {
  challengeId: string;
  trustStatus: "pending" | "denied" | "expired";
}

/** Host 创建选项；注入 seam 只供宿主装配与定向测试，浏览器永远不可控制。 */
export interface CreateWebWorkspaceHostOptions {
  globalStateRoot?: string;
  registry?: WorkspaceRegistry;
  directoryPicker?: WebDirectoryPicker;
  /** 只有 Route 已确认本机回环 Host 时才允许装配默认原生 chooser。 */
  nativeDirectorySelectionEnabled?: boolean;
  /** 原生 chooser 最长允许等待时间；超时会中止 chooser 并释放 busy 状态。 */
  directoryPickerTimeoutMs?: number;
  now?: () => number;
  selectionTtlMs?: number;
  createContext?: (input: { workspaceId: string; workspaceRoot: string; displayName: string; stateRoot: string }) => Promise<WebWorkspaceContext>;
}

/** Adapter 尚未重新发布类型产物时保留按 ID 的运行时契约，避免 Host 回退为全表路径查询。 */
type WorkspaceRegistryById = Omit<WorkspaceRegistry, "get"> & {
  get?(workspaceId: string): { workspaceId: string; workspaceRoot: string; displayName: string; lastOpenedAt: number } | undefined;
};

const DEFAULT_SELECTION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_DIRECTORY_PICKER_TIMEOUT_MS = 5 * 60 * 1_000;

/** 创建仅支持本机原生目录选择器的 Web Workspace Host。 */
export function createWebWorkspaceHost(options: CreateWebWorkspaceHostOptions = {}): WebWorkspaceHost {
  const now = options.now ?? function currentTime() { return Date.now(); };
  const registry = (options.registry ?? createNodeWorkspaceRegistry({ globalStateRoot: options.globalStateRoot, now })) as WorkspaceRegistryById;
  const directoryPicker = options.directoryPicker ?? (options.nativeDirectorySelectionEnabled ? createLocalDirectoryPicker() : undefined);
  const selectionTtlMs = options.selectionTtlMs ?? DEFAULT_SELECTION_TTL_MS;
  const directoryPickerTimeoutMs = Math.max(1, options.directoryPickerTimeoutMs ?? DEFAULT_DIRECTORY_PICKER_TIMEOUT_MS);
  const selections = new Map<string, PendingSelection>();
  const challenges = new Map<string, PendingTrustChallenge>();
  const contexts = new Map<string, Promise<WebWorkspaceContext>>();
  let pickerInFlight: AbortController | undefined;

  /** 返回指定目录的稳定 stateRoot 对应 TrustPolicy。 */
  function getTrustPolicy(workspaceRoot: string): WorkspaceTrustPolicy {
    const stateRoot = resolveNodeStateRoot({ workspaceRoot, globalStateRoot: options.globalStateRoot });
    return createNodeTrustPolicy({ stateRoot });
  }

  /** 将 Registry 条目投影为浏览器安全摘要，不初始化 Runtime。 */
  async function toSummary(entry: { workspaceId: string; workspaceRoot: string; displayName: string; lastOpenedAt: number }): Promise<WebWorkspaceSummary> {
    let available = false;
    try {
      available = fs.statSync(entry.workspaceRoot).isDirectory();
    } catch {
      available = false;
    }
    const trustStatus = (await getTrustPolicy(entry.workspaceRoot).getTrustStatus(entry.workspaceRoot)).status;
    return { workspaceId: entry.workspaceId, displayName: entry.displayName, lastOpenedAt: entry.lastOpenedAt, available, trustStatus };
  }

  /** canonicalize 并拒绝不存在或非目录的候选，错误不携带路径。 */
  function requireCanonicalDirectory(candidate: string): { workspaceRoot: string; workspaceId: string; displayName: string } {
    if (!candidate.trim()) throw new WebWorkspaceHostError("DIRECTORY_INVALID", "所选目录不可用");
    const workspaceRoot = canonicalizeNodePath(candidate);
    try {
      if (!fs.statSync(workspaceRoot).isDirectory()) throw new WebWorkspaceHostError("DIRECTORY_INVALID", "所选目录不可用");
    } catch (error) {
      if (error instanceof WebWorkspaceHostError) throw error;
      throw new WebWorkspaceHostError("DIRECTORY_INVALID", "所选目录不可用");
    }
    const workspaceId = createNodeWorkspaceId(workspaceRoot);
    const displayName = workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "工作区";
    return { workspaceRoot, workspaceId, displayName };
  }

  /** 读取一次性选择令牌；成功读取后立即删除，防止重放。 */
  function consumeSelection(selectionToken: string): PendingSelection {
    const selection = selections.get(selectionToken);
    selections.delete(selectionToken);
    if (!selection || selection.expiresAt <= now()) throw new WebWorkspaceHostError("DIRECTORY_SELECTION_EXPIRED", "目录选择已过期，请重新选择");
    return selection;
  }

  /** 读取一次性 Trust challenge；成功读取后立即删除。 */
  function consumeChallenge(challengeId: string): PendingTrustChallenge {
    const challenge = challenges.get(challengeId);
    challenges.delete(challengeId);
    if (!challenge || challenge.expiresAt <= now()) throw new WebWorkspaceHostError("TRUST_CHALLENGE_EXPIRED", "信任确认已过期，请重新选择");
    return challenge;
  }

  /** 优先调用 Adapter 的按 ID 查询；未重建的旧运行时产物只安全地回退为内存索引扫描。 */
  function getRegistryEntry(workspaceId: string) {
    if (registry.get) return registry.get(workspaceId);
    return registry.list().find(function findWorkspace(entry) { return entry.workspaceId === workspaceId; });
  }

  /** 确保可信 Runtime 内存在且只存在当前 canonical workspace 的 Project。 */
  async function createDefaultContext(input: { workspaceId: string; workspaceRoot: string; displayName: string; stateRoot: string }): Promise<WebWorkspaceContext> {
    const { createWebCompositionRoot } = await import("../composition-root");
    const root = createWebCompositionRoot({
      config: { host: "web", debug: false, logLevel: "info", context: {}, workspaceRoot: input.workspaceRoot },
      stateRoot: input.stateRoot,
    });
    const runtime = await root.bootstrap();
    const existing = (await runtime.projects.list()).find(function isWorkspaceProject(project) {
      return project.workspaceRoot === input.workspaceRoot;
    });
    const project = existing ?? await runtime.projects.create({ name: input.displayName, workspaceRoot: input.workspaceRoot });
    return { workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, runtime, projectId: project.id, compositionRoot: root };
  }

  /** 根据 Registry 条目复查身份、Trust 并按 workspaceId 去重 Runtime bootstrap。 */
  async function getContext(workspaceId: string): Promise<WebWorkspaceContext> {
    const entry = getRegistryEntry(workspaceId);
    if (!entry) throw new WebWorkspaceHostError("WORKSPACE_NOT_FOUND", "工作区不存在");
    const candidate = requireCanonicalDirectory(entry.workspaceRoot);
    if (candidate.workspaceId !== workspaceId) throw new WebWorkspaceHostError("WORKSPACE_NOT_FOUND", "工作区不存在");
    const trustStatus = (await getTrustPolicy(candidate.workspaceRoot).getTrustStatus(candidate.workspaceRoot)).status;
    if (trustStatus !== "trusted") {
      contexts.delete(workspaceId);
      throw new WebWorkspaceHostError("WORKSPACE_NOT_TRUSTED", "工作区尚未获得信任");
    }
    const existing = contexts.get(workspaceId);
    if (existing) return existing;
    const stateRoot = resolveNodeStateRoot({ workspaceRoot: candidate.workspaceRoot, globalStateRoot: options.globalStateRoot });
    const pending = (options.createContext ?? createDefaultContext)({ ...candidate, stateRoot });
    contexts.set(workspaceId, pending);
    try {
      return await pending;
    } catch (error) {
      if (contexts.get(workspaceId) === pending) contexts.delete(workspaceId);
      throw error;
    }
  }

  return {
    /** 读取 Registry 与 Trust 摘要；不会扫描能力或创建状态目录。 */
    async listWorkspaces(): Promise<WebWorkspaceSummary[]> {
      return Promise.all(registry.list().map(function mapWorkspace(entry) { return toSummary(entry); }));
    },

    /** 仅向本机 UI 声明原生 chooser 是否可用，不暴露平台、路径或底层错误。 */
    isDirectorySelectionAvailable(): boolean {
      return Boolean(directoryPicker);
    },

    /** 调用宿主原生目录框，并把 canonical 候选封装为短期一次性 token；请求中断或超时会主动释放 chooser。 */
    async beginDirectorySelection(requestSignal?: AbortSignal): Promise<WebDirectorySelection | undefined> {
      if (!directoryPicker) throw new WebWorkspaceHostError("DIRECTORY_PICKER_UNAVAILABLE", "当前 Host 不支持本机目录选择");
      if (pickerInFlight) throw new WebWorkspaceHostError("DIRECTORY_PICKER_BUSY", "目录选择正在进行");
      if (requestSignal?.aborted) return undefined;
      const pickerController = new AbortController();
      pickerInFlight = pickerController;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let removeRequestAbortListener: (() => void) | undefined;
      try {
        const selected = await new Promise<string | undefined>(function awaitPicker(resolve, reject) {
          let settled = false;
          function settle(value: string | undefined): void {
            if (settled) return;
            settled = true;
            resolve(value);
          }
          function abortPicker(): void {
            pickerController.abort();
            settle(undefined);
          }
          if (requestSignal) {
            requestSignal.addEventListener("abort", abortPicker, { once: true });
            removeRequestAbortListener = function removeAbortListener() {
              requestSignal.removeEventListener("abort", abortPicker);
            };
            if (requestSignal.aborted) abortPicker();
          }
          timeoutId = setTimeout(abortPicker, directoryPickerTimeoutMs);
          Promise.resolve()
            .then(function invokeDirectoryPicker() { return directoryPicker(pickerController.signal); })
            .then(settle, function handlePickerError(error: unknown) {
              if (pickerController.signal.aborted) {
                settle(undefined);
                return;
              }
              reject(error);
            });
        });
        if (pickerController.signal.aborted) return undefined;
        if (!selected) return undefined;
        const candidate = requireCanonicalDirectory(selected);
        const selectionToken = randomUUID();
        const expiresAt = now() + selectionTtlMs;
        selections.set(selectionToken, { workspaceRoot: candidate.workspaceRoot, displayName: candidate.displayName, expiresAt });
        return { selectionToken, displayName: candidate.displayName, expiresAt };
      } catch (error) {
        if (pickerController.signal.aborted) return undefined;
        if (error instanceof WebWorkspaceHostError) throw error;
        throw new WebWorkspaceHostError("DIRECTORY_PICKER_UNAVAILABLE", "无法打开本机目录选择器");
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        removeRequestAbortListener?.();
        if (pickerInFlight === pickerController) pickerInFlight = undefined;
      }
    },

    /** 消费 token 后复查 Trust；未信任时只创建挑战，绝不创建 Runtime。 */
    async inspectSelection(selectionToken: string): Promise<WebWorkspaceTrustChallenge | WebWorkspaceSummary> {
      const selection = consumeSelection(selectionToken);
      const candidate = requireCanonicalDirectory(selection.workspaceRoot);
      const trustStatus = (await getTrustPolicy(candidate.workspaceRoot).getTrustStatus(candidate.workspaceRoot)).status;
      if (trustStatus === "trusted") return toSummary(registry.register(candidate.workspaceRoot));
      const challengeId = randomUUID();
      challenges.set(challengeId, { ...selection, challengeId, trustStatus });
      return { challengeId, displayName: candidate.displayName, trustStatus };
    },

    /** 记录用户的显式 Trust 决定；allow 后才注册目录并 bootstrap 对应 Runtime。 */
    async submitTrust(input: { challengeId: string; decision: "allow" | "deny" }): Promise<WebWorkspaceSummary> {
      const challenge = consumeChallenge(input.challengeId);
      const candidate = requireCanonicalDirectory(challenge.workspaceRoot);
      const trustPolicy = getTrustPolicy(candidate.workspaceRoot);
      if (input.decision === "deny") {
        const entry = await trustPolicy.denyTrust(candidate.workspaceRoot);
        return { workspaceId: candidate.workspaceId, displayName: candidate.displayName, lastOpenedAt: now(), available: true, trustStatus: entry.status };
      }
      await trustPolicy.grantTrust(candidate.workspaceRoot);
      const verified = await trustPolicy.getTrustStatus(candidate.workspaceRoot);
      if (verified.status !== "trusted") throw new WebWorkspaceHostError("WORKSPACE_NOT_TRUSTED", "工作区尚未获得信任");
      const summary = await toSummary(registry.register(candidate.workspaceRoot));
      await getContext(summary.workspaceId);
      return summary;
    },

    getContext,

    /** 只注销 Registry；不删除目录、Trust、state 或运行中的 Runtime。 */
    async removeWorkspace(workspaceId: string): Promise<boolean> {
      return registry.remove(workspaceId);
    },
  };
}

/** 按平台创建本机目录选择器；仅 Windows 与 macOS 支持，其他平台不降级为路径输入。 */
export function createLocalDirectoryPicker(): WebDirectoryPicker | undefined {
  return createLocalDirectoryPickerForPlatform(process.platform);
}

/** 按指定平台构造 picker，供定向测试确认 Windows/macOS 能力声明。 */
export function createLocalDirectoryPickerForPlatform(platform: NodeJS.Platform): WebDirectoryPicker | undefined {
  const command = platform === "win32"
    ? {
      executable: "powershell.exe",
      args: ["-NoProfile", "-STA", "-Command", "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '选择工作区'; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }"],
    }
    : platform === "darwin"
      ? {
        executable: "osascript",
        args: ["-e", "try\nPOSIX path of (choose folder with prompt \"选择工作区\")\non error number -128\nreturn \"\"\nend try"],
      }
      : undefined;
  if (!command) return undefined;
  return function pickLocalDirectory(signal?: AbortSignal): Promise<string | undefined> {
    return new Promise<string | undefined>(function waitForNativePicker(resolve, reject) {
      // PowerShell hosts the WinForms FolderBrowserDialog. Hiding the child
      // process also hides its modal dialog, leaving the HTTP request pending
      // with no window the user can confirm or cancel.
      // 与 PowerShell 的无 BOM UTF-8 输出配对，避免中文路径受启动终端代码页影响。
      execFile(command.executable, command.args, { encoding: "utf8", windowsHide: false, maxBuffer: 8 * 1_024, signal }, function onPickerExit(error, stdout) {
        if (error) {
          if (signal?.aborted) {
            resolve(undefined);
            return;
          }
          reject(error);
          return;
        }
        const selected = stdout.trim();
        resolve(selected || undefined);
      });
    });
  };
}
