/** 失败反馈回归：启动前异常经 SSE 与持久消息进入同一可访问提示，不泄露错误原文。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRuntime, Session } from "@autopilot-agent/core";
import { createPresentationState } from "@autopilot-agent/presentation";
import { createRuntimeAgentStream } from "@/lib/runtime-host/web-agent-stream";
import { encodeSseStream } from "@/lib/runtime-host/web-event-sse-adapter";
import { getLegacyTurnFailure, isWebTurnFailure, normalizePersistedWebTurnFailure, toWebTurnFailure } from "@/lib/runtime-host/web-turn-failure";
import { getSessionMessages } from "@/lib/session-store";
import { clearWebPerformanceDiagnostics, readWebPerformanceDiagnostics, recordWebTurnFailureDiagnostic } from "@/lib/runtime-host/web-performance-diagnostics";
import TurnPresentation from "@/app/chat/components/TurnPresentation";

interface DiagnosticSwitch {
  __AUTOPILOT_PERF_DIAGNOSTICS__?: boolean;
}

const diagnosticSwitch = globalThis as typeof globalThis & DiagnosticSwitch;

/** 通过实际组件渲染失败 DTO，覆盖带 turnId 且没有 Presentation 事件的截图场景。 */
function renderFailure(failure: ReturnType<typeof toWebTurnFailure>) {
  return renderToStaticMarkup(<TurnPresentation state={createPresentationState()} turnId="failed-turn" showThinking={false} failure={failure} onApprovalDecision={function ignoreApproval() {}} onUserQuestionSubmit={async function ignoreAnswer() {}} onUserQuestionCancel={function ignoreCancel() {}} />);
}

describe("web turn failure", function suite() {
  afterEach(function clearFailureDiagnostics() {
    clearWebPerformanceDiagnostics();
    diagnosticSwitch.__AUTOPILOT_PERF_DIAGNOSTICS__ = false;
    vi.restoreAllMocks();
  });

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
    expect(failureEvent.feedbackId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(failureEvent.failure.diagnostic.stage).toBe("web_stream");
    const history = await getSessionMessages(runtime, session.id);
    expect(history[0].failure).toEqual(failureEvent.failure);
    expect(text).not.toContain("PRIVATE_SECRET_AND_PATH");
    expect(JSON.stringify(history)).not.toContain("PRIVATE_SECRET_AND_PATH");
    for (const failure of [failureEvent.failure, history[0].failure]) {
      const markup = renderFailure(failure);
      expect(markup).toContain('role="alert"');
      expect(markup).toContain("需要配置主模型 API Key");
      expect(markup).toContain("前往配置");
      expect(markup).toContain(`反馈 ID：<code>${failureEvent.feedbackId}</code>`);
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

  it("按白名单重建旧 Provider failure 并保留有效 ID、阶段和 HTTP 状态", function normalizesLegacyProviderFailureDto() {
    const feedbackId = "123e4567-e89b-42d3-a456-426614174000";
    const fallbackFeedbackId = "223e4567-e89b-42d3-a456-426614174000";
    const legacyFailure = {
      code: "TURN_EXECUTION_FAILED",
      message: "模型服务未能接受本次请求。请稍后重试；如果持续失败，请提供反馈 ID。",
      feedbackId,
      diagnostic: { code: "PROVIDER_REQUEST_REJECTED", stage: "provider_sampling", providerHttpStatus: 402 },
    };

    expect(isWebTurnFailure(legacyFailure)).toBe(false);
    const normalized = normalizePersistedWebTurnFailure(legacyFailure, fallbackFeedbackId)!;
    expect(normalized).toMatchObject({
      code: "TURN_EXECUTION_FAILED",
      feedbackId,
      diagnostic: { code: "PROVIDER_REQUEST_REJECTED", stage: "provider_sampling", providerHttpStatus: 402 },
    });
    expect(normalized.message).toBe("模型服务未接受本次请求。请检查请求设置或稍后重试；如果持续失败，请提供反馈 ID。");
    expect(normalized.message).not.toBe(legacyFailure.message);
    const migrated = normalizePersistedWebTurnFailure({ ...legacyFailure, diagnostic: { ...legacyFailure.diagnostic, providerFailureProfile: "deepseek_official" } }, fallbackFeedbackId)!;
    expect(migrated).toMatchObject({ feedbackId, diagnostic: { stage: "provider_sampling", providerHttpStatus: 402, providerFailureReason: "billing_insufficient" } });
    expect(migrated.message).toContain("模型服务账户余额不足");
    expect(migrated.diagnostic).not.toHaveProperty("providerFailureProfile");
    expect(isWebTurnFailure(migrated)).toBe(true);
    const unsafe = toWebTurnFailure("sk-secret", "PROVIDER_REQUEST_REJECTED", { providerFailureReason: { toString() { return "billing_insufficient"; } } });
    expect(unsafe.diagnostic).not.toHaveProperty("providerFailureReason");
    expect(JSON.stringify(unsafe)).not.toContain("sk-secret");

    for (const priorFeedbackId of ["invalid-id", undefined]) {
      const fallback = normalizePersistedWebTurnFailure({ ...legacyFailure, feedbackId: priorFeedbackId }, fallbackFeedbackId)!;
      expect(fallback.feedbackId).toBe(fallbackFeedbackId);
    }
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

  it("Core 失败的 ID、类别、阶段和状态码在 SSE、持久消息与历史卡片中一致", async function keepsCoreFailureCorrelation() {
    const feedbackId = "123e4567-e89b-42d3-a456-426614174000";
    let session: Session = { id: "provider-session", status: "idle", persistenceMode: "durable", createdAt: 1, updatedAt: 1 };
    const runtime = {
      sessions: {
        async get() { return structuredClone(session); },
        async save(value: Session) { session = structuredClone(value); },
      },
      turns: {
        async *start() {
          yield {
            type: "turn_failed",
            turnId: "provider-turn",
            error: "raw response sk-provider-secret /private/provider/request",
            errorCode: "PROVIDER_REQUEST_REJECTED",
            failureStage: "provider_sampling",
            feedbackId,
            providerHttpStatus: 402,
            providerFailureReason: "billing_insufficient",
            providerFailureDetail: "code:capacity_exhausted",
            checkpoint: { turnId: "provider-turn", status: "failed", stepCount: 0, messages: [], completedCallIds: [] },
          };
        },
      },
    } as unknown as AgentRuntime;
    const stream = createRuntimeAgentStream({ runtime, sessionId: session.id, turnId: "provider-turn", mode: "start", content: "synthetic request", requestSignal: new AbortController().signal });
    const text = await new Response(stream).text();
    const failureEvent = JSON.parse(text.split("\n\n")[0].slice(6));
    const history = await getSessionMessages(runtime, session.id);

    expect(failureEvent.feedbackId).toBe(feedbackId);
    expect(failureEvent.failure).toEqual(history[0].failure);
    expect(failureEvent.failure).toMatchObject({
      code: "TURN_EXECUTION_FAILED",
      diagnostic: { code: "PROVIDER_REQUEST_REJECTED", stage: "provider_sampling", providerHttpStatus: 402, providerFailureReason: "billing_insufficient" },
    });
    expect(failureEvent.providerFailureReason).toBe("billing_insufficient");
    expect(failureEvent.failure.diagnostic.providerFailureDetail).toBe("code:capacity_exhausted");
    expect(normalizePersistedWebTurnFailure(failureEvent.failure, feedbackId)?.diagnostic.providerFailureDetail).toBe("code:capacity_exhausted");
    expect(renderFailure(history[0].failure)).toContain("code:capacity_exhausted");
    expect(toWebTurnFailure(undefined, "PROVIDER_REQUEST_REJECTED", { providerFailureDetail: "code:sk-secret" }).diagnostic.providerFailureDetail).toBeUndefined();
    expect(failureEvent.failure.message).toContain("模型服务账户余额不足");
    expect(failureEvent.error).toBeUndefined();
    expect(text).not.toContain("deepseek_official");
    expect(text).not.toContain("providerFailureProfile");
    expect(text).not.toContain("sk-provider-secret");
    expect(text).not.toContain("/private/provider/request");
    expect(JSON.stringify(history)).not.toContain("raw response");
    expect(renderFailure(history[0].failure)).toContain("HTTP 状态：402");
    expect(renderFailure(history[0].failure)).toContain(`反馈 ID：<code>${feedbackId}</code>`);

    const unconfirmed402 = toWebTurnFailure("raw response", "PROVIDER_REQUEST_REJECTED", { providerHttpStatus: 402 });
    expect(unconfirmed402.message).toContain("模型服务未接受本次请求");
    expect(unconfirmed402.diagnostic).not.toHaveProperty("providerFailureReason");
    expect(isWebTurnFailure(unconfirmed402)).toBe(true);
    expect(renderFailure(unconfirmed402)).toContain("HTTP 状态：402");
  });

  it("SSE 编码异常出口也生成反馈 ID 并隐藏底层异常", async function addsFeedbackToSseAdapterFailure() {
    diagnosticSwitch.__AUTOPILOT_PERF_DIAGNOSTICS__ = false;
    const logFailure = vi.spyOn(console, "error").mockImplementation(function ignoreSafeFailureLog() {});
    async function* failedLines(): AsyncGenerator<string> {
      throw new Error("raw response sk-sse-secret /private/sse/path");
      yield "";
    }
    const text = await new Response(encodeSseStream(failedLines())).text();
    const failureEvent = JSON.parse(text.split("\n\n")[0].slice(6));

    expect(failureEvent.type).toBe("turn_failed");
    expect(failureEvent.feedbackId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(failureEvent.failure.diagnostic.stage).toBe("web_stream");
    expect(text).not.toContain("sk-sse-secret");
    expect(text).not.toContain("/private/sse/path");
    expect(readWebPerformanceDiagnostics().filter((record) => record.point === "turn_failure")).toHaveLength(0);
    expect(logFailure).toHaveBeenCalledWith("[autopilot-web] turn failure diagnostic", {
      feedbackId: failureEvent.feedbackId,
      diagnosticCode: "WEB_STREAM_FAILED",
      failureStage: "web_stream",
    });

    diagnosticSwitch.__AUTOPILOT_PERF_DIAGNOSTICS__ = true;
    recordWebTurnFailureDiagnostic(failureEvent.failure);
    const diagnostic = readWebPerformanceDiagnostics().find((record) => record.point === "turn_failure");
    expect(diagnostic).toMatchObject({
      feedbackId: failureEvent.feedbackId,
      diagnosticCode: "WEB_STREAM_FAILED",
      failureStage: "web_stream",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("sk-sse-secret");
    expect(JSON.stringify(diagnostic)).not.toContain("/private/sse/path");
    expect(JSON.stringify(logFailure.mock.calls)).not.toContain("sk-sse-secret");
    expect(JSON.stringify(logFailure.mock.calls)).not.toContain("/private/sse/path");
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
