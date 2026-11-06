/** 验证 Kernel 图片原生采样和回退的受控分支。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentKernel } from '../../src/internal/kernel/agent-kernel';
import { ToolRegistry } from '../../src/internal/tools/tool-registry';
import { AgentSampleError } from '../../src/internal/lib/llm';
const id = '00000000-0000-4000-8000-000000000001';
const sha256 = 'a'.repeat(64);
const image = { id, sha256, width: 4, height: 4, bytes: 3, mimeType: 'image/png', name: 'a.png', relativePath: 'safe' };
/** 收集事件。 */
async function collect(stream: AsyncIterable<any>) { const events = []; for await (const e of stream) events.push(e); return events; }
/** 注入受控图片存储和采样器。 */
function kernel(sample: any, supportsImageInput: boolean) {
  return createAgentKernel({ turnId: 'test-turn', sessionId: 'test-session', messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image-ref', id, sha256, width: 4, height: 4 }] }], toolRegistry: new ToolRegistry(), permissionContext: { mode: 'auto_approve' }, modelSampler: { sample }, supportsImageInput, sessionImageStore: { read: vi.fn(async function read() { return { image, bytes: Buffer.from('abc') }; }), put: vi.fn() } });
}
afterEach(function reset() { vi.useRealTimers(); });
describe('Kernel 图片路径', function suite() {
  it('支持图片时发送受控数据', async function native() {
    const sample = vi.fn().mockResolvedValue({ content: '完成', toolCalls: [], reasoningSummary: '', finishReason: 'stop' });
    const events = await collect(kernel(sample, true).run());
    expect(sample).toHaveBeenCalledTimes(1);
    expect(sample.mock.calls[0][2].imageData[id]).toEqual({ mimeType: 'image/png', data: 'YWJj' });
    expect(events.some(function complete(e) { return e.type === 'turn_completed'; })).toBe(true);
  });
  it('不支持图片且工具不可用时明确失败', async function unavailable() {
    const sample = vi.fn(); const events = await collect(kernel(sample, false).run());
    expect(sample).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed', errorCode: 'IMAGE_VISION_UNAVAILABLE' });
  });
  it('鉴权拒绝不进入回退', async function auth() {
    const sample = vi.fn().mockRejectedValue(new AgentSampleError('拒绝', 'PROVIDER_REQUEST_REJECTED'));
    const events = await collect(kernel(sample, true).run());
    expect(sample).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed', errorCode: 'PROVIDER_REQUEST_REJECTED' });
  });
  it('上下文溢出沿用 compact 事件', async function overflow() {
    const sample = vi.fn().mockRejectedValue(new AgentSampleError('溢出', 'CONTEXT_OVERFLOW'));
    const events = await collect(kernel(sample, true).run());
    expect(sample).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'context_overflow' });
  });
  it('超过退避上限不触发回退', async function retryAfter() {
    const sample = vi.fn().mockRejectedValue(new AgentSampleError('限流', 'PROVIDER_RATE_LIMIT', undefined, 429, undefined, undefined, 20000));
    const events = await collect(kernel(sample, true).run());
    expect(sample).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed', errorCode: 'PROVIDER_RATE_LIMIT' });
  });
  it('输出正文后的断流不重试或回退', async function streamedFailure() {
    const sample = vi.fn(async function fail(_messages, _tools, _options, onDelta) { onDelta('部分'); throw new AgentSampleError('断流', 'STREAM_INCOMPLETE'); });
    const events = await collect(kernel(sample, true).run());
    expect(sample).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed', errorCode: 'STREAM_INCOMPLETE' });
  });
  it('瞬时错误耗尽既有预算才进入回退', async function retries() {
    vi.useFakeTimers();
    const sample = vi.fn().mockRejectedValue(new AgentSampleError('限流', 'PROVIDER_RATE_LIMIT'));
    const pending = collect(kernel(sample, true).run()); await vi.advanceTimersByTimeAsync(60000);
    const events = await pending;
    expect(sample).toHaveBeenCalledTimes(6);
    expect(events.filter(function recovery(e) { return e.type === 'model_recovery'; })).toHaveLength(5);
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed', errorCode: 'IMAGE_VISION_UNAVAILABLE' });
  });
});

