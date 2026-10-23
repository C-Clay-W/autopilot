/** Work 预览服务定向测试：合成 HTTP 与 fake clock 覆盖就绪/404/重定向/退出/取消/过期/串会话/停止。 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { JobReadView, JobView, SessionJobService, WorkPreviewPrepareRequest } from "@autopilot-agent/core";
import { probeLocalService, type ProbeOptions, type ProbeResult } from "@/lib/workspace-host/work-preview-readiness";
import { WorkPreviewError, createWorkPreviewService, type WebWorkPreviewService } from "@/lib/workspace-host/work-preview-service";
import type { WorkPreviewToolFact } from "@/lib/workspace-host/work-preview-facts";

const WORKSPACE = "C:/env-workspace";

/** 本轮启动的合成服务句柄；afterEach 统一关闭，避免句柄泄漏。 */
const servers: Server[] = [];

/** 启动一个返回固定状态码的合成本地服务；hang 模式保持连接不响应。 */
async function startServer(status: number, opts: { hang?: boolean } = {}): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    if (opts.hang) return;
    res.writeHead(status, { "content-type": "text/plain", ...(status >= 300 && status < 400 ? { location: "/next" } : {}) });
    res.end("fixture");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { server, origin: "http://127.0.0.1:" + port };
}

afterEach(async function closeServers() {
  await Promise.all(servers.splice(0).map(function close(server) { return new Promise<void>((resolve) => server.close(() => resolve())); }));
});

/** 可变 Job 替身状态；用例可推进状态/归属以复现准备后停止、owner 变化。 */
interface FakeJobState {
  status: JobView["status"];
  controlState: JobView["controlState"];
  /** Job 声明的本机服务地址；未声明时没有预览绑定资格。 */
  serviceUrl?: string;
  /** verifyServiceOwnership 的固定回答；缺省按状态推断为 owned。 */
  ownership?: "owned" | "unowned" | "unverifiable";
}

/** 构造可运行/可停止的 scoped Job 替身；serviceUrl 与归属回答控制预览绑定。 */
function fakeJobs(input: { state?: FakeJobState; stopError?: Error; jobId?: string } = {}): SessionJobService {
  const state = input.state ?? { status: "running" as JobView["status"], controlState: "owned" as JobView["controlState"] };
  const jobId = input.jobId ?? "job-1";
  function jobView(): JobView {
    return {
      jobId,
      status: state.status,
      controlState: state.controlState,
      canStop: state.controlState === "owned",
      startedAt: 1,
      updatedAt: 2,
      stdoutBytes: 0,
      stderrBytes: 0,
      outputTruncated: false,
      ...(state.serviceUrl !== undefined ? { serviceUrl: state.serviceUrl } : {}),
    };
  }
  return {
    list: vi.fn(async function list() { return { jobs: [jobView()], totalCount: 1, activeCount: state.status === "running" || state.status === "starting" ? 1 : 0 }; }),
    read: vi.fn(async function read() {
      const readView: JobReadView = {
        job: jobView(),
        waitOutcome: "snapshot",
        output: {
          stdout: { text: "", nextCursor: "c1", startCursor: "c0", gap: false, resetRequired: false, truncated: false },
          stderr: { text: "", nextCursor: "c2", startCursor: "c0", gap: false, resetRequired: false, truncated: false },
        },
      };
      return readView;
    }),
    stop: vi.fn(async function stop() {
      if (input.stopError) throw input.stopError;
      state.status = "stopped";
      state.controlState = "terminal";
      return jobView();
    }),
    verifyServiceOwnership: vi.fn(async function verify() {
      if (state.status !== "running" && state.status !== "starting") return "unowned" as const;
      if (state.controlState !== "owned") return "unowned" as const;
      if (state.serviceUrl === undefined) return "unowned" as const;
      return (state.ownership ?? "owned") as "owned" | "unowned" | "unverifiable";
    }),
  } as unknown as SessionJobService;
}

/** 构造 prepare 请求；默认目标由调用方给定。 */
function prepareRequest(origin: string, input: Partial<WorkPreviewPrepareRequest> = {}): WorkPreviewPrepareRequest {
  return { url: origin + "/", workspaceId: WORKSPACE, sessionId: "session-a", turnId: "turn-1", callId: "call-1", openWhen: "after_turn", ...input };
}

/** 创建测试服务：真实探测实现但收窄预算，时钟手动推进。 */
function createService(input: {
  jobs?: SessionJobService;
  facts?: readonly WorkPreviewToolFact[];
  factsOf?: (sessionId: string) => Promise<readonly WorkPreviewToolFact[]>;
  clock?: { value: number };
  ttlMs?: number;
  capacity?: number;
  probe?: (url: string, options?: ProbeOptions) => Promise<ProbeResult>;
} = {}): WebWorkPreviewService {
  const clock = input.clock ?? { value: 1_000_000 };
  const factsOf = input.factsOf ?? (input.facts ? async function fixedFacts() { return input.facts!; } : undefined);
  return createWorkPreviewService({
    workspaceRoot: WORKSPACE,
    agentAuthorities: ["127.0.0.1:3000", "localhost:3000"],
    jobsOf: function jobsOf() { return input.jobs ?? fakeJobs(); },
    now: function now() { return clock.value; },
    probe: input.probe ?? function fastProbe(url, opts) { return probeLocalService(url, { ...opts, delayMs: 0, perTryMs: 150 }); },
    ...(factsOf ? { factsOf } : {}),
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
  });
}

/** 构造与 prepare 结果一致的权威事实；用例可改写 copyUrl/turnId/jobId 复现负向。 */
function factFrom(prepared: { previewId: string; copyUrl: string; hostLabel: string; jobId?: string }, input: Partial<WorkPreviewToolFact> = {}): WorkPreviewToolFact {
  return {
    previewId: prepared.previewId,
    turnId: "turn-1",
    callId: "call-1",
    copyUrl: prepared.copyUrl,
    hostLabel: prepared.hostLabel,
    openWhen: "after_turn",
    ...(prepared.jobId !== undefined ? { jobId: prepared.jobId } : {}),
    ...input,
  };
}

/** 断言 Promise 拒绝为指定预览错误码。 */
async function expectPreviewError(pending: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected rejection: " + code).toBeInstanceOf(WorkPreviewError);
  expect((caught as WorkPreviewError).code).toBe(code);
}

describe("preparePreview 就绪", function suite() {
  it("2xx 就绪并返回冻结安全事实，resolve 返回带就绪状态的导航 DTO", async function readies() {
    const { origin } = await startServer(200);
    const service = createService();
    const result = await service.preparePreview(prepareRequest(origin));
    expect(result).toMatchObject({
      hostLabel: "127.0.0.1:" + new URL(origin).port,
      copyUrl: origin + "/",
      openWhen: "after_turn",
      state: "prepared",
    });
    const dto = await service.resolveNavigation({ previewId: result.previewId, sessionId: "session-a" });
    expect(dto).toMatchObject({ turnId: "turn-1", navigationUrl: origin + "/", sandboxProfile: "trusted_local", serviceState: "ready", canStop: false });
  });

  it("404 目标按页面不存在拒绝且不缓存引用", async function rejects404() {
    const { origin } = await startServer(404);
    const service = createService();
    await expectPreviewError(service.preparePreview(prepareRequest(origin)), "PREVIEW_PAGE_NOT_FOUND");
    await expectPreviewError(service.resolveNavigation({ previewId: "pvw-anything", sessionId: "session-a" }), "PREVIEW_NOT_FOUND");
  });

  it("3xx 以 redirect_pending 准备成功，不跟随重定向", async function redirectsPending() {
    const { origin } = await startServer(302);
    const service = createService();
    const result = await service.preparePreview(prepareRequest(origin));
    const dto = await service.resolveNavigation({ previewId: result.previewId, sessionId: "session-a" });
    expect(dto.serviceState).toBe("redirect_pending");
  });

  it("公网目标不做服务端探测，serviceState 恒为 unchecked", async function skipsPublicProbe() {
    const probe = vi.fn(function noProbe() { throw new Error("公网目标不应被服务端探测"); });
    const service = createService({ probe });
    const result = await service.preparePreview(prepareRequest("https://example.com", { url: "https://example.com/docs" }));
    const dto = await service.resolveNavigation({ previewId: result.previewId, sessionId: "session-a" });
    expect(dto).toMatchObject({ sandboxProfile: "strict_public", serviceState: "unchecked", canStop: false });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("preparePreview Job 归属", function suite() {
  it("活动 Job 声明地址与目标同源且监听归属成立时准备成功并可停止", async function acceptsOwnedJob() {
    const { origin } = await startServer(200);
    const jobs = fakeJobs({ state: { status: "running", controlState: "owned", serviceUrl: origin } });
    const service = createService({ jobs });
    const result = await service.preparePreview(prepareRequest(origin, { jobId: "job-1" }));
    expect(result.jobId).toBe("job-1");
    expect(result.autoOpen).toBeUndefined();
    expect(jobs.verifyServiceOwnership).toHaveBeenCalled();
    const dto = await service.resolveNavigation({ previewId: result.previewId, sessionId: "session-a" });
    expect(dto.canStop).toBe(true);
    await service.stopPreviewJob({ previewId: result.previewId, sessionId: "session-a" });
    expect(jobs.stop).toHaveBeenCalledWith({ jobId: "job-1", source: "host" });
    await expectPreviewError(service.resolveNavigation({ previewId: result.previewId, sessionId: "session-a" }), "PREVIEW_NOT_FOUND");
  });

  it("无法证明服务归属时准备成功但只保留结果尾部入口", async function marksManualWithoutProof() {
    const { origin } = await startServer(200);
    const undeclared = await createService().preparePreview(prepareRequest(origin));
    expect(undeclared.jobId).toBeUndefined();
    expect(undeclared.autoOpen).toBe(false);

    const unowned = fakeJobs({ state: { status: "running", controlState: "owned", serviceUrl: origin, ownership: "unowned" } });
    const unownedResult = await createService({ jobs: unowned }).preparePreview(prepareRequest(origin));
    expect(unownedResult.jobId).toBeUndefined();
    expect(unownedResult.autoOpen).toBe(false);

    const unverifiable = fakeJobs({ state: { status: "running", controlState: "owned", serviceUrl: origin, ownership: "unverifiable" } });
    const unverifiableResult = await createService({ jobs: unverifiable }).preparePreview(prepareRequest(origin));
    expect(unverifiableResult.jobId).toBeUndefined();
    expect(unverifiableResult.autoOpen).toBe(false);
  });

  it("停止失败按安全语义收敛，不泄露底层错误", async function mapsStopErrors() {
    const { origin } = await startServer(200);
    const owner = fakeJobs({ state: { status: "running", controlState: "owned", serviceUrl: origin }, stopError: Object.assign(new Error("/private/raw owner"), { code: "JOB_OWNER_UNAVAILABLE" }) });
    const service = createService({ jobs: owner });
    const result = await service.preparePreview(prepareRequest(origin));
    await expectPreviewError(service.stopPreviewJob({ previewId: result.previewId, sessionId: "session-a" }), "PREVIEW_JOB_UNAVAILABLE");

    const timeout = fakeJobs({ state: { status: "running", controlState: "owned", serviceUrl: origin }, stopError: Object.assign(new Error("x"), { code: "JOB_STOP_TIMEOUT" }) });
    const service2 = createService({ jobs: timeout });
    const result2 = await service2.preparePreview(prepareRequest(origin));
    await expectPreviewError(service2.stopPreviewJob({ previewId: result2.previewId, sessionId: "session-a" }), "PREVIEW_STOP_FAILED");
  });

  it("无 jobId 的引用没有停止资格", async function refusesManualStop() {
    const { origin } = await startServer(200);
    const service = createService();
    const result = await service.preparePreview(prepareRequest(origin));
    await expectPreviewError(service.stopPreviewJob({ previewId: result.previewId, sessionId: "session-a" }), "PREVIEW_JOB_UNAVAILABLE");
  });
});

describe("CR R1：地址绑定由宿主核验，不依赖 Job 日志", function suite() {
  /** 固定就绪的探测替身：本组只验证 Job 归属判定，不依赖真实端口。 */
  const readyProbe = async function readyProbe() { return { state: "ready" } as ProbeResult; };

  it("输出中出现伪造地址不构成绑定证据：Job 未声明地址时不自动交付", async function rejectsForgedLog() {
    const service = createService({ jobs: fakeJobs(), probe: readyProbe });
    const result = await service.preparePreview(prepareRequest("http://127.0.0.1:5199", { jobId: "job-1" }));
    expect(result.jobId).toBeUndefined();
    expect(result.autoOpen).toBe(false);
  });

  it("声明地址与目标端口不同时不绑定", async function rejectsDifferentPort() {
    const service = createService({
      jobs: fakeJobs({ state: { status: "running", controlState: "owned", serviceUrl: "http://127.0.0.1:51999/" } }),
      probe: readyProbe,
    });
    const result = await service.preparePreview(prepareRequest("http://127.0.0.1:5199"));
    expect(result.jobId).toBeUndefined();
    expect(result.autoOpen).toBe(false);
  });

  it("回环别名同端口视为同一绑定", async function acceptsLoopbackAlias() {
    const service = createService({
      jobs: fakeJobs({ state: { status: "running", controlState: "owned", serviceUrl: "http://localhost:5199/" } }),
      probe: readyProbe,
    });
    const result = await service.preparePreview(prepareRequest("http://127.0.0.1:5199"));
    expect(result.jobId).toBe("job-1");
    const dto = await service.resolveNavigation({ previewId: result.previewId, sessionId: "session-a" });
    expect(dto).toMatchObject({ canStop: true, serviceState: "ready" });
  });

  it("不由本 Runtime 拥有的活动 Job 不获得自动资格", async function rejectsForeignOwner() {
    const service = createService({
      jobs: fakeJobs({ state: { status: "running", controlState: "foreign_owner", serviceUrl: "http://127.0.0.1:5199/" } }),
      probe: readyProbe,
    });
    const result = await service.preparePreview(prepareRequest("http://127.0.0.1:5199"));
    expect(result.jobId).toBeUndefined();
    expect(result.autoOpen).toBe(false);
  });

  it("准备后 Job 停止或失去归属时 resolve 不交付", async function rechecksJobOnResolve() {
    const state: FakeJobState = { status: "running", controlState: "owned", serviceUrl: "http://127.0.0.1:5199/" };
    const service = createService({ jobs: fakeJobs({ state }), probe: readyProbe });
    const result = await service.preparePreview(prepareRequest("http://127.0.0.1:5199"));
    expect(result.jobId).toBe("job-1");

    state.status = "stopped";
    state.controlState = "terminal";
    await expectPreviewError(service.resolveNavigation({ previewId: result.previewId, sessionId: "session-a" }), "PREVIEW_JOB_UNAVAILABLE");

    state.status = "running";
    state.controlState = "foreign_owner";
    await expectPreviewError(service.resolveNavigation({ previewId: result.previewId, sessionId: "session-a" }), "PREVIEW_JOB_UNAVAILABLE");
  });

  it("探测期间 Job 退出时不返回可自动交付结果", async function dropsBindingWhenJobExitsDuringProbe() {
    const state: FakeJobState = { status: "running", controlState: "owned", serviceUrl: "http://127.0.0.1:5199/" };
    const probe = async function probingProbe() {
      state.status = "stopped";
      state.controlState = "terminal";
      return { state: "ready" } as ProbeResult;
    };
    const service = createService({ jobs: fakeJobs({ state }), probe });
    const result = await service.preparePreview(prepareRequest("http://127.0.0.1:5199"));
    expect(result.jobId).toBeUndefined();
    expect(result.autoOpen).toBe(false);
  });
});

describe("缓存有界性", function suite() {
  it("取消立即停止探测", async function abortsImmediately() {
    const { origin } = await startServer(200, { hang: true });
    const controller = new AbortController();
    const service = createService({
      probe: function slowProbe(url, opts) { return probeLocalService(url, { ...opts, delayMs: 0, perTryMs: 5_000, totalMs: 60_000 }); },
    });
    const pending = service.preparePreview(prepareRequest(origin, { signal: controller.signal }));
    controller.abort();
    await expectPreviewError(pending, "PREVIEW_PROBE_ABORTED");
  });

  it("TTL 惰性过期：超期引用按 PREVIEW_EXPIRED 拒绝", async function expiresByTtl() {
    const { origin } = await startServer(200);
    const clock = { value: 1_000_000 };
    const service = createService({ clock, ttlMs: 1_000 });
    const result = await service.preparePreview(prepareRequest(origin));
    clock.value += 1_001;
    await expectPreviewError(service.resolveNavigation({ previewId: result.previewId, sessionId: "session-a" }), "PREVIEW_EXPIRED");
  });

  it("串会话引用按不存在处理，不泄露存在性", async function isolatesSessions() {
    const { origin } = await startServer(200);
    const service = createService();
    const result = await service.preparePreview(prepareRequest(origin));
    await expectPreviewError(service.resolveNavigation({ previewId: result.previewId, sessionId: "session-b" }), "PREVIEW_NOT_FOUND");
  });

  it("容量满时拒绝新引用，只淘汰已过期项且不挤掉活动预览", async function boundsCapacity() {
    const { origin } = await startServer(200);
    const clock = { value: 1_000_000 };
    const service = createService({ clock, capacity: 1, ttlMs: 1_000 });
    await service.preparePreview(prepareRequest(origin, { callId: "call-1" }));
    await expectPreviewError(service.preparePreview(prepareRequest(origin, { callId: "call-2" })), "PREVIEW_CAPACITY_REACHED");
    clock.value += 1_001;
    const result = await service.preparePreview(prepareRequest(origin, { callId: "call-3" }));
    expect(result.state).toBe("prepared");
  });

  it("同一身份重复准备原位替换，不占新容量", async function idempotentPrepare() {
    const { origin } = await startServer(200);
    const service = createService({ capacity: 1 });
    const first = await service.preparePreview(prepareRequest(origin));
    const second = await service.preparePreview(prepareRequest(origin));
    expect(second.previewId).toBe(first.previewId);
  });
});

describe("CR R2：缓存过期/重启后按权威事实重开", function suite() {
  /** 固定就绪探测：重建用例只验证事实校验与目标策略，不依赖真实端口。 */
  const readyProbe = async function readyProbe() { return { state: "ready" } as ProbeResult; };

  it("TTL 过期后同一服务按成功事实重建并重新探测", async function reopensAfterTtl() {
    const { origin } = await startServer(200);
    const clock = { value: 1_000_000 };
    const facts: WorkPreviewToolFact[] = [];
    const service = createService({ clock, ttlMs: 1_000, facts });
    const prepared = await service.preparePreview(prepareRequest(origin));
    facts.push(factFrom(prepared));

    clock.value += 1_001;
    const dto = await service.resolveNavigation({ previewId: prepared.previewId, sessionId: "session-a" });
    expect(dto).toMatchObject({ navigationUrl: prepared.copyUrl, serviceState: "ready", canStop: false });
  });

  it("Host 重启（新服务实例）后仍可重开合法公网引用且不探测", async function reopensAfterRestart() {
    const facts: WorkPreviewToolFact[] = [];
    const prepareService = createService();
    const prepared = await prepareService.preparePreview(prepareRequest("https://example.com", { url: "https://example.com/docs" }));
    facts.push(factFrom(prepared));

    const probe = vi.fn(function noProbe() { throw new Error("公网重建不应被服务端探测"); });
    const restarted = createService({ facts, probe });
    const dto = await restarted.resolveNavigation({ previewId: prepared.previewId, sessionId: "session-a" });
    expect(dto).toMatchObject({ sandboxProfile: "strict_public", serviceState: "unchecked", canStop: false });
    expect(probe).not.toHaveBeenCalled();
  });

  it("重建时复查 Job：已中断的本地 Job 拒绝交付", async function rejectsInterruptedJobAfterRestart() {
    const facts: WorkPreviewToolFact[] = [];
    const state: FakeJobState = { status: "running", controlState: "owned", serviceUrl: "http://127.0.0.1:5199/" };
    const prepareService = createService({ jobs: fakeJobs({ state }), probe: readyProbe });
    const prepared = await prepareService.preparePreview(prepareRequest("http://127.0.0.1:5199"));
    expect(prepared.jobId).toBe("job-1");
    facts.push(factFrom(prepared));

    state.status = "stopped";
    state.controlState = "terminal";
    const restarted = createService({ jobs: fakeJobs({ state }), facts, probe: readyProbe });
    await expectPreviewError(restarted.resolveNavigation({ previewId: prepared.previewId, sessionId: "session-a" }), "PREVIEW_JOB_UNAVAILABLE");
  });

  it("重建仍保留 Job 绑定并可停止", async function keepsJobBindingAfterRestart() {
    const facts: WorkPreviewToolFact[] = [];
    const state: FakeJobState = { status: "running", controlState: "owned", serviceUrl: "http://127.0.0.1:5199/" };
    const prepareService = createService({ jobs: fakeJobs({ state }), probe: readyProbe });
    const prepared = await prepareService.preparePreview(prepareRequest("http://127.0.0.1:5199"));
    facts.push(factFrom(prepared));

    const jobs = fakeJobs({ state });
    const restarted = createService({ jobs, facts, probe: readyProbe });
    const dto = await restarted.resolveNavigation({ previewId: prepared.previewId, sessionId: "session-a" });
    expect(dto.canStop).toBe(true);
    await restarted.stopPreviewJob({ previewId: prepared.previewId, sessionId: "session-a" });
    expect(jobs.stop).toHaveBeenCalledWith({ jobId: "job-1", source: "host" });
  });

  it("伪造、跨会话、身份不符或缺失事实一律按不存在处理", async function rejectsUnverifiableFacts() {
    const prepared = await createService().preparePreview(prepareRequest("https://example.com", { url: "https://example.com/docs" }));

    await expectPreviewError(
      createService({ facts: [factFrom(prepared, { previewId: "pvw-forged" })] }).resolveNavigation({ previewId: "pvw-forged", sessionId: "session-a" }),
      "PREVIEW_NOT_FOUND",
    );
    await expectPreviewError(
      createService({ facts: [factFrom(prepared)] }).resolveNavigation({ previewId: prepared.previewId, sessionId: "session-b" }),
      "PREVIEW_NOT_FOUND",
    );
    await expectPreviewError(
      createService({ facts: [factFrom(prepared, { turnId: "turn-9" })] }).resolveNavigation({ previewId: prepared.previewId, sessionId: "session-a" }),
      "PREVIEW_NOT_FOUND",
    );
    await expectPreviewError(
      createService({ facts: [] }).resolveNavigation({ previewId: prepared.previewId, sessionId: "session-a" }),
      "PREVIEW_NOT_FOUND",
    );
  });

  it("事实中的地址未通过目标策略时拒绝重建", async function rejectsUnapprovedFactTarget() {
    const prepared = await createService().preparePreview(prepareRequest("https://example.com", { url: "https://example.com/docs" }));
    const service = createService({ facts: [factFrom(prepared, { copyUrl: "http://localhost:3000/" })] });
    await expectPreviewError(service.resolveNavigation({ previewId: prepared.previewId, sessionId: "session-a" }), "PREVIEW_UNAVAILABLE");
  });

  it("缓存有效时不读取权威事实", async function skipsFactsWhileCached() {
    const { origin } = await startServer(200);
    const factsOf = vi.fn(async function facts() { return [] as WorkPreviewToolFact[]; });
    const service = createService({ factsOf });
    const prepared = await service.preparePreview(prepareRequest(origin));
    await service.resolveNavigation({ previewId: prepared.previewId, sessionId: "session-a" });
    expect(factsOf).not.toHaveBeenCalled();
  });
});

describe("目标与手动链接", function suite() {
  it("Agent 自身端口回环别名按 PREVIEW_INVALID_TARGET 拒绝", async function rejectsAgentPort() {
    const service = createService();
    await expectPreviewError(service.preparePreview(prepareRequest("http://localhost:3000", { url: "http://localhost:3000/" })), "PREVIEW_INVALID_TARGET");
    await expectPreviewError(service.preparePreview(prepareRequest("http://127.0.0.1:3000", { url: "http://127.0.0.1:3000/" })), "PREVIEW_INVALID_TARGET");
  });

  it("手动链接只校验返回导航 DTO，不探测不入缓存", async function validatesManualLink() {
    const probe = vi.fn(function noProbe() { throw new Error("手动链接不应被服务端探测"); });
    const service = createService({ probe });
    const dto = service.openManualLink("http://127.0.0.1:5173/demo");
    expect(dto).toEqual({ source: "user_link", hostLabel: "127.0.0.1:5173", navigationUrl: "http://127.0.0.1:5173/demo", sandboxProfile: "trusted_local", serviceState: "unchecked", canStop: false });
    expect(service.openManualLink("https://example.com/x#top").sandboxProfile).toBe("strict_public");
    expect(function invalidManual() { service.openManualLink("http://127.0.0.1:5173/?x=1"); }).toThrow(WorkPreviewError);
    expect(probe).not.toHaveBeenCalled();
  });
});
