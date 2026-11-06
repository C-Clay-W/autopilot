/** 受控剪贴板和 Ink 输入验证图片占位符与提交关联。 */
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { createInitialCliProjection } from '../../src/event-projector.js';
import { createCliTuiStore, CliTuiApp } from '../../src/tui.js';
import { readWindowsClipboard } from '../../src/tui/input/clipboard-image.js';
vi.mock('../../src/tui/input/clipboard-image.js', function mockClipboard() { return { readWindowsClipboard: vi.fn(async function read() { return { images: [{ name: 'a.png', mimeType: 'image/png', bytes: new Uint8Array([1]) }] }; }) }; });
/** 等待 Ink 渲染和异步粘贴。 */
function wait() { return new Promise(function done(resolve) { setTimeout(resolve, 80); }); }
/** 在受控 stdin 的 read 内发布 data，模拟 Node Readable 读取时的事件顺序。 */
function writeInput(stdin: ReturnType<typeof render>['stdin'], value: string) {
  const stream = stdin as typeof stdin & { data: string | null; read(): string | null; emit(name: string, ...args: unknown[]): boolean };
  const read = stream.read;
  stream.read = function readWithData() {
    const chunk = read();
    if (chunk !== null) stream.emit('data', chunk);
    return chunk;
  };
  stream.data = value;
  try { stream.emit('readable'); }
  finally { stream.read = read; }
}
describe('图片编号重置', function suite() {
  it('删光后从一开始，追加唯一且历史图片不串', async function numbering() {
    const projection = createInitialCliProjection(); const calls: any[] = [];
    const controller = { async dispatch(action: any) { calls.push(action); return { kind: 'ok', exitCode: 0, lines: [], projection }; }, async consume() { return { kind: 'ok', exitCode: 0, lines: [], projection }; }, async resume() { return { kind: 'ok', exitCode: 0, lines: [], projection }; }, getProjection() { return projection; }, setSession() {}, setEventListener() {} };
    const view = render(createElement(CliTuiApp, { store: createCliTuiStore(), controller, closeWhenIdle: false, useColor: false, screenReader: true, renderMode: 'inline', onResult() {}, onRequestInterrupt() {}, onRequestCancel() {}, onEof() {}, onAppExit() {} }));
    try {
      writeInput(view.stdin, '字'); writeInput(view.stdin, '\u0016'); await wait();
      expect(view.lastFrame()).toContain('[Image 1]');
      writeInput(view.stdin, '\u007f'); await wait();
      vi.mocked(readWindowsClipboard).mockResolvedValueOnce({ images: [{ name: 'b.png', mimeType: 'image/png', bytes: new Uint8Array([2]) }] });
      writeInput(view.stdin, '\u0016'); await wait();
      expect(view.lastFrame()).toContain('[Image 1]'); expect(view.lastFrame()).not.toContain('[Image 2]');
      writeInput(view.stdin, '\u0016'); await wait(); expect(view.lastFrame()).toContain('[Image 2]');
      writeInput(view.stdin, '\r'); await wait(); expect(calls[0].images.map(function name(image: any) { return image.name; })).toEqual(['b.png','a.png']);
      writeInput(view.stdin, '\u0016'); await wait(); expect(view.lastFrame()).toContain('[Image 1]');
      writeInput(view.stdin, '\u001b[A'); await wait(); writeInput(view.stdin, '\r'); await wait();
      expect(calls[1].images.map(function name(image: any) { return image.name; })).toEqual(['b.png','a.png']);
    } finally { view.unmount(); }
  });
  it('相同历史文本的图片按条目各自恢复', async function identicalHistory() {
    const projection = createInitialCliProjection(); const calls: any[] = [];
    const controller = { async dispatch(action: any) { calls.push(action); return { kind: 'ok', exitCode: 0, lines: [], projection }; }, async consume() { return { kind: 'ok', exitCode: 0, lines: [], projection }; }, async resume() { return { kind: 'ok', exitCode: 0, lines: [], projection }; }, getProjection() { return projection; }, setSession() {}, setEventListener() {} };
    const view = render(createElement(CliTuiApp, { store: createCliTuiStore(), controller, closeWhenIdle: false, useColor: false, screenReader: true, renderMode: 'inline', onResult() {}, onRequestInterrupt() {}, onRequestCancel() {}, onEof() {}, onAppExit() {} }));
    try {
      writeInput(view.stdin, '\u0016'); await wait(); writeInput(view.stdin, '\r'); await wait();
      vi.mocked(readWindowsClipboard).mockResolvedValueOnce({ images: [{ name: 'b.png', mimeType: 'image/png', bytes: new Uint8Array([2]) }] });
      writeInput(view.stdin, '\u0016'); await wait(); writeInput(view.stdin, '\r'); await wait();
      writeInput(view.stdin, '\u001b[A'); await wait(); writeInput(view.stdin, '\u001b[A'); await wait();
      writeInput(view.stdin, '\r'); await wait();
      expect(calls.map(function image(action: any) { return action.images[0].name; })).toEqual(['a.png', 'b.png', 'a.png']);
    } finally { view.unmount(); }
  });
});
