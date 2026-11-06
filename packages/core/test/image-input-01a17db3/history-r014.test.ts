/** 图片 canonical 历史的压缩、计量、签名与公开事件投影。 */
import { describe, expect, it, vi } from 'vitest';
import { compactMessages, estimateMessageTokens, projectMessagesForSummary, serializeCanonicalMessagesForSignature } from '../../src/internal/kernel/compact';
import { sanitizeEventForExternal } from '../../src/runtime/protocol/sanitize-checkpoint';
import type { AgentMessage } from '../../src/internal/types/agent-message';
const ref = { type: 'image-ref' as const, id: '00000000-0000-4000-8000-000000000001', sha256: 'a'.repeat(64), width: 1024, height: 1024 };
describe('图片历史与公开投影', function suite() {
  it('摘要不冒充看图，尾部保留图片，计量和签名绑定图片', async function compact() {
    const messages: AgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: '旧事' }] }, { role: 'assistant', content: [{ type: 'text', text: '完成' }] }, { role: 'user', content: [ref] }];
    expect(estimateMessageTokens([messages[2]])).toBeGreaterThan(680);
    expect(serializeCanonicalMessagesForSignature([messages[2]])).not.toBe(serializeCanonicalMessagesForSignature([{ role: 'user', content: [{ ...ref, sha256: 'b'.repeat(64) }] }]));
    expect(projectMessagesForSummary([messages[2]])).toContain('[用户图片]');
    const sampler = { sample: vi.fn().mockResolvedValue({ content: '旧事摘要', toolCalls: [], reasoningSummary: '', finishReason: 'stop' }) };
    const result = await compactMessages({ messages, preserveRecentTurns: 1, targetTokens: 2000, trigger: 'manual', sampler });
    expect(result.messages.at(-1)).toEqual(messages[2]);
    expect(JSON.stringify(sampler.sample.mock.calls[0][0])).not.toContain(ref.sha256);
  });
  it('公开 checkpoint 不含图片引用或私有路径', function safeProjection() {
    const checkpoint = { turnId: 'turn', status: 'interrupted', stepCount: 1, messages: [{ role: 'user', content: [ref] }], pendingCalls: [{ id: 'call', name: 'vision_analyze', input: { path: 'private/path.png', expectedSha256: ref.sha256 } }], completedCallIds: [] };
    const event = sanitizeEventForExternal({ type: 'turn_interrupted', turnId: 'turn', checkpoint } as any);
    const json = JSON.stringify(event); expect(json).not.toContain(ref.sha256); expect(json).not.toContain('private/path.png'); expect(json).not.toContain(ref.id);
  });
});
