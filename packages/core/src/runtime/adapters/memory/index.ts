/**
 * runtime/adapters/memory — 内存适配器统一出口
 *
 * 用于 Runtime contract test 与不依赖持久化的 headless smoke。
 */

export { MemorySessionStore } from "./memory-session-store";
export { MemoryCheckpointStore } from "./memory-checkpoint-store";
export { MemoryTranscriptStore } from "./memory-transcript-store";
export { MemoryCredentialStore } from "./memory-credential-store";
export { MemoryProjectStore } from "./memory-project-store";
export { MemoryEventSink } from "./memory-event-sink";
export { DefaultClock } from "./default-clock";
export { MemoryWorkspaceAdapter } from "./memory-workspace-adapter";
export { MemoryTurnStore } from "./memory-turn-store";
export { MemoryApprovalStore } from "./memory-approval-store";
export { MemoryInputInbox } from "./memory-input-inbox";
export { MemoryLeaseStore } from "./memory-lease-store";
export { MemoryJobStore } from "./memory-job-store";
export { MemoryFileMutationStore } from "./memory-file-mutation-store";
export { MemorySessionResourceStore } from "./memory-session-resource-store";
export { MemoryUserQuestionStore } from "./memory-user-question-store";

import type { RuntimePorts } from "../../ports";
import { createUnavailableSandboxPort } from "../../ports/sandbox-port";
import { MemorySessionStore } from "./memory-session-store";
import { MemoryCheckpointStore } from "./memory-checkpoint-store";
import { MemoryTranscriptStore } from "./memory-transcript-store";
import { MemoryCredentialStore } from "./memory-credential-store";
import { MemoryProjectStore } from "./memory-project-store";
import { MemoryEventSink } from "./memory-event-sink";
import { DefaultClock } from "./default-clock";
import { MemoryWorkspaceAdapter } from "./memory-workspace-adapter";
import { MemoryTurnStore } from "./memory-turn-store";
import { MemoryApprovalStore } from "./memory-approval-store";
import { MemoryInputInbox } from "./memory-input-inbox";
import { MemoryLeaseStore } from "./memory-lease-store";
import { MemoryJobStore } from "./memory-job-store";
import { MemoryFileMutationStore } from "./memory-file-mutation-store";
import { MemorySessionResourceStore } from "./memory-session-resource-store";
import { MemoryUserQuestionStore } from "./memory-user-question-store";

/** 返回一组全新的内存适配器；每次调用互相隔离，保证测试独立性。 */
export function createMemoryPorts(workspaceRoot = "/tmp/test-workspace"): RuntimePorts {
  return {
    sessionStore: new MemorySessionStore(),
    checkpointStore: new MemoryCheckpointStore(),
    transcriptStore: new MemoryTranscriptStore(),
    credentialStore: new MemoryCredentialStore(),
    projectStore: new MemoryProjectStore(),
    eventSink: new MemoryEventSink(),
    clock: new DefaultClock(),
    workspaceAdapter: new MemoryWorkspaceAdapter(workspaceRoot),
    turnStore: new MemoryTurnStore(),
    approvalStore: new MemoryApprovalStore(),
    inputInbox: new MemoryInputInbox(),
    leaseStore: new MemoryLeaseStore(),
    jobStore: new MemoryJobStore(),
    jobOwnerProbe: {
      /** 内存宿主不判断外部 PID；同进程 Runtime 身份由 Core 注册表判定。 */
      async probe() { return "unknown"; },
    },
    fileMutationStore: new MemoryFileMutationStore(),
    sessionResourceStore: new MemorySessionResourceStore(),
    userQuestionStore: new MemoryUserQuestionStore(),
    /** 内存宿主无沙箱 backend；fail-closed stub 保证工具执行期不可能静默裸跑。 */
    sandboxPort: createUnavailableSandboxPort(),
  };
}
