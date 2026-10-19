/**
 * node/sandbox/windows-sandbox-setup.ts — Windows 沙箱 status/setup 的显式入口。
 *
 * Windows provision（专用账户/WFP/ACL）属于系统变更，只能由宿主显式命令触发
 * （Talk-Plan0917 边界 3）；本模块把 SRT 的 srt-win 探测与安装结果投影为脱敏的
 * SandboxCapabilityReport，不泄露 SID、用户名、凭据状态明细或真实路径。Windows
 * 实机操作当前按老大指示暂缓，这里只保证 fail-closed 的语义与稳定错误码。
 */

import { SANDBOX_ERROR_CODES, SandboxPortError, type SandboxCapabilityReport } from "@autopilot-agent/core";
import { type SrtRuntimeSurface, loadSrtRuntimeSurface } from "./srt-module";

/** Windows status/setup 的装配选项；loadModule 为测试 seam。 */
export interface WindowsSandboxSetupOptions {
  /** 覆盖默认 srt-win 二进制路径（生产可指向宿主自签名二进制；SRT 要求显式路径）。 */
  srtWinExe?: string;
  /** 测试 seam；生产默认非字面量动态 import SRT。 */
  loadModule?: () => Promise<SrtRuntimeSurface>;
}

/** 判定 WindowsSandboxError 形态的错误（fake 注入的也按 code 判别）。 */
function isWindowsSandboxError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string";
}

/** 仅提取白名单底层错误码与数值 Win32 码；绝不包含异常正文或路径。 */
export function formatSandboxFailureDiagnostic(phase: string, error: unknown): string {
  const source = error && typeof error === "object" ? error as { code?: unknown; win32Code?: unknown } : {};
  const code = typeof source.code === "string" && /^(EPERM|EACCES|ENOENT|ENOTDIR|EINVAL|EBUSY|ETIMEDOUT|not_provisioned)$/.test(source.code) ? source.code : undefined;
  const win32 = typeof source.win32Code === "number" && Number.isSafeInteger(source.win32Code) && source.win32Code >= 0 && source.win32Code <= 0xffffffff
    ? `0x${source.win32Code.toString(16).padStart(8, "0")}` : undefined;
  return [`phase=${phase}`, ...(code ? [`cause=${code}`] : []), ...(win32 ? [`win32=${win32}`] : [])].join(";");
}

/** 把 srt-win 状态投影为脱敏能力报告；provisioned 只输出布尔，不输出 SID/凭据明细。 */
function projectWindowsStatus(mod: SrtRuntimeSurface, status: Awaited<ReturnType<SrtRuntimeSurface["checkWindowsSandboxStatusAsync"]>>, version?: string): SandboxCapabilityReport {
  const provisioned = status.user.provisioned && status.user.credPresent;
  return {
    platform: "windows",
    backend: "srt-windows",
    // Windows 保障等级必须以实机门禁（T12/T13）为准，未验证前不得报告 full。
    enforcement: provisioned ? "partial" : "unavailable",
    installed: true,
    provisioned,
    ...(version !== undefined ? { version } : {}),
    diagnostics: [
      `wfp=${status.wfp.state}`,
      `sandbox_user_provisioned=${status.user.provisioned}`,
      "full 能力需 SandboxPort 初始化与 WFP 行为验证成功；provision 状态本身不证明可执行",
    ],
  };
}

/** 读取 Windows 沙箱安装与 provision 状态；srt-win 不可达等异常统一 fail-closed。 */
export async function readWindowsSandboxCapability(options: WindowsSandboxSetupOptions = {}): Promise<SandboxCapabilityReport> {
  try {
    const mod = await (options.loadModule ?? loadSrtRuntimeSurface)();
    const srtWin = { exe: options.srtWinExe ?? mod.VENDORED_SRT_WIN_EXE, prependArgs: [] as const };
    const status = await mod.checkWindowsSandboxStatusAsync({ srtWin });
    return projectWindowsStatus(mod, status);
  } catch (error) {
    throw toSandboxPortError(error);
  }
}

/** 显式安装入口：触发一次 UAC 提权安装；用户取消 UAC 不视为错误，返回当前状态报告。 */
export async function runWindowsSandboxSetup(options: WindowsSandboxSetupOptions = {}): Promise<SandboxCapabilityReport> {
  try {
    const mod = await (options.loadModule ?? loadSrtRuntimeSurface)();
    const srtWin = { exe: options.srtWinExe ?? mod.VENDORED_SRT_WIN_EXE, prependArgs: [] as const };
    const result = await mod.installWindowsSandboxAsync({ srtWin });
    const status = {
      user: { provisioned: result.user.provisioned, credPresent: result.user.credPresent, realUserSid: "" },
      wfp: { state: result.wfp.state as "absent" | "installed" | "cannot-read", filters: result.wfp.filters },
    };
    const report = projectWindowsStatus(mod, status);
    return result.cancelled === true
      ? { ...report, diagnostics: [...(report.diagnostics ?? []), "install_cancelled: 用户取消了 UAC 提权，安装未执行"] }
      : report;
  } catch (error) {
    throw toSandboxPortError(error);
  }
}

/** 把底层异常映射为稳定 SandboxPortError；不透传原始文案，避免泄露系统细节。 */
function toSandboxPortError(error: unknown): SandboxPortError {
  if (error instanceof SandboxPortError) return error;
  if (isWindowsSandboxError(error)) {
    if (error.code === "not_provisioned") return new SandboxPortError(SANDBOX_ERROR_CODES.NOT_PROVISIONED, "Windows 沙箱未完成 provision，请先显式执行 setup");
    return new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, formatSandboxFailureDiagnostic("capability-probe", error));
  }
  return new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, formatSandboxFailureDiagnostic("capability-probe", error));
}
