/** Trust 对话框尺寸变化与终端清理的受控回归。 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCliTrustDialog } from "../../src/tui/trust-dialog.js";
import { TUI_INLINE_RESIZE_CLEAR } from "../../src/tui/constants.js";
/** 等待 Ink 和 resize 防抖处理。 */
function delay(ms: number): Promise<void> { return new Promise(function wait(resolve) { setTimeout(resolve, ms); }); }
describe("Trust resize", function suite() {
  it("缩窄清除旧帧，反复缩放保留选择并在退出清理监听", async function resize() {
    const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(flag: boolean): void };
    stdin.isTTY = true;
    Object.assign(stdin, { ref: function ref() {}, unref: function unref() {} });
    let ready = false;
    stdin.setRawMode = function setRawMode(flag) { if (flag) ready = true; };
    const stdout = new EventEmitter() as EventEmitter & { isTTY: boolean; columns: number; rows: number; write(chunk: string): boolean };
    stdout.isTTY = true; stdout.columns = 80; stdout.rows = 30;
    const writes: string[] = [];
    stdout.write = function write(chunk) { writes.push(String(chunk)); return true; };
    const result = runCliTrustDialog({ workspaceRoot: "C:/workspace/project", streams: { stdin: stdin as unknown as NodeJS.ReadStream, stdout }, env: { NO_COLOR: "1" } });
    for (let i = 0; i < 100 && !ready; i += 1) await delay(10);
    expect(ready).toBe(true);
    stdin.write("\u001b[B"); await delay(50);
    stdout.columns = 120; stdout.emit("resize"); await delay(250);
    stdout.columns = 50; stdout.emit("resize"); await delay(250);
    expect(writes).toContain(TUI_INLINE_RESIZE_CLEAR);
    stdout.columns = 100; stdout.emit("resize"); await delay(250);
    stdin.write("\r");
    await expect(result).resolves.toBe("declined");
    expect(stdout.listenerCount("resize")).toBe(0);
  });
});

