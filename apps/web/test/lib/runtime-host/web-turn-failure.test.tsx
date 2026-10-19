/** 失败反馈回归：启动前异常经 SSE 与持久消息进入同一可访问提示，不泄露错误原文。 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRuntime, Session } from "@autopilot-agent/core";
import { createPresentationState } from "@autopilot-agent/presentation";
import { createRuntimeAgentStream } from "@/lib/runtime-host/web-agent-stream";
import { getLegacyTurnFailure, toWebTurnFailure } from "@/lib/runtime-host/web-turn-failure";
import { getSessionMessages } from "@/lib/session-store";
import TurnPresentation from "@/app/chat/components/TurnPresentation";

/** 通过实际组件渲染失败 DTO，覆盖带 turnId 且没有 Presentation 事件的截图场景。 */
function renderFailure(failure: ReturnType<typeof toWebTurnFailure>) {
  return renderToStaticMarkup(<TurnPresentation state={createPresentationState()} turnId="failed-turn" showThinking={false} failure={failure} onApprovalDecision={function ignoreApproval() {}} onUserQuestionSubmit={async function ignoreAnswer() {}} onUserQuestionCancel={function ignoreCancel() {}} />);
}

describe("web turn failure", function suite() {
  it("启动失败时 Live 与刷新历史都展示配置入口，Host 错误不占 Runtime seq", async function showsMissingCredentials() {
    let session: Session = { id: "failed-session", status: "idle", persistenceMode: "durable", createdAt: 1, updatedAt: 1 };
    const runtime = { sessions: {
      async get() { return structuredClone(session); },
      async save(value: Session) { session = structuredClone(value); },
    }, turns: {
      async *start() { throw Object.assign(new Error("PRIVATE_SECRET_AND_PATH"), { code: "MISSING_CREDENTIAL" }); yield; },
    } } as unknown as AgentRuntime;
    const stream = createRuntimeAgentStream({ runtime, sessionId: session.id, turnId: "failed-turn", mode: "start", content: "你好", requestSignal: new AbortController().signal });
    const text = await new Response(stream).text();
    const failureEvent = JSON.parse(text.split("\n\n")[0].slice(6));
    expect(failureEvent.type).toBe("turn_failed");
    expect(failureEvent.seq).toBeUndefined();
    const history = await getSessionMessages(runtime, session.id);
    expect(history[0].failure).toEqual(failureEvent.failure);
    expect(text).not.toContain("PRIVATE_SECRET_AND_PATH");
    expect(JSON.stringify(history)).not.toContain("PRIVATE_SECRET_AND_PATH");
    for (const failure of [failureEvent.failure, history[0].failure]) {
      const markup = renderFailure(failure);
      expect(markup).toContain('role="alert"');
      expect(markup).toContain("需要配置主模型 API Key");
      expect(markup).toContain("前往配置");
      expect(markup).not.toContain("正在等待");
    }
  });

  it("旧错误精确恢复，正常回答不会误报；未知异常只显示通用提示", function handlesLegacyAndUnknownErrors() {
    expect(renderFailure(getLegacyTurnFailure("指定的 Provider credentialRef 无法解析")!)).toContain("前往配置");
    expect(getLegacyTurnFailure("你的 Key 配置如下")).toBeUndefined();
    const failure = toWebTurnFailure(new Error("sk-fixture-secret /private/user/path"));
    expect(failure.code).toBe("TURN_EXECUTION_FAILED");
    expect(JSON.stringify(failure)).not.toContain("sk-fixture-secret");
  });
});
