/** Web 恢复回归：真实 Runtime 与 HTTP Route 共用工作区实例，保留审批输入和取消控制器。 */
import { describe, expect, it, vi } from "vitest";
import { createAgentRuntime, createMemoryPorts, type AgentEvent, type ModelSampler, type WebCapability } from "@autopilot-agent/core";
import { POST as approve } from "@/app/api/sessions/[id]/approvals/route";
import { POST as continueTurn } from "@/app/api/sessions/[id]/continue/route";
import { POST as cancel } from "@/app/api/sessions/[id]/cancel/route";
import { GET as readSession } from "@/app/api/sessions/[id]/route";
import type { WebCompositionRoot } from "@/lib/composition-root";
import type { WebWorkspaceContext } from "@/lib/workspace-host/web-workspace-host";
import { runWithWorkspaceRequestContext } from "@/lib/workspace-host/web-workspace-session";

/** 消费真实 Core 事件，确保终态后的持久化收尾也执行完成。 */
async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

/** 内存 Port 只模拟存储，Runtime/审批/恢复/HTTP/SSE 均使用生产实现，不读写项目或模型服务。 */
function createContext(web: WebCapability, modelSampler: ModelSampler, maxTotalTokens?: number, workspaceRoot?: string) {
  const ports = createMemoryPorts("/private/tmp/web-runtime-continuation");
  /** 与生产 Bootstrap 一样，每次装配返回新 Runtime，暴露 Route 错误重建实例的问题。 */
  function bootstrap() {
    return createAgentRuntime({ ports, defaultRunConfig: { workspaceTrusted: true, permissionMode: "ask", web, modelSampler, ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }), ...(workspaceRoot ? { workspaceRoot } : {}) } });
  }
  const runtime = bootstrap();
  const context: WebWorkspaceContext = {
    workspaceId: "fixture-workspace",
    workspaceRoot: "/private/tmp/web-runtime-continuation",
    projectId: "fixture-project",
    runtime,
    compositionRoot: { bootstrap: async function createFreshRuntime() { return bootstrap(); } } as WebCompositionRoot,
  };
  return { ports, runtime, context };
}

/** 只发送浏览器允许的请求 DTO，原始工具 URL 不经过审批/恢复请求体。 */
function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/sessions/fixture", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("Web Runtime continuity", function runtimeContinuitySuite() {
  /** Stage 6 原始失败：不同 HTTP 请求之间，批准后仍应得到原始 URL 并且只抓取一次。 */
  it("批准后通过原 Runtime 恢复 Fetch，不执行脱敏占位", async function resumesOriginalFetchInput() {
    const url = "https://example.com/manual-check?value=PRIVATE_URL";
    const fetch = vi.fn(async function fetchPublicPage(input: { url: string }) {
      return { url: input.url, finalUrl: input.url, content: "PRIVATE_PAGE_BODY", contentType: "text/plain", truncated: false };
    });
    let samples = 0;
    const { runtime, context, ports } = createContext({ fetch: { fetch } }, {
      /** 首轮申请 Fetch，恢复收到结果后完成，不以模型服务掩盖宿主恢复行为。 */
      async sample() {
        return ++samples === 1
          ? { content: "", reasoningSummary: "", toolCalls: [{ id: "fetch-1", name: "web_fetch", input: { url } }] }
          : { content: "读取结束", reasoningSummary: "", toolCalls: [] };
      },
    });
    const session = await runtime.sessions.create({ id: "approval-session", title: "审批恢复" });
    const events = await collect(runtime.turns.start({ sessionId: session.id, turnId: "approval-turn", content: "读取公开网页" }));
    const pending = events.find(event => event.type === "approval_required");
    if (pending?.type !== "approval_required") throw new Error("fixture 未进入审批");
    const params = { params: Promise.resolve({ id: session.id }) };
    const history = await runWithWorkspaceRequestContext(context, () => readSession(new Request("http://localhost/api/sessions/fixture"), params));
    expect(await history.json()).toMatchObject({ meta: { runtimeStatus: "waiting_approval" }, agent: { turnId: "approval-turn", status: "awaiting_approval" } });
    const body = { turnId: "approval-turn", approvalId: pending.result.approval.approvalId };
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(await ports.checkpointStore.getLatest(session.id))).not.toContain("PRIVATE_URL");
    const approved = await runWithWorkspaceRequestContext(context, () => approve(request({ ...body, decision: "allow_once" }), params));
    expect(approved.status).toBe(200);
    const resumed = await runWithWorkspaceRequestContext(context, () => continueTurn(request(body), params));
    const sse = await resumed.text();
    expect(resumed.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0].url).toBe(url);
    expect(sse).toContain('"type":"turn_completed"');
    expect(sse).not.toContain("WEB_INPUT_UNAVAILABLE");
    expect(sse).not.toContain("PRIVATE_URL");
    expect(sse).not.toContain("PRIVATE_PAGE_BODY");
  });

  it("历史返回不可恢复预算终态，Continue Route 按 Core 判定拒绝", async function rejectsNonRecoverableBudgetContinue() {
    let sampleCount = 0;
    const { runtime, context } = createContext({}, {
      /** 执行一次安全读取并返回超额 usage，让 Core 在下一个安全边界终止 Turn。 */
      async sample() {
        sampleCount += 1;
        return { content: "", toolCalls: [{ id: "budget-read", name: "read_file", input: { path: "package.json", limit: 20 } }], reasoningSummary: "读取预算 fixture", usage: { inputTokens: 12, outputTokens: 0, contextTokens: 12 } };
      },
    }, 10, process.cwd());
    const session = await runtime.sessions.create({ id: "token-budget-session", title: "预算终态" });
    const turnId = "token-budget-turn";
    const events = await collect(runtime.turns.start({ sessionId: session.id, turnId, content: "检查预算" }));
    const failure = events.find(event => event.type === "turn_failed");
    expect(sampleCount).toBe(1);
    expect(events.filter(event => event.type === "tool_result" && event.toolName === "read_file")).toHaveLength(1);
    expect(failure?.type === "turn_failed" ? failure.termination : undefined).toMatchObject({
      reason: "token_budget",
      recoverable: false,
      budget: { used: 12, limit: 10, unit: "tokens" },
    });

    const params = { params: Promise.resolve({ id: session.id }) };
    const history = await runWithWorkspaceRequestContext(context, () => readSession(new Request("http://localhost/api/sessions/fixture"), params));
    expect((await history.json()).agent).toMatchObject({
      turnId,
      status: "failed",
      recoverable: false,
      termination: { reason: "token_budget", recoverable: false, budget: { used: 12, limit: 10, unit: "tokens" } },
    });

    const response = await runWithWorkspaceRequestContext(context, () => continueTurn(request({ turnId }), params));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "TURN_NOT_RESUMABLE" });
  });

  /** 不注册 Web 辅助取消索引，确认 cancel Route 真正取消持有执行树的 Core Runtime。 */
  it("取消请求终止原 Runtime 的 Search 并落为 interrupted", async function cancelsOriginalRuntime() {
    let started!: () => void;
    const searchStarted = new Promise<void>(resolve => { started = resolve; });
    let signal: AbortSignal | undefined;
    const { runtime, context } = createContext({ search: {
      /** 模拟等待中的网络正文，只有正确 Runtime 的取消信号能使其退出。 */
      search(input) {
        signal = input.signal;
        return new Promise(function awaitCancellation(_resolve, reject) {
          signal?.addEventListener("abort", function rejectOnAbort() { reject(new Error("cancelled")); }, { once: true });
          started();
        });
      },
    } }, {
      /** 只申请一个公开搜索，测试不连接任何 Provider。 */
      async sample() { return { content: "", reasoningSummary: "", toolCalls: [{ id: "search-1", name: "web_search", input: { query: "public" } }] }; },
    });
    const session = await runtime.sessions.create({ id: "cancel-session", title: "取消" });
    const input = { sessionId: session.id, turnId: "cancel-turn" };
    const running = collect(runtime.turns.start({ ...input, content: "公开搜索" }));
    try {
      await searchStarted;
      const response = await runWithWorkspaceRequestContext(context, () => cancel(request({ turnId: input.turnId }), { params: Promise.resolve({ id: session.id }) }));
      expect(response.status).toBe(200);
      await running;
      expect(signal?.aborted).toBe(true);
      expect((await runtime.turns.getState(input)).checkpoint?.status).toBe("interrupted");
      const history = await runWithWorkspaceRequestContext(context, () => readSession(new Request("http://localhost/api/sessions/fixture"), { params: Promise.resolve({ id: session.id }) }));
      expect((await history.json()).meta.runtimeStatus).toBe("interrupted");
    } finally {
      await runtime.turns.cancel(input);
      await running;
    }
  });
});
