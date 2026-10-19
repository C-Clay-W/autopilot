/** Stage4 CLI 后台任务管理的 parser、Controller 并发与 TUI 返回边界测试。 */

import type { AgentEvent, JobOutputView, JobView } from "@autopilot-agent/core";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { createCliController, type CliController, type CliControllerResult } from "../src/controller.js";
import { createInitialCliProjection } from "../src/event-projector.js";
import { parseSlashAction } from "../src/parser.js";
import { createPlainRenderer } from "../src/renderer.js";
import { CliTuiApp, createCliTuiStore } from "../src/tui.js";
import type { CliAction, CliProjection, CliRuntime } from "../src/types.js";

const job: JobView = { jobId: "job-1", status: "running", controlState: "owned", canStop: true, revision: 2, startedAt: 1, updatedAt: 2, stdoutBytes: 4, stderrBytes: 0, outputTruncated: false };
const output: JobOutputView = {
  stdout: { text: "safe", nextCursor: "stdout-next", startCursor: "stdout-start", gap: false, resetRequired: false, truncated: false },
  stderr: { text: "", nextCursor: "stderr-next", startCursor: "stderr-start", gap: false, resetRequired: false, truncated: false },
};

/** 把最小测试事件收窄为公开 AgentEvent。 */
function asEvent(value: unknown): AgentEvent { return value as AgentEvent; }

/** 创建可控结束的活动 Turn 流，用于证明 Job 管理不会排在模型消费之后。 */
function createBusyStream(release: Promise<void>): AsyncGenerator<AgentEvent> {
  return (async function* busyStream() {
    yield asEvent({ type: "turn_started", turnId: "turn-busy", stepCount: 0 });
    await release;
    yield asEvent({ type: "turn_completed", turnId: "turn-busy", checkpoint: { turnId: "turn-busy", status: "completed", stepCount: 1, messages: [], completedCallIds: [] } });
  })();
}

/** 创建只实现 Session Job 管理的 Runtime double。 */
function createJobRuntime(calls: string[]): CliRuntime {
  return {
    jobs: {
      forSession: function forSession(binding) {
        calls.push(`bind:${binding.workspaceId}:${binding.sessionId}`);
        return {
          list: async function list() { calls.push("list"); return { jobs: [job] }; },
          read: async function read(input) { calls.push(`read:${input.jobId}`); return { job, output, waitOutcome: "snapshot" as const }; },
          stop: async function stop(input) { calls.push(`stop:${input.jobId}:${input.source}`); return { ...job, status: "stopped" as const, controlState: "terminal" as const, canStop: false }; },
        };
      },
    },
  } as unknown as CliRuntime;
}

/** 创建能返回 Job 视图的 TUI Controller double。 */
function createTuiController(calls: CliAction[]): CliController {
  const projection = createInitialCliProjection();
  /** 生成带当前安全投影的 Controller 结果。 */
  function result(extra: Partial<CliControllerResult> = {}): CliControllerResult { return { kind: "ok", exitCode: 0, lines: [], projection, ...extra }; }
  return {
    async dispatch(action) {
      calls.push(action);
      if (action.type === "list_jobs") return result({ jobView: { mode: "list", list: { jobs: [job] } } });
      if (action.type === "show_job") return result({ jobView: { mode: "detail", job } });
      if (action.type === "read_job_output") return result({ jobView: { mode: "detail", job, output } });
      if (action.type === "stop_job") return result({ jobView: { mode: "detail", job: { ...job, status: "stopped", controlState: "terminal", canStop: false } } });
      return result();
    },
    async consume() { return result(); },
    async resume() { return result(); },
    getProjection() { return projection; },
    setSession() {},
    setEventListener() {},
  };
}

describe("Stage4 CLI background jobs", function cliJobsSuite() {
  it("解析 /jobs 的列表、详情、日志和停止，不把命令交给模型", function parsesJobsActions() {
    expect(parseSlashAction("/jobs")).toEqual({ kind: "action", action: { type: "list_jobs" } });
    expect(parseSlashAction("/jobs show job-1")).toEqual({ kind: "action", action: { type: "show_job", jobId: "job-1" } });
    expect(parseSlashAction("/jobs output job-1")).toEqual({ kind: "action", action: { type: "read_job_output", jobId: "job-1" } });
    expect(parseSlashAction("/jobs stop job-1")).toEqual({ kind: "action", action: { type: "stop_job", jobId: "job-1" } });
  });

  it("活动 Turn 尚未结束时仍立即走同 Runtime 的 Session 绑定管理接口", async function managesJobsWhileTurnIsBusy() {
    let finishTurn!: () => void;
    const release = new Promise<void>(function waitForRelease(resolve) { finishTurn = resolve; });
    const calls: string[] = [];
    const controller = createCliController({ runtime: createJobRuntime(calls), renderer: createPlainRenderer("text"), sessionId: "session-1", workspaceRoot: "C:/workspace" });
    const consuming = controller.consume(createBusyStream(release));
    await new Promise<void>(function letStartedEventRun(resolve) { setImmediate(resolve); });

    const listed = await controller.dispatch({ type: "list_jobs" });
    expect(listed.jobView).toEqual({ mode: "list", list: { jobs: [job] } });
    expect(controller.getProjection().status).toBe("running");
    const stopped = await controller.dispatch({ type: "stop_job", jobId: "job-1" });
    expect(stopped.jobView).toMatchObject({ mode: "detail", job: { jobId: "job-1", status: "stopped", canStop: false } });
    expect(controller.getProjection().status).toBe("running");
    expect(calls).toEqual(["bind:C:/workspace:session-1", "list", "bind:C:/workspace:session-1", "stop:job-1:host"]);
    finishTurn();
    await consuming;
  });

  it("TUI 可从列表进入详情，Esc 逐级返回且不触发 Turn 取消", async function returnsFromJobsWithoutCancellingTurn() {
    const calls: CliAction[] = [];
    const store = createCliTuiStore();
    const controller = createTuiController(calls);
    const rendered = render(<CliTuiApp
      store={store}
      controller={controller}
      closeWhenIdle={false}
      useColor={false}
      screenReader={true}
      onResult={function syncResult(result) { store.syncProjection(result.projection); }}
      onRequestInterrupt={function ignoreInterrupt() {}}
      onRequestCancel={function recordUnexpectedCancel() { calls.push({ type: "cancel_turn" }); }}
      onEof={function ignoreEof() {}}
      onAppExit={function ignoreExit() {}}
    />);

    rendered.stdin.write("/jobs");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForList(resolve) { setTimeout(resolve, 20); });
    expect(rendered.lastFrame() ?? "").toContain("Background jobs");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForDetail(resolve) { setTimeout(resolve, 20); });
    expect(rendered.lastFrame() ?? "").toContain("Background job");
    rendered.stdin.write("s");
    await new Promise<void>(function waitForStop(resolve) { setTimeout(resolve, 20); });
    expect(rendered.lastFrame() ?? "").toContain("stopped");
    rendered.stdin.write("\u001b");
    await new Promise<void>(function waitForBack(resolve) { setTimeout(resolve, 20); });
    expect(rendered.lastFrame() ?? "").toContain("Background jobs");
    expect(rendered.lastFrame() ?? "").toContain("stopped");
    const dispatch = controller.dispatch.bind(controller);
    let releaseDetail!: () => void;
    const pendingDetail = new Promise<void>(function holdDetail(resolve) { releaseDetail = resolve; });
    controller.dispatch = async function delayDetail(action) {
      if (action.type === "show_job") await pendingDetail;
      return dispatch(action);
    };
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForRequest(resolve) { setTimeout(resolve, 20); });
    rendered.stdin.write("\u001b");
    await new Promise<void>(function waitForClose(resolve) { setTimeout(resolve, 20); });
    releaseDetail();
    await new Promise<void>(function waitForLateResponse(resolve) { setTimeout(resolve, 20); });
    expect(rendered.lastFrame() ?? "").not.toContain("Background job");
    rendered.stdin.write("draft");
    await new Promise<void>(function waitForPrompt(resolve) { setTimeout(resolve, 20); });
    expect(rendered.lastFrame() ?? "").toContain("draft");
    expect(calls).toEqual([{ type: "list_jobs" }, { type: "show_job", jobId: "job-1" }, { type: "stop_job", jobId: "job-1" }, { type: "show_job", jobId: "job-1" }]);
    rendered.unmount();
  });

  it("alternate-screen 与 NO_COLOR 路径复用同一 Job 视图且不输出 ANSI", async function rendersFullscreenJobsWithoutColor() {
    const calls: CliAction[] = [];
    const store = createCliTuiStore();
    const controller = createTuiController(calls);
    const rendered = render(<CliTuiApp
      store={store}
      controller={controller}
      closeWhenIdle={false}
      useColor={false}
      screenReader={false}
      renderMode="alternate-screen"
      onResult={function syncResult(result) { store.syncProjection(result.projection); }}
      onRequestInterrupt={function ignoreInterrupt() {}}
      onRequestCancel={function ignoreCancel() {}}
      onEof={function ignoreEof() {}}
      onAppExit={function ignoreExit() {}}
    />);
    rendered.stdin.write("/jobs");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForJobs(resolve) { setTimeout(resolve, 20); });
    expect(rendered.lastFrame() ?? "").toContain("Background jobs");
    expect(rendered.lastFrame() ?? "").not.toContain("\u001b[");
    rendered.unmount();
  });
});
