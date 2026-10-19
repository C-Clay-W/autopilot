/**
 * runtime/ports — Runtime 层 Port 统一出口
 */

import type { SessionStore } from "./session-store";
import type { CheckpointStore } from "./checkpoint-store";
import type { TranscriptStore } from "./transcript-store";
import type { CredentialStore } from "./credential-store";
import type { ProjectStore } from "./project-store";
import type { EventSink } from "./event-sink";
import type { Clock } from "./clock";
import type { WorkspaceAdapter, WorkspaceInfo } from "./workspace-adapter";
import type { TurnStore } from "./turn-store";
import type { ApprovalStore } from "./approval-store";
import type { InputInbox } from "./input-inbox";
import type { LeaseStore } from "./lease-store";
import type { JobStore } from "./job-store";
import type { JobOwnerProbe } from "./job-owner-probe";
import type { FileMutationStore } from "./file-mutation-store";
import type { SessionResourceStore } from "./session-resource-store";
import type { UserQuestionStore } from "./user-question-store";
import type { SandboxPort } from "./sandbox-port";
import type { ExternalPermissionProjector } from "./external-permission-projector";
import type { HostMutationProtection } from "./host-mutation-protection";
export type { HostMutationProtection, ProtectedMutationTarget } from "./host-mutation-protection";

export type { SessionStore, CheckpointStore, TranscriptStore, CredentialStore, ProjectStore, EventSink, Clock, WorkspaceAdapter, WorkspaceInfo, TurnStore, ApprovalStore, InputInbox, LeaseStore, JobStore, JobOwnerProbe, FileMutationStore, SessionResourceStore, UserQuestionStore, ExternalPermissionProjector };
export type { ExternalPermissionSnapshot } from "./external-permission-projector";
export type { JobStoreWriteCondition } from "./job-store";
export type { GetUserQuestionInput, SaveUserQuestionAnswerInput, SaveUserQuestionAnswerResult } from "./user-question-store";
export type { SandboxPort } from "./sandbox-port";
export { SandboxPortError, createUnavailableSandboxPort } from "./sandbox-port";

/** Runtime 依赖的所有 Port 集合。 */
export interface RuntimePorts {
  /** Native宿主权威/配置位置保护；缺省仅兼容不持有文件权威的旧/Memory宿主。 */
  hostMutationProtection?: HostMutationProtection;
  sessionStore: SessionStore;
  checkpointStore: CheckpointStore;
  transcriptStore: TranscriptStore;
  credentialStore: CredentialStore;
  projectStore: ProjectStore;
  eventSink: EventSink;
  clock: Clock;

  /** WorkspaceAdapter 在 Phase 2.5 加入，用于解析 canonical 工作区根目录。 */
  workspaceAdapter: WorkspaceAdapter;

  /** TurnStore 在 Phase 3 加入，存储 Turn 实体与冻结的 FrozenRunConfig。 */
  turnStore: TurnStore;

  /** ApprovalStore 在 Phase 4 加入，存储审批决策与持久授权。 */
  approvalStore: ApprovalStore;

  /** InputInbox 在 Phase 4 加入，存储 steer / queue 持续输入。 */
  inputInbox: InputInbox;

  /** LeaseStore 在 Step 4 加入，管理跨宿主 Session Turn ownership。 */
  leaseStore: LeaseStore;

  /** Stage 14 的 Job durable store；进程句柄仍由 Runtime 内存管理。 */
  jobStore: JobStore;

  /** Stage1 owner 宿主进程三态探测；不提供 kill 或 Runtime 接管。 */
  jobOwnerProbe: JobOwnerProbe;

  /** Stage 15 的私有 Undo WAL/blob store；不得投影至 checkpoint 或普通事件。 */
  fileMutationStore: FileMutationStore;

  /** Session 删除时必须同步清理的宿主外围资源，例如 Web 图片附件。 */
  sessionResourceStore: SessionResourceStore;

  /** AskUserQuestion 的问题与私有答案 Store；Browser 不得绕过对应 Service。 */
  userQuestionStore: UserQuestionStore;

  /**
   * Stage 1 起为 mandatory：进程沙箱执行边界。真实 backend 未接入时必须显式提供
   * createUnavailableSandboxPort()（fail-closed），不允许缺省裸跑。
   */
  sandboxPort: SandboxPort;

  /**
   * Talk-Plan1013 Stage 2：外部权限规则投影；缺省时 allow_workspace 外部授权保持 pending，
   * 不会自动放行（fail-safe），只影响"记住"能力，不影响审批本身。
   */
  externalPermissionProjector?: ExternalPermissionProjector;
}
