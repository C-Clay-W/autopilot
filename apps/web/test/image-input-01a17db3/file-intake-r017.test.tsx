/** 验证 Work 图片选择与拖入的文件摄取契约（不覆盖真实 DOM 事件绑定）。 */
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
/** 创建只读依赖的最小选项。 */
function options(canWrite = true) {
  return { isChat: false, workspaceId: 'workspace', sessionId: 'session', hasWorkspace: true, canWrite, loading: false, activeTurnId: '', messages: [], presentation: createPresentationState(), currentRetrieval: 'none', databaseEnabled: false, selectedSkills: [], inputRef: { current: '' }, inputActionsRef: { current: null }, textareaRef: { current: null }, currentSessionIdRef: { current: 'session' }, currentWorkspaceIdRef: { current: 'workspace' }, activeTurnRef: { current: null }, cancelInFlightRef: { current: null }, cancelRequestedRef: { current: false }, cancelledTurnIdsRef: { current: new Set() }, historyInputIdsRef: { current: new Set() }, awaitingUserInputRef: { current: false }, joinedInputIdsRef: { current: new Set() }, pendingInputsRef: { current: [] }, setMessages: vi.fn(), setPresentation: vi.fn(), setLoading: vi.fn(), setPendingInputs: vi.fn(), setInputDeliveryNotice: vi.fn(), setSelectedSkills: vi.fn() } as any;
}
/** 构造受控拖入事件。 */
function drop(files: File[]) { return { preventDefault() { /* 受控事件无需默认行为 */ }, stopPropagation() { /* 受控事件无需冒泡 */ }, dataTransfer: { files } } as any; }
/** 渲染 Hook 并返回当前实例。 */
function mount(canWrite = true) {
  let current!: ReturnType<typeof useConversationSubmission>;
  /** 将被测 Hook 接入受控组件。 */
  function Probe() { current = useConversationSubmission(options(canWrite)); return null; }
  return { view: render(createElement(Probe)), get current() { return current; } };
}
describe('Work 图片摄取', function suite() {
  it('拖入多图按顺序追加到草稿', async function dropImages() {
    const subject = mount();
    try {
      subject.current.handleDrop(drop([new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.jpg', { type: 'image/jpeg' })]));
      await frame();
      expect(subject.current.selectedFiles.map(function name(file) { return file.name; })).toEqual(['a.png', 'b.jpg']);
    } finally { subject.view.unmount(); }
  });
  it('拖入非图片文件时整批拒绝并提示', async function rejectNonImage() {
    notice.error.mockClear();
    const subject = mount();
    try {
      subject.current.handleDrop(drop([new File(['a'], 'a.png', { type: 'image/png' }), new File(['t'], 'notes.txt', { type: 'text/plain' })]));
      await frame();
      expect(subject.current.selectedFiles).toEqual([]);
      expect(notice.error).toHaveBeenCalledTimes(1);
    } finally { subject.view.unmount(); }
  });
  it('不可写时不接受拖入或选择', async function readOnly() {
    const subject = mount(false);
    try {
      subject.current.handleDrop(drop([new File(['a'], 'a.png', { type: 'image/png' })]));
      await frame();
      expect(subject.current.selectedFiles).toEqual([]);
    } finally { subject.view.unmount(); }
  });
});
