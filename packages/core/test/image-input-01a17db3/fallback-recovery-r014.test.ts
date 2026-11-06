/** 验证视觉回退跨审批 checkpoint 恢复和不重复分析。 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAgentKernel } from '../../src/internal/kernel/agent-kernel';
import { ToolRegistry } from '../../src/internal/tools/tool-registry';
import { createVisionAnalyzeTool } from '../../src/internal/tools/builtins/vision-analyze-tool';
/** 收集单次 Kernel 事件。 */
async function collect(kernel: ReturnType<typeof createAgentKernel>) { const events: any[] = []; for await (const e of kernel.run()) events.push(e); return events; }
describe('图片回退恢复', function suite() {
  it('审批恢复后分析一次，之后模型仅接收观察', async function resumes() {
    const workspaceRoot = mkdtempSync(join(process.cwd(), '../../.agent-tests/work-test/image-input-01a17db3/fixtures/recovery-')); const bytes = Buffer.from('image A'); writeFileSync(join(workspaceRoot, 'a.png'), bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex'); const id = '00000000-0000-4000-8000-000000000001';
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: '看图' }, { type: 'image-ref' as const, id, sha256, width: 1, height: 1 }] }];
    const sample = vi.fn().mockResolvedValue({ content: '完成', toolCalls: [], reasoningSummary: '', finishReason: 'stop' }); const analyze = vi.fn().mockResolvedValue('观察');
    const registry = new ToolRegistry(); registry.register(createVisionAnalyzeTool());
    const options = { turnId: 'turn', sessionId: 'session', messages, workspaceRoot, toolRegistry: registry, permissionContext: { mode: 'ask' as const, workspaceTrusted: true, validateApproval: vi.fn().mockResolvedValue(true) }, modelSampler: { sample }, supportsImageInput: false, visionAnalyzer: { analyze }, sessionImageStore: { put: vi.fn(), async read() { return { image: { id, sha256, width: 1, height: 1, bytes: bytes.length, name: 'a.png', mimeType: 'image/png', relativePath: 'a.png' }, bytes }; } } };
    const first = await collect(createAgentKernel(options)); const approval = first.find(function find(e) { return e.type === 'approval_required'; }); const paused = first.find(function find(e) { return e.type === 'turn_paused'; });
    expect(approval).toBeDefined(); expect(paused).toBeDefined(); expect(analyze).not.toHaveBeenCalled(); expect(sample).not.toHaveBeenCalled();
    const resumed = await collect(createAgentKernel({ ...options, checkpoint: paused.checkpoint, approval: { approvalId: approval.result.approval.approvalId, decision: 'allow_once' } }));
    expect(analyze).toHaveBeenCalledTimes(1); expect(sample).toHaveBeenCalledTimes(1); expect(resumed.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(JSON.stringify(sample.mock.calls[0][0])).toContain('观察'); expect(JSON.stringify(sample.mock.calls[0][0])).not.toContain('image-ref');
  });
});
