/**
 * runtime/domain/job.ts — 受管后台 Job 的稳定领域模型。
 *
 * Job 只持久化可恢复的元数据和受限输出；真实子进程句柄严格属于当前 Runtime 内存。
 * 沙箱执行资源（executionId）只存在于 Runtime 内存并绑定 Job 终态，durable 记录
 * 只保存不含敏感明细的安全 policy 摘要。
 */
import type { SandboxPort } from "../ports";
import type { SandboxMode, SandboxPolicy } from "./sandbox-policy";

/** 当前 durable Job 记录版本；旧记录缺少该字段时按 v1 只读兼容。 */
export const JOB_RECORD_VERSION = 2 as const;

/** Job 的有限生命周期；stopping 只有确认进程树退出后才能进入 stopped。 */
export type JobStatus = "starting" | "running" | "stopping" | "completed" | "failed" | "stopped" | "interrupted";

/** Runtime 私有 owner；PID 只用于存活探测，不能作为用户停止参数。 */
export interface JobOwner {
  runtimeInstanceId: string;
  hostProcessId: number;
}

/** owner 存活探测三态；unknown 必须保守拒绝控制。 */
export type JobOwnerLiveness = "alive" | "dead" | "unknown";

/** 持久化安全输出流；offset 属于投影字符位置，不与原始 byte cursor 混用。 */
export interface JobSafeOutputStreamSnapshot {
  projectionVersion: 1;
  epoch: string;
  text: string;
  startOffset: number;
  nextOffset: number;
  truncated: boolean;
}

/** stdout/stderr 分流的安全输出快照。 */
export interface JobSafeOutputSnapshot {
  stdout: JobSafeOutputStreamSnapshot;
  stderr: JobSafeOutputStreamSnapshot;
}

/** 单流安全输出读取结果；cursor 是 Core 生成的不透明值。 */
export interface JobSafeOutputStreamView {
  text: string;
  nextCursor: string;
  startCursor: string;
  gap: boolean;
  resetRequired: boolean;
  truncated: boolean;
}

/** 面向模型或宿主的双流安全输出结果。 */
export interface JobOutputView {
  stdout: JobSafeOutputStreamView;
  stderr: JobSafeOutputStreamView;
}

/** 安全管理视图中的控制状态；终态与所有权不确定必须显式区分。 */
export type JobControlState = "owned" | "foreign_owner" | "owner_unknown" | "terminal";

/** 包装进程的可证执行阶段；缺少原生 ready 协议时目标状态只能是未知。 */
export interface JobExecutionFacts {
  phase: "wrapper_spawn_failed" | "wrapper_running" | "wrapper_exit" | "target_spawn_error_reported";
  targetState: "unknown" | "not_started";
  signal?: string;
  win32Code?: string;
}

/** Job 的最近一次安全控制事实；不保存命令、PID 或原始参数。 */
export interface JobLastControl {
  action: "stop";
  source: "agent" | "host" | "legacy_api";
  at: number;
}

/** 面向 Agent 与宿主的安全 Job 摘要；不包含 owner、PID、命令、参数或绝对路径。 */
export interface JobView {
  jobId: string;
  status: JobStatus;
  controlState: JobControlState;
  canStop: boolean;
  revision?: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  exitCode?: number;
  execution?: JobExecutionFacts;
  failureCode?: Job["failureCode"];
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
  lastControl?: JobLastControl;
}

/** 当前 Session 的有界 Job 列表。 */
export interface JobListView {
  jobs: JobView[];
  /** 当前 Session 全量记录与活动数量，独立于分页大小。 */
  totalCount?: number;
  activeCount?: number;
  nextPageCursor?: string;
}

/** 长轮询读取的确定性结果；timeout 不表示 Job 失败。 */
export interface JobReadView {
  job: JobView;
  output: JobOutputView;
  waitOutcome: "snapshot" | "terminal" | "timeout";
}

/** Job 输出的有界持久化快照；cursor 单调递增，供 poll 返回增量。 */
export interface JobOutputSnapshot {
  stdout: string;
  stderr: string;
  stdoutCursor: number;
  stderrCursor: number;
  /** 当前 durable 输出窗口可读取的最早原始字节 cursor。 */
  stdoutStartCursor: number;
  /** 当前 durable 输出窗口可读取的最早原始字节 cursor。 */
  stderrStartCursor: number;
  totalStdoutBytes: number;
  totalStderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** Job 记录随存的安全沙箱摘要；只含模式与冻结 policy 摘要，不含代理 env、完整 deny 路径或命令派生敏感数据。 */
export interface JobSandboxSummary {
  mode: SandboxMode;
  policyDigest: string;
  policyVersion: number;
}

/** 绑定 workspace 与 Session 的非 PTY 后台进程记录。 */
export interface Job {
  /** 新记录固定为 v2；缺省仅表示旧兼容记录。 */
  jobRecordVersion?: typeof JOB_RECORD_VERSION;
  id: string;
  workspaceId: string;
  sessionId: string;
  turnId?: string;
  program: string;
  args: string[];
  cwd: string;
  status: JobStatus;
  /** 新记录的私有 owner；不得进入安全 DTO。 */
  owner?: JobOwner;
  /** 新记录从 0 开始单调递增，所有更新必须条件写。 */
  revision?: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  exitCode?: number;
  execution?: JobExecutionFacts;
  failureCode?: "JOB_SPAWN_FAILED" | "JOB_STOP_FAILED" | "JOB_STOP_TIMEOUT" | "JOB_STORAGE_FAILED";
  lastControl?: JobLastControl;
  output: JobOutputSnapshot;
  /** 面向模型和宿主的安全窗口；原始输出仍只留在服务端兼容字段。 */
  safeOutput?: JobSafeOutputSnapshot;
  /** 新记录随存的冻结沙箱摘要；旧 v2 记录缺省视为无沙箱事实，不参与恢复判定。 */
  sandbox?: JobSandboxSummary;
}

/** 启动一个已通过执行期 PolicyEngine 授权的后台 Job。 */
export interface StartJobInput {
  /** 工具声明的精确外部写请求，不是权限；工具调用ID只由Core注入。 */
  externalWriteTarget?: string;
  toolCallId?: string;
  /** 仅在启动交付前取消并清理半启动进程；成功返回后不再关联 Turn 取消。 */
  signal?: AbortSignal;
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string;
  turnId?: string;
  program: string;
  args: string[];
  cwd: string;
  /** 已由 ToolExecutor 解析确认的冻结沙箱范围；后台与前台共用同一边界，缺失即 fail-closed 拒绝启动。 */
  sandbox: {
    /** 沙箱 Port；prepare/release 生命周期由 JobService 编排并与 Job 终态绑定。 */
    port: SandboxPort;
    /** 当前 Turn 冻结的沙箱策略。 */
    policy: SandboxPolicy;
  };
}

/** 读取 Job 增量输出的输入。 */
export interface PollJobInput {
  id: string;
  stdoutCursor?: number;
  stderrCursor?: number;
}

/** Job poll 的受限增量输出。 */
export interface JobPollResult {
  job: Job;
  stdout: string;
  stderr: string;
  nextStdoutCursor: number;
  nextStderrCursor: number;
  stdoutStartCursor: number;
  stderrStartCursor: number;
  truncated: boolean;
}
