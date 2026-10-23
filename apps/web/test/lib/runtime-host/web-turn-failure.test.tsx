/** 失败反馈回归：启动前异常经 SSE 与持久消息进入同一可访问提示，不泄露错误原文。 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRuntime, Session } from "@autopilot-agent/core";
import { createPresentationState } from "@autopilot-agent/presentation";
import { createRuntimeAgentStream } from "@/lib/runtime-host/web-agent-stream";
import { getLegacyTurnFailure, isWebTurnFailure, toWebTurnFailure } from "@/lib/runtime-host/web-turn-failure";
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

  it("沙箱不可用按结构化类别提示，且不引导模型配置（H1）", function showsSandboxFailure() {
    const failure = toWebTurnFailure("沙箱不可用，无法提供已隔离执行，本次任务已停止，不会无沙箱直接执行。", "SANDBOX_UNAVAILABLE");
    expect(failure.code).toBe("SANDBOX_UNAVAILABLE");
    const markup = renderFailure(failure);
    expect(markup).toContain("本机沙箱不可用，命令未执行");
    expect(markup).toContain("这不是模型配置问题");
    expect(markup).not.toContain("前往配置");
    // History 回收已持久 DTO 时按 DTO 识别，不二次分类降级。
    expect(isWebTurnFailure(failure)).toBe(true);
    expect(isWebTurnFailure(new Error("PRIVATE_SECRET_AND_PATH"))).toBe(false);
  });

  it("未登记的 errorCode 不参与分类，通用失败也不指向配置页（H1）", function ignoresUnregisteredCode() {
    const failure = toWebTurnFailure(new Error("PRIVATE_INTERNAL_DETAIL"), "PRIVATE_INTERNAL_CODE");
    expect(failure.code).toBe("TURN_EXECUTION_FAILED");
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_INTERNAL_DETAIL");
    expect(renderFailure(failure)).not.toContain("前往配置");
  });

  it("沙箱失败经 SSE 与持久消息得到同一分类（H1）", async function streamsSandboxFailure() {
    let session: Session = { id: "sandbox-session", status: "idle", persistenceMode: "durable", createdAt: 1, updatedAt: 1 };
    const runtime = {
      sessions: {
        async get() { return structuredClone(session); },
        async save(value: Session) { session = structuredClone(value); },
      },
      turns: {
        async *start() {
          yield {
            type: "turn_failed",
            turnId: "sandbox-turn",
            error: "沙箱不可用，无法提供已隔离执行，本次任务已停止，不会无沙箱直接执行。",
            errorCode: "SANDBOX_UNAVAILABLE",
            checkpoint: { turnId: "sandbox-turn", status: "failed", stepCount: 1, messages: [], completedCallIds: [] },
          };
        },
      },
    } as unknown as AgentRuntime;
    const stream = createRuntimeAgentStream({ runtime, sessionId: session.id, turnId: "sandbox-turn", mode: "start", content: "把计算器做成页面", requestSignal: new AbortController().signal });
    const text = await new Response(stream).text();
    const failureEvent = JSON.parse(text.split("\n\n")[0].slice(6));
    expect(failureEvent.type).toBe("turn_failed");
    expect(failureEvent.failure.code).toBe("SANDBOX_UNAVAILABLE");
    const history = await getSessionMessages(runtime, session.id);
    expect(history[0].failure).toEqual(failureEvent.failure);
    for (const failure of [failureEvent.failure, history[0].failure]) {
      const markup = renderFailure(failure);
      expect(markup).toContain("本机沙箱不可用，命令未执行");
      expect(markup).not.toContain("前往配置");
    }
  });
});
