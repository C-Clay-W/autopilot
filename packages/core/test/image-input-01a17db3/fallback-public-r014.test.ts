/** 验证视觉回退跨审批 checkpoint 恢复和不重复分析。 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAgentKernel } from '../../src/internal/kernel/agent-kernel';
import { ToolRegistry } from '../../src/internal/tools/tool-registry';
import { sanitizeEventForExternal } from '../../src/runtime/protocol/sanitize-checkpoint';
import { createVisionAnalyzeTool } from '../../src/internal/tools/builtins/vision-analyze-tool';
import { createTurnEventRecorder } from '../../src/runtime/application/turn/turn-event-recorder';
import { createTurnRecoveryService } from '../../src/runtime/application/turn/turn-recovery-service';
/** 收集单次 Kernel 事件。 */
async function collect(kernel: ReturnType<typeof createAgentKernel>) { const events: any[] = []; for await (const e of kernel.run()) events.push(e); return events; }
describe('图片回退恢复', function suite() {
  it('审批恢复后分析一次，之后模型仅接收观察', async function resumes() {
    const workspaceRoot = mkdtempSync(join(process.cwd(), '../../.agent-tests/work-test/image-input-01a17db3/fixtures/recovery-')); const bytes = Buffer.from('image A'); mkdirSync(join(workspaceRoot, '.local', 'session-uploads', 'session'), { recursive: true }); writeFileSync(join(workspaceRoot, '.local', 'session-uploads', 'session', 'a.png'), bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex'); const id = '00000000-0000-4000-8000-000000000001';
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: '看图' }, { type: 'image-ref' as const, id, sha256, width: 1, height: 1 }] }];
    const sample = vi.fn().mockResolvedValue({ content: '完成', toolCalls: [], reasoningSummary: '', finishReason: 'stop' }); const analyze = vi.fn().mockResolvedValue('观察');
    const registry = new ToolRegistry(); registry.register(createVisionAnalyzeTool());
    const options = { turnId: 'turn', sessionId: 'session', messages, workspaceRoot, toolRegistry: registry, permissionContext: { mode: 'ask' as const, workspaceTrusted: true, validateApproval: vi.fn().mockResolvedValue(true) }, modelSampler: { sample }, supportsImageInput: false, visionAnalyzer: { analyze }, sessionImageStore: { put: vi.fn(), async read() { return { image: { id, sha256, width: 1, height: 1, bytes: bytes.length, name: 'a.png', mimeType: 'image/png', relativePath: '.local/session-uploads/session/a.png' }, bytes }; } } };
    const first = await collect(createAgentKernel(options)); const approval = first.find(function find(e) { return e.type === 'approval_required'; }); const paused = first.find(function find(e) { return e.type === 'turn_paused'; });
    expect(approval).toBeDefined(); expect(paused).toBeDefined(); expect(analyze).not.toHaveBeenCalled(); expect(sample).not.toHaveBeenCalled();
    const publicFirst = first.map(function project(event) { return sanitizeEventForExternal(event); });
    expect(JSON.stringify(publicFirst)).not.toMatch(/session-uploads|a\.png/);
    const safeApproval = publicFirst.find(function find(event) { return event.type === 'approval_required'; }) as any;
    expect(safeApproval.result.approval.approvalId).toBe(approval.result.approval.approvalId);
    expect(safeApproval.result.approval.display.resource).toBe('会话图片');
    expect(safeApproval.result.approval.allowedDecisions).toEqual(approval.result.approval.allowedDecisions);
    expect(JSON.stringify(paused.checkpoint)).toContain('session-uploads');
    const resumed = await collect(createAgentKernel({ ...options, checkpoint: paused.checkpoint, approval: { approvalId: approval.result.approval.approvalId, decision: 'allow_once' } }));
    const resultEvent = resumed.find(function result(e) { return e.type === 'tool_result'; }); expect(resultEvent).toBeDefined(); expect(JSON.stringify(sanitizeEventForExternal(resultEvent))).not.toContain('.local/session-uploads');
    for (const event of [...first, ...resumed]) {
      const safe = sanitizeEventForExternal(event);
      expect(JSON.stringify(safe)).not.toMatch(/session-uploads|a\.png/);
      expect(sanitizeEventForExternal(safe)).toEqual(safe);
    }
    expect(resultEvent.result.output.observation).toBe('观察');
    expect(analyze).toHaveBeenCalledTimes(1); expect(sample).toHaveBeenCalledTimes(1); expect(resumed.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(JSON.stringify(sample.mock.calls[0][0])).toContain('观察'); expect(JSON.stringify(sample.mock.calls[0][0])).not.toContain('image-ref');
  });
  it('仅系统图片调用的开始、进度和失败使用安全投影', function eventProjection() {
    const callId = 'image-fallback-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002';
    const base = { turnId: 'turn', stepId: 'step', callId, toolName: 'vision_analyze' };
    const secret = '.local/session-uploads/session/a.png';
    const events: any[] = [
      { type: 'tool_started', ...base, summary: secret, detail: secret, diff: secret },
      { type: 'tool_progress', ...base, tail: secret },
      { type: 'tool_result', ...base, retryCount: 0, summary: secret, detail: secret, result: { status: 'error', callId, toolName: 'vision_analyze', error: { code: 'FILE_NOT_READ', message: secret }, display: { titleKey: 'x', target: secret, summary: secret } } },
      { type: 'tool_result', ...base, retryCount: 0, summary: secret, result: { status: 'denied', callId, toolName: 'vision_analyze', error: { code: 'APPROVAL_REQUIRED', message: secret }, display: { titleKey: 'x', target: secret } } },
      { type: 'tool_result', ...base, retryCount: 0, summary: secret, result: { status: 'cancelled', callId, toolName: 'vision_analyze', error: { code: 'EXECUTION_CANCELLED', message: secret }, meta: { durationMs: 1, inputHash: 'hash' }, interruption: { phase: 'executing', normalizedInputHash: 'hash', sideEffectState: 'unknown', safeToRetry: false, reason: secret } } },
    ];
    for (const event of events) {
      const safe = sanitizeEventForExternal(event);
      expect(JSON.stringify(safe)).not.toContain(secret);
      expect(sanitizeEventForExternal(safe)).toEqual(safe);
    }
    const ordinary = { ...events[2], callId: 'ordinary', result: { ...events[2].result, callId: 'ordinary' } };
    expect(sanitizeEventForExternal(ordinary)).toEqual(ordinary);
  });
  it('统一 recorder 和旧 transcript 历史读取都应用同一脱敏', async function recordedAndHistory() {
    const callId = 'image-fallback-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002';
    const event: any = { type: 'tool_started', turnId: 'turn', stepId: 'step', callId, toolName: 'vision_analyze', summary: '.local/session-uploads/session/a.png' };
    const oldEnvelope = { seq: 1, sessionId: 'session', turnId: 'turn', timestamp: 'now', event };
    const append = vi.fn(); const write = vi.fn();
    const ports: any = { clock: { now: function now() { return 0; }, timestamp: function timestamp() { return 'now'; } }, transcriptStore: { append, getEvents: vi.fn().mockResolvedValue([oldEnvelope]) }, eventSink: { write }, turnStore: { getLatest: vi.fn().mockResolvedValue(null) }, sessionStore: { get: vi.fn().mockResolvedValue(null) }, checkpointStore: { recoverStale: vi.fn().mockResolvedValue(undefined) } };
    const safe = await createTurnEventRecorder(ports).record({ seq: 2, sessionId: 'session', turnId: 'turn', isDurable: true, event });
    expect(JSON.stringify([safe, append.mock.calls, write.mock.calls])).not.toContain('session-uploads');
    const state = await createTurnRecoveryService(ports, {} as any).getState({ sessionId: 'session' });
    expect(JSON.stringify(state.events)).not.toContain('session-uploads');
    expect(oldEnvelope.event.summary).toContain('session-uploads');
  });
});

