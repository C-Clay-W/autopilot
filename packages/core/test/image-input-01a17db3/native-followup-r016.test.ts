/** 验证原生图片在工具调用之后的再次采样仍可读取。 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgentKernel } from '../../src/internal/kernel/agent-kernel';
import { ToolRegistry } from '../../src/internal/tools/tool-registry';
const id='00000000-0000-4000-8000-000000000001'; const sha256='a'.repeat(64);
describe('图片工具后采样', function suite() {
  it('工具结果后再次携带同一图片引用和字节', async function toolFollowup() {
    const registry = new ToolRegistry(); registry.register({ name: 'inspect_test', description: 'test', inputSchema: z.object({}), metadata: { effect: 'none', destructive: false, concurrency: { max: 1 }, retry: { safe: false } }, createActionFacts() { return { toolName: 'inspect_test', effect: 'none', destructive: false, operation: 'read', resource: 'test', risk: 'read_only' }; }, async execute() { return { value: 'ok' }; }, serializeOutput(output) { return output; } } as any);
    const sample = vi.fn().mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'c1', name: 'inspect_test', input: {} }], reasoningSummary: '', finishReason: 'tool_calls' }).mockResolvedValueOnce({ content: '完成', toolCalls: [], reasoningSummary: '', finishReason: 'stop' });
    const store = { put: vi.fn(), read: vi.fn(async function read() { return { image: { id, sha256, width: 1, height: 1, bytes: 3, name: 'a.png', mimeType: 'image/png', relativePath: 'safe' }, bytes: Buffer.from('abc') }; }) };
    const kernel = createAgentKernel({ turnId: 'turn', sessionId: 'session', messages: [{ role: 'user', content: [{ type: 'image-ref', id, sha256, width: 1, height: 1 }] }], toolRegistry: registry, permissionContext: { mode: 'auto_approve', workspaceTrusted: true }, modelSampler: { sample }, supportsImageInput: true, sessionImageStore: store });
    const events=[]; for await (const event of kernel.run()) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' }); expect(sample).toHaveBeenCalledTimes(2);
    expect(sample.mock.calls[1][2].imageData[id].data).toBe('YWJj'); expect(JSON.stringify(sample.mock.calls[1][0])).toContain('tool-result'); expect(JSON.stringify(sample.mock.calls[1][0])).toContain('image-ref');
  });
});

