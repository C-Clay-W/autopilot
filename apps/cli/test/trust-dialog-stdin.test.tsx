/**
 * CLI 首次 Trust 对话框 stdin 数据转发契约测试。
 *
 * 验证真实 TTY 按键经 `stdin.on("data")` 转发进入 Ink 专用输入流后，
 * 能驱动对话框决策（Enter 确认 / ↓ 切换焦点），回归 Trust 对话框按键失效的问题。
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCliTrustDialog } from "../src/tui.js";

/** 构造 isTTY=true 的假 stdin，记录 setRawMode 调用以探测 Ink 挂载完成。 */
function createFakeStdin(): { stdin: PassThrough; rawModeCalls: boolean[] } {
  const stdin = new PassThrough();
  Object.defineProperty(stdin, "isTTY", { value: true });
  const rawModeCalls: boolean[] = [];
  stdin.setRawMode = function setRawMode(flag: boolean): void { rawModeCalls.push(flag); };
  stdin.ref = function ref(): void {};
  stdin.unref = function unref(): void {};
  return { stdin, rawModeCalls };
}

/** 构造完整假 stdout，满足 Ink 的 on/write/columns/rows/isTTY 接口。 */
function createFakeStdout(): NodeJS.WriteStream {
  const stdout = new EventEmitter();
  Object.defineProperty(stdout, "isTTY", { value: true });
  Object.defineProperty(stdout, "columns", { value: 120 });
  Object.defineProperty(stdout, "rows", { value: 30 });
  stdout.write = function write(): boolean { return true; };
  return stdout as unknown as NodeJS.WriteStream;
}

/** 等待 Ink 挂载并启用 raw mode（观察到 setRawMode(true)）。 */
async function waitForRawMode(rawModeCalls: boolean[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (rawModeCalls.includes(true)) return;
    await new Promise(function delay(resolve) { setTimeout(resolve, 10); });
  }
  throw new Error("Ink 未启用 raw mode");
}

describe("CLI Trust dialog stdin forwarding", function cliTrustDialogStdinSuite() {
  it("真实 TTY 按键经转发进入 Ink，Enter 确认 Yes 返回 granted", async function enterConfirmsGrant() {
    const { stdin, rawModeCalls } = createFakeStdin();
    const stdout = createFakeStdout();
    const promise = runCliTrustDialog({
      workspaceRoot: "C:/workspace/project",
      streams: { stdout, stdin: stdin as unknown as NodeJS.ReadStream },
      signalSource: { on() {}, removeListener() {} },
      env: {},
    });
    await waitForRawMode(rawModeCalls);
    stdin.write("\r");
    await expect(promise).resolves.toBe("granted");
  });

  it("↓ 切换焦点后 Enter 确认 No 返回 declined", async function downThenEnterDeclines() {
    const { stdin, rawModeCalls } = createFakeStdin();
    const stdout = createFakeStdout();
    const promise = runCliTrustDialog({
      workspaceRoot: "C:/workspace/project",
      streams: { stdout, stdin: stdin as unknown as NodeJS.ReadStream },
      signalSource: { on() {}, removeListener() {} },
      env: {},
    });
    await waitForRawMode(rawModeCalls);
    stdin.write("\u001b[B");
    await new Promise(function settleFocus(resolve) { setTimeout(resolve, 50); });
    stdin.write("\r");
    await expect(promise).resolves.toBe("declined");
  });
});
