/**
 * work-preview-service.ts — Work 内置预览的宿主服务。
 *
 * 每个 Workspace Context 单例（Talk-Plan0908 §7.1）：目标策略校验、工具引用归属核对、
 * Job 所有权最小验证、有界就绪缓存（TTL 30min、每工作区 64 个）与引用停止；
 * 手动链接只校验并返回导航 DTO，不做服务端探测。缓存过期或 Host 重启后，按同一会话
 * transcript 的权威成功工具事实重新校验并重建短期缓存（§7.3）。
 * 只准备导航交付，绝不读取网页内容，不创建第二套 Session/Job 存储；Job 服务延迟取自同一个 Runtime。
 */

import { createHash } from "node:crypto";
import { sameServiceOrigin, type JobView, type SessionJobService, type WorkPreviewPrepareRequest, type WorkPreviewPrepareResult } from "@autopilot-agent/core";
import { probeLocalService, type ProbeOptions, type ProbeResult } from "./work-preview-readiness";
import { normalizePreviewTarget, type PreviewSandboxProfile } from "./work-preview-target";
import type { WorkPreviewToolFact } from "./work-preview-facts";

/** 预览域稳定错误码；文案固定，不携带原始 URL、路径或底层细节。 */
export type WorkPreviewErrorCode =
  | "PREVIEW_INVALID_TARGET"
  | "PREVIEW_NOT_FOUND"
  | "PREVIEW_UNAVAILABLE"
  | "PREVIEW_EXPIRED"
  | "PREVIEW_JOB_UNAVAILABLE"
  | "PREVIEW_NOT_READY"
  | "PREVIEW_PAGE_NOT_FOUND"
  | "PREVIEW_HTTP_ERROR"
  | "PREVIEW_CONNECTION_FAILED"
  | "PREVIEW_PROBE_TIMEOUT"
  | "PREVIEW_PROBE_ABORTED"
  | "PREVIEW_CAPACITY_REACHED"
  | "PREVIEW_STOP_FAILED"
  | "PREVIEW_INTERNAL_ERROR";

/** 各错误码的固定安全文案；work-session-error 的 HTTP 映射与工具错误共用同一语义。 */
const PREVIEW_ERROR_MESSAGES: Record<WorkPreviewErrorCode, string> = {
  PREVIEW_INVALID_TARGET: "预览目标地址不符合首期支持范围",
  PREVIEW_NOT_FOUND: "预览引用不存在或不属于当前会话",
  PREVIEW_UNAVAILABLE: "预览目标当前无法在宿主内打开",
  PREVIEW_EXPIRED: "预览引用已过期，请从结果重新打开",
  PREVIEW_JOB_UNAVAILABLE: "预览关联的后台任务不可用，无法确认服务归属",
  PREVIEW_NOT_READY: "预览页面尚未就绪",
  PREVIEW_PAGE_NOT_FOUND: "预览页面不存在（HTTP 404）",
  PREVIEW_HTTP_ERROR: "预览地址返回 HTTP 错误",
  PREVIEW_CONNECTION_FAILED: "无法连接预览地址",
  PREVIEW_PROBE_TIMEOUT: "预览地址检查超时",
  PREVIEW_PROBE_ABORTED: "预览地址检查已取消",
  PREVIEW_CAPACITY_REACHED: "预览引用数量已达上限，请稍后重试",
  PREVIEW_STOP_FAILED: "预览服务停止失败",
  PREVIEW_INTERNAL_ERROR: "预览服务发生内部错误",
};

/** 带稳定错误码的预览错误；文案仅含固定文本和有界 HTTP 状态，不回显原始输入。 */
export class WorkPreviewError extends Error {
  /** 复用 Core 的可信工具错误入口，仅传固定文案与有界 HTTP 状态，不携带底层异常。 */
  readonly toolError: { code: string; message: string };
  /** 冻结安全错误与可选 HTTP 状态，让工具和 HTTP 入口复用现有错误链。 */
  constructor(public readonly code: WorkPreviewErrorCode, public readonly httpStatus?: number) {
    super(PREVIEW_ERROR_MESSAGES[code]);
    this.name = "WorkPreviewError";
    this.httpStatus = code === "PREVIEW_PAGE_NOT_FOUND" ? 404 : code === "PREVIEW_HTTP_ERROR" && Number.isInteger(httpStatus) && httpStatus! >= 400 && httpStatus! <= 599 ? httpStatus : undefined;
    if (code === "PREVIEW_HTTP_ERROR" && this.httpStatus !== undefined) this.message = `${this.message}（HTTP ${this.httpStatus}）`;
    this.toolError = { code, message: this.message };
  }
}

/** 导航 DTO 的服务状态；公网目标恒为 unchecked，服务端从不探测公网。 */
export type PreviewServiceState = "unchecked" | "probing" | "ready" | "redirect_pending" | "unavailable";

/** 工具交付引用的受限导航 DTO；只供父应用 fetch 消费，不含凭据、query 或内部映射。 */
export interface WorkPreviewNavigation {
  previewId: string;
  turnId: string;
  hostLabel: string;
  navigationUrl: string;
  sandboxProfile: PreviewSandboxProfile;
  serviceState: PreviewServiceState;
  canStop: boolean;
}

/** 手动链接的受限导航 DTO；纯导航校验结果，不创建工具事实或 Job。 */
export interface WorkManualLinkNavigation {
  source: "user_link";
  hostLabel: string;
  navigationUrl: string;
  sandboxProfile: PreviewSandboxProfile;
  serviceState: "unchecked";
  canStop: false;
}

/** 短期运行缓存中的引用记录：只保存就绪状态与到 Job 的当前绑定。 */
interface PreviewRef {
  previewId: string;
  sessionId: string;
  turnId: string;
  navigationUrl: string;
  hostLabel: string;
  sandboxProfile: PreviewSandboxProfile;
  openWhen: "now" | "after_turn";
  jobId?: string;
  serviceState: PreviewServiceState;
  lastAccessAt: number;
}

/** 预览服务创建选项；jobsOf 延迟取得同一 Runtime 的 scoped Job 服务，供测试注入替身。 */
export interface CreateWorkPreviewServiceOptions {
  /** 当前 Workspace Context 的 canonical 根目录；能力请求归属必须一致。 */
  workspaceRoot: string;
  /** Agent 自身监听 authority 列表，用于拒绝把管理 API/页面嵌入预览。 */
  agentAuthorities: readonly string[];
  /** 按 Session 取得 scoped Job 服务；Runtime bootstrap 完成前不会被调用。 */
  jobsOf: (sessionId: string) => SessionJobService;
  /** 按 Session 读取同一 Work 会话的权威成功工具事实；缺失时过期/重启后不提供重建。 */
  factsOf?: (sessionId: string) => Promise<readonly WorkPreviewToolFact[]>;
  /** 时钟，默认 Date.now；供 fake clock 测试。 */
  now?: () => number;
  /** 就绪探测实现；默认 probeLocalService，测试注入合成实现或收窄预算。 */
  probe?: (url: string, options?: ProbeOptions) => Promise<ProbeResult>;
  /** 缓存 TTL，默认 30 分钟。 */
  ttlMs?: number;
  /** 每工作区引用容量上限，默认 64。 */
  capacity?: number;
}

/** Web Work 预览服务：prepare（工具路径）/ resolve+stop（受限 API）/ openManualLink（手动路径）。 */
export interface WebWorkPreviewService {
  preparePreview(request: WorkPreviewPrepareRequest): Promise<WorkPreviewPrepareResult>;
  resolveNavigation(input: { previewId: string; sessionId: string }): Promise<WorkPreviewNavigation>;
  stopPreviewJob(input: { previewId: string; sessionId: string }): Promise<{ previewId: string; state: "stopped" }>;
  openManualLink(url: string): WorkManualLinkNavigation;
}

/** 由身份四元组派生稳定不透明 previewId；同一调用重复准备不新建导航。 */
function stablePreviewId(workspaceRoot: string, sessionId: string, turnId: string, callId: string): string {
  return "pvw-" + createHash("sha256").update(`${workspaceRoot}|${sessionId}|${turnId}|${callId}`).digest("hex").slice(0, 24);
}

/** 判断字符串是否为 URL 安全的不透明标识。 */
function isOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** 活动且由本 Runtime 拥有的 Job；只有这类记录才可能成为预览归属候选。 */
function isOwnedActiveJob(job: JobView): boolean {
  return (job.status === "running" || job.status === "starting") && job.controlState === "owned";
}

/** 创建 Workspace Context 内单例的预览服务；缓存与探测全部有界，宿主重启即清空。 */
export function createWorkPreviewService(options: CreateWorkPreviewServiceOptions): WebWorkPreviewService {
  const now = options.now ?? function currentTime() { return Date.now(); };
  const probe = options.probe ?? probeLocalService;
  const ttlMs = options.ttlMs ?? 30 * 60 * 1_000;
  const capacity = options.capacity ?? 64;
  const refs = new Map<string, PreviewRef>();

  /** 惰性清理已过 TTL 的引用；只淘汰过期项，不静默挤掉活动预览。 */
  function evictExpired(): void {
    const cutoff = now() - ttlMs;
    for (const [id, ref] of refs) {
      if (ref.lastAccessAt <= cutoff) refs.delete(id);
    }
  }

  /** 核对请求归属并按冻结目标策略规范化；失败统一抛稳定错误码。 */
  function requireApprovedTarget(request: WorkPreviewPrepareRequest) {
    if (request.workspaceId !== options.workspaceRoot) throw new WorkPreviewError("PREVIEW_UNAVAILABLE");
    const target = normalizePreviewTarget(request.url, options.agentAuthorities);
    if (!target.ok) throw new WorkPreviewError("PREVIEW_INVALID_TARGET");
    return target.target;
  }

  /**
   * 核验声明绑定的当前有效性：Job 仍活动且由本 Runtime 拥有、声明地址与目标精确同源，
   * 并且该端口的当前监听者属于该 Job 的进程树。无法证明（unverifiable）同样视为不成立。
   */
  async function verifyBoundJob(sessionId: string, jobId: string, navigationUrl: string): Promise<boolean> {
    const jobs = options.jobsOf(sessionId);
    try {
      const listed = await jobs.list({ limit: 100 });
      const job = listed.jobs.find(function sameJob(item) { return item.jobId === jobId; });
      if (!job || !isOwnedActiveJob(job) || !job.serviceUrl || !sameServiceOrigin(job.serviceUrl, navigationUrl)) return false;
      return (await jobs.verifyServiceOwnership({ jobId, serviceUrl: job.serviceUrl })) === "owned";
    } catch {
      return false;
    }
  }

  /**
   * 在当前 Session 活动且 owned 的 Job 中寻找唯一能被证明监听该目标的 Job。
   * 没有匹配、多个匹配或任何一步无法证明时都不返回绑定（取消自动交付，退回显式手动确认）。
   */
  async function bindOwnedJob(sessionId: string, navigationUrl: string): Promise<string | undefined> {
    let listed: { jobs: readonly JobView[] };
    try {
      listed = await options.jobsOf(sessionId).list({ limit: 100 });
    } catch {
      return undefined;
    }
    const candidates = listed.jobs.filter(function declaresTarget(job) {
      return isOwnedActiveJob(job) && job.serviceUrl !== undefined && sameServiceOrigin(job.serviceUrl, navigationUrl);
    });
    const owned: string[] = [];
    for (const candidate of candidates) {
      if (await verifyBoundJob(sessionId, candidate.jobId, navigationUrl)) owned.push(candidate.jobId);
    }
    return owned.length === 1 ? owned[0] : undefined;
  }

  /** 写入短期引用：同身份原位替换，否则先淘汰过期项再检查容量上限。 */
  function rememberRef(ref: PreviewRef): void {
    if (refs.has(ref.previewId)) {
      refs.set(ref.previewId, ref);
      return;
    }
    evictExpired();
    if (refs.size >= capacity) throw new WorkPreviewError("PREVIEW_CAPACITY_REACHED");
    refs.set(ref.previewId, ref);
  }

  /** 从同一会话的权威成功工具事实查找引用；没有事实 seam 或读取失败时按无事实处理。 */
  async function findFact(previewId: string, sessionId: string): Promise<WorkPreviewToolFact | undefined> {
    if (!options.factsOf) return undefined;
    try {
      const facts = await options.factsOf(sessionId);
      return facts.find(function samePreview(fact) { return fact.previewId === previewId; });
    } catch {
      return undefined;
    }
  }

  /**
   * 缓存缺失或过期时按同会话权威成功工具事实重建短期引用（§7.3）：
   * 校验 previewId 与 {sessionId, turnId, callId} 的稳定派生关系，再经目标策略、Job 归属与就绪复查。
   */
  async function rebuildRef(previewId: string, sessionId: string, expired: boolean): Promise<PreviewRef> {
    const fact = await findFact(previewId, sessionId);
    // 有事实 seam 时一律按不存在处理，不泄露存在性；未装配 seam 的旧宿主保持过期语义。
    const missingCode = options.factsOf === undefined && expired ? "PREVIEW_EXPIRED" : "PREVIEW_NOT_FOUND";
    if (!fact || stablePreviewId(options.workspaceRoot, sessionId, fact.turnId, fact.callId) !== previewId) {
      throw new WorkPreviewError(missingCode);
    }
    // 只使用权威事实中的宿主批准地址，绝不用浏览器自报 URL 重建目标。
    const target = normalizePreviewTarget(fact.copyUrl, options.agentAuthorities);
    if (!target.ok) throw new WorkPreviewError("PREVIEW_UNAVAILABLE");

    let serviceState: PreviewServiceState = "unchecked";
    if (target.target.sandboxProfile === "trusted_local") {
      const result = await probe(target.target.navigationUrl, { perTryMs: 2_000, maxAttempts: 1, delayMs: 0 });
      serviceState = result.state === "ready" ? "ready" : result.state === "redirect_pending" ? "redirect_pending" : "unavailable";
      // 原 Job 停止/失去归属/绑定失效时拒绝交付，也不能认领同地址的新 Job。
      if (fact.jobId !== undefined && !(await verifyBoundJob(sessionId, fact.jobId, target.target.navigationUrl))) throw new WorkPreviewError("PREVIEW_JOB_UNAVAILABLE");
    }
    const ref: PreviewRef = {
      previewId,
      sessionId,
      turnId: fact.turnId,
      navigationUrl: target.target.navigationUrl,
      hostLabel: target.target.hostLabel,
      sandboxProfile: target.target.sandboxProfile,
      openWhen: fact.openWhen,
      ...(fact.jobId !== undefined ? { jobId: fact.jobId } : {}),
      serviceState,
      lastAccessAt: now(),
    };
    rememberRef(ref);
    return ref;
  }

  return {
    /** 准备预览：目标校验 → Job 归属最小验证 → 有界就绪探测 → 稳定引用入缓存。 */
    async preparePreview(request: WorkPreviewPrepareRequest): Promise<WorkPreviewPrepareResult> {
      if (!isOpaqueId(request.sessionId) || !isOpaqueId(request.turnId)) throw new WorkPreviewError("PREVIEW_UNAVAILABLE");
      if (request.callId.length === 0 || request.callId.length > 256) throw new WorkPreviewError("PREVIEW_UNAVAILABLE");
      const target = requireApprovedTarget(request);

      // 就绪探测仅针对已批准本地目标；公网目标不做任何服务端访问，交付后由浏览器加载。
      let serviceState: PreviewServiceState = "unchecked";
      if (target.sandboxProfile === "trusted_local") {
        const result = await probe(target.navigationUrl, { signal: request.signal });
        if (result.state === "ready") serviceState = "ready";
        else if (result.state === "redirect_pending") serviceState = "redirect_pending";
        else {
          const code = result.reason === "http_status" ? result.status === 404 ? "PREVIEW_PAGE_NOT_FOUND" : "PREVIEW_HTTP_ERROR"
            : result.reason === "timeout" ? "PREVIEW_PROBE_TIMEOUT"
              : result.reason === "aborted" ? "PREVIEW_PROBE_ABORTED" : "PREVIEW_CONNECTION_FAILED";
          throw new WorkPreviewError(code, result.status);
        }
      }

      // 地址归属必须在探测之后由宿主证明：Job 声明地址 → 活动/ownership → 监听者属于该 Job。
      // 模型声明的 jobId、Job 日志与 HTTP 200 都不能单独认领服务；无法证明时只保留结果尾部入口。
      const jobId = target.sandboxProfile === "trusted_local" ? await bindOwnedJob(request.sessionId, target.navigationUrl) : undefined;
      const autoOpen = target.sandboxProfile !== "trusted_local" || jobId !== undefined;

      const previewId = stablePreviewId(options.workspaceRoot, request.sessionId, request.turnId, request.callId);
      const ref: PreviewRef = {
        previewId,
        sessionId: request.sessionId,
        turnId: request.turnId,
        navigationUrl: target.navigationUrl,
        hostLabel: target.hostLabel,
        sandboxProfile: target.sandboxProfile,
        openWhen: request.openWhen,
        ...(jobId !== undefined ? { jobId } : {}),
        serviceState,
        lastAccessAt: now(),
      };
      // 同一身份重复准备（重试）原位替换，不新建导航、不占新容量。
      rememberRef(ref);
      return {
        previewId,
        hostLabel: target.hostLabel,
        copyUrl: target.copyUrl,
        openWhen: request.openWhen,
        state: "prepared",
        ...(jobId !== undefined ? { jobId } : {}),
        ...(autoOpen ? {} : { autoOpen: false }),
      };
    },

    /** 从引用解析受限导航 DTO；缓存过期/缺失时按权威事实重建，跨会话引用一律按不存在处理。 */
    async resolveNavigation(input: { previewId: string; sessionId: string }): Promise<WorkPreviewNavigation> {
      let ref = refs.get(input.previewId);
      if (ref && ref.sessionId !== input.sessionId) throw new WorkPreviewError("PREVIEW_NOT_FOUND");
      let expired = false;
      if (ref && now() - ref.lastAccessAt > ttlMs) {
        refs.delete(input.previewId);
        ref = undefined;
        expired = true;
      }
      if (!ref) ref = await rebuildRef(input.previewId, input.sessionId, expired);
      ref.lastAccessAt = now();
      if (ref.sandboxProfile === "trusted_local") {
        // 打开面板前的快速就绪复查：单次短超时，探测失败仅标记 unavailable，不销毁引用。
        const result = await probe(ref.navigationUrl, { perTryMs: 2_000, maxAttempts: 1, delayMs: 0 });
        ref.serviceState = result.state === "ready" ? "ready" : result.state === "redirect_pending" ? "redirect_pending" : "unavailable";
        // 探测完成后再复查活动/归属/监听绑定，覆盖探测期间退出与端口重用；失配即不向 iframe 交付。
        if (ref.jobId !== undefined && !(await verifyBoundJob(ref.sessionId, ref.jobId, ref.navigationUrl))) {
          throw new WorkPreviewError("PREVIEW_JOB_UNAVAILABLE");
        }
      } else {
        ref.serviceState = "unchecked";
      }
      return {
        previewId: ref.previewId,
        turnId: ref.turnId,
        hostLabel: ref.hostLabel,
        navigationUrl: ref.navigationUrl,
        sandboxProfile: ref.sandboxProfile,
        serviceState: ref.serviceState,
        canStop: ref.jobId !== undefined,
      };
    },

    /** 停止引用拥有的受管 Job；只能停止本计划关联且归属当前会话的 Job，终态后移除引用。 */
    async stopPreviewJob(input: { previewId: string; sessionId: string }): Promise<{ previewId: string; state: "stopped" }> {
      const ref = refs.get(input.previewId);
      if (!ref || ref.sessionId !== input.sessionId) throw new WorkPreviewError("PREVIEW_NOT_FOUND");
      if (!ref.jobId) throw new WorkPreviewError("PREVIEW_JOB_UNAVAILABLE");
      const jobs = options.jobsOf(input.sessionId);
      try {
        await jobs.stop({ jobId: ref.jobId, source: "host" });
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "JOB_OWNER_UNAVAILABLE" || code === "JOB_OWNER_UNKNOWN" || code === "JOB_STATE_CONFLICT") {
          throw new WorkPreviewError("PREVIEW_JOB_UNAVAILABLE");
        }
        throw new WorkPreviewError("PREVIEW_STOP_FAILED");
      }
      refs.delete(input.previewId);
      return { previewId: input.previewId, state: "stopped" };
    },

    /** 手动链接只校验目标策略并返回导航 DTO；不探测、不入缓存、不关联 Job。 */
    openManualLink(url: string): WorkManualLinkNavigation {
      const target = normalizePreviewTarget(url, options.agentAuthorities);
      if (!target.ok) throw new WorkPreviewError("PREVIEW_INVALID_TARGET");
      return {
        source: "user_link",
        hostLabel: target.target.hostLabel,
        navigationUrl: target.target.navigationUrl,
        sandboxProfile: target.target.sandboxProfile,
        serviceState: "unchecked",
        canStop: false,
      };
    },
  };
}
