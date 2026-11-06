/** 受控剪贴板和 Ink 输入验证图片占位符与提交关联。 */
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { createInitialCliProjection } from '../../src/event-projector.js';
import { createCliTuiStore, CliTuiApp } from '../../src/tui.js';
import { readWindowsClipboard } from '../../src/tui/input/clipboard-image.js';
vi.mock('../../src/tui/input/clipboard-image.js', function mockClipboard() { return { readWindowsClipboard: vi.fn(async function read() { return { images: [{ name: 'a.png', mimeType: 'image/png', bytes: new Uint8Array([1]) }, { name: 'b.png', mimeType: 'image/png', bytes: new Uint8Array([2]) }] }; }) }; });
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
describe('CLI 图片草稿', function suite() {
  it.each(['\u007f', '\b'])('仅图粘贴后以 %j 删除末图并提交剩余图片', async function imagePaste(backspace) {
    const projection = createInitialCliProjection(); const calls: any[] = [];
    const controller = { async dispatch(action: any) { calls.push(action); return { kind: 'ok', exitCode: 0, lines: [], projection }; }, async consume() { return { kind: 'ok', exitCode: 0, lines: [], projection }; }, async resume() { return { kind: 'ok', exitCode: 0, lines: [], projection }; }, getProjection() { return projection; }, setSession() {}, setEventListener() {} };
    const view = render(createElement(CliTuiApp, { store: createCliTuiStore(), controller, closeWhenIdle: false, useColor: false, screenReader: true, renderMode: 'inline', onResult() {}, onRequestInterrupt() {}, onRequestCancel() {}, onEof() {}, onAppExit() {} }));
    try {
      writeInput(view.stdin, '\u0016'); await wait();
      expect(view.lastFrame()).toContain('[Image 1]'); expect(view.lastFrame()).toContain('[Image 2]');
      writeInput(view.stdin, backspace); await wait();
      expect(view.lastFrame()).not.toContain('[Image 2]'); expect(view.lastFrame()).toContain('[Image 1]');
      writeInput(view.stdin, '\r'); await wait();
      expect(calls).toHaveLength(1); expect(calls[0].type).toBe('submit_prompt');
      expect(calls[0].images.map(function name(image: any) { return image.name; })).toEqual(['a.png']);
    } finally { view.unmount(); }
  });
  it('方向键与前向 Delete 原子删除图片并保留文字后提交', async function forwardDelete() {
    const projection = createInitialCliProjection(); const calls: any[] = [];
    const controller = { async dispatch(action: any) { calls.push(action); return { kind: 'ok', exitCode: 0, lines: [], projection }; }, async consume() { return { kind: 'ok', exitCode: 0, lines: [], projection }; }, async resume() { return { kind: 'ok', exitCode: 0, lines: [], projection }; }, getProjection() { return projection; }, setSession() {}, setEventListener() {} };
    const view = render(createElement(CliTuiApp, { store: createCliTuiStore(), controller, closeWhenIdle: false, useColor: false, screenReader: true, renderMode: 'inline', onResult() {}, onRequestInterrupt() {}, onRequestCancel() {}, onEof() {}, onAppExit() {} }));
    try {
      writeInput(view.stdin, '\u0016'); await wait();
      writeInput(view.stdin, '\u001b[D'); await wait();
      writeInput(view.stdin, '\u001b[C'); await wait();
      writeInput(view.stdin, '字'); await wait();
      writeInput(view.stdin, '\u001b[D'); await wait();
      writeInput(view.stdin, '\u001b[D'); await wait();
      writeInput(view.stdin, '\u001b[3~'); await wait();
      expect(view.lastFrame()).not.toContain('[Image 2]');
      writeInput(view.stdin, '\r'); await wait();
      expect(calls).toHaveLength(1);
      expect(calls[0].content).toContain('字');
      expect(calls[0].images.map(function name(image: any) { return image.name; })).toEqual(['a.png']);
    } finally { view.unmount(); }
  });
  it('Alt+V 粘贴纯文本并正常提交', async function textPaste() {
    vi.mocked(readWindowsClipboard).mockResolvedValueOnce({ images: [], text: '普通文字' });
    const projection = createInitialCliProjection(); const calls: any[] = [];
    const controller = { async dispatch(action: any) { calls.push(action); return { kind: 'ok', exitCode: 0, lines: [], projection }; }, async consume() { return { kind: 'ok', exitCode: 0, lines: [], projection }; }, async resume() { return { kind: 'ok', exitCode: 0, lines: [], projection }; }, getProjection() { return projection; }, setSession() {}, setEventListener() {} };
    const view = render(createElement(CliTuiApp, { store: createCliTuiStore(), controller, closeWhenIdle: false, useColor: false, screenReader: true, renderMode: 'inline', onResult() {}, onRequestInterrupt() {}, onRequestCancel() {}, onEof() {}, onAppExit() {} }));
    try { writeInput(view.stdin, '\u001bv'); await wait(); expect(view.lastFrame()).toContain('普通文字'); writeInput(view.stdin, '\r'); await wait(); expect(calls[0]).toMatchObject({type:'submit_prompt',content:'普通文字'}); expect(calls[0].images).toBeUndefined(); } finally { view.unmount(); }
  });});



