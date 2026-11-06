/** 验证 Work 运行中图片追加的网络不确定状态提示。 */
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { createPresentationState } from '@autopilot-agent/presentation';
import { useConversationSubmission } from '@/app/chat/hooks/useConversationSubmission';
const notice = vi.hoisted(function createNotice() { return { error: vi.fn(), warning: vi.fn(), success: vi.fn() }; });
vi.mock('@/app/chat/components/Notice', function mockNotice() { return { useNotice: function useNotice() { return notice; } }; });
vi.mock('@/app/chat/session-task-context', function mockContext() { return { useSessionTaskContext: function context() { return { manager: { beginSession: vi.fn() }, refreshSessions: vi.fn() }; } }; });
/** 等待 Hook 更新。 */
function frame() { return new Promise(function resolve(done) { setTimeout(done, 30); }); }
describe('运行中图片提交状态', function suite() {
  it('响应丢失时告知核对会话记录，不能断言加入失败', async function uncertain() {
    const messages: any[] = [];
    const input = { current: '看图' };
    const options = { isChat: false, workspaceId: 'workspace', sessionId: 'session', hasWorkspace: true, canWrite: true, loading: true, activeTurnId: 'turn', messages: [], presentation: createPresentationState(), currentRetrieval: 'none', databaseEnabled: false, selectedSkills: [], inputRef: input, inputActionsRef: { current: null }, textareaRef: { current: null }, currentSessionIdRef: { current: 'session' }, currentWorkspaceIdRef: { current: 'workspace' }, activeTurnRef: { current: { sessionId: 'session', turnId: 'turn' } }, cancelInFlightRef: { current: null }, cancelRequestedRef: { current: false }, cancelledTurnIdsRef: { current: new Set() }, historyInputIdsRef: { current: new Set() }, awaitingUserInputRef: { current: false }, joinedInputIdsRef: { current: new Set() }, pendingInputsRef: { current: [] }, setMessages: function update(fn: any) { messages.splice(0, messages.length, ...fn(messages)); }, setPresentation: vi.fn(), setLoading: vi.fn(), setPendingInputs: vi.fn(), setInputDeliveryNotice: vi.fn(), setSelectedSkills: vi.fn() } as any;
    vi.stubGlobal('window', { location: { search: '?mode=work&workspaceId=workspace&sessionId=session' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ attachment: { id: 'image', name: 'a.png', mimeType: 'image/png' } })).mockRejectedValueOnce(new TypeError('network failed')));
    let current!: ReturnType<typeof useConversationSubmission>;
    function Probe() { current = useConversationSubmission(options); return null; }
    const view = render(createElement(Probe));
    try {
      current.setSelectedFiles([{ name: 'a.png', size: 1, file: new File(['x'], 'a.png', { type: 'image/png' }) }]);
      await frame(); await current.handleSend(); await frame();
      const visible = JSON.stringify({ messages, warning: notice.warning.mock.calls, error: notice.error.mock.calls });
      expect(input.current).toBe('看图');
      expect(visible).toMatch(/未确认|不确定/);
      expect(visible).toMatch(/核对|检查/);
    } finally { view.unmount(); vi.unstubAllGlobals(); }
  });

  /** 运行活动 Turn 的受控响应，并保留测试期间的新输入和目标切换。 */
  async function exercise(response: (options?: any) => Promise<Response>, switchTarget = false, newTurn = false, changeEpoch = false, switchDuringStream = false) {
    notice.warning.mockClear(); notice.error.mockClear();
    const messages: any[] = []; const input = { current: '看图' };
    const session = { current: 'session' };
    const pendingInputs = { current: [] as any[] };
    const options = { isChat: false, workspaceId: 'workspace', sessionId: 'session', hasWorkspace: true, canWrite: true, loading: true, activeTurnId: 'turn', messages: [], presentation: createPresentationState(), currentRetrieval: 'none', databaseEnabled: false, selectedSkills: [], inputRef: input, inputActionsRef: { current: null }, textareaRef: { current: null }, currentSessionIdRef: session, currentWorkspaceIdRef: { current: 'workspace' }, activeTurnRef: { current: { sessionId: 'session', turnId: 'turn' } }, cancelInFlightRef: { current: null }, cancelRequestedRef: { current: false }, cancelledTurnIdsRef: { current: new Set() }, historyInputIdsRef: { current: new Set() }, awaitingUserInputRef: { current: false }, joinedInputIdsRef: { current: new Set() }, pendingInputsRef: pendingInputs, setMessages: function update(fn: any) { messages.splice(0, messages.length, ...fn(messages)); }, setPresentation: vi.fn(), setLoading: vi.fn(), setPendingInputs: vi.fn(), setInputDeliveryNotice: vi.fn(), setSelectedSkills: vi.fn(), clearActiveTurn: vi.fn(), loadHistory: vi.fn() } as any;
    if (newTurn) Object.assign(options, { loading: false, activeTurnId: '', getSessionController: function controller() { return { createAbortController: function create() { return new AbortController(); } }; }, requestAbortRef: { current: null }, executionEpochRef: { current: 0 }, locallyCreatedSessionRef: { current: null }, awaitingApprovalRef: { current: false }, transportDisconnectedRef: { current: false }, queuedFollowUpTurnIdRef: { current: null }, setStreamingMessageId: vi.fn(), setActivity: vi.fn(), setTransportState: vi.fn(), setReadOnlyReason: vi.fn(), setPinnedSkills: vi.fn(), consumeAgentStream: vi.fn(async function consume() { if (switchDuringStream) session.current = 'other'; return 'ended_without_terminal'; }) });
    vi.stubGlobal('window', { location: { search: '?mode=work&workspaceId=workspace&sessionId=session' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ attachment: { id: 'image', name: 'a.png', mimeType: 'image/png' } })).mockImplementationOnce(async function submit() { input.current = '新输入'; if (switchTarget) session.current = 'other'; if (changeEpoch) options.executionEpochRef.current++; return response(options); }));
    let current!: ReturnType<typeof useConversationSubmission>;
    /** 将被测 Hook 接入受控组件。 */
    function Probe() { current = useConversationSubmission(options); return null; }
    const view = render(createElement(Probe));
    try {
      current.setSelectedFiles([{ name: 'a.png', size: 1, file: new File(['x'], 'a.png', { type: 'image/png' }) }]);
      await frame(); await current.handleSend(); await frame();
      return { messages, input: input.current, files: current.selectedFiles, pendingInputs: pendingInputs.current, options };
    } finally { view.unmount(); vi.unstubAllGlobals(); }
  }

  it.each([
    ['缺失确认', function missing() { return Promise.resolve(Response.json({ accepted: true }, { status: 202 })); }],
    ['无法解析确认', function invalid() { return Promise.resolve(new Response('{', { status: 202 })); }],
  ])('%s时保留新旧草稿并提示核对', async function missingConfirmation(_name, response) {
    const result = await exercise(response);
    expect(result.input).toBe('看图\n新输入');
    expect(result.files.map(function name(file) { return file.name; })).toEqual(['a.png']);
    expect(JSON.stringify(result.messages)).toMatch(/未确认.*检查会话记录/);
    expect(JSON.stringify(result.messages)).not.toContain('输入加入失败');
  });

  it('明确拒绝保留失败提示和新旧草稿', async function rejected() {
    const result = await exercise(function respond() { return Promise.resolve(Response.json({ error: '明确拒绝' }, { status: 400 })); });
    expect(result.input).toBe('看图\n新输入');
    expect(JSON.stringify(result.messages)).toContain('输入加入失败：明确拒绝');
  });

  it('活动任务结束时保留原有重发提示', async function finished() {
    const result = await exercise(function respond() { return Promise.resolve(Response.json({ code: 'active_turn_finished' }, { status: 409 })); });
    expect(result.input).toBe('看图\n新输入');
    expect(JSON.stringify(result.messages)).toContain('上一任务已经结束');
  });

  it('完整确认后不恢复草稿并登记等待输入', async function accepted() {
    const result = await exercise(function respond() { return Promise.resolve(Response.json({ inputId: 'input-1', delivery: 'steer', status: 'pending' }, { status: 202 })); });
    expect(result.input).toBe('新输入');
    expect(result.pendingInputs).toHaveLength(1);
    expect(result.files).toHaveLength(0);
  });

  it('迟到失败不覆盖切换后的目标输入', async function switched() {
    const result = await exercise(function respond() { return Promise.reject(new TypeError('network failed')); }, true);
    expect(result.input).toBe('新输入');
    expect(result.messages).toHaveLength(0);
  });

  it('新任务收到无效 202 确认时恢复草稿并提示先核对', async function newTurnUnconfirmed() {
    const result = await exercise(function respond() { return Promise.resolve(Response.json({}, { status: 202 })); }, false, true);
    expect(result.input).toBe('看图\n新输入');
    expect(result.files.map(function name(file) { return file.name; })).toEqual(['a.png']);
    expect(JSON.stringify(notice.warning.mock.calls)).toMatch(/未确认.*检查会话记录/);
    expect(JSON.stringify(result.messages)).not.toContain('分析失败');
  });

  it('新任务有效确认迟到时不写入切换后的等待状态', async function lateValidConfirmation() {
    const result = await exercise(function respond() { return Promise.resolve(Response.json({ inputId: 'old-input', delivery: 'queue', status: 'pending' }, { status: 202 })); }, true, true);
    expect(result.pendingInputs).toHaveLength(0);
    expect(result.input).toBe('新输入');
  });
  it('新任务确认迟到时不覆盖切换后的目标', async function newTurnSwitched() {
    const result = await exercise(function respond() { return Promise.resolve(Response.json({}, { status: 202 })); }, true, true);
    expect(result.input).toBe('新输入');
    expect(JSON.stringify(result.messages)).not.toContain('提交状态未确认');
    expect(notice.warning).not.toHaveBeenCalled();
  });

  it.each([
    ['有效 202', function confirmed() { return Promise.resolve(Response.json({ inputId: 'old-input', delivery: 'queue', status: 'pending' }, { status: 202 })); }],
    ['无效 202', function invalid() { return Promise.resolve(Response.json({}, { status: 202 })); }],
    ['明确拒绝', function rejected() { return Promise.resolve(Response.json({ error: '拒绝' }, { status: 400 })); }],
    ['成功流', function stream() { return Promise.resolve(new Response('data: example\n\n', { status: 200 })); }],
    ['网络异常', function network() { return Promise.reject(new TypeError('network failed')); }],
  ])('目标切换后迟到%s不能回写或清理新目标', async function lateResponse(_label, respond) {
    const result = await exercise(respond, true, true);
    expect(result.input).toBe('新输入');
    expect(result.pendingInputs).toHaveLength(0);
    expect(result.options.setLoading.mock.calls).toEqual([[true]]);
    expect(result.options.setStreamingMessageId.mock.calls).toHaveLength(1);
    expect(result.options.clearActiveTurn).not.toHaveBeenCalled();
    expect(result.options.loadHistory).not.toHaveBeenCalled();
    expect(result.options.consumeAgentStream).not.toHaveBeenCalled();
    expect(result.options.setTransportState).not.toHaveBeenCalled();
  });

  it('同一会话新执行代次认领后旧确认不得回写', async function newerExecution() {
    const result = await exercise(function respond() { return Promise.resolve(Response.json({ inputId: 'old-input', delivery: 'queue', status: 'pending' }, { status: 202 })); }, false, true, true);
    expect(result.pendingInputs).toHaveLength(0);
    expect(result.options.setLoading.mock.calls).toEqual([[true]]);
    expect(result.options.clearActiveTurn).not.toHaveBeenCalled();
  });

  it.each([202, 400])('读取 %s 响应体时切换目标不得回写', async function bodySwitch(status) {
    const result = await exercise(async function respond(options) {
      const response = Response.json(status === 202 ? { inputId: 'old-input', delivery: 'queue', status: 'pending' } : { error: '拒绝' }, { status });
      const read = response.json.bind(response);
      response.json = async function parse() { const value = await read(); options.currentSessionIdRef.current = 'other'; return value; };
      return response;
    }, false, true);
    expect(result.pendingInputs).toHaveLength(0);
    expect(result.options.setLoading.mock.calls).toEqual([[true]]);
    expect(result.options.clearActiveTurn).not.toHaveBeenCalled();
    expect(result.options.loadHistory).not.toHaveBeenCalled();
  });

  it('当前会话有效新任务确认仍会登记', async function currentConfirmation() {
    const result = await exercise(function respond() { return Promise.resolve(Response.json({ inputId: 'new-input', delivery: 'queue', status: 'pending' }, { status: 202 })); }, false, true);
    expect(result.pendingInputs.map(function id(item) { return item.inputId; })).toEqual(['new-input']);
    expect(result.options.loadHistory).toHaveBeenCalledWith('session');
  });

  it('当前会话成功流仍会消费', async function currentStream() {
    const result = await exercise(function respond() { return Promise.resolve(new Response('data: example\n\n', { status: 200 })); }, false, true);
    expect(result.options.consumeAgentStream).toHaveBeenCalledOnce();
    expect(result.options.loadHistory).toHaveBeenCalledWith('session');
  });

  it('流消费期间切换目标后旧收尾不清理新目标', async function streamSwitch() {
    const result = await exercise(function respond() { return Promise.resolve(new Response('data: example\n\n', { status: 200 })); }, false, true, false, true);
    expect(result.options.consumeAgentStream).toHaveBeenCalledOnce();
    expect(result.options.loadHistory).not.toHaveBeenCalled();
    expect(result.options.clearActiveTurn).not.toHaveBeenCalled();
    expect(result.options.setLoading.mock.calls).toEqual([[true]]);
  });
});

