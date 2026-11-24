// 剪贴板替身回归：验证中文编码、进程失败与 stdin 失败，不访问系统剪贴板。
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const mocked = vi.hoisted(function mocks() { return { spawn: vi.fn() }; });
vi.mock("node:child_process", function mockProcess() { return { spawn: mocked.spawn }; });
import { copyTuiSelectedText } from "../src/tui/viewport/selection.js";
afterEach(function restore() { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
/** 模拟平台剪贴板子进程，不执行任何外部程序。 */
function child() {
  const proc = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end: ReturnType<typeof vi.fn> } };
  proc.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  mocked.spawn.mockReturnValue(proc);
  return proc;
}
it("Windows 中文使用带 BOM 的 UTF16LE，写入成功后才完成", async function unicodeClipboard() {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const proc = child();
  const pending = copyTuiSelectedText("中文😀", { write: vi.fn() });
  expect(proc.stdin.end).toHaveBeenCalledWith(Buffer.from("\ufeff中文😀", "utf16le"));
  proc.emit("close", 0);
  await pending;
});
it("macOS 使用 pbcopy 且保留 UTF8", async function macClipboard() {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  const proc = child();
  const pending = copyTuiSelectedText("中文", { write: vi.fn() });
  expect(mocked.spawn).toHaveBeenLastCalledWith("pbcopy", [], expect.any(Object));
  expect(proc.stdin.end).toHaveBeenCalledWith(Buffer.from("中文"));
  proc.emit("close", 0);
  await pending;
});
it("非零退出和 stdin 错误均向调用方报告", async function clipboardFailure() {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  let proc = child();
  let pending = copyTuiSelectedText("text", { write: vi.fn() });
  const rejected = expect(pending).rejects.toThrow("剪贴板写入失败");
  proc.emit("close", 1);
  await rejected;
  proc = child();
  pending = copyTuiSelectedText("text", { write: vi.fn() });
  const pipeRejected = expect(pending).rejects.toThrow("pipe failed");
  proc.stdin.emit("error", new Error("pipe failed"));
  await pipeRejected;
});
