// 主进程拥有持久交互 shell、Node20 启动路径、代次隔离与有界输出，不推断 AP 任务状态。
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { access, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { IPty, IPtyForkOptions } from "node-pty";
import type { TerminalOutput } from "./contract";
import type { TerminalType } from "./workspace";

const execute = promisify(execFile);
export const OUTPUT_LIMIT = 1024 * 1024;
export const OUTPUT_BATCH = 64 * 1024;

/** 仅识别 ANSI 控制序列边界的有界输出环；终端画面仍由 xterm 解释。 */
export class OutputBuffer {
  private chunks: { start: number; end: number; data: string; delivered: boolean }[] = [];
  private pending = "";
  private state: "ground" | "escape" | "intermediate" | "csi" | "string" | "stringEscape" = "ground";
  private osc = false;
  private dropping = false;
  private position = 0;
  private end = 0;
  /** 在完整控制序列边界切批，过长单序列整段省略并报告缺口。 */
  append(data: string): void {
    for (let index = 0; index < data.length; index++) {
      const character = data[index];
      const code = character.charCodeAt(0);
      this.position++;
      if (!this.dropping) this.pending += character;
      if (code === 0x18 || code === 0x1a) this.state = "ground";
      else if (this.state === "stringEscape") this.state = character === "\\" ? "ground" : code === 0x1b ? "stringEscape" : "string";
      else if (this.state === "string") {
        if (code === 0x1b) this.state = "stringEscape";
        else if (code === 0x9c || this.osc && code === 7) this.state = "ground";
      } else if (code === 0x1b) this.state = "escape";
      else if (code === 0x9b) this.state = "csi";
      else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) { this.state = "string"; this.osc = code === 0x9d; }
      else if (this.state === "escape") {
        if (character === "[") this.state = "csi";
        else if (["]", "P", "X", "^", "_"].includes(character)) { this.state = "string"; this.osc = character === "]"; }
        else if (code >= 0x20 && code <= 0x2f) this.state = "intermediate";
        else if (code >= 0x30 && code <= 0x7e) this.state = "ground";
      } else if (this.state === "csi" && code >= 0x40 && code <= 0x7e || this.state === "intermediate" && code >= 0x30 && code <= 0x7e) this.state = "ground";
      const safe = this.state === "ground" && !(code >= 0xd800 && code <= 0xdbff);
      if (this.dropping) {
        this.end = this.position;
        if (safe) this.dropping = false;
      } else if (safe && (this.pending.length >= OUTPUT_BATCH / 2 || index === data.length - 1)) {
        const previous = this.chunks.at(-1);
        // 已交付块保持不变，后续追加不得破坏 renderer 已持有的安全游标边界。
        if (previous && !previous.delivered && previous.end === this.position - this.pending.length && previous.data.length + this.pending.length <= OUTPUT_BATCH) {
          previous.data += this.pending;
          previous.end = this.position;
        } else this.chunks.push({ start: this.position - this.pending.length, end: this.position, data: this.pending, delivered: false });
        this.pending = "";
        this.end = this.position;
        while (this.chunks.length && (this.chunks.length > 1024 || this.chunks[0].start < this.end - OUTPUT_LIMIT)) this.chunks.shift();
      } else if (this.pending.length >= OUTPUT_BATCH) {
        this.chunks = [];
        this.pending = "";
        this.end = this.position;
        this.dropping = true;
      }
    }
  }
  /** 返回完整批次，重连或缓冲溢出不会从半条 ANSI 序列开始解析。 */
  read(after: number): TerminalOutput {
    const chunk = this.chunks.find(function next(item) { return item.start >= after; });
    if (!chunk) return { data: "", cursor: this.end, gap: after !== this.end };
    chunk.delivered = true;
    return { data: chunk.data, cursor: chunk.end, gap: after !== chunk.start };
  }
}

export interface TerminalSession { pty: IPty; generation: number; output: OutputBuffer; exited: boolean; apStarted?: boolean; startCommand?: TerminalType; resizePipe?: string }
export interface LaunchSpec { shell: string; args: string[]; env: Record<string, string> }

/** 使用环境变量传递路径，shell 脚本只含固定语法，目录和 CLI 路径不会进入命令拼接。 */
export function shellSpec(platform: string, node: string | null, cli: string, bootstrap: string, environment: NodeJS.ProcessEnv): LaunchSpec {
  const env: Record<string, string> = {};
  // 嵌入的 xterm 独立检测颜色，父进程或外层终端的颜色开关只作用在那个终端。
  const parentOnly = ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_CHANNEL_FD", "NO_COLOR", "CLICOLOR", "FORCE_COLOR"];
  for (const [key, value] of Object.entries(environment)) {
    const name = key.toUpperCase();
    if (value === undefined || parentOnly.includes(name) || name.startsWith("AUTOPILOT_DESKTOP_STATUS_")) continue;
    if (name.startsWith("AUTOPILOT_AGENT_") && !["AUTOPILOT_AGENT_RUNNER", "AUTOPILOT_AGENT_OBSERVATION"].includes(name)) continue;
    env[key] = value;
  }
  // Windows 的 node-pty 不会把 PTY name 写入 TERM，子进程应检测到实际的 xterm。
  env.TERM = "xterm-256color";
  env.TERM_PROGRAM = "autopilot-desktop";
  if (!node) return platform === "win32"
    ? { shell: join(environment.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args: ["-NoLogo", "-NoProfile", "-NoExit"], env }
    : { shell: "/bin/bash", args: ["--noprofile", "--norc", "-i"], env };
  env.AUTOPILOT_DESKTOP_NODE = node;
  env.AUTOPILOT_DESKTOP_CLI = cli;
  const pathKey = Object.keys(env).find(function isPath(key) { return key.toLowerCase() === "path"; }) ?? "PATH";
  env[pathKey] = dirname(node) + delimiter + (env[pathKey] ?? "");
  if (platform === "win32") env.AUTOPILOT_DESKTOP_RESIZE_PIPE = `\\\\.\\pipe\\autopilot-desktop-${randomUUID()}`;
  if (platform === "win32") return {
    shell: join(environment.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "function global:ap { & $env:AUTOPILOT_DESKTOP_NODE $env:AUTOPILOT_DESKTOP_CLI @args }; function global:claude { & $env:AUTOPILOT_DESKTOP_NODE $env:AUTOPILOT_AGENT_RUNNER claude @args }; function global:codex { & $env:AUTOPILOT_DESKTOP_NODE $env:AUTOPILOT_AGENT_RUNNER codex @args }; function global:opencode { & $env:AUTOPILOT_DESKTOP_NODE $env:AUTOPILOT_AGENT_RUNNER opencode @args }; function global:codebuddy { & $env:AUTOPILOT_DESKTOP_NODE $env:AUTOPILOT_AGENT_RUNNER codebuddy @args }"], env,
  };
  return { shell: "/bin/bash", args: ["--noprofile", "--rcfile", bootstrap, "-i"], env };
}

/** 解析明确兼容的 Node20，不将 Electron 内置 Node 当作 CLI 运行时。 */
export async function resolveCliRuntime(appPath: string, resourcesPath: string, packaged: boolean): Promise<{ node: string; cli: string }> {
  const cli = createRequire(join(appPath, "package.json")).resolve("@autopilot-agent/cli/dist/main.js");
  await access(cli);
  const candidates = [join(resourcesPath, "node20", process.platform === "win32" ? "node.exe" : "bin/node")];
  if (!packaged && process.platform === "win32") candidates.push(resolve(appPath, "../../.local/node-windows-20.20.2/package/bin/node.exe"));
  // 本机 Node 可作为开发候选，实际版本必须满足 CLI 的 engines。
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) if (directory) candidates.push(join(directory, process.platform === "win32" ? "node.exe" : "node"));
  for (const candidate of candidates) {
    try {
      const node = await realpath(candidate);
      const result = await execute(node, ["-p", "process.versions.node"], { timeout: 3000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: "" } });
      const [major, minor] = result.stdout.trim().split(".").map(Number);
      if ((major === 20 && minor >= 11) || major === 21) return { node, cli };
    } catch { /* 缺失或不兼容候选继续检查，全部失败时保留窗格级错误。 */ }
  }
  throw new Error("需要兼容 CLI 的 Node 20 运行时，请安装 Node 20.11 或更高的 20.x 版本后重试。");
}

/** 校验用户选取的真实目录，不要求 Git 或替 CLI 授予 Trust。 */
export async function validDirectory(directory: string): Promise<string> {
  if (!directory || directory.includes("\0") || directory.length > 32768) throw new Error("工作区目录无效，请重新选择。");
  try {
    const canonical = await realpath(directory);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not directory");
    return canonical;
  } catch { throw new Error("工作区目录不可用，请重新选择。"); }
}

/** 惰性加载原生模块，使纯逻辑测试不会启动真实 PTY。 */
export function spawnPty(shell: string, args: string[], options: IPtyForkOptions): IPty {
  return (require("node-pty") as typeof import("node-pty")).spawn(shell, args, options);
}

/** 首次视图网格启动保存的智能体一次，空白终端直接保留交互Shell。 */
export function resizePty(session: TerminalSession, cols: number, rows: number): void {
  session.pty.resize(cols, rows);
  if (!session.apStarted) {
    if (session.startCommand !== "shell") session.pty.write(`${session.startCommand ?? "ap"}\r`);
    session.apStarted = true;
  }
}

/** CLI 先在旧网格输出可容纳目标网格的帧；普通 shell/旧 CLI 没有管道，直接沿原路径。 */
export async function preparePtyResize(session: TerminalSession, cols: number, rows: number): Promise<string | null> {
  if (!session.resizePipe || session.exited) return null;
  const token = randomUUID();
  return new Promise(function prepare(resolvePrepared, reject) {
    const socket = createConnection(session.resizePipe!);
    let response = "";
    socket.setTimeout(1500, function timedOut() { socket.destroy(new Error("DESKTOP_RESIZE_UNAVAILABLE")); });
    socket.on("connect", function connected() { socket.write(`${cols} ${rows} ${token}\n`); });
    socket.on("data", function received(data) {
      response += data.toString();
      if (response.length > 36) socket.destroy(new Error("DESKTOP_RESIZE_UNAVAILABLE"));
    });
    socket.on("end", function prepared() { socket.destroy(); if (response === token) resolvePrepared(token); else reject(new Error("DESKTOP_RESIZE_UNAVAILABLE")); });
    socket.on("error", function failed(error: NodeJS.ErrnoException) {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolvePrepared(null);
      else reject(new Error("DESKTOP_RESIZE_UNAVAILABLE"));
    });
  });
}

/** 有界停止受管 shell 树，命令失败保留对象供用户重试，不虚报关闭。 */
export async function stopPty(session: TerminalSession): Promise<void> {
  if (session.exited) return;
  const pid = session.pty.pid;
  if (process.platform === "win32") {
    await execute(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { timeout: 5000, windowsHide: true });
  } else {
    const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid="], { timeout: 3000 });
    const rows = stdout.trim().split("\n").map(function parse(line) { return line.trim().split(/\s+/).map(Number); });
    const owned = new Set([pid]);
    for (let size = 0; size !== owned.size;) {
      size = owned.size;
      for (const [child, parent] of rows) if (owned.has(parent)) owned.add(child);
    }
    for (const child of [...owned].reverse()) {
      try { process.kill(child, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
  const deadline = Date.now() + 3000;
  while (!session.exited && Date.now() < deadline) await new Promise<void>(function pause(resolve) { setTimeout(resolve, 20); });
  if (!session.exited) throw new Error("终端尚未确认退出，请重试关闭。");
}

/** 生成 Mac 交互 bash 的固定函数定义，首个视图网格由主进程触发 ap。 */
export async function prepareShell(userData: string): Promise<string> {
  const directory = join(userData, "parallel-shell");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "bootstrap.bash");
  await writeFile(path, '# Desktop 受管交互 shell 的固定启动入口\nap() { "$AUTOPILOT_DESKTOP_NODE" "$AUTOPILOT_DESKTOP_CLI" "$@"; }\n' + ["claude", "codex", "opencode", "codebuddy"].map(function wrapper(agent) { return `${agent}() { "$AUTOPILOT_DESKTOP_NODE" "$AUTOPILOT_AGENT_RUNNER" ${agent} "$@"; }\n`; }).join(""), { mode: 0o600 });
  return path;
}
