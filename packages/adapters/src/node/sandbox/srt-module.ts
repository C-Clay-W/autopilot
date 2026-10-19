/**
 * node/sandbox/srt-module.ts — SRT（@anthropic-ai/sandbox-runtime）的受控加载面。
 *
 * SRT 是 ESM-only 包且自带平台二进制资产，必须保持为运行时依赖；本模块用非字面量
 * 动态 import 加载，避免 esbuild 把 CJS 产物中的动态导入降级为 require(ESM)。Adapter
 * 只消费本文件声明的 SrtRuntimeSurface 窄接口，测试用 fake 通过 loadModule seam 注入。
 */

/** Adapter 实际消费的 SandboxManager 方法面；与 ISandboxManager 的对应子集保持同步。 */
export interface SrtSandboxManagerSurface {
  initialize(runtimeConfig: unknown): Promise<void>;
  isSupportedPlatform(): boolean;
  isSandboxingEnabled(): boolean;
  checkDependencies(): { warnings: string[]; errors: string[] };
  waitForNetworkInitialization(): Promise<boolean>;
  wrapWithSandboxArgv(
    command: string,
    binShell?: string | { exe: string; args: readonly string[] },
    customConfig?: unknown,
    abortSignal?: AbortSignal,
    cwd?: string,
    options?: { commandId?: string; commandText?: string },
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
  updateConfig(newConfig: unknown): void;
}

/** Windows status/setup 的消费面（Talk-Plan0917：Windows 实机操作按老大指示暂缓，仅保留显式入口）。 */
export interface SrtWindowsSurface {
  checkWindowsSandboxStatusAsync(options?: { srtWin?: { exe: string; prependArgs: readonly string[] } }): Promise<{
    user: { provisioned: boolean; credPresent: boolean; realUserSid: string };
    wfp: { state: "absent" | "installed" | "cannot-read"; filters: number };
  }>;
  installWindowsSandboxAsync(options?: {
    srtWin?: { exe: string; prependArgs: readonly string[] };
    force?: boolean;
  }): Promise<{ wfp: { state: string; filters: number }; user: { provisioned: boolean; credPresent: boolean }; cancelled?: true }>;
  WindowsSandboxError: new (code: string, message: string, subcommand?: string) => Error & { code: string };
  VENDORED_SRT_WIN_EXE: string;
}

/** SRT 主入口的窄类型面；loadModule 的返回值只需满足该结构。 */
export interface SrtRuntimeSurface extends SrtWindowsSurface {
  SandboxManager: SrtSandboxManagerSurface;
}

/** SRT 包标识；类型引用使用字面量，运行时加载使用同值变量以绕过打包器静态分析。 */
const SRT_MODULE_SPECIFIER = "@anthropic-ai/sandbox-runtime";

/** SRT 主入口的类型投影（仅类型位置使用字面量 import()，运行时被擦除）。 */
export type SrtModule = typeof import("@anthropic-ai/sandbox-runtime");

/** 读取 SRT 包版本；仅 CJS 产物可用 require 解析，ESM/测试注入场景返回 undefined，不参与业务分支。 */
export function readSrtVersion(): string | undefined {
  try {
    if (typeof require !== "function") return undefined;
    // 有意使用运行时 require：版本读取只发生在 CJS 产物，且已用 typeof 探测防御 ESM 场景。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require(`${SRT_MODULE_SPECIFIER}/package.json`) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** 生产默认加载器：非字面量动态 import，运行时由 Node 原生解析 ESM 包。 */
export function loadSrtRuntimeSurface(): Promise<SrtRuntimeSurface> {
  return import(SRT_MODULE_SPECIFIER) as Promise<SrtRuntimeSurface>;
}
