/**
 * job-service-ownership.ts — 监听端口与 Job 进程树的归属核验（Talk-Plan0908 R1）。
 *
 * 只通过操作系统只读命令枚举监听 PID 与父链：Windows 用 netstat + PowerShell CIM，
 * macOS/Linux 用 lsof（缺失时退回 ss）与 ps。任何无法解析、命令缺失或平台不支持的情况
 * 一律返回 undefined，调用方必须按“无法证明”处理，不得退化成按端口放行。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5_000;

/** 归属核验所需的只读探测面；测试注入替身，生产使用默认实现。 */
export interface JobServiceOwnershipProbe {
  /** 监听指定 TCP 端口的 PID 集合；undefined 表示无法核验。 */
  listenerPids(port: number): Promise<readonly number[] | undefined>;
  /** 指定 PID 的祖先链（含自身，由近到远）；undefined 表示无法核验。 */
  ancestry(pid: number): Promise<readonly number[] | undefined>;
}

/** 执行只读命令；命令不存在或超时返回 undefined，非零退出码按调用方判断。 */
async function run(command: string, args: readonly string[]): Promise<{ stdout: string; code: number } | undefined> {
  try {
    const { stdout } = await execFileAsync(command, [...args], { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
    return { stdout: String(stdout), code: 0 };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown; status?: unknown };
    if (failed.code === "ENOENT") return undefined;
    // lsof 无匹配时退出码为 1，仍属可解析的“没有监听者”。
    if (typeof failed.stdout === "string") return { stdout: failed.stdout, code: typeof failed.status === "number" ? failed.status : 1 };
    return undefined;
  }
}

/** 解析 netstat -ano 的 LISTENING 行：取本地端口与 PID。 */
function parseWindowsListeners(stdout: string, port: number): number[] {
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/iu.exec(line);
    if (!match || Number(match[2]) !== port) continue;
    const pid = Number(match[3]);
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/** 解析 `ps -A -o pid=,ppid=` 输出为父链映射。 */
function parseParentMap(stdout: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid)) parents.set(pid, ppid);
  }
  return parents;
}

/** 从父子映射构造由近到远的祖先链；环或断链时截断。 */
function chainFrom(parents: Map<number, number>, pid: number): number[] {
  const chain: number[] = [];
  let current = pid;
  while (Number.isSafeInteger(current) && current > 1 && !chain.includes(current) && chain.length < 64) {
    chain.push(current);
    const parent = parents.get(current);
    if (parent === undefined) break;
    current = parent;
  }
  return chain;
}

/** 生产默认探测：平台不支持或工具缺失时返回 undefined，由调用方 fail-closed。 */
export function createDefaultJobServiceOwnershipProbe(): JobServiceOwnershipProbe {
  return {
    async listenerPids(port) {
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
      if (process.platform === "win32") {
        const result = await run("netstat", ["-ano", "-p", "tcp"]);
        return result && result.code === 0 ? parseWindowsListeners(result.stdout, port) : undefined;
      }
      const lsof = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
      if (lsof) {
        if (lsof.code !== 0 && lsof.stdout.trim().length === 0) return [];
        return lsof.stdout.split(/\r?\n/u).map(function pid(value) { return Number(value.trim()); }).filter(function positive(value) { return Number.isSafeInteger(value) && value > 0; });
      }
      const ss = await run("ss", ["-ltnp"]);
      if (!ss || ss.code !== 0) return undefined;
      const pids: number[] = [];
      for (const line of ss.stdout.split(/\r?\n/)) {
        if (!line.includes(`:${port} `) && !line.includes(`:${port}\t`)) continue;
        for (const match of line.matchAll(/pid=(\d+)/gu)) {
          const pid = Number(match[1]);
          if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
        }
      }
      return pids;
    },
    async ancestry(pid) {
      if (!Number.isInteger(pid) || pid < 1) return undefined;
      if (process.platform === "win32") {
        const result = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"]);
        return result && result.code === 0 ? chainFrom(parseParentMap(result.stdout), pid) : undefined;
      }
      const result = await run("ps", ["-A", "-o", "pid=,ppid="]);
      return result && result.code === 0 ? chainFrom(parseParentMap(result.stdout), pid) : undefined;
    },
  };
}
