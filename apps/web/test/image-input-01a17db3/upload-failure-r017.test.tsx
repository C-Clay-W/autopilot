/** 验证 Work 图片上传失败时保留整批草稿且不发送部分图片。 */
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { createPresentationState } from '@autopilot-agent/presentation';
import { useConversationSubmission } from '@/app/chat/hooks/useConversationSubmission';
const notice = vi.hoisted(function createNotice() { return { error: vi.fn(), warning: vi.fn(), success: vi.fn() }; });
vi.mock('@/app/chat/components/Notice', function mockNotice() { return { useNotice: function useNotice() { return notice; } }; });
vi.mock('@/app/chat/session-task-context', function mockContext() { return { useSessionTaskContext: function context() { return { manager: {}, refreshSessions: vi.fn() }; } }; });
/** 等待 Hook 更新。 */
function frame() { return new Promise(function resolve(done) { setTimeout(done, 30); }); }
describe('Work 图片上传失败', function suite() {
  it('第二批上传失败时恢复整批草稿且不提交消息', async function uploadFailure() {
    notice.error.mockClear();
    const messages: any[] = []; const input = { current: '看图' };
    const options = { isChat: false, workspaceId: 'workspace', sessionId: 'session', hasWorkspace: true, canWrite: true, loading: false, activeTurnId: '', messages: [], presentation: createPresentationState(), currentRetrieval: 'none', databaseEnabled: false, selectedSkills: [], inputRef: input, inputActionsRef: { current: null }, textareaRef: { current: null }, currentSessionIdRef: { current: 'session' }, currentWorkspaceIdRef: { current: 'workspace' }, activeTurnRef: { current: null }, cancelInFlightRef: { current: null }, cancelRequestedRef: { current: false }, cancelledTurnIdsRef: { current: new Set() }, historyInputIdsRef: { current: new Set() }, awaitingUserInputRef: { current: false }, joinedInputIdsRef: { current: new Set() }, pendingInputsRef: { current: [] }, setMessages: function update(fn: any) { messages.splice(0, messages.length, ...fn(messages)); }, setPresentation: vi.fn(), setLoading: vi.fn(), setPendingInputs: vi.fn(), setInputDeliveryNotice: vi.fn(), setSelectedSkills: vi.fn() } as any;
    vi.stubGlobal('window', { location: { search: '?mode=work&workspaceId=workspace&sessionId=session' } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ attachment: { id: 'a', name: 'a.png', mimeType: 'image/png' } }))
      .mockResolvedValueOnce(Response.json({ error: '图片上传失败' }, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    let current!: ReturnType<typeof useConversationSubmission>;
    /** 将被测 Hook 接入受控组件。 */
    function Probe() { current = useConversationSubmission(options); return null; }
    const view = render(createElement(Probe));
    try {
      current.setSelectedFiles([{ name: 'a.png', size: 1, file: new File(['a'], 'a.png', { type: 'image/png' }) }, { name: 'b.png', size: 1, file: new File(['b'], 'b.png', { type: 'image/png' }) }]);
      await frame(); await current.handleSend(); await frame();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.some(function isMessage(call) { return String(call[0]).endsWith('/messages'); })).toBe(false);
      expect(notice.error).toHaveBeenCalledWith('图片上传失败');
      expect(input.current).toBe('看图');
      expect(current.selectedFiles.map(function name(file) { return file.name; })).toEqual(['a.png', 'b.png']);
      expect(messages).toEqual([]);
    } finally { view.unmount(); vi.unstubAllGlobals(); }
  });
});
