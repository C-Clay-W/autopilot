/** S3续聊定向测试：真实React Hook、固定快照、唯一发送链与网络状态校准。 */
import { createElement, type SetStateAction } from "react";
import { render } from "ink-testing-library";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPresentationState } from "@autopilot-agent/presentation";
import { useConversationSubmission } from "@/app/chat/hooks/useConversationSubmission";
import { buildContinueChatContent, canContinueUi } from "@/app/chat/components/interactive-ui/continue-chat";
import { createSavingsFixture } from "../../../../../packages/presentation/test/interactive-ui.fixture";
import type { Message } from "@/app/chat/chat-page-types";
import InteractiveUIBlock from "@/app/chat/components/interactive-ui/InteractiveUIBlock";

const context = vi.hoisted(function contexts() { return { manager: { beginSession: vi.fn() }, refreshSessions: vi.fn() }; });
vi.mock("@/app/chat/session-task-context", function mockContext() { return { useSessionTaskContext: function readContext() { return context; } }; });
vi.mock("@/app/chat/components/Notice", function mockNotice() { return { useNotice: function notice() { return { warning: vi.fn(), error: vi.fn(), success: vi.fn() }; } }; });

/** 用已有Ink renderer运行真实Hook，不模拟React生命周期。 */
function mountSubmission(options: Parameters<typeof useConversationSubmission>[0]) {
  let current!: ReturnType<typeof useConversationSubmission>;
  /** 仅挂载Hook，不渲染DOM。 */
  function Probe(props: typeof options) { current = useConversationSubmission(props); return null; }
  const mounted = render(createElement(Probe, options));
  return { get current() { return current; }, rerender(next: typeof options) { mounted.rerender(createElement(Probe, next)); }, unmount: mounted.unmount };
}
/** 等待真实React状态提交。 */
async function frame() { await new Promise<void>(function next(resolve) { setTimeout(resolve, 25); }); }

/** 每个测试独立的实例、消息与受控网络端口。 */
function fixture(retrievalMode: "none" | "web" = "none") {
  const document = createSavingsFixture();
  const target = { sessionId: "session", turnId: "old-turn", uiId: document.uiId };
  let messages: Message[] = [];
  const disconnected = { current: false };
  const loadHistory = vi.fn(async function history() { return false; });
  const options = {
    isChat: true, active: true, workspaceId: "@chat", sessionId: "session", hasWorkspace: true, canWrite: true, currentRetrieval: retrievalMode, loading: false, activeTurnId: "", messages: [],
    presentation: { ...createPresentationState(), items: [{ id: "ui", kind: "ui_document", ...target, title: document.title, fallbackText: document.fallbackText, document }] },
    currentSessionIdRef: { current: "session" }, currentWorkspaceIdRef: { current: "@chat" },
    activeTurnRef: { current: null }, cancelInFlightRef: { current: null }, cancelRequestedRef: { current: false },
    requestAbortRef: { current: null }, locallyCreatedSessionRef: { current: null }, executionEpochRef: { current: 0 },
    awaitingUserInputRef: { current: false }, awaitingApprovalRef: { current: false }, transportDisconnectedRef: disconnected,
    queuedFollowUpTurnIdRef: { current: null }, selectedSkills: [], databaseEnabled: false,
    inputRef: { current: "保留输入草稿" }, inputActionsRef: { current: null }, textareaRef: { current: null },
    setMessages: function set(next: SetStateAction<Message[]>) { messages = typeof next === "function" ? next(messages) : next; },
    setLoading: vi.fn(), setActivity: vi.fn(), setStreamingMessageId: vi.fn(), clearActiveTurn: vi.fn(),
    setSelectedSkills: vi.fn(), setPinnedSkills: vi.fn(), loadHistory,
    setTransportState: vi.fn(function transport(state) { disconnected.current = state === "disconnected"; }),
    consumeAgentStream: vi.fn(async function stream() { return "terminal"; }),
    getSessionController: function controller() { return { createAbortController: function abort() { return new AbortController(); } }; },
  } as unknown as Parameters<typeof useConversationSubmission>[0];
  return { document, target, options, loadHistory, get messages() { return messages; } };
}

describe("S3 UI explicit continuation", function suite() {
  beforeEach(function setup() { vi.stubGlobal("window", { setTimeout }); vi.spyOn(console, "log").mockImplementation(function quiet() {}); });
  afterEach(function cleanup() { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("块按当前续聊边界启用按钮，生成中禁用仍保留本地参数", function button() {
    const f = fixture(); const item = f.options.presentation.items[0] as Extract<typeof f.options.presentation.items[number], { kind: "ui_document" }>;
    const action = { disabled: false, onContinue: async function send() {} };
    const enabled = renderToStaticMarkup(createElement(InteractiveUIBlock, { item, continuation: action }));
    expect(enabled).toMatch(/<button(?![^>]*\sdisabled(?:=|\s|>))[^>]*>按当前参数继续分析/);
    const disabled = renderToStaticMarkup(createElement(InteractiveUIBlock, { item, continuation: { ...action, disabled: true } }));
    expect(disabled).toMatch(/<button[^>]*disabled=""[^>]*>按当前参数继续分析/);
    expect(disabled).toContain('value="1000"');
  });

  it("固定模板仅包含选中字段的当前值，文档初值不变并拒绝隐藏字段", function snapshot() {
    const document = createSavingsFixture();
    const fields = [{ label: "本金", statePath: "principal" }];
    const content = buildContinueChatContent(document, fields, { ...document.spec.state, principal: 2000 });
    expect(content).toBe('界面："储蓄增长探索"\n当前参数：\n"本金"=2000\n请基于以上选择继续分析。');
    expect(content).not.toContain("view");
    expect(document.spec.state!.principal).toBe(1000);
    expect(function hidden() { buildContinueChatContent(document, [{ label: "隐藏", statePath: "missing" }], document.spec.state!); }).toThrow();
    const current = { sessionId: "s", isChat: true, retrieval: "none", active: true, canWrite: true, loading: false, stopping: false, disconnected: false };
    const target = { sessionId: "s", turnId: "t", uiId: document.uiId };
    expect(canContinueUi(target, current)).toBe(true);
    expect(canContinueUi(target, { ...current, retrieval: "web" })).toBe(true);
    for (const blocked of [{ active: false }, { canWrite: false }, { loading: true }, { activeTurnId: "running" }, { disconnected: true }, { stopping: true }, { retrieval: "rag" }, { isChat: false }, { sessionId: "other" }]) expect(canContinueUi(target, { ...current, ...blocked })).toBe(false);
  });

  /** Web UI 显式续聊仍投递到当前会话原有 messages Route，不引入新发送或网络动作。 */
  it("Web模式的当前UI块通过原messages链提交普通续聊文本", async function webContinuation() {
    const f = fixture("web");
    const fetcher = vi.fn(async function complete() { return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }); });
    vi.stubGlobal("fetch", fetcher);
    const hook = mountSubmission(f.options);
    try {
      await frame();
      expect(hook.current.uiContinuation.disabled).toBe(false);
      await hook.current.uiContinuation.onContinue({ ...f.target, content: "按当前参数继续分析" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][0]).toBe("/api/chat/sessions/session/messages");
      expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ content: "按当前参数继续分析", clientMessageId: expect.any(String) });
      expect(f.messages.find(function user(message) { return message.role === "user"; })?.content).toBe("按当前参数继续分析");
    } finally { hook.unmount(); }
  });

  it("双击及与输入框竞态只发一次普通messages，保留草稿与待上传附件", async function once() {
    const f = fixture();
    let release!: (response: Response) => void;
    const fetcher = vi.fn(function request(_input: RequestInfo | URL, _init?: RequestInit) { return new Promise<Response>(function pending(resolve) { release = resolve; }); });
    vi.stubGlobal("fetch", fetcher);
    const hook = mountSubmission(f.options);
    try {
      await frame();
      hook.current.setSelectedFiles([{ name: "pending.txt", size: 1, file: {} as File }]);
      await frame();
      const content = buildContinueChatContent(f.document, [{ label: "本金", statePath: "principal" }], f.document.spec.state!);
      const first = hook.current.uiContinuation.onContinue({ ...f.target, content });
      const second = hook.current.uiContinuation.onContinue({ ...f.target, content });
      const composer = hook.current.handleSend("同时发送");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][0]).toBe("/api/chat/sessions/session/messages");
      expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ content, clientMessageId: expect.any(String) });
      expect(f.messages.find(function user(message) { return message.role === "user"; })?.content).toBe(content);
      release(new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }));
      await Promise.all([first, second, composer]); await frame();
      expect(f.options.inputRef.current).toBe("保留输入草稿");
      expect(hook.current.selectedFiles).toHaveLength(1);
    } finally { hook.unmount(); }
  });

  it("旧回调在切会话、后台、只读或活动Turn状态下不提交", async function stale() {
    const f = fixture(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const hook = mountSubmission(f.options);
    try {
      await frame(); const oldCallback = hook.current.uiContinuation.onContinue;
      await oldCallback({ ...f.target, turnId: "other-turn", content: "固定快照" });
      await oldCallback({ ...f.target, uiId: "other-ui", content: "固定快照" });
      for (const change of [{ active: false }, { canWrite: false }, { loading: true }, { activeTurnId: "running" }, { currentRetrieval: "rag" }, { sessionId: "other" }]) {
        hook.rerender({ ...f.options, ...change }); await frame();
        await oldCallback({ ...f.target, content: "固定快照" });
      }
      expect(fetcher).not.toHaveBeenCalled();
    } finally { hook.unmount(); }
  });

  it("响应丢失只校准History，不自动重发，未知状态期间继续按钮保持阻断", async function unknown() {
    const f = fixture(); const fetcher = vi.fn(async function lost() { throw new TypeError("Failed to fetch"); }); vi.stubGlobal("fetch", fetcher);
    const hook = mountSubmission(f.options);
    try {
      await frame();
      await hook.current.uiContinuation.onContinue({ ...f.target, content: "固定快照" });
      await hook.current.uiContinuation.onContinue({ ...f.target, content: "固定快照" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(f.loadHistory).toHaveBeenCalledWith("session");
      expect(f.options.transportDisconnectedRef.current).toBe(true);
    } finally { hook.unmount(); }
  });

  it("明确拒绝不自动重试，用户再次显式提交才生成新的消息身份", async function failure() {
    const f = fixture(); const fetcher = vi.fn(async function refused(_input: RequestInfo | URL, _init?: RequestInit) { return Response.json({ error: "输入无效" }, { status: 400 }); }); vi.stubGlobal("fetch", fetcher);
    const hook = mountSubmission(f.options);
    try {
      await frame(); await hook.current.uiContinuation.onContinue({ ...f.target, content: "固定快照" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(f.loadHistory).not.toHaveBeenCalled();
      await hook.current.uiContinuation.onContinue({ ...f.target, content: "更新快照" });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetcher.mock.calls[0][1].body as string).clientMessageId).not.toBe(JSON.parse(fetcher.mock.calls[1][1].body as string).clientMessageId);
    } finally { hook.unmount(); }
  });
});
