/** 受控验证 Windows 与 macOS 剪贴板解析及共享限制，不调用系统命令。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(function makeMocks() { return { command: vi.fn(), stat: vi.fn(), readFile: vi.fn(), normalize: vi.fn() }; });
vi.mock("node:child_process", function mockChild() { return { execFile: mocks.command }; });
vi.mock("node:fs/promises", function mockFs() { return { stat: mocks.stat, readFile: mocks.readFile }; });
vi.mock("@autopilot-agent/core", function mockCore() { return { normalizeWorkImage: mocks.normalize }; });
import { readMacClipboard, readWindowsClipboard } from "../../src/tui/input/clipboard-image.js";
const originalPlatform = process.platform;
/** 设置受控平台和系统命令返回值。 */
function prepare(platform: string, payload: unknown) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  mocks.command.mockImplementation(function command(_file: string, _args: string[], _opts: object, callback: Function) { callback(null, { stdout: JSON.stringify(payload), stderr: "" }); });
}
beforeEach(function setup() {
  vi.clearAllMocks();
  mocks.stat.mockResolvedValue({ isFile: function isFile() { return true; }, size: 3 });
  mocks.readFile.mockResolvedValue(Buffer.from("abc"));
  mocks.normalize.mockImplementation(async function normalize(input: { bytes: Uint8Array; mimeType: string }) { return { bytes: input.bytes, mimeType: input.mimeType, gifFirstFrame: false }; });
});
afterEach(function restore() { Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true }); });
describe("跨平台剪贴板", function suite() {
  it("Mac 图片与文本调用系统桥接并复用规范化", async function image() {
    prepare("darwin", { kind: "image", value: "YWJj", text: "说明" });
    const result = await readMacClipboard();
    expect(mocks.command.mock.calls[0][0]).toBe("/usr/bin/osascript");
    expect(result.text).toBe("说明"); expect(result.images.map(function name(image) { return image.name; })).toEqual(["clipboard.png"]);
    expect(mocks.normalize).toHaveBeenCalledOnce();
  });
  it("Mac 文件列表按序读取并拒绝不支持格式或超出数量", async function files() {
    prepare("darwin", { kind: "files", value: ["/fixture/a.png", "/fixture/b.jpg"] });
    expect((await readMacClipboard()).images.map(function name(image) { return image.name; })).toEqual(["a.png", "b.jpg"]);
    prepare("darwin", { kind: "files", value: ["/fixture/a.txt"] }); await expect(readMacClipboard()).rejects.toThrow("不支持");
    prepare("darwin", { kind: "files", value: Array(11).fill("/fixture/a.png") }); await expect(readMacClipboard()).rejects.toThrow("10 张");
  });
  it("Mac 文本、命令失败以及不支持平台行为", async function textAndFailure() {
    prepare("darwin", { kind: "text", value: "普通文字" }); expect(await readMacClipboard()).toEqual({ images: [], text: "普通文字" });
    mocks.command.mockImplementation(function failed(_f: string, _a: string[], _o: object, callback: Function) { callback(new Error("private script and clipboard text")); });
    await expect(readMacClipboard()).rejects.toThrow("剪贴板图片读取或处理失败");
    mocks.command.mockClear(); prepare("linux", {}); expect(await readMacClipboard()).toEqual({ images: [] }); expect(mocks.command).not.toHaveBeenCalled();
  });
  it("Windows 原有 PowerShell 截图路径仍复用规范化", async function windows() {
    prepare("win32", { kind: "image", value: "YWJj" }); expect((await readWindowsClipboard()).images).toHaveLength(1);
    expect(mocks.command.mock.calls[0][0]).toBe("powershell.exe"); expect(mocks.normalize).toHaveBeenCalledOnce();
  });
  it("拒绝无效 JSON、畸形图片编码和超界输出", async function malformed() {
    prepare("darwin", { kind: "image", value: "@@@" }); await expect(readMacClipboard()).rejects.toThrow();
    prepare("darwin", { kind: "image", value: "A".repeat(27_962_032) }); await expect(readMacClipboard()).rejects.toThrow();
    mocks.command.mockImplementation(function invalid(_f: string, _a: string[], _o: object, callback: Function) { callback(null, { stdout: "{", stderr: "" }); });
    await expect(readMacClipboard()).rejects.toThrow();
  });
  it("命令超限只显示固定提示", async function limits() {
    prepare("darwin", {});
    mocks.command.mockImplementation(function tooMany(_f: string, _a: string[], _o: object, callback: Function) { callback(Object.assign(new Error("private"), { stderr: "TOO_MANY_IMAGES" })); });
    await expect(readMacClipboard()).rejects.toThrow("一次最多粘贴 10 张图片");
    mocks.command.mockImplementation(function tooLarge(_f: string, _a: string[], _o: object, callback: Function) { callback(Object.assign(new Error("private"), { stderr: "IMAGE_TOO_LARGE" })); });
    await expect(readMacClipboard()).rejects.toThrow("图片超过 20 MiB 输入上限");
  });
  it("接近上限的合法编码不会因校验失败", async function largeImage() {
    prepare("darwin", { kind: "image", value: "A".repeat(27_962_024) });
    const result = await readMacClipboard(); expect(result.images[0].bytes.byteLength).toBe(20_971_518);
  });
});
