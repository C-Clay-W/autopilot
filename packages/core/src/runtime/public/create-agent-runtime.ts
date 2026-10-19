/**
 * runtime/public/create-agent-runtime.ts — 公开 Runtime Facade 工厂
 *
 * 宿主（Web / CLI / Desktop）通过该函数创建共享 AgentRuntime，
 * 只需注入 Port 实现，不再直接操作 Kernel 或内部 Runtime。
 *
 * Phase 3 新增 projects / sessions 服务；modelSamplerFactory 留给 Step 7 后续接入。
 */

import { createTurnService } from "../application/turn-service";
import type { TurnService } from "../application/turn-service";
import { createProjectService } from "../application/project-service";
import { createSessionService } from "../application/session-service";
import { createApprovalService } from "../application/approval-service";
import { createInputInboxService } from "../application/input-inbox-service";
import { createUserQuestionService } from "../application/user-question-service";
import type { RuntimePorts } from "../ports";
import type { RunConfig } from "../protocol";
import type { AgentRuntime } from "./agent-runtime";
import { createJobService } from "../application/job-service";
import { createUndoService } from "../application/undo-service";

/** 创建 Runtime 所需参数。 */
export interface CreateAgentRuntimeOptions {
  /** 外部实现的 Port 集合。 */
  ports: RuntimePorts;

  /** 默认运行配置；单次 turn 可覆盖。 */
  defaultRunConfig?: RunConfig;

  /** 仅拥有结构化回答入口的宿主启用 AskUserQuestion；CLI 默认不启用。 */
  enableUserQuestions?: boolean;
}

/** 创建公开 AgentRuntime 实例。 */
export function createAgentRuntime(options: CreateAgentRuntimeOptions): AgentRuntime {
  const { ports, defaultRunConfig, enableUserQuestions = false } = options;
  const approvalService = createApprovalService({
    approvalStore: ports.approvalStore,
    checkpointStore: ports.checkpointStore,
    transcriptStore: ports.transcriptStore,
    turnStore: ports.turnStore,
    clock: ports.clock,
    // Talk-Plan1013 Stage 2：外部权限规则投影；缺省时 allow_workspace 外部授权保持 pending。
    externalRuleProjector: ports.externalPermissionProjector,
  });
  const inputInboxService = createInputInboxService(ports.inputInbox);
  const userQuestionService = createUserQuestionService({ questionStore: ports.userQuestionStore, checkpointStore: ports.checkpointStore, turnStore: ports.turnStore, clock: ports.clock });
  const jobs = createJobService({ store: ports.jobStore, ownerProbe: ports.jobOwnerProbe, sessionStore: ports.sessionStore, projectStore: ports.projectStore, now: () => ports.clock.now() });
  const turns: TurnService = createTurnService(ports, defaultRunConfig, approvalService, inputInboxService, jobs, userQuestionService, enableUserQuestions);
  const projects = createProjectService(ports.projectStore);
  const sessions = createSessionService(ports, jobs);
  const undo = createUndoService(ports);
  return {
    turns,
    projects,
    sessions,
    approvals: {
      submit: approvalService.submit,
      getDecision: approvalService.getDecision,
      hasPersistentGrant: approvalService.hasPersistentGrant,
      listPersistentGrants: approvalService.listPersistentGrants,
      revokePersistentGrant: approvalService.revokePersistentGrant,
    },
    inbox: inputInboxService,
    questions: userQuestionService,
    jobs,
    undo,
    // 生命周期顺序（Talk-Plan0917 Stage 2）：先终止本 Runtime 全部 Job 与其进程树，
    // 最后 shutdown 沙箱 backend，确保代理/ACL 等平台资源在进程资源结束之后释放。
    shutdown: async () => {
      await jobs.shutdown();
      await ports.sandboxPort.shutdown();
    },
  };
}
