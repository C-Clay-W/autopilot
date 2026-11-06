/** 验证剪贴板图片仍在处理时提交被阻止并保留草稿。 */
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { createInitialCliProjection } from '../../src/event-projector.js';
import { createCliTuiStore, CliTuiApp } from '../../src/tui.js';
vi.mock('../../src/tui/input/clipboard-image.js', function mockClipboard() {
  return {
    readWindowsClipboard: vi.fn(function read() {
      return new Promise(function delay(resolve) {
        setTimeout(function done() { resolve({ images: [{ name: 'a.png', mimeType: 'image/png', bytes: new Uint8Array([1]) }] }); }, 200);
      });
    }),
  };
});
/** 等待指定毫秒，覆盖异步粘贴的处理窗口。 */
function wait(ms = 80) { return new Promise(function done(resolve) { setTimeout(resolve, ms); }); }
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
describe('CLI 图片未就绪提交', function suite() {
  it('图片处理中按 Enter 只提示等待，处理完成后可正常提交', async function notReady() {
    const projection = createInitialCliProjection(); const calls: any[] = [];
    const controller = { async dispatch(action: any) { calls.push(action); return { kind: 'ok', exitCode: 0, lines: [], projection }; }, async consume() { return { kind: 'ok', exitCode: 0, lines: [], projection }; }, async resume() { return { kind: 'ok', exitCode: 0, lines: [], projection }; }, getProjection() { return projection; }, setSession() {}, setEventListener() {} };
    const view = render(createElement(CliTuiApp, { store: createCliTuiStore(), controller, closeWhenIdle: false, useColor: false, screenReader: true, renderMode: 'inline', onResult() {}, onRequestInterrupt() {}, onRequestCancel() {}, onEof() {}, onAppExit() {} }));
    try {
      writeInput(view.stdin, '\u0016'); await wait(20);
      writeInput(view.stdin, '\r'); await wait(20);
      expect(calls).toHaveLength(0);
      expect(view.lastFrame()).toContain('图片仍在处理');
      await wait(260);
      expect(view.lastFrame()).toContain('[Image 1]');
      writeInput(view.stdin, '\r'); await wait();
      expect(calls).toHaveLength(1);
      expect(calls[0].images.map(function name(image: any) { return image.name; })).toEqual(['a.png']);
    } finally { view.unmount(); }
  });
});
