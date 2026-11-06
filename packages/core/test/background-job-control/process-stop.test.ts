/** 受管停止底座故障注入：Windows 检查 taskkill，POSIX 检查原 detached 进程组。 */
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(function createMocks() { return { spawn: vi.fn() }; });
vi.mock("node:child_process", function mockedProcesses() { return { spawn: mocks.spawn }; });
import { terminateManagedProcessTree } from "../../src/internal/tools/process-utils";
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

/** 恢复平台模拟、计时器和信号 spy，避免影响后续用例。 */
afterEach(function restoreTimers() {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
  mocks.spawn.mockReset();
});

it.runIf(process.platform === "win32")("Stage5 taskkill 超时有界且清理命令进程", async function boundsTaskkill() {
  vi.useFakeTimers();
  const command = Object.assign(new EventEmitter(), { kill: vi.fn() });
  mocks.spawn.mockReturnValue(command);
  const root = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null }) as unknown as ChildProcess;
  const result = expect(terminateManagedProcessTree(root, { timeoutMs: 100 })).rejects.toMatchObject({ code: "TIMEOUT" });
  await vi.advanceTimersByTimeAsync(101);
  await result;
  expect(command.kill).toHaveBeenCalledOnce();
});

it.runIf(process.platform === "win32")("Stage5 taskkill 非零不能因 root 已退出变成成功", async function rejectsFailedTree() {
  const command = Object.assign(new EventEmitter(), { kill: vi.fn() });
  mocks.spawn.mockReturnValue(command);
  const root = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null }) as unknown as ChildProcess;
  const result = expect(terminateManagedProcessTree(root)).rejects.toMatchObject({ code: "FAILED" });
  Object.assign(root, { exitCode: 0 });
  root.emit("close", 0);
  command.emit("close", 1);
  await result;
});

/** 模拟 macOS/POSIX 组消失，不能以根退出替代组检查。 */
it("W5a POSIX 等待 SIGTERM 后原进程组消失", async function waitsForPosixGroup() {
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  let exists = true;
  const kill = vi.spyOn(process, "kill").mockImplementation(function signalGroup(_pid, signal) {
    if (signal === 0 && !exists) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
  const root = Object.assign(new EventEmitter(), { pid: 12345, exitCode: 0, signalCode: null }) as unknown as ChildProcess;
  let settled = false;
  const result = terminateManagedProcessTree(root, { graceMs: 40, timeoutMs: 100 }).then(function stopped() { settled = true; });
  await vi.advanceTimersByTimeAsync(20);
  expect(settled).toBe(false);
  exists = false;
  await vi.advanceTimersByTimeAsync(20);
  await result;
  expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
  expect(kill).not.toHaveBeenCalledWith(-12345, "SIGKILL");
});

/** 宽限期后升级 SIGKILL，发送时 ESRCH 是组已消失，不退回只杀根进程。 */
it("W5a POSIX 宽限后升级并接受 ESRCH 竞态", async function escalatesPosixGroup() {
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  let exists = true;
  const kill = vi.spyOn(process, "kill").mockImplementation(function signalGroup(_pid, signal) {
    if (signal === "SIGKILL") exists = false;
    if (!exists) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
  const rootKill = vi.fn();
  const root = Object.assign(new EventEmitter(), { pid: 12345, exitCode: 0, signalCode: null, kill: rootKill }) as unknown as ChildProcess;
  const result = terminateManagedProcessTree(root, { graceMs: 20, timeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(21);
  await result;
  expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
  expect(rootKill).not.toHaveBeenCalled();
});

/** 权限拒绝不是组消失，不能误写停止成功。 */
it("W5a POSIX EPERM 不当作进程组消失", async function rejectsPosixPermissionFailure() {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  vi.spyOn(process, "kill").mockImplementation(function denied() { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  const root = Object.assign(new EventEmitter(), { pid: 12345, exitCode: 0, signalCode: null }) as unknown as ChildProcess;
  await expect(terminateManagedProcessTree(root)).rejects.toMatchObject({ code: "FAILED" });
});
