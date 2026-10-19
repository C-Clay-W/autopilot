/** Windows 沙箱命令装配：选择可信 runner、解析原生程序，保留 argv 而不经过 shell 插值。 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveWindowsPackageManagerCommand, SANDBOX_ERROR_CODES, SandboxPortError } from "@autopilot-agent/core";

/** 仅采用与当前钉死依赖逐字节一致的公共 runner；没有合格副本时仍使用依赖原件。 */
export function resolveWindowsSandboxRunner(vendored: string, explicit?: string): string {
  if (explicit !== undefined) {
    if (!path.win32.isAbsolute(explicit)) throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "Windows runner 必须是宿主指定的绝对路径");
    return explicit;
  }
  const publicRunner = path.win32.join(process.env.ProgramData ?? "C:\\ProgramData", "AutopilotSandbox", "bin", "srt-win.exe");
  try {
    if (createHash("sha256").update(fs.readFileSync(publicRunner)).digest("hex") === createHash("sha256").update(fs.readFileSync(vendored)).digest("hex")) return publicRunner;
  } catch { /* 公共副本不存在或不匹配时不执行它。 */ }
  return vendored;
}

/** 在宿主侧解析原生程序或可信包管理器 JS；不把 .cmd 交给隐式 shell。
 *  包管理器解析复用 Core 共享受信实现（与 danger-full-access 直接执行同一份逻辑）。 */
export function resolveWindowsSandboxCommand(program: string, args: readonly string[]): { exe: string; args: string[] } {
  const managed = resolveWindowsPackageManagerCommand(program, args);
  if (managed) return { exe: managed.executable, args: managed.args };
  const candidates = path.win32.isAbsolute(program) ? [program] : (process.env.PATH ?? "").split(";").filter(Boolean).map(function candidate(directory) {
    return path.win32.join(directory.replace(/^"|"$/g, ""), /\.exe$/i.test(program) ? program : `${program}.exe`);
  });
  const exe = candidates.find(function exists(candidate) { return fs.existsSync(candidate) && fs.statSync(candidate).isFile(); });
  if (exe === undefined || !/\.exe$/i.test(exe)) throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "Windows 原生可执行程序不可用，命令未启动");
  return { exe, args: [...args] };
}

/** 校验 SRT 固定版本的原生目标尾部，移除空 shell-body，并叠加冻结 temp 环境。 */
export function finalizeWindowsSandboxArgv(argv: readonly string[], target: { exe: string; args: readonly string[] }, tempRoot?: string): string[] {
  const marker = argv.length - target.args.length - 3;
  const expected = ["--", target.exe, ...target.args, ""];
  if (marker < 1 || JSON.stringify(argv.slice(marker)) !== JSON.stringify(expected)) throw new SandboxPortError(SANDBOX_ERROR_CODES.RUNNER_FAILED, "Windows 沙箱包装结构异常，命令未启动");
  const env = tempRoot === undefined ? [] : ["TEMP", "TMP", "TMPDIR"].flatMap(function entry(key) { return ["--env", `${key}=${tempRoot}`]; });
  return [...argv.slice(0, marker), ...env, ...argv.slice(marker, -1)];
}
