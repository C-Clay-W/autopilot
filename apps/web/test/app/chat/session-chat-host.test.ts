/** 临时会话壳回归测试：新建对话必须保留空白 Chat，不得因旧临时身份隐藏。 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isProvisionalSessionSelected, resolveProvisionalSessionView, shouldReleaseProvisionalTransition } from "@/app/chat/session-chat-host";
import { mergeHistoryIntoChatMessages, type RealtimeChatMessage } from "@/app/chat/chat-message-state";

const chatSessionHostSource = readFileSync(path.resolve(__dirname, "../../../app/chat/chat-session-host.tsx"), "utf8");
const chatPageContentSource = readFileSync(path.resolve(__dirname, "../../../app/chat/chat-page-content.tsx"), "utf8");
const chatMessageListSource = readFileSync(path.resolve(__dirname, "../../../app/chat/components/ChatMessageList.tsx"), "utf8");
const chatComposerSource = readFileSync(path.resolve(__dirname, "../../../app/chat/components/ChatComposer.tsx"), "utf8");
const chatMessageItemSource = readFileSync(path.resolve(__dirname, "../../../app/chat/components/ChatMessageItem.tsx"), "utf8");
const sessionConversationSource = readFileSync(path.resolve(__dirname, "../../../app/chat/hooks/useSessionConversation.ts"), "utf8");

describe("resolveProvisionalSessionView", function provisionalSessionViewSuite() {
  it("已有临时会话时点击新建仍显示空白草稿", function keepsBlankDraftVisible() {
    expect(resolveProvisionalSessionView({ workspaceId: "workspace-a", sessionId: "session-a" }, "workspace-a", ""))
      .toEqual({ visible: true, sessionId: "" });
  });

  it("选择临时会话本身时绑定其 Session", function bindsMatchingProvisionalSession() {
    expect(resolveProvisionalSessionView({ workspaceId: "workspace-a", sessionId: "session-a" }, "workspace-a", "session-a"))
      .toEqual({ visible: true, sessionId: "session-a" });
  });

  it("临时会话按复合身份保持独立选中状态", function matchesWorkspaceAndSessionIdentity() {
    expect(isProvisionalSessionSelected({ workspaceId: "workspace-a", sessionId: "session-a" }, "workspace-a", "session-a")).toBe(true);
    expect(isProvisionalSessionSelected({ workspaceId: "workspace-a", sessionId: "session-a" }, "workspace-b", "session-a")).toBe(false);
  });

  it("选择其他会话时隐藏临时实例", function hidesWhenAnotherSessionIsSelected() {
    expect(resolveProvisionalSessionView({ workspaceId: "workspace-a", sessionId: "session-a" }, "workspace-a", "session-b"))
      .toEqual({ visible: false, sessionId: "" });
  });

  it("首次发送复用草稿槽位，避免创建 Session 后卸载实时流", function keepsFirstTurnMounted() {
    expect(chatSessionHostSource).toContain("key={`draft:${item.slotId}`}");
    expect(chatSessionHostSource).toContain("sessionId={item.sessionId}");
    expect(chatSessionHostSource).toContain("draftSlotsRef.current = nextDraftSlots;");
    expect(chatSessionHostSource).toContain("draftTransitionRef.current = nextSlot;");
    expect(sessionConversationSource).toContain("if (sessionId && locallyCreatedSessionRef.current === sessionId) return;");
    expect(chatSessionHostSource).not.toContain("key={`provisional:${key}`}");
  });

  it("URL 尚未确认新 Session 时不释放首发过渡槽", function waitsForCreatedSessionSelection() {
    const transition = { workspaceId: "workspace-a", sessionId: "session-a" };
    expect(shouldReleaseProvisionalTransition(transition, "workspace-a", "")).toBe(false);
    expect(shouldReleaseProvisionalTransition(transition, "workspace-a", "session-b")).toBe(false);
    expect(shouldReleaseProvisionalTransition(transition, "workspace-a", "session-a")).toBe(true);
  });

  it("Agent 与附件上传分别使用准确的活动反馈", function usesSpecificActivityFeedback() {
    expect(chatPageContentSource).not.toContain("ThinkingIndicator");
    expect(chatMessageListSource).toContain('submissionActivity === "upload"');
    expect(chatMessageListSource).toContain("? isChat && currentRetrieval === \"rag\"");
    expect(chatMessageListSource).toContain('<KnowledgeIngestProgress steps={knowledgeProgress.length ? knowledgeProgress : [{ stage: "upload", message: "正在准备上传文件" }]} />');
    expect(chatMessageListSource).toContain(": <ActivityIndicator running />");
    expect(chatComposerSource).toContain('submissionActivity === "upload" ? "正在上传附件" : "任务正在启动"');
    expect(chatMessageItemSource).toContain('msg.activity === "answer" && !msg.turnId');
    expect(chatPageContentSource).not.toContain("正在创建会话并启动任务");
    expect(chatMessageItemSource).toContain('msg.activity === "ingest" && !msg.turnId && <KnowledgeIngestProgress');
    expect(chatPageContentSource).toContain("activity={activity}");
  });

  it("只有真实可恢复的 Agent Turn 才显示继续执行", function onlyShowsContinueForRecoverableTurn() {
    expect(sessionConversationSource).toContain("canContinue: Boolean(m.turnId && recoverableTurnId && m.turnId === recoverableTurnId)");
    expect(sessionConversationSource).not.toContain("canContinue: m.turnId === recoverableTurnId");
  });

  it("较旧 History 不覆盖尚未持久化的首发实时回答", function keepsRealtimeAnswerVisible() {
    const current: RealtimeChatMessage[] = [
      { id: "u-local", role: "user" as const, content: "首发", optimistic: true },
      { id: "a-local", role: "assistant" as const, content: "", turnId: "turn-1", optimistic: true },
    ];
    const staleHistory: RealtimeChatMessage[] = [{ id: "u-server", role: "user", content: "首发" }];
    expect(mergeHistoryIntoChatMessages(current, staleHistory)).toEqual([
      staleHistory[0],
      current[1],
    ]);
  });

  it("History 已包含回答时替换乐观副本而不重复渲染", function replacesPersistedRealtimeCopy() {
    const current: RealtimeChatMessage[] = [{ id: "a-local", role: "assistant", content: "", turnId: "turn-1", optimistic: true }];
    const history: RealtimeChatMessage[] = [{ id: "a-server", role: "assistant", content: "OK", turnId: "turn-1" }];
    expect(mergeHistoryIntoChatMessages(current, history)).toEqual(history);
  });

  /** 重复问题不能与已经展示的旧消息匹配并改写旧时间。 */
  it("重复发送同文问题时旧记录不吞掉新问题或改变顺序", function preservesRepeatedQuestionOrder() {
    const old: RealtimeChatMessage = { id: "old-question", role: "user", content: "同一个问题", createdAt: 10 };
    const oldAnswer: RealtimeChatMessage = { id: "old-answer", role: "assistant", content: "旧回答", createdAt: 20 };
    const pending: RealtimeChatMessage = { id: "pending-question", role: "user", content: "同一个问题", createdAt: 30, optimistic: true };
    const current = [old, oldAnswer, pending];
    expect(mergeHistoryIntoChatMessages(current, [old, oldAnswer])).toEqual(current);
    const history: RealtimeChatMessage[] = [old, oldAnswer, { id: "new-question", role: "user", content: "同一个问题", createdAt: 31 }, { id: "new-answer", role: "assistant", content: "新回答", createdAt: 40 }];
    expect(mergeHistoryIntoChatMessages(current, history).map(function id(message) { return message.id; })).toEqual(["old-question", "old-answer", "new-question", "new-answer"]);
  });

  it("未持久化的上传消息按真实时间保留在后续问答之前", function keepsUploadBeforeLaterHistory() {
    const current: RealtimeChatMessage[] = [
      { id: "upload", role: "user", content: "", optimistic: true, createdAt: 10 },
      { id: "ingest", role: "assistant", content: "", optimistic: true, createdAt: 11 },
    ];
    const history: RealtimeChatMessage[] = [
      { id: "question", role: "user", content: "给我张三的信息", createdAt: 20 },
      { id: "answer", role: "assistant", content: "张三的信息", createdAt: 30 },
    ];
    expect(mergeHistoryIntoChatMessages(current, history).map(function readId(message) { return message.id; })).toEqual(["upload", "ingest", "question", "answer"]);
  });

  it("用稳定记录身份替换已持久化的上传和结果卡片", function replacesPersistedKnowledgeCards() {
    const current: RealtimeChatMessage[] = [
      { id: "upload-local", role: "user", content: "", optimistic: true, clientRecordId: "knowledge-1", createdAt: 10 },
      { id: "ingest-local", role: "assistant", content: "", optimistic: true, clientRecordId: "knowledge-1", createdAt: 11 },
    ];
    const history: RealtimeChatMessage[] = [
      { id: "upload-server", role: "user", content: "", clientRecordId: "knowledge-1", createdAt: 20 },
      { id: "ingest-server", role: "assistant", content: "", clientRecordId: "knowledge-1", createdAt: 30 },
    ];

    expect(mergeHistoryIntoChatMessages(current, history).map(function readId(message) { return message.id; }))
      .toEqual(["upload-server", "ingest-server"]);
  });
});
