/** Kernel 对消息图片数量、总字节和身份的受控限制。 */
import { describe, expect, it, vi } from 'vitest';
import { createAgentKernel } from '../../src/internal/kernel/agent-kernel';
import { ToolRegistry } from '../../src/internal/tools/tool-registry';
/** 收集受控 Kernel 事件。 */
async function collect(count: number, bytesPerImage: number, mismatched = false) {
  const refs = Array.from({ length: count }, function create(_, i) { return { type: 'image-ref' as const, id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, sha256: 'a'.repeat(64), width: 1, height: 1 }; });
  const sample = vi.fn().mockResolvedValue({ content: '完成', toolCalls: [], reasoningSummary: '', finishReason: 'stop' });
  const kernel = createAgentKernel({ turnId: 'turn', sessionId: 'session', messages: [{ role: 'user', content: refs }], toolRegistry: new ToolRegistry(), permissionContext: { mode: 'auto_approve' }, modelSampler: { sample }, supportsImageInput: true, sessionImageStore: { put: vi.fn(), async read({ id }) { return { image: { id, sha256: mismatched ? 'b'.repeat(64) : 'a'.repeat(64), width: 1, height: 1, bytes: bytesPerImage, name: 'a.png', mimeType: 'image/png', relativePath: 'safe' }, bytes: Buffer.alloc(bytesPerImage) }; } } });
  const events = []; for await (const event of kernel.run()) events.push(event); return { events, sample };
}
describe('图片批次边界', function suite() {
  it('十张可采样，十一张拒绝', async function count() {
    const ok = await collect(10, 1); expect(ok.sample).toHaveBeenCalledTimes(1);
    const bad = await collect(11, 1); expect(bad.sample).not.toHaveBeenCalled(); expect(bad.events.at(-1)).toMatchObject({ type: 'turn_failed', errorCode: 'IMAGE_INPUT_UNAVAILABLE' });
  });
  it('总量超 20MiB 拒绝发送', async function total() {
    const bad = await collect(6, 3_600_000); expect(bad.sample).not.toHaveBeenCalled(); expect(bad.events.at(-1)).toMatchObject({ type: 'turn_failed', errorCode: 'IMAGE_INPUT_UNAVAILABLE' });
  });
  it('元数据哈希改变时拒绝采样', async function integrity() {
    const bad = await collect(1, 1, true); expect(bad.sample).not.toHaveBeenCalled(); expect(bad.events.at(-1)).toMatchObject({ type: 'turn_failed', errorCode: 'IMAGE_INPUT_UNAVAILABLE' });
  });
});
