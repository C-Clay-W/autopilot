/** thread 来源标签契约：只有宿主在真实投递链写入的 Prompt 才有来源，历史与重放一致。 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ChatMessageItem from "@/app/chat/components/ChatMessageItem";
import { createAgentRuntime, createMemoryPorts } from "@autopilot-agent/core";
import type { ModelSampler, RuntimePorts } from "@autopilot-agent/core";
import { getSessionMessages } from "@/lib/session-store";
import { persistUserMessage } from "@/lib/runtime-host/web-message-projection";
import { mapHistoryMessage } from "@/app/chat/history-restore";
import { createWebTurnHost } from "@/lib/workspace-host/web-turn-host";

/** 固定回答的采样器：不触达网络。 */
const sampler: ModelSampler = {
  async sample() { return { content: "完成", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" }; },
};

/** 建立内存 Runtime 与 TurnHost。 */
function setup() {
  const ports: RuntimePorts = createMemoryPorts();
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler: sampler } });
  return { ports, runtime, host: createWebTurnHost({ runtime, ports }) };
}

describe("thread 来源标签", function sourceLabelContract() {
  it("run Prompt 由宿主写入来源，重放与刷新读到同一标签", async function runPromptHasOrigin() {
    const f = setup();
    const session = await f.runtime.sessions.create({ title: "目标" });
    await f.host.recordThreadPrompt({ sessionId: session.id, content: "完整正文与机器字段", fromThreadId: "session-a", messageId: "m-1", handoffDisplay: { title: "标题", instruction: "接续指令", summary: "摘要" } });
    // 同一消息身份重复投影不产生第二个气泡。
    await f.host.recordThreadPrompt({ sessionId: session.id, content: "完整正文与机器字段", fromThreadId: "session-a", messageId: "m-1", handoffDisplay: { title: "标题", instruction: "接续指令", summary: "摘要" } });
    const messages = await getSessionMessages(f.runtime, session.id);
    expect(messages.filter(function prompt(message) { return message.clientRecordId === "thread:m-1"; })).toHaveLength(1);
    const projected = mapHistoryMessage({ ...messages[0]!, type: "message" } as never, undefined, undefined);
    expect(projected.origin).toEqual({ kind: "thread", threadId: "session-a" });
    expect(projected.content).toBe("# Handoff：标题\n\n接续指令");
    expect(projected.handoffDisplay).toEqual({ title: "标题", instruction: "接续指令", summary: "摘要" });
  });

  it("普通人类消息没有来源标签，正文无法伪造", async function humanPromptHasNoOrigin() {
    const f = setup();
    const session = await f.runtime.sessions.create({ title: "普通" });
    await persistUserMessage(f.runtime, session.id, "# Handoff：我自己输入的任务");
    const messages = await getSessionMessages(f.runtime, session.id);
    const projected = mapHistoryMessage({ ...messages[0]!, type: "message" } as never, undefined, undefined);
    expect(projected.origin).toBeUndefined();
    expect(projected.content).toBe("# Handoff：我自己输入的任务");
  });

  it("交接标签在气泡外且摘要默认折叠", function handoffMarkup() {
    const html = renderToStaticMarkup(createElement(ChatMessageItem, {
      msg: { id: "m", role: "user", content: "# Handoff：标题\n\n接续", origin: { kind: "thread", threadId: "private-id" }, handoffDisplay: { title: "标题", instruction: "接续", summary: "摘要内容" } },
      presentation: { items: [] }, isChat: false,
    } as never));
    expect(html).toContain("Sent by Autopilot from another thread");
    expect(html.indexOf("Sent by Autopilot from another thread")).toBeLessThan(html.indexOf("group relative bg-card"));
    expect(html).toContain("<details class=");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("private-id");
  });

  it("steer 消费后的协作输入与普通输入区分来源", async function consumedInputKeepsOrigin() {
    const f = setup();
    const session = await f.runtime.sessions.create({ title: "目标" });
    const threadInput = await f.runtime.inbox.post({
      sessionId: session.id,
      clientMessageId: "cm-thread-2",
      delivery: "queue",
      content: "协作补充",
      origin: { kind: "thread", threadId: "session-b" },
    });
    await f.runtime.inbox.consume({ sessionId: session.id, inputId: threadInput.inputId, turnId: "turn-label" });
    const humanInput = await f.runtime.inbox.post({ sessionId: session.id, clientMessageId: "cm-human-1", delivery: "queue", content: "人类补充" });
    await f.runtime.inbox.consume({ sessionId: session.id, inputId: humanInput.inputId, turnId: "turn-label" });
    for (const [index, inputId] of [threadInput.inputId, humanInput.inputId].entries()) {
      await f.ports.transcriptStore.append(session.id, {
        seq: index + 1,
        sessionId: session.id,
        turnId: "turn-label",
        timestamp: new Date().toISOString(),
        event: { type: "input_consumed", turnId: "turn-label", inputId } as never,
      });
    }
    await f.host.recordSettledTurn({ sessionId: session.id, turnId: "turn-label" });
    const messages = await getSessionMessages(f.runtime, session.id);
    const threadBubble = messages.find(function bubble(message) { return message.clientRecordId === `input:${threadInput.inputId}`; });
    expect(threadBubble?.origin).toEqual({ kind: "thread", threadId: "session-b" });
    const humanBubble = messages.find(function bubble(message) { return message.clientRecordId === `input:${humanInput.inputId}`; });
    expect(humanBubble?.origin).toBeUndefined();
  });
});
