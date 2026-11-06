/** 验证跨 Turn 图片历史、旧纯文本 checkpoint、未知模型能力与冻结能力目录。 */
import { describe, expect, it, vi } from 'vitest';
import { createAgentKernel } from '../../src/internal/kernel/agent-kernel';
import { ToolRegistry } from '../../src/internal/tools/tool-registry';
import { getModelCapabilityForRef } from '../../src/runtime/provider/model-capability-catalog';
const id = '00000000-0000-4000-8000-000000000001';
const sha256 = 'a'.repeat(64);
const image = { id, sha256, width: 4, height: 4, bytes: 3, mimeType: 'image/png', name: 'a.png', relativePath: 'safe' };
const ref = { type: 'image-ref', id, sha256, width: 4, height: 4 };
/** 收集事件。 */
async function collect(stream: AsyncIterable<any>) { const events = []; for await (const e of stream) events.push(e); return events; }
/** 用给定历史消息和受控图片存储创建 Kernel；未传 supportsImageInput 表示能力未知。 */
function kernel(messages: any[], sample: any, supportsImageInput?: boolean) {
  const read = vi.fn(async function readImage() { return { image, bytes: Buffer.from('abc') }; });
  return { read, kernel: createAgentKernel({ turnId: 'test-turn', sessionId: 'test-session', messages, toolRegistry: new ToolRegistry(), permissionContext: { mode: 'auto_approve' }, modelSampler: { sample }, ...(supportsImageInput === undefined ? {} : { supportsImageInput }), sessionImageStore: { read, put: vi.fn() } }) };
}
describe('图片跨 Turn 与能力冻结', function suite() {
  it('旧纯文本 checkpoint 不读图片存储且不传图片数据', async function legacy() {
    const sample = vi.fn().mockResolvedValue({ content: '完成', toolCalls: [], reasoningSummary: '', finishReason: 'stop' });
    const subject = kernel([{ role: 'user', content: [{ type: 'text', text: '旧事' }] }, { role: 'assistant', content: [{ type: 'text', text: '完成' }] }, { role: 'user', content: [{ type: 'text', text: '继续' }] }], sample, true);
    await collect(subject.kernel.run());
    expect(sample).toHaveBeenCalledTimes(1);
    expect(sample.mock.calls[0][2].imageData).toEqual({});
    expect(subject.read).not.toHaveBeenCalled();
  });
  it('历史 Turn 的图片引用仍展开为原生数据且同一图片只读一次', async function crossTurn() {
    const sample = vi.fn().mockResolvedValue({ content: '完成', toolCalls: [], reasoningSummary: '', finishReason: 'stop' });
    const subject = kernel([{ role: 'user', content: [{ type: 'text', text: '看图' }, ref] }, { role: 'assistant', content: [{ type: 'text', text: '已看过' }] }, { role: 'user', content: [{ type: 'text', text: '再看一次' }, ref] }], sample, true);
    await collect(subject.kernel.run());
    expect(sample.mock.calls[0][2].imageData).toEqual({ [id]: { mimeType: 'image/png', data: 'YWJj' } });
    expect(subject.read).toHaveBeenCalledTimes(1);
  });
  it('历史图片哈希不一致时明确失败且不采样', async function tampered() {
    const sample = vi.fn();
    const subject = kernel([{ role: 'user', content: [{ ...ref, sha256: 'b'.repeat(64) }] }], sample, true);
    const events = await collect(subject.kernel.run());
    expect(sample).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed', errorCode: 'IMAGE_INPUT_UNAVAILABLE' });
  });
  it('能力未知按未获支持处理，不发送图片数据', async function unknownCapability() {
    const sample = vi.fn();
    const subject = kernel([{ role: 'user', content: [{ type: 'text', text: '看图' }, ref] }], sample);
    const events = await collect(subject.kernel.run());
    expect(sample).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed', errorCode: 'IMAGE_VISION_UNAVAILABLE' });
  });
  it('目录只对显式登记 image 的模型返回图片能力', function catalog() {
    expect(getModelCapabilityForRef({ provider: 'deepseek', modelId: 'deepseek-v4-flash' })?.inputModalities.includes('image')).toBe(true);
    expect(getModelCapabilityForRef({ provider: 'firstParty', modelId: 'deepseek-flash' })?.inputModalities.includes('image')).toBe(true);
    expect(getModelCapabilityForRef({ provider: 'ali', modelId: 'qwen3-vl-flash' })?.inputModalities.includes('image')).toBe(true);
    expect(getModelCapabilityForRef({ provider: 'unknown', modelId: 'mystery-vision' })).toBeUndefined();
  });
});
