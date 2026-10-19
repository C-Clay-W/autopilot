/** Stage5 Windows taskkill 故障注入：非零和超时不能被父进程退出掩盖。 */
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(function createMocks() { return { spawn: vi.fn() }; });
vi.mock("node:child_process", function mockedProcesses() { return { spawn: mocks.spawn }; });
import { terminateManagedProcessTree } from "../../src/internal/tools/process-utils";
afterEach(function restoreTimers() { vi.useRealTimers(); mocks.spawn.mockReset(); });

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
