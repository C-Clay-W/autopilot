/** 本任务 Web 回归：连续 History 稳定消息位置、同轮分段与受控流程图真实 SSR。 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getTurnPresentationMessageIds, mergeHistoryIntoChatMessages, type RealtimeChatMessage } from "@/app/chat/chat-message-state";
import { uiRegistry } from "@/app/chat/components/interactive-ui/registry";
import Flowchart from "@/app/chat/components/interactive-ui/components/Flowchart";

/** 只读出用户可见顺序，避免把对象字段是否改动当成行为测试。 */
function ids(messages: RealtimeChatMessage[]) { return messages.map(function id(message) { return message.id; }); }

describe("manual Web history and flow", function suite() {
  it("重复 History 不把已确认 user 时间替换到 assistant 之后", function repeatedMerge() {
    const user: RealtimeChatMessage = { id: "local", role: "user", content: "prompt", createdAt: 10, optimistic: true };
    const answer: RealtimeChatMessage = { id: "live", role: "assistant", content: "answer", createdAt: 20, turnId: "t", optimistic: true };
    const history: RealtimeChatMessage[] = [{ id: "stored", role: "user", content: "prompt", createdAt: 210, turnId: "t" }];
    const once = mergeHistoryIntoChatMessages([user, answer], history);
    const twice = mergeHistoryIntoChatMessages(once, history);
    expect(ids(twice)).toEqual(["stored", "live"]);
    expect(twice[0].createdAt).toBe(10);
    expect(ids(mergeHistoryIntoChatMessages(twice, history))).toEqual(["stored", "live"]);
  });

  it("恢复/后台合成容器在本轮 Prompt 之后且真实分段只挂一个 Presentation", function turnAnchors() {
    const messages: RealtimeChatMessage[] = [{ id: "user", role: "user", turnId: "t", content: "run", createdAt: 210 }, { id: "agent-turn-t", role: "assistant", turnId: "t", content: "", createdAt: 20 }];
    expect(ids(mergeHistoryIntoChatMessages([], messages))).toEqual(["user", "agent-turn-t"]);
    const real: RealtimeChatMessage[] = [messages[0], { id: "segment-1", role: "assistant", turnId: "t", content: "part one", createdAt: 220 }, { id: "segment-2", role: "assistant", turnId: "t", content: "part two", createdAt: 230 }];
    const merged = mergeHistoryIntoChatMessages(messages, real);
    expect(ids(merged)).toEqual(["user", "segment-1", "segment-2"]);
    expect([...getTurnPresentationMessageIds(merged)]).toEqual(["segment-1"]);
    expect(ids(mergeHistoryIntoChatMessages(merged, [messages[0], messages[1]]))).toEqual(["user", "segment-1", "segment-2"]);
  });

  it("Flowchart registry 渲染方向/分支/回路及文字等价，不解释 HTML", function flowRenderer() {
    expect(uiRegistry.Flowchart).toBe(Flowchart);
    for (const direction of ["TB", "LR"]) {
      const markup = renderToStaticMarkup(createElement(Flowchart, { element: { type: "Flowchart", props: { direction, description: "检查后决定完成或重试", nodes: [{ id: "start", label: "<script>开始</script>", kind: "terminal" }, { id: "check", label: "是否通过？", kind: "decision" }, { id: "end", label: "完成" }], edges: [{ id: "next", from: "start", to: "check" }, { id: "yes", from: "check", to: "end", label: "是" }, { id: "no", from: "check", to: "start", label: "否" }] } } } as any));
      expect(markup).toContain('<svg');
      expect(markup).toContain('marker-end=');
      expect(markup).toContain('是否通过？');
      expect(markup).toContain('节点与连线文字说明');
      expect(markup).toContain('→');
      expect(markup).toContain('：否');
      expect(markup).not.toContain('<script>');
    }
  });
});
