/**
 * runtime/public/agent-runtime.ts — 公开 AgentRuntime 接口定义
 *
 * Phase 3 抽离：将 AgentRuntime 接口从 create-agent-runtime.ts 中分离，
 * 便于宿主以 type-only 方式引用，避免循环依赖。
 */

import type { TurnService } from "../application/turn-service";
import type { ProjectService } from "../application/project-service";
import type { SessionService } from "../application/session-service";
import type { ApprovalService } from "../application/approval-service";
import type { InputInboxService } from "../application/input-inbox-service";
import type { JobService } from "../application/job-service";
import type { UndoService } from "../application/undo-service";
import type { UserQuestionSubmissionService } from "../application/user-question-service";

/** 公开 AgentRuntime 接口；宿主通过此 Facade 访问所有 Runtime 能力。 */
export interface AgentRuntime {
  /** turn 操作服务。 */
  turns: TurnService;
  /** project 操作服务；Phase 3 新增。 */
  projects: ProjectService;
  /** session 操作服务；Phase 3 新增。 */
  sessions: SessionService;
  /** 审批服务；Phase 4 新增。 */
  approvals: ApprovalService;
  /** 持续输入收件箱服务；Phase 4 新增。 */
  inbox: InputInboxService;
  /** 结构化用户问题服务；宿主只能提交受限答案，恢复时由 TurnService 从可信 Store 读取。 */
  questions: UserQuestionSubmissionService;
  /** 受管非 PTY 后台 Job 服务。 */
  jobs: JobService;
  /** 仅供宿主显式确认入口调用的文件 rollback 能力。 */
  undo: UndoService;
  /** 宿主退出前调用，终止本 Runtime 拥有的活动 Job。 */
  shutdown?(): Promise<void>;
}

/**
 * 兼容别名；Phase 2.5 起 composition-root.ts 使用 AgentRuntimeFacade 名称。
 * 内部等同于 AgentRuntime，保留是为了不破坏既有引用。
 */
export type AgentRuntimeFacade = AgentRuntime;
