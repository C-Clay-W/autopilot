/** 受控验证 Mac 两次粘贴沿现有占位符顺序提交，不代表真实终端。 */
import { createElement } from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialCliProjection } from "../../src/event-projector.js";
import { createCliTuiStore, CliTuiApp } from "../../src/tui.js";
const reader = vi.hoisted(function makeReader() { return vi.fn(); });
vi.mock("../../src/tui/input/clipboard-image.js", function mockClipboard() { return { readMacClipboard: reader, readWindowsClipboard: vi.fn() }; });
const originalPlatform = process.platform;
/** 等待 Ink 渲染。 */
function wait() { return new Promise(function done(resolve) { setTimeout(resolve, 80); }); }
/** 在受控 stdin 发布真实输入事件顺序。 */
function writeInput(stdin: ReturnType<typeof render>["stdin"], value: string) {
  const stream = stdin as typeof stdin & { data: string | null; read(): string | null; emit(name: string, ...args: unknown[]): boolean };
  const read = stream.read; stream.read = function readWithData() { const chunk = read(); if (chunk !== null) stream.emit("data", chunk); return chunk; };
  stream.data = value; try { stream.emit("readable"); } finally { stream.read = read; }
}
afterEach(function restore() { Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true }); vi.clearAllMocks(); });
describe("Mac 图片输入", function suite() {
  it("两次粘贴追加并保留文字与提交顺序", async function repeatedPaste() {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    reader.mockResolvedValueOnce({ images: [{ name: "a.png", mimeType: "image/png", bytes: new Uint8Array([1]) }], text: "说明" }).mockResolvedValueOnce({ images: [{ name: "b.png", mimeType: "image/png", bytes: new Uint8Array([2]) }] });
    const projection = createInitialCliProjection(); const calls: any[] = [];
    const controller = { async dispatch(action: any) { calls.push(action); return { kind: "ok", exitCode: 0, lines: [], projection }; }, async consume() { return { kind: "ok", exitCode: 0, lines: [], projection }; }, async resume() { return { kind: "ok", exitCode: 0, lines: [], projection }; }, getProjection() { return projection; }, setSession() {}, setEventListener() {} };
    const view = render(createElement(CliTuiApp, { store: createCliTuiStore(), controller, closeWhenIdle: false, useColor: false, screenReader: true, renderMode: "inline", onResult() {}, onRequestInterrupt() {}, onRequestCancel() {}, onEof() {}, onAppExit() {} }));
    try { writeInput(view.stdin, "\u0016"); await wait(); writeInput(view.stdin, "\u0016"); await wait(); expect(view.lastFrame()).toContain("[Image 1]"); expect(view.lastFrame()).toContain("[Image 2]"); writeInput(view.stdin, "\r"); await wait(); expect(calls).toHaveLength(1); expect(calls[0].content).toContain("说明"); expect(calls[0].images.map(function name(image: any) { return image.name; })).toEqual(["a.png", "b.png"]); } finally { view.unmount(); }
  });
});
