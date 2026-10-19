/** Web Workspace Job API 定向测试：锁定来源、归属、有限参数和安全错误。 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobReadView, JobView, SessionJobService } from "@autopilot-agent/core";
import type { WebWorkspaceContext, WebWorkspaceHost } from "@/lib/workspace-host/web-workspace-host";
import { setWebWorkspaceHostForTest } from "@/lib/workspace-host/web-workspace-server";
import { listWebWorkspaceJobs, readWebWorkspaceJobOutput, stopWebWorkspaceJob, validateWorkJobRequestSource } from "@/lib/workspace-host/web-workspace-jobs";

it("Stage5 Next 回环 URL 规范化仍严格匹配浏览器 Host 和 Origin", function checksActualLoopbackOrigin() {
  const request = function request(origin: string, host = "127.0.0.1:3001") { return new Request("http://localhost:3001/api/jobs", { headers: { host, origin } }); };
  expect(validateWorkJobRequestSource(request("http://127.0.0.1:3001"), true)).toBeUndefined();
  expect(validateWorkJobRequestSource(request("http://localhost:3001"), true)?.status).toBe(403);
  expect(validateWorkJobRequestSource(request("http://127.0.0.1:3002"), true)?.status).toBe(403);
  expect(validateWorkJobRequestSource(request("http://evil.test:3001", "evil.test:3001"), true)?.status).toBe(403);
  expect(validateWorkJobRequestSource(request("null"), true)?.status).toBe(403);
});

const job: JobView = {
  jobId: "job_safe_1",
  status: "running",
  controlState: "owned",
  canStop: true,
  revision: 2,
  startedAt: 1,
  updatedAt: 2,
  stdoutBytes: 4,
  stderrBytes: 0,
  outputTruncated: false,
};

const readView: JobReadView = {
  job,
  waitOutcome: "snapshot",
  output: {
    stdout: { text: "safe", nextCursor: "next_stdout", startCursor: "start_stdout", gap: false, resetRequired: false, truncated: false },
    stderr: { text: "", nextCursor: "next_stderr", startCursor: "start_stderr", gap: false, resetRequired: false, truncated: false },
  },
};

/** 构造不读取真实 Registry、工作区或进程的 scoped Job Host。 */
function installHost(jobs: SessionJobService, input: { productMode?: "work" | "chat"; readOnlyReason?: string } = {}) {
  const forSession = vi.fn(function bindJobs() { return jobs; });
  const context = {
    workspaceId: "opaque-workspace",
    workspaceRoot: "C:/env-workspace",
    projectId: "project-a",
    compositionRoot: {},
    runtime: {
      sessions: { get: vi.fn(async function getSession() { return { id: "session-a", projectId: "project-a", productMode: input.productMode ?? "work" }; }) },
      turns: { getState: vi.fn(async function getState() { return { readOnlyReason: input.readOnlyReason }; }) },
      jobs: { forSession },
    },
  } as unknown as WebWorkspaceContext;
  const getContext = vi.fn(async function getContext() { return context; });
  setWebWorkspaceHostForTest({ getContext } as unknown as WebWorkspaceHost);
  return { context, forSession, getContext };
}

/** 每项恢复 Host 注入，避免测试访问真实工作区。 */
afterEach(function resetHost() { setWebWorkspaceHostForTest(undefined); });

describe("Web Workspace Jobs", function suite() {
  it("只用 canonical root 绑定当前 Work Session 并返回 no-store 安全列表", async function listsScopedJobs() {
    const list = vi.fn(async function listJobs() { return { jobs: [job], nextPageCursor: "next_page" }; });
    const fixture = installHost({ list } as unknown as SessionJobService);
    const response = await listWebWorkspaceJobs(new Request("http://localhost/api/jobs?limit=20"), Promise.resolve({ workspaceId: "opaque-workspace", sessionId: "session-a" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ jobs: [job], nextPageCursor: "next_page" });
    expect(fixture.forSession).toHaveBeenCalledWith({ workspaceId: "C:/env-workspace", sessionId: "session-a" });
    expect(list).toHaveBeenCalledWith({ limit: 20, pageCursor: undefined });
  });

  it("在初始化 Host 前拒绝 Origin null、跨端口和无 Origin 的外部 Host", async function rejectsForeignSources() {
    const fixture = installHost({ list: vi.fn() } as unknown as SessionJobService);
    const requests = [
      new Request("http://localhost/api/jobs", { headers: { Origin: "null" } }),
      new Request("http://localhost:3000/api/jobs", { headers: { Origin: "http://localhost:3001" } }),
      new Request("http://example.test/api/jobs"),
    ];
    for (const request of requests) {
      const response = await listWebWorkspaceJobs(request, Promise.resolve({ workspaceId: "opaque-workspace", sessionId: "session-a" }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "WORK_REQUEST_ORIGIN_INVALID" });
    }
    expect(fixture.getContext).not.toHaveBeenCalled();
  });

  it("读取输出固定 waitMs=0，坏 cursor 与旧只读 Work 在调用 Job 前拒绝", async function readsBoundedOutput() {
    const read = vi.fn(async function readJob() { return readView; });
    const fixture = installHost({ read } as unknown as SessionJobService);
    const params = Promise.resolve({ workspaceId: "opaque-workspace", sessionId: "session-a", jobId: "job_safe_1" });
    const response = await readWebWorkspaceJobOutput(new Request("http://localhost/api/jobs/job_safe_1/output?stdoutCursor=cursor_1"), params);
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledWith({ jobId: "job_safe_1", stdoutCursor: "cursor_1", stderrCursor: undefined, waitMs: 0 });

    const invalid = await readWebWorkspaceJobOutput(new Request("http://localhost/api/jobs/job_safe_1/output?stdoutCursor=bad%21"), Promise.resolve({ workspaceId: "opaque-workspace", sessionId: "session-a", jobId: "job_safe_1" }));
    expect(invalid.status).toBe(400);
    expect(read).toHaveBeenCalledTimes(1);

    setWebWorkspaceHostForTest(undefined);
    const readonlyFixture = installHost({ read } as unknown as SessionJobService, { readOnlyReason: "WORK_HISTORY_READ_ONLY" });
    const readonly = await readWebWorkspaceJobOutput(new Request("http://localhost/api/jobs/job_safe_1/output"), Promise.resolve({ workspaceId: "opaque-workspace", sessionId: "session-a", jobId: "job_safe_1" }));
    expect(readonly.status).toBe(409);
    expect(readonlyFixture.forSession).not.toHaveBeenCalled();
    expect(fixture.forSession).toHaveBeenCalledTimes(1);
  });

  it("停止只接受同源空对象，并把 owner 失败映射为固定 409", async function stopsWithStableErrors() {
    const stop = vi.fn(async function stopJob() { return { ...job, status: "stopped", controlState: "terminal", canStop: false } as JobView; });
    installHost({ stop } as unknown as SessionJobService);
    const request = new Request("http://localhost:3000/api/jobs/job_safe_1/stop", { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" }, body: "{}" });
    const response = await stopWebWorkspaceJob(request, Promise.resolve({ workspaceId: "opaque-workspace", sessionId: "session-a", jobId: "job_safe_1" }));
    expect(response.status).toBe(200);
    expect(stop).toHaveBeenCalledWith({ jobId: "job_safe_1", source: "host" });
    expect(await response.json()).toMatchObject({ job: { status: "stopped", canStop: false } });

    const invalid = await stopWebWorkspaceJob(new Request("http://localhost/api/jobs/job_safe_1/stop", { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json" }, body: "{\"signal\":\"KILL\"}" }), Promise.resolve({ workspaceId: "opaque-workspace", sessionId: "session-a", jobId: "job_safe_1" }));
    expect(invalid.status).toBe(400);
    expect(stop).toHaveBeenCalledTimes(1);

    stop.mockRejectedValueOnce(Object.assign(new Error("/private/raw owner"), { code: "JOB_OWNER_UNAVAILABLE" }));
    const blocked = await stopWebWorkspaceJob(new Request("http://localhost/api/jobs/job_safe_1/stop", { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json" }, body: "{}" }), Promise.resolve({ workspaceId: "opaque-workspace", sessionId: "session-a", jobId: "job_safe_1" }));
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).not.toContain("/private/raw owner");
  });
});
