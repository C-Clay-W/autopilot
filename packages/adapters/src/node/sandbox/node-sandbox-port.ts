/**
 * node/sandbox/node-sandbox-port.ts — SandboxPort 的 SRT（Node 平台）实现。
 *
 * Talk-Plan0917 Stage 2：在 Node Adapter 内接入钉死版本 SRT 0.0.78，绑定单一
 * canonical workspaceRoot；macOS 使用 Seatbelt，Windows 使用原生 argv、会话 ACL 与 WFP。
 * Windows 初始化与网络验证成功后可包装命令；完整路径、Job 与 MCP 门禁仍未通过。
 *
 * 关键映射决策（吸收 Stage 0 Spike 事实）：
 * - macOS SRT 输入面是 shell 命令字符串、输出面是结构化 argv + env：Adapter 把 Core 校验过
 *   的 program + args 用 POSIX 单引号序列化为 wrap 输入，wrap 输出 argv 直接交给
 *   spawn，Core 契约"不返回拼接字符串给工具解释"由输出面保证；
 * - SRT 0.0.78 在 macOS 硬编码注入 TMPDIR=/tmp/claude：Adapter 在 wrap 输入前缀显式
 *   覆盖 TMPDIR 为宿主验证的受控 tempRoot，不默认继承 SRT 的内部路径；
 * - 网络 deny-by-default：allowedDomains 仅来自宿主 settings/policy，空列表即全拒；
 * - allowAppleEvents 固定 false；不支持 excludedCommands；不做 unsandboxed retry。
 */

import {
  SANDBOX_ERROR_CODES,
  SandboxPortError,
  type SandboxCapabilityReport,
  type SandboxEnforcement,
  type SandboxExecutionRequest,
  type SandboxPort,
  type SandboxPreparedCommand,
  type SandboxPolicy,
} from "@autopilot-agent/core";
import { type SrtRuntimeSurface, loadSrtRuntimeSurface, readSrtVersion } from "./srt-module";
import { formatSandboxFailureDiagnostic, readWindowsSandboxCapability, runWindowsSandboxSetup } from "./windows-sandbox-setup";
import { finalizeWindowsSandboxArgv, resolveWindowsSandboxCommand, resolveWindowsSandboxRunner } from "./windows-sandbox-command";
import { createManagedExecutionControl } from "./managed-execution-control";
import path from "node:path";
import { getNodeFileMutationLockRoot } from "../file-mutation-locks";
import { canonicalizeNodePath } from "../state-root";

/** SRT manager 是进程级单例；所有平台不同 Port 均不得改写他人的执行策略。 */
const managerOwners = new WeakMap<object, object>();

/** createNodeSandboxPort 的装配选项。 */
export interface NodeSandboxPortOptions {
  /** 已 canonical 化的绑定工作区根；进程级全局沙箱只服务这一个 root。 */
  workspaceRoot: string;
  /** 宿主显式绑定的授权与恢复状态根；缺失时不允许启动命令。 */
  stateRoot?: string;
  /** 宿主显式验证的受控 tempRoot；缺省时不覆盖 SRT 注入的 TMPDIR。 */
  tempRoot?: string;
  /** 仅宿主可指定 Windows runner；缺省优先使用与依赖哈希一致的公共副本。 */
  windowsSrtWinExe?: string;
  /** 宿主显式启用候选私有管道协议；必须同时提供候选原生 runner 路径。 */
  managedExecutionProtocol?: 1;
  /** 测试 seam；生产默认非字面量动态 import SRT。 */
  loadModule?: () => Promise<SrtRuntimeSurface>;
}

/** POSIX 单引号转义：关闭一切插值，防注入。 */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 把已校验的结构化 program + args 序列化为 SRT wrap 输入；tempRoot 存在时以
 * `TMPDIR=<tempRoot>` 环境前缀覆盖 SRT 注入的 /tmp/claude。
 */
export function serializePosixCommand(program: string, args: readonly string[], tempRoot?: string): string {
  const command = [posixQuote(program), ...args.map(posixQuote)].join(" ");
  return tempRoot !== undefined ? `TMPDIR=${posixQuote(tempRoot)} ${command}` : command;
}

/** 把冻结 SandboxPolicy 映射为 SRT SandboxRuntimeConfig；网络默认拒绝，写边界按 mode 收放。 */
export function buildSrtRuntimeConfig(policy: SandboxPolicy): Record<string, unknown> {
  if ("externalWriteCapability" in policy && policy.externalWriteCapability !== undefined) throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "当前平台未证明精确外部文件写边界，不能提升父目录写根");
  return {
    network: {
      allowedDomains: [...policy.allowedDomains],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: [...policy.deniedRead],
      // 所有可写模式仅授予工作区与受控 temp；模式本身不授予任何外部修改能力。
      allowWrite: policy.mode !== "read-only" && policy.workspaceRoot !== undefined ? [...new Set([policy.workspaceRoot, ...(policy.tempRoot !== undefined ? [policy.tempRoot] : [])])] : [],
      denyWrite: [...policy.deniedWrite],
    },
    allowAppleEvents: false,
  };
}

/** 构造绑定单一 workspaceRoot 的 SandboxPort；同一进程内多个实例共享 SRT 全局 manager。 */
export function createNodeSandboxPort(options: NodeSandboxPortOptions): SandboxPort {
  let module: SrtRuntimeSurface | undefined;
  let initPromise: Promise<void> | undefined;
  let initConfigKey: string | undefined;
  let shutdown = false;
  /** 最近一次 release 清理失败的脱敏诊断；release 契约幂等不抛，诊断经 status 暴露。 */
  let cleanupDiagnostic: string | undefined;
  const activeExecutions = new Set<string>();
  const executionControls = new Map<string, ReturnType<typeof createManagedExecutionControl>>();
  let windowsRunner: string | undefined;
  const owner = {};
  let operationTail: Promise<unknown> = Promise.resolve();

  /** 串行 prepare/release/shutdown；异步 wrap 期间也保持执行域预约。 */
  function serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation);
    operationTail = result.catch(function retainQueue() {});
    return result;
  }

  /** 比较读允许与敏感拒绝是否交叉；不确定的通配拒绝规则直接阻塞。 */
  function overlapsDeniedRead(root: string, denied: string): boolean {
    if (/[*?\[\]{}]/u.test(denied)) return true;
    const paths = /^[a-z]:/iu.test(root) || /^[a-z]:/iu.test(denied) ? path.win32 : path.posix;
    /** 按对应平台规范路径；Windows 比较忽略大小写。 */
    function normalize(candidate: string): string {
      const value = paths.resolve(candidate);
      return paths === path.win32 ? value.toLowerCase() : value;
    }
    const left = normalize(root);
    const right = normalize(denied);
    return left === right || left.startsWith(right.endsWith(paths.sep) ? right : `${right}${paths.sep}`) || right.startsWith(left.endsWith(paths.sep) ? left : `${left}${paths.sep}`);
  }

  /** 注入不可由权限模式覆盖的授权配置与 durable 状态保护域。 */
  function protectAuthority(policy: SandboxPolicy): SandboxPolicy {
    const settingsRoot = path.join(options.workspaceRoot, ".autopilot");
    const writes = [getNodeFileMutationLockRoot(), ...["settings.json", "settings.local.json", "mcp.json"].map(function settingsPath(file) { return path.join(settingsRoot, file); })];
    const state = options.stateRoot ? [options.stateRoot, canonicalizeNodePath(options.stateRoot)] : [];
    return { ...policy, deniedRead: [...new Set([...policy.deniedRead, ...state])], deniedWrite: [...new Set([...policy.deniedWrite, ...state, ...writes, ...writes.map(function canonical(candidate) { return canonicalizeNodePath(candidate); })])] };
  }

  /** 加载 SRT 模块（缓存）；加载失败映射为 SANDBOX_UNAVAILABLE。 */
  async function ensureModule(): Promise<SrtRuntimeSurface> {
    if (!module) {
      try {
        module = await (options.loadModule ?? loadSrtRuntimeSurface)();
      } catch (error) {
        throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, formatSandboxFailureDiagnostic("module-load", error));
      }
    }
    return module;
  }

  /** 按失败阶段映射稳定错误码；仅保留白名单底层码。 */
  function toPortError(error: unknown, phase: string, fallbackCode: string = SANDBOX_ERROR_CODES.UNAVAILABLE): SandboxPortError {
    if (error instanceof SandboxPortError && error.message.startsWith("phase=")) return error;
    return new SandboxPortError(error instanceof SandboxPortError ? error.code : fallbackCode, formatSandboxFailureDiagnostic(phase, error));
  }

  /** 按冻结策略初始化；macOS 更新 config，Windows 无活动命令时重建会话 ACL。 */
  async function ensureInitialized(policy: SandboxPolicy): Promise<SrtRuntimeSurface> {
    if (shutdown) throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "沙箱已 shutdown，无法初始化");
    if (cleanupDiagnostic) throw new SandboxPortError(SANDBOX_ERROR_CODES.CLEANUP_FAILED, "沙箱清理未确认，禁止继续执行");
    const mod = await ensureModule();
    if (!mod.SandboxManager.isSupportedPlatform()) {
      throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, `当前平台 ${process.platform} 不被沙箱 backend 支持`);
    }
    const dependencies = process.platform === "win32" ? { errors: [] } : mod.SandboxManager.checkDependencies();
    if (dependencies.errors.length > 0) {
      throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "沙箱平台依赖缺失，无法提供已隔离执行");
    }
    const currentOwner = managerOwners.get(mod.SandboxManager);
    if (currentOwner !== undefined && currentOwner !== owner) throw new SandboxPortError(SANDBOX_ERROR_CODES.SCOPE_CONFLICT, "共享沙箱已被另一 Port 绑定，拒绝策略混用");
    const protectedPolicy = protectAuthority(policy);
    const config = buildSrtRuntimeConfig(protectedPolicy);
    if (process.platform === "win32") {
      if (policy.mode === "danger-full-access") throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "Windows 暂不支持全盘写授权，命令未启动");
      windowsRunner ??= resolveWindowsSandboxRunner(mod.VENDORED_SRT_WIN_EXE, options.windowsSrtWinExe);
      config.windows = { srtWin: { path: windowsRunner } };
      if (policy.mode === "read-only") {
        if (protectedPolicy.deniedRead.some(function deniedOverlap(denied) { return overlapsDeniedRead(options.workspaceRoot, denied); })) throw new SandboxPortError(SANDBOX_ERROR_CODES.POLICY_DENIED, "必要读根与敏感拒绝域交叉，目标命令未启动");
        (config.filesystem as Record<string, unknown>).allowRead = [options.workspaceRoot];
      }
    }
    const configKey = JSON.stringify(config);
    if (initPromise && configKey === initConfigKey) {
      await initPromise;
      return mod;
    }
    if (initPromise) {
      try {
        await initPromise;
        if (activeExecutions.size > 0) throw new SandboxPortError(SANDBOX_ERROR_CODES.SCOPE_CONFLICT, "存在活动沙箱执行，拒绝切换共享策略");
        if (process.platform === "win32") {
          // Windows ACL 为会话级；不能仅 updateConfig 后假称新模式已经生效。
          await mod.SandboxManager.reset();
          initPromise = undefined;
          initConfigKey = undefined;
        } else {
          mod.SandboxManager.updateConfig(config);
          initConfigKey = configKey;
          return mod;
        }
      } catch (error) {
        throw toPortError(error, "initialize");
      }
    }
    managerOwners.set(mod.SandboxManager, owner);
    initConfigKey = configKey;
    initPromise = (async () => {
      await mod.SandboxManager.initialize(config);
      // 网络限制未就绪时不允许启动任何被包装命令（fail-closed）。
      if (!(await mod.SandboxManager.waitForNetworkInitialization())) {
        throw new SandboxPortError(SANDBOX_ERROR_CODES.RUNNER_FAILED, "沙箱网络限制未就绪，目标命令未启动");
      }
    })();
    try {
      await initPromise;
    } catch (error) {
      // 初始化失败不缓存成功状态，允许后续重试；错误统一映射。
      initPromise = undefined;
      initConfigKey = undefined;
      await mod.SandboxManager.reset().catch(function ignoreResetFailure() { cleanupDiagnostic = "沙箱初始化失败后的 reset 失败"; });
      if (!cleanupDiagnostic) managerOwners.delete(mod.SandboxManager);
      throw toPortError(error, "initialize");
    }
    return mod;
  }

  /** 未初始化场景 status 使用默认 policy 触发惰性初始化（Trust 后绑定 root，缺省 workspace-write）。 */
  const defaultPolicy: SandboxPolicy = {
    mode: "workspace-write",
    workspaceRoot: options.workspaceRoot,
    ...(options.tempRoot !== undefined ? { tempRoot: options.tempRoot } : {}),
    allowedDomains: Object.freeze([]),
    deniedRead: Object.freeze([]),
    deniedWrite: Object.freeze([]),
  };

  /** 组装 unavailable 能力报告。 */
  function unavailableReport(diagnostics: readonly string[]): SandboxCapabilityReport {
    return { platform: describePlatform(), backend: "srt", enforcement: "unavailable", installed: false, diagnostics: [...diagnostics] };
  }

  return {
    async status(): Promise<SandboxCapabilityReport> {
      return serializeOperation(async function statusLocked() {
        if (shutdown) return unavailableReport(["沙箱已 shutdown"]);
        if (cleanupDiagnostic) return unavailableReport([cleanupDiagnostic]);
        if (process.platform === "win32") {
          let phase = "module-load";
          try {
            const mod = await ensureModule();
            phase = "runner-resolve";
            windowsRunner ??= resolveWindowsSandboxRunner(mod.VENDORED_SRT_WIN_EXE, options.windowsSrtWinExe);
            phase = "capability-probe";
            const report = await readWindowsSandboxCapability({ loadModule: options.loadModule, srtWinExe: windowsRunner });
            if (!report.provisioned) return report;
            phase = "initialize";
            if (initPromise) await initPromise;
            else await ensureInitialized(defaultPolicy);
            return { ...report, enforcement: "full", diagnostics: [...(report.diagnostics ?? []), "network_fence_verified=true", ...(cleanupDiagnostic ? [cleanupDiagnostic] : [])] };
          } catch (error) {
            return unavailableReport([toPortError(error, phase).message]);
          }
        }
        if (process.platform !== "darwin") return unavailableReport([`平台 ${process.platform} 不在首发支持列表`]);
        try {
          const mod = await ensureInitialized(defaultPolicy);
          const version = readSrtVersion();
          return {
            platform: "macos",
            backend: "srt-seatbelt",
            enforcement: "full",
            installed: true,
            provisioned: true,
            ...(version !== undefined ? { version } : {}),
            ...(cleanupDiagnostic !== undefined ? { diagnostics: [cleanupDiagnostic] } : {}),
          };
        } catch (error) {
          return unavailableReport([error instanceof SandboxPortError ? error.message : "沙箱初始化失败"]);
        }
      });
    },

    async setup(): Promise<SandboxCapabilityReport> {
      if (shutdown) throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "沙箱已 shutdown，无法执行 setup");
      if (activeExecutions.size > 0) throw new SandboxPortError(SANDBOX_ERROR_CODES.SCOPE_CONFLICT, "仍有活动执行，禁止执行系统 setup");
      // macOS Seatbelt 无需 provision；显式 setup 仅返回当前能力报告。
      if (process.platform === "darwin") return this.status();
      // Windows provision（UAC）是系统级变更，只能由宿主显式命令触发到这里。
      if (process.platform === "win32") {
        const mod = await ensureModule();
        windowsRunner ??= resolveWindowsSandboxRunner(mod.VENDORED_SRT_WIN_EXE, options.windowsSrtWinExe);
        return runWindowsSandboxSetup({ loadModule: options.loadModule, srtWinExe: windowsRunner });
      }
      throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, `平台 ${process.platform} 无沙箱 setup 流程`);
    },

    async prepare(request: SandboxExecutionRequest): Promise<SandboxPreparedCommand> {
      return serializeOperation(async function prepareLocked() {
        if ("externalWriteCapability" in request.policy && request.policy.externalWriteCapability !== undefined) throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "外部精确文件能力尚未通过 OS 门禁，目标命令未启动");
        if (shutdown) throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "沙箱已 shutdown，无法准备执行");
        if (!options.stateRoot) throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "未绑定授权状态保护域，目标命令未启动");
        if (options.managedExecutionProtocol !== undefined && (options.managedExecutionProtocol !== 1 || !options.windowsSrtWinExe)) throw new SandboxPortError(SANDBOX_ERROR_CODES.RUNNER_FAILED, "候选执行协议必须绑定宿主指定 runner");
        if (activeExecutions.has(request.commandId)) throw new SandboxPortError(SANDBOX_ERROR_CODES.SCOPE_CONFLICT, "执行已绑定，禁止复用活动 executionId");
        // 单 root guard：检测到另一个 canonical workspaceRoot 时拒绝热切全局沙箱状态。
        if (request.policy.workspaceRoot !== undefined && request.policy.workspaceRoot !== options.workspaceRoot) {
          throw new SandboxPortError(SANDBOX_ERROR_CODES.SCOPE_CONFLICT, "沙箱已绑定另一工作区，拒绝并行多根使用");
        }
        // 仅支持已接入的原生平台；初始化或网络验证失败时不启动目标。
        if (process.platform !== "darwin" && process.platform !== "win32") {
          throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "当前平台的命令执行路径未通过实机门禁，目标命令未启动");
        }
        const mod = await ensureInitialized(request.policy);
        activeExecutions.add(request.commandId);
        try {
          const command = serializePosixCommand(request.program, request.args, request.policy.tempRoot ?? options.tempRoot);
          let wrapped: { argv: string[]; env: NodeJS.ProcessEnv };
          if (process.platform === "win32") {
            let target: ReturnType<typeof resolveWindowsSandboxCommand>;
            try {
              target = resolveWindowsSandboxCommand(request.program, request.args);
            } catch (error) {
              throw toPortError(error, "command-resolve");
            }
            try {
              wrapped = await mod.SandboxManager.wrapWithSandboxArgv("", target, undefined, undefined, request.cwd, { commandId: request.commandId });
              wrapped.argv = finalizeWindowsSandboxArgv(wrapped.argv, target, request.policy.tempRoot ?? options.tempRoot);
            } catch (error) {
              throw toPortError(error, "wrap", SANDBOX_ERROR_CODES.RUNNER_FAILED);
            }
          } else {
            try {
              wrapped = await mod.SandboxManager.wrapWithSandboxArgv(command, "/bin/bash", undefined, undefined, request.cwd, { commandId: request.commandId });
            } catch (error) {
              throw toPortError(error, "wrap", SANDBOX_ERROR_CODES.RUNNER_FAILED);
            }
          }
          if (wrapped.argv.length === 0) {
            throw new SandboxPortError(SANDBOX_ERROR_CODES.RUNNER_FAILED, "沙箱包装输出为空，目标命令未启动");
          }
          const enforcement: SandboxEnforcement = "full";
          const control = process.platform === "win32" && request.managed && options.managedExecutionProtocol === 1 ? createManagedExecutionControl() : undefined;
          if (control) {
            const marker = wrapped.argv.indexOf("--");
            if (marker < 1) throw new SandboxPortError(SANDBOX_ERROR_CODES.RUNNER_FAILED, "候选 runner 参数边界缺失");
            wrapped.argv.splice(marker, 0, "--job-control-v1");
            executionControls.set(request.commandId, control);
          }
          return {
            executionId: request.commandId,
            executable: wrapped.argv[0],
            args: wrapped.argv.slice(1),
            env: { ...wrapped.env } as Record<string, string>,
            enforcement,
            ...(control ? { control } : {}),
          };
        } catch (error) {
          activeExecutions.delete(request.commandId);
          try { mod.SandboxManager.cleanupAfterCommand(); } catch { cleanupDiagnostic = "沙箱包装失败后的清理未确认"; }
          throw error;
        }
      });
    },

    async release(executionId: string): Promise<void> {
      return serializeOperation(async function releaseLocked() {
        if (!activeExecutions.has(executionId)) return;
        executionControls.get(executionId)?.dispose();
        executionControls.delete(executionId);
        activeExecutions.delete(executionId);
        // cleanupAfterCommand 幂等（Spike 验证）；未初始化时无 per-command 资源可清理。
        if (!module || !initPromise) return;
        try {
          module.SandboxManager.cleanupAfterCommand();
        } catch {
          cleanupDiagnostic = "沙箱按命令资源清理失败，已记录诊断（不中断释放）";
        }
      });
    },

    async shutdown(): Promise<void> {
      return serializeOperation(async function shutdownLocked() {
        if (shutdown) return;
        // 未确认终态时保留控制与策略资源，由 Runtime 的 Job 停止流程处理。
        if (activeExecutions.size > 0) throw new SandboxPortError(SANDBOX_ERROR_CODES.CLEANUP_FAILED, "仍有活动执行，禁止提前 shutdown");
        shutdown = true;
        if (module && initPromise) {
          try {
            await module.SandboxManager.reset();
            cleanupDiagnostic = undefined;
          } catch {
            cleanupDiagnostic = "沙箱 shutdown 时 reset 失败，可能存在平台资源残留";
          }
        }
        if (module && !cleanupDiagnostic && managerOwners.get(module.SandboxManager) === owner) managerOwners.delete(module.SandboxManager);
      });
    },
  };
}

/** 把 Node 平台映射为 SandboxCapabilityReport.platform 值域。 */
function describePlatform(): SandboxCapabilityReport["platform"] {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  return "unknown";
}
