/** 验证用户取消与账户余额不足不进入图片视觉回退。 */
import { describe, expect, it, vi } from 'vitest';
import { createAgentKernel } from '../../src/internal/kernel/agent-kernel';
import { ToolRegistry } from '../../src/internal/tools/tool-registry';
import { AgentSampleError } from '../../src/internal/lib/llm';
const id = '00000000-0000-4000-8000-000000000001';
const image = { id, sha256: 'a'.repeat(64), width: 4, height: 4, bytes: 3, mimeType: 'image/png', name: 'a.png', relativePath: 'safe' };
const messages = [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image-ref', id, sha256: image.sha256, width: 4, height: 4 }] }];
/** 收集事件。 */
async function collect(stream: AsyncIterable<any>) { const events = []; for await (const e of stream) events.push(e); return events; }
/** 创建支持图片原生输入的受控 Kernel。 */
function kernel(sample: any, signal?: AbortSignal) {
  return createAgentKernel({ turnId: 'test-turn', sessionId: 'test-session', messages: messages as any, toolRegistry: new ToolRegistry(), permissionContext: { mode: 'auto_approve' }, modelSampler: { sample }, supportsImageInput: true, ...(signal ? { signal } : {}), sessionImageStore: { read: vi.fn(async function readImage() { return { image, bytes: Buffer.from('abc') }; }), put: vi.fn() } });
}
describe('图片失败分支不误回退', function suite() {
  it('采样中取消转为中断且不重试或回退', async function cancel() {
    const controller = new AbortController();
    const sample = vi.fn(function pending() { return new Promise(function never() { /* 保持挂起直到取消 */ }); });
    const pending = collect(kernel(sample, controller.signal).run());
    setTimeout(function abort() { controller.abort(); }, 10);
    const events = await pending;
    expect(sample).toHaveBeenCalledTimes(1);
    expect(events.filter(function recovery(e) { return e.type === 'model_recovery'; })).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'turn_interrupted' });
  });
  it('余额不足直接失败并保留安全原因，不回退视觉工具', async function billing() {
    const sample = vi.fn().mockRejectedValue(new AgentSampleError('余额不足', 'PROVIDER_REQUEST_REJECTED', undefined, 402, 'billing_insufficient'));
    const events = await collect(kernel(sample).run());
    expect(sample).toHaveBeenCalledTimes(1);
    expect(events.filter(function recovery(e) { return e.type === 'model_recovery'; })).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed', errorCode: 'PROVIDER_REQUEST_REJECTED', providerFailureReason: 'billing_insufficient' });
  });
});
