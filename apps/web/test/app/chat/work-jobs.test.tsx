/** Work Jobs 客户端定向测试：锁定迟到响应、日志 reset、轮询释放与可访问顺序。 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentPresentationState } from "@autopilot-agent/presentation";
import type { JobReadView, JobView } from "@autopilot-agent/core";
import { createWorkJobController } from "@/app/chat/work-job-controller";
import { WorkJobsPanel } from "@/app/chat/components/WorkJobs";
import TurnPresentation from "@/app/chat/components/TurnPresentation";

const runningJob: JobView = {
  jobId: "job_safe_1",
  status: "running",
  controlState: "owned",
  canStop: true,
  revision: 1,
  startedAt: 1,
  updatedAt: 2,
  stdoutBytes: 3,
  stderrBytes: 0,
  outputTruncated: false,
};

/** 构造安全增量输出，允许用例只覆盖 cursor 连续性。 */
function createRead(text: string, cursor: string, resetRequired = false): JobReadView {
  return {
    job: runningJob,
    waitOutcome: "snapshot",
    output: {
      stdout: { text, nextCursor: cursor, startCursor: `start_${cursor}`, gap: false, resetRequired, truncated: false },
      stderr: { text: "", nextCursor: `err_${cursor}`, startCursor: `err_start_${cursor}`, gap: false, resetRequired: false, truncated: false },
    },
  };
}

/** 等待 fetch Promise 和 React 无关的 controller 微任务完成。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>(function waitForResponseStream(resolve) { setTimeout(resolve, 0); });
}

describe("Work Jobs", function suite() {
  it("Stage5 effect 重放在首请求未完成时仍重新读取列表", async function restoresAfterEffectReplay() {
    let resolveFirst: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn(function response() {
      if (fetchImpl.mock.calls.length === 1) return new Promise<Response>(function wait(resolve) { resolveFirst = resolve; });
      return Promise.resolve(Response.json({ jobs: [runningJob] }));
    });
    const controller = createWorkJobController({ workspaceId: "w", sessionId: "s", fetchImpl });
    controller.setActive(true, false);
    controller.dispose();
    controller.setActive(true, false);
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().jobs).toEqual([runningJob]);
    resolveFirst?.(Response.json({ jobs: [] }));
    await flush();
    expect(controller.getSnapshot().jobs).toEqual([runningJob]);
    controller.dispose();
  });
  it("Stage5 二十次切换和详情开关不遗留轮询或并发请求", async function releasesRepeatedPolling() {
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    let activeRequests = 0;
    let peakRequests = 0;
    const controller = createWorkJobController({
      workspaceId: "w", sessionId: "s",
      setTimer: function schedule(callback) { timers.set(++nextTimer, callback); return nextTimer; },
      clearTimer: function clear(timer) { timers.delete(Number(timer)); },
      fetchImpl: async function fetchSnapshot(input) {
        activeRequests += 1;
        peakRequests = Math.max(peakRequests, activeRequests);
        await Promise.resolve();
        activeRequests -= 1;
        return Response.json(String(input).includes("/output") ? createRead("x".repeat(8192), "next") : { jobs: [runningJob], totalCount: 1, activeCount: 1 });
      },
    });
    for (let index = 0; index < 20; index += 1) {
      controller.setActive(true, false);
      await flush();
      await controller.open(runningJob.jobId);
      expect(timers.size).toBeLessThanOrEqual(2);
      controller.close();
      controller.setActive(false, false);
      expect(timers.size).toBe(0);
    }
    controller.dispose();
    expect(activeRequests).toBe(0);
    expect(peakRequests).toBe(1);
    expect(timers.size).toBe(0);
  });
  it("CR 终态日志继续取完，旧列表不能覆盖停止状态", async function drainsTerminalOutput() {
    const terminal = { ...runningJob, status: "stopped" as const, canStop: false, revision: 3 };
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const first = createRead("first", "one");
    first.job = terminal;
    first.output.stdout.truncated = true;
    const second = createRead("last", "two");
    second.job = terminal;
    const responses = [Response.json({ jobs: [terminal] }), Response.json(first), Response.json(second), Response.json({ jobs: [runningJob] })];
    const controller = createWorkJobController({ workspaceId: "w", sessionId: "s", fetchImpl: vi.fn(async function response() { return responses.shift()!; }), setTimer: function schedule(callback, delay) { timers.push({ callback, delay }); return timers.length; }, clearTimer: function clear() {} });
    controller.setActive(true, true);
    await flush();
    expect(timers.some(function probing(timer) { return timer.delay === 5000; })).toBe(true);
    await controller.open(runningJob.jobId);
    timers.findLast(function detail(timer) { return timer.delay === 1000; })!.callback();
    await flush();
    expect(controller.getSnapshot().selected?.output.stdout.text).toBe("firstlast");
    await controller.refresh();
    expect(controller.getSnapshot().selected?.job.status).toBe("stopped");
    controller.dispose();
  });
  it("切换为非活动会话后丢弃迟到列表响应", async function ignoresLateList() {
    let resolveRequest: ((response: Response) => void) | undefined;
    let requestCount = 0;
    const fetchImpl = vi.fn(function deferredFetch() {
      requestCount += 1;
      if (requestCount > 1) return Promise.resolve(Response.json({ jobs: [] }));
      return new Promise<Response>(function wait(resolve) { resolveRequest = resolve; });
    }) as unknown as typeof fetch;
    const controller = createWorkJobController({ workspaceId: "workspace-a", sessionId: "session-a", fetchImpl });

    controller.setActive(true, false);
    controller.setActive(false, false);
    controller.setActive(true, false);
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    resolveRequest?.(Response.json({ jobs: [runningJob] }));
    await flush();

    expect(controller.getSnapshot().jobs).toEqual([]);
    expect(controller.getSnapshot().state).toBe("ready");
    controller.dispose();
  });

  it("活动日志按安全 cursor 增量读取，reset 时替换旧窗口且停止失败保留详情", async function handlesCursorResetAndStopFailure() {
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    const responses = [
      Response.json({ jobs: [] }),
      Response.json(createRead("old", "cursor_1")),
      Response.json(createRead("new", "cursor_2", true)),
      Response.json({ code: "JOB_STOP_FAILED", error: "后台任务停止失败" }, { status: 500 }),
    ];
    const fetchMock = vi.fn(async function fetchResponse(_input: RequestInfo | URL, _init?: RequestInit) { return responses.shift()!; });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const controller = createWorkJobController({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      fetchImpl,
      setTimer: function setTimer(callback, delay) { const timer = { callback: callback as () => void, delay: Number(delay), cleared: false }; timers.push(timer); return timer as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: function clearTimer(timer) { const target = timer as unknown as { cleared: boolean }; target.cleared = true; },
    });

    controller.setActive(true, false);
    await flush();
    expect(controller.getSnapshot().jobs).toEqual([]);
    await controller.open("job_safe_1");
    expect(controller.getSnapshot().jobs).toEqual([runningJob]);
    const detailTimer = timers.findLast(function findDetail(timer) { return timer.delay === 1_000 && !timer.cleared; });
    expect(detailTimer).toBeDefined();
    detailTimer?.callback();
    await flush();

    expect(controller.getSnapshot().selected?.output.stdout.text).toBe("new");
    expect(controller.getSnapshot().selected?.output.stdout.resetRequired).toBe(true);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("stdoutCursor=cursor_1");

    await controller.stop("job_safe_1");
    expect(controller.getSnapshot().detailError).toBe("后台任务停止失败");
    expect(controller.getSnapshot().stoppingJobId).toBeUndefined();
    controller.dispose();
    expect(timers.filter(function liveTimer(timer) { return !timer.cleared; })).toHaveLength(0);
  });

  it("列表和详情使用状态文字、有限滚动与目标行停止，不显示原始命令字段", function rendersAccessiblePanel() {
    const snapshot = {
      state: "ready" as const,
      jobs: [runningJob],
      selectedJobId: runningJob.jobId,
      selected: createRead("safe output", "cursor_1"),
    };
    const markup = renderToStaticMarkup(<WorkJobsPanel snapshot={snapshot} onRefresh={vi.fn()} onLoadMore={vi.fn()} onOpen={vi.fn()} onClose={vi.fn()} onStop={vi.fn()} />);

    expect(markup).toContain("后台任务 · 1 个运行中");
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("关闭窗口不会停止任务");
    expect(markup).toContain("运行中");
    expect(markup).toContain("停止任务");
    expect(markup).toContain("max-w-4xl");
    expect(markup).toContain("safe output");
    expect(markup).not.toContain("program");
    expect(markup).not.toContain("C:/private");
  });

  it("安全 Job 入口位于最终回答之后、Turn Summary 之前，Chat 不显示入口", function ordersResultEntry() {
    const state: AgentPresentationState = {
      sessionId: "session-a",
      turnId: "turn-a",
      appliedEventIds: [],
      lastSeqByTurn: {},
      turnStartedAt: {},
      items: [
        { id: "tool:1", kind: "tool_call", turnId: "turn-a", callId: "call-1", toolName: "start_background_job", profileKey: "start_background_job", category: "process", state: "completed", titleKey: "tool.job.start.completed", job: { action: "start", jobId: "job_safe_1", observedStatus: "running" } },
        { id: "answer:1", kind: "assistant_answer", channel: "final", turnId: "turn-a", stepId: "step-1", content: "后台任务已经启动。" },
        { id: "summary:1", kind: "turn_summary", turnId: "turn-a", state: "completed", toolCount: 1 },
      ],
    };
    const common = { state, turnId: "turn-a", showThinking: false, onOpenBackgroundJob: vi.fn(), onApprovalDecision: vi.fn(), onUserQuestionSubmit: vi.fn(async function submit() {}), onUserQuestionCancel: vi.fn() };
    const work = renderToStaticMarkup(<TurnPresentation {...common} productMode="work" />);
    const chat = renderToStaticMarkup(<TurnPresentation {...common} productMode="chat" />);

    expect(work.indexOf("后台任务已经启动")).toBeLessThan(work.indexOf("查看后台任务"));
    expect(work.indexOf("查看后台任务")).toBeLessThan(work.indexOf("Turn Summary"));
    expect(chat).not.toContain("查看后台任务");
  });
});
