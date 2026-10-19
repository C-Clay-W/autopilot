/**
 * work-job-controller.ts — 当前可见 Work Session 的后台 Job 请求与轮询控制器。
 *
 * 控制器只消费 Web 安全 DTO；请求代次、AbortController 与定时器共同阻止迟到覆盖和孤儿轮询。
 */

import type { JobListView, JobReadView, JobView } from "@autopilot-agent/core";

export type WorkJobLoadState = "idle" | "loading" | "ready" | "error";

/** UI 读取的后台任务不可变快照。 */
export interface WorkJobSnapshot {
  state: WorkJobLoadState;
  jobs: readonly JobView[];
  totalCount?: number;
  activeCount?: number;
  nextPageCursor?: string;
  error?: string;
  selectedJobId?: string;
  selected?: JobReadView;
  detailError?: string;
  stoppingJobId?: string;
  terminalNotice?: string;
}

/** 控制器对 React 层提供的最小操作。 */
export interface WorkJobController {
  getSnapshot(): WorkJobSnapshot;
  subscribe(listener: () => void): () => void;
  setActive(active: boolean, turnRunning: boolean, visible?: boolean): void;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  open(jobId: string): Promise<void>;
  close(): void;
  stop(jobId: string): Promise<void>;
  dispose(): void;
}

type WorkJobTimer = ReturnType<typeof setTimeout> | number;

/** 可替换依赖只供确定性测试控制请求与时间，不进入生产调用参数。 */
export interface CreateWorkJobControllerOptions {
  workspaceId: string;
  sessionId: string;
  fetchImpl?: typeof fetch;
  setTimer?: (callback: () => void, delay: number) => WorkJobTimer;
  clearTimer?: (timer: WorkJobTimer) => void;
}

const ACTIVE_STATES = new Set<JobView["status"]>(["starting", "running", "stopping"]);
const OUTPUT_TEXT_LIMIT = 32 * 1_024;
const RETRY_DELAYS = [2_000, 4_000, 8_000, 15_000] as const;

/** 返回 Job API 的双重编码基础地址，不允许调用方拼接任意路径。 */
function createBaseUrl(workspaceId: string, sessionId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/jobs`;
}

/** 将未知 Web 错误收敛为用户可见固定摘要，不显示服务端原始细节。 */
async function readFailure(response: Response, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(function invalidBody() { return undefined; });
  return body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string"
    ? (body as { error: string }).error
    : fallback;
}

/** 裁剪 UI 累积文本，避免长任务让 DOM 和 React state 无限增长。 */
function appendBounded(current: string, next: string, gap: boolean): string {
  const combined = `${current}${gap && current ? "\n…较早输出不可用…\n" : ""}${next}`;
  return combined.length <= OUTPUT_TEXT_LIMIT ? combined : `…仅显示最近输出…\n${combined.slice(-OUTPUT_TEXT_LIMIT)}`;
}

/** 合并增量安全输出；cursor reset 时丢弃旧窗口，不能把不连续内容伪装成连续日志。 */
function mergeRead(previous: JobReadView | undefined, next: JobReadView): JobReadView {
  if (!previous || previous.job.jobId !== next.job.jobId) return next;
  return {
    ...next,
    output: {
      stdout: {
        ...next.output.stdout,
        text: next.output.stdout.resetRequired
          ? next.output.stdout.text
          : appendBounded(previous.output.stdout.text, next.output.stdout.text, next.output.stdout.gap),
      },
      stderr: {
        ...next.output.stderr,
        text: next.output.stderr.resetRequired
          ? next.output.stderr.text
          : appendBounded(previous.output.stderr.text, next.output.stderr.text, next.output.stderr.gap),
      },
    },
  };
}

/** 创建只绑定一个 workspace/session 的控制器；切换身份时由 React 销毁旧实例。 */
export function createWorkJobController(options: CreateWorkJobControllerOptions): WorkJobController {
  const fetchImpl = options.fetchImpl ?? fetch;
  const schedule: (callback: () => void, delay: number) => WorkJobTimer = options.setTimer ?? function scheduleTimer(callback, delay) { return setTimeout(callback, delay); };
  const cancelTimer: (timer: WorkJobTimer) => void = options.clearTimer ?? function cancelScheduledTimer(timer) { clearTimeout(timer as ReturnType<typeof setTimeout>); };
  const baseUrl = createBaseUrl(options.workspaceId, options.sessionId);
  const listeners = new Set<() => void>();
  const observedActive = new Map<string, boolean>();
  let snapshot: WorkJobSnapshot = { state: "idle", jobs: [] };
  let active = false;
  let visible = true;
  let turnRunning = false;
  let disposed = false;
  let initialized = false;
  let retryIndex = 0;
  let revision = 0;
  let listAbort: AbortController | undefined;
  let detailAbort: AbortController | undefined;
  let listTimer: WorkJobTimer | undefined;
  let detailTimer: WorkJobTimer | undefined;
  let detailHasMore = false;

  /** 独立列表、详情和停止响应只允许单调推进同一 Job 的状态。 */
  function latestJob(incoming: JobView): JobView {
    const known = snapshot.jobs.find(function sameJob(job) { return job.jobId === incoming.jobId; });
    return known && (known.revision ?? -1) > (incoming.revision ?? -1) ? known : incoming;
  }

  /** 发布不可变快照，仅在语义变化时通知 React 订阅者。 */
  function publish(patch: Partial<WorkJobSnapshot>): void {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(function notify(listener) { listener(); });
  }

  /** 清除下一次列表轮询，不影响正在运行的 Runtime Turn 或 Job。 */
  function clearListTimer(): void {
    if (listTimer !== undefined) cancelTimer(listTimer);
    listTimer = undefined;
  }

  /** 清除下一次日志轮询，不把关闭详情解释为停止 Job。 */
  function clearDetailTimer(): void {
    if (detailTimer !== undefined) cancelTimer(detailTimer);
    detailTimer = undefined;
  }

  /** 根据活动任务、空列表运行中探测及失败退避安排下一次摘要读取。 */
  function scheduleList(delay?: number): void {
    clearListTimer();
    if (!active || !visible || disposed) return;
    const hasActive = snapshot.jobs.some(function isActive(job) { return ACTIVE_STATES.has(job.status); });
    const nextDelay = delay ?? (hasActive ? 2_000 : turnRunning ? 5_000 : undefined);
    if (nextDelay === undefined) return;
    listTimer = schedule(function pollList() { void refresh(); }, nextDelay);
  }

  /** 活动详情每秒读取增量；终态或不可见时立即停止。 */
  function scheduleDetail(): void {
    clearDetailTimer();
    if (!active || !visible || disposed || !snapshot.selectedJobId || !snapshot.selected || (!ACTIVE_STATES.has(snapshot.selected.job.status) && !detailHasMore)) return;
    detailTimer = schedule(function pollDetail() { void readSelected(snapshot.selectedJobId!); }, 1_000);
  }

  /** 比较本页面已观察的活动状态，只为实时跨入终态的 Job 生成文字提醒。 */
  function observeTerminalTransitions(jobs: readonly JobView[]): string | undefined {
    let notice: string | undefined;
    jobs.forEach(function observe(job) {
      const isActive = ACTIVE_STATES.has(job.status);
      if (observedActive.get(job.jobId) && !isActive) notice = job.status === "completed" ? "后台任务已完成" : "后台任务已结束，请查看详情";
      observedActive.set(job.jobId, isActive);
    });
    return notice;
  }

  /** 读取当前选中 Job 的安全输出；请求代次变化时丢弃迟到结果。 */
  async function readSelected(jobId: string): Promise<void> {
    detailAbort?.abort();
    const controller = new AbortController();
    detailAbort = controller;
    const requestRevision = revision;
    const previous = snapshot.selected?.job.jobId === jobId ? snapshot.selected : undefined;
    const query = new URLSearchParams();
    if (previous?.output.stdout.nextCursor) query.set("stdoutCursor", previous.output.stdout.nextCursor);
    if (previous?.output.stderr.nextCursor) query.set("stderrCursor", previous.output.stderr.nextCursor);
    try {
      const response = await fetchImpl(`${baseUrl}/${encodeURIComponent(jobId)}/output${query.size ? `?${query}` : ""}`, { signal: controller.signal, cache: "no-store" });
      console.log(response);
      if (!response.ok) throw new Error(await readFailure(response, "无法读取后台任务输出"));
      const next = await response.json() as JobReadView;
      if (disposed || controller.signal.aborted || requestRevision !== revision || snapshot.selectedJobId !== jobId) return;
      detailHasMore = [next.output.stdout, next.output.stderr].some(function hasRemaining(stream) { return stream.truncated && stream.text.length > 0; });
      next.job = latestJob(next.job);
      const selected = mergeRead(previous, next);
      const knownJob = snapshot.jobs.some(function isSelectedJob(job) { return job.jobId === selected.job.jobId; });
      const jobs = knownJob
        ? snapshot.jobs.map(function updateJob(job) { return job.jobId === selected.job.jobId ? selected.job : job; })
        : [selected.job, ...snapshot.jobs];
      publish({ selected, jobs, detailError: undefined });
      scheduleDetail();
      scheduleList();
    } catch (error) {
      if (disposed || controller.signal.aborted || requestRevision !== revision || snapshot.selectedJobId !== jobId) return;
      publish({ detailError: error instanceof Error ? error.message : "无法读取后台任务输出" });
      scheduleList(RETRY_DELAYS[Math.min(retryIndex, RETRY_DELAYS.length - 1)]);
    }
  }

  /** 读取当前页摘要；同类请求不重叠，失败按 2/4/8/15 秒退避。 */
  async function refresh(): Promise<void> {
    if (disposed || !options.sessionId || listAbort) return;
    const controller = new AbortController();
    listAbort = controller;
    const requestRevision = revision;
    if (!initialized) publish({ state: "loading", error: undefined });
    try {
      const response = await fetchImpl(`${baseUrl}?limit=20`, { signal: controller.signal, cache: "no-store" });
      console.log(response);
      if (!response.ok) throw new Error(await readFailure(response, "无法读取后台任务"));
      const data = await response.json() as JobListView;
      if (disposed || controller.signal.aborted || requestRevision !== revision) return;
      data.jobs = data.jobs.map(latestJob);
      const notice = initialized ? observeTerminalTransitions(data.jobs) : (data.jobs.forEach(function seed(job) { observedActive.set(job.jobId, ACTIVE_STATES.has(job.status)); }), undefined);
      initialized = true;
      retryIndex = 0;
      const selected = snapshot.selected && data.jobs.find(function findSelected(job) { return job.jobId === snapshot.selected?.job.jobId; });
      publish({ state: "ready", jobs: data.jobs, totalCount: data.totalCount, activeCount: data.activeCount, selected: selected ? { ...snapshot.selected!, job: selected } : snapshot.selected, nextPageCursor: data.nextPageCursor, error: undefined, terminalNotice: notice });
      scheduleList();
    } catch (error) {
      if (disposed || controller.signal.aborted || requestRevision !== revision) return;
      const delay = RETRY_DELAYS[Math.min(retryIndex, RETRY_DELAYS.length - 1)];
      retryIndex = Math.min(retryIndex + 1, RETRY_DELAYS.length - 1);
      publish({ state: "error", error: error instanceof Error ? error.message : "无法读取后台任务" });
      scheduleList(delay);
    } finally {
      if (listAbort === controller) listAbort = undefined;
    }
  }

  /** 使用服务端签名 cursor 加载下一页，只追加未出现的 Job。 */
  async function loadMore(): Promise<void> {
    const cursor = snapshot.nextPageCursor;
    if (!cursor || disposed || listAbort) return;
    const controller = new AbortController();
    listAbort = controller;
    const requestRevision = revision;
    try {
      const response = await fetchImpl(`${baseUrl}?limit=20&pageCursor=${encodeURIComponent(cursor)}`, { signal: controller.signal, cache: "no-store" });
      console.log(response);
      if (!response.ok) throw new Error(await readFailure(response, "无法加载更多后台任务"));
      const data = await response.json() as JobListView;
      if (disposed || controller.signal.aborted || requestRevision !== revision) return;
      const known = new Set(snapshot.jobs.map(function jobId(job) { return job.jobId; }));
      publish({ jobs: [...snapshot.jobs, ...data.jobs.filter(function newJob(job) { return !known.has(job.jobId); })], nextPageCursor: data.nextPageCursor, error: undefined });
    } catch (error) {
      if (!controller.signal.aborted && requestRevision === revision) publish({ error: error instanceof Error ? error.message : "无法加载更多后台任务" });
    } finally {
      if (listAbort === controller) listAbort = undefined;
    }
  }

  /** 打开详情并立即读取；关闭旧请求不会停止目标 Job。 */
  async function open(jobId: string): Promise<void> {
    if (disposed) return;
    detailAbort?.abort();
    clearDetailTimer();
    detailHasMore = false;
    publish({ selectedJobId: jobId, selected: undefined, detailError: undefined, terminalNotice: undefined });
    await readSelected(jobId);
  }

  /** 关闭详情、终止浏览器读取并保留后台 Job 本身。 */
  function close(): void {
    detailAbort?.abort();
    detailAbort = undefined;
    clearDetailTimer();
    publish({ selectedJobId: undefined, selected: undefined, detailError: undefined, stoppingJobId: undefined });
  }

  /** 发送精确人工停止请求；只锁目标 Job，失败保留详情和可重试入口。 */
  async function stop(jobId: string): Promise<void> {
    if (disposed || snapshot.stoppingJobId) return;
    detailAbort?.abort();
    clearDetailTimer();
    publish({ stoppingJobId: jobId, detailError: undefined });
    try {
      const response = await fetchImpl(`${baseUrl}/${encodeURIComponent(jobId)}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      console.log(response);
      if (!response.ok) throw new Error(await readFailure(response, "无法停止后台任务"));
      const data = await response.json() as { job: JobView };
      if (disposed) return;
      data.job = latestJob(data.job);
      publish({
        jobs: snapshot.jobs.map(function updateJob(job) { return job.jobId === data.job.jobId ? data.job : job; }),
        selected: snapshot.selected?.job.jobId === data.job.jobId ? { ...snapshot.selected, job: data.job } : snapshot.selected,
        stoppingJobId: undefined,
      });
      await refresh();
      if (snapshot.selectedJobId === jobId) await readSelected(jobId);
    } catch (error) {
      if (disposed) return;
      publish({ stoppingJobId: undefined, detailError: error instanceof Error ? error.message : "无法停止后台任务" });
    }
  }

  /** 仅当前可见 Work 激活轮询；隐藏/切换只取消 HTTP，不停止 Job 或 Turn SSE。 */
  function setActive(nextActive: boolean, nextTurnRunning: boolean, nextVisible = true): void {
    disposed = false;
    const becameReadable = nextActive && nextVisible && (!active || !visible);
    active = nextActive;
    visible = nextVisible;
    turnRunning = nextTurnRunning;
    if (!active || !visible) {
      revision += 1;
      listAbort?.abort();
      detailAbort?.abort();
      listAbort = undefined;
      detailAbort = undefined;
      clearListTimer();
      clearDetailTimer();
      return;
    }
    if (becameReadable || !initialized) {
      void refresh();
      if (snapshot.selectedJobId) void readSelected(snapshot.selectedJobId);
    }
    else {
      scheduleList();
      scheduleDetail();
    }
  }

  /** 释放组件拥有的请求和定时器，不影响共享 Runtime 或后台 Job。 */
  function dispose(): void {
    disposed = true;
    active = false;
    revision += 1;
    listAbort?.abort();
    detailAbort?.abort();
    listAbort = undefined;
    detailAbort = undefined;
    clearListTimer();
    clearDetailTimer();
    listeners.clear();
  }

  return {
    getSnapshot: function getSnapshot() { return snapshot; },
    subscribe: function subscribe(listener) { listeners.add(listener); return function unsubscribe() { listeners.delete(listener); }; },
    setActive,
    refresh,
    loadMore,
    open,
    close,
    stop,
    dispose,
  };
}
