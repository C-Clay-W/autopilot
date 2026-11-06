/** 视觉工具执行审批与审批后换图防护的受控测试。 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from '../../src/internal/tools/tool-executor';
import { ToolRegistry } from '../../src/internal/tools/tool-registry';
import { createVisionAnalyzeTool } from '../../src/internal/tools/builtins/vision-analyze-tool';
const fixtureRoot = join(process.cwd(), '../../.agent-tests/work-test/image-input-01a17db3/fixtures');
/** 创建隔离图片和真实 ToolExecutor，视觉 Provider 使用测试替身。 */
function setup() {
  const workspaceRoot = mkdtempSync(join(fixtureRoot, 'vision-')); const original = Buffer.from('image A'); writeFileSync(join(workspaceRoot, 'a.png'), original);
  const analyze = vi.fn().mockResolvedValue('观察结果'); const registry = new ToolRegistry(); registry.register(createVisionAnalyzeTool());
  const executor = new ToolExecutor(registry, { workspaceRoot, permissionMode: 'ask', workspaceTrusted: true, visionAnalyzer: { analyze } });
  const input = { path: 'a.png', prompt: '看图', expectedSha256: createHash('sha256').update(original).digest('hex') };
  return { workspaceRoot, input, executor, analyze };
}
describe('视觉工具审批', function suite() {
  it('批准后执行一次并发送同一副本', async function allow() {
    const f = setup(); const pending = await f.executor.execute({ callId: 'call', toolName: 'vision_analyze', input: f.input });
    expect(pending.status).toBe('approval_required'); if (pending.status !== 'approval_required') return;
    expect(f.analyze).not.toHaveBeenCalled();
    const result = await f.executor.execute({ callId: 'call', toolName: 'vision_analyze', input: f.input, approval: { approvalId: pending.approval.approvalId, decision: 'allow_once' } });
    expect(result.status).toBe('success'); expect(f.analyze).toHaveBeenCalledTimes(1);
    expect(f.analyze.mock.calls[0][0].imageDataUrl).toBe('data:image/png;base64,aW1hZ2UgQQ==');
  });
  it('审批后换图不外发', async function changed() {
    const f = setup(); const pending = await f.executor.execute({ callId: 'call', toolName: 'vision_analyze', input: f.input });
    expect(pending.status).toBe('approval_required'); if (pending.status !== 'approval_required') return;
    writeFileSync(join(f.workspaceRoot, 'a.png'), Buffer.from('image B'));
    const result = await f.executor.execute({ callId: 'call', toolName: 'vision_analyze', input: f.input, approval: { approvalId: pending.approval.approvalId, decision: 'allow_once' } });
    expect(result.status).toBe('error'); expect(f.analyze).not.toHaveBeenCalled();
  });
  it('拒绝审批不外发', async function deny() {
    const f = setup(); const pending = await f.executor.execute({ callId: 'call', toolName: 'vision_analyze', input: f.input });
    expect(pending.status).toBe('approval_required'); if (pending.status !== 'approval_required') return;
    const result = await f.executor.execute({ callId: 'call', toolName: 'vision_analyze', input: f.input, approval: { approvalId: pending.approval.approvalId, decision: 'deny' } });
    expect(result.status).toBe('denied'); expect(f.analyze).not.toHaveBeenCalled();
  });
});
