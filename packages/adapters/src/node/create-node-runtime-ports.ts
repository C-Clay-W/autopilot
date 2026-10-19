/**
 * Node Runtime Port Composition Root：用同一个显式 stateRoot 装配所有 durable Port。
 */

import { NodeChatError, createNodeIdentityError } from "./node-errors";
import { createUnavailableSandboxPort, type ProductMode, type RuntimePorts } from "@autopilot-agent/core";
import { createNodeCapabilityLoader } from "./create-node-capability-loader";
import { createNodeSandboxPort } from "./sandbox/node-sandbox-port";
import { createNodeWorkspaceAdapter } from "./workspace-adapter";
import { createNodeApprovalStore } from "./stores/node-approval-store";
import { createNodeExternalPermissionProjector } from "./settings/node-external-permission-projector";
import { createNodeHostMutationProtection } from "./host-mutation-protection";
import { createNodeCheckpointStore } from "./stores/node-checkpoint-store";
import { createNodeCredentialStore } from "./stores/node-credential-store";
import { createNodeEventSink } from "./stores/node-event-sink";
import { createNodeInputInbox } from "./stores/node-input-inbox";
import { createNodeProjectStore } from "./stores/node-project-store";
import { createNodeSessionStore } from "./stores/node-session-store";
import { createNodeTranscriptStore } from "./stores/node-transcript-store";
import { createNodeTurnStore } from "./stores/node-turn-store";
import { createNodeLeaseStore } from "./stores/node-lease-store";
import { createNodeClock } from "./stores/node-clock";
import { createNodeJobStore } from "./stores/node-job-store";
import { createNodeJobOwnerProbe } from "./job-owner-probe";
import { createNodeFileMutationStore } from "./stores/node-file-mutation-store";
import { createNodeSessionResourceStore } from "./stores/node-session-resource-store";
import { createNodeUserQuestionStore } from "./stores/node-user-question-store";
import type { NodeWorkspaceAdapterOptions, NodeStoreOptions } from "./types";

/** Node Runtime Port 的显式装配选项。 */
export interface NodeRuntimePortsOptions extends NodeStoreOptions {
  /** Chat 仅供独立存储装配入口使用，不解析或伪造工作区。 */
  productMode?: ProductMode;
  workspaceRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** trust 后确定的用户 settings 路径；仅 CredentialStore 按需读取。 */
  userSettingsPath?: string;
  /** 与TrustPolicy实际装配一致的Native信任目录，不接受请求/session覆盖。 */
  trustRoot?: string;
  /**
   * 宿主显式验证的沙箱受控 tempRoot（Talk-Plan0917：CLI 使用 Trust 后的
   * <workspace>/.autopilot/tmp）；缺省时沙箱不覆盖 SRT 的内部 TMPDIR，
   * 也不回退环境 TEMP/TMP。
   */
  sandboxTempRoot?: string;
}

/** 创建共享 Node durable Port 集合；不会从模型、请求体或 workspaceRoot 推导 stateRoot。 */
export function createNodeRuntimePorts(options: NodeRuntimePortsOptions): RuntimePorts {
  const storeOptions: NodeStoreOptions = { stateRoot: options.stateRoot };
  const workspaceOptions: NodeWorkspaceAdapterOptions = {
    workspaceRoot: options.workspaceRoot,
    cwd: options.cwd,
    env: options.env,
  };
  /** Chat 的工作区端口始终拒绝，不能回退到环境变量或 cwd。 */
  function noWorkspace(): never { throw createNodeIdentityError("WORKSPACE_REQUIRED"); }
  return {
    hostMutationProtection: options.productMode === "chat" ? undefined : createNodeHostMutationProtection(options),
    sessionStore: createNodeSessionStore({ ...storeOptions, productMode: options.productMode }),
    checkpointStore: createNodeCheckpointStore(storeOptions),
    transcriptStore: createNodeTranscriptStore(storeOptions),
    credentialStore: createNodeCredentialStore({ env: options.env, userSettingsPath: options.userSettingsPath }),
    projectStore: createNodeProjectStore(storeOptions),
    eventSink: createNodeEventSink(storeOptions),
    clock: createNodeClock(),
    workspaceAdapter: options.productMode === "chat" ? { resolveWorkspaceRoot: noWorkspace, canonicalizeWorkspaceRoot: noWorkspace, getWorkspaceInfo: noWorkspace } : createNodeWorkspaceAdapter(workspaceOptions),
    turnStore: createNodeTurnStore(storeOptions),
    approvalStore: createNodeApprovalStore(storeOptions),
    /** Work授权查询/投影复用既有Stage2端口；注入本身不产生任何grant。 */
    externalPermissionProjector: options.productMode === "chat" || options.workspaceRoot === undefined ? undefined : createNodeExternalPermissionProjector(),
    inputInbox: createNodeInputInbox(storeOptions),
    leaseStore: createNodeLeaseStore(storeOptions),
    jobStore: createNodeJobStore(storeOptions),
    jobOwnerProbe: createNodeJobOwnerProbe(),
    fileMutationStore: createNodeFileMutationStore(storeOptions),
    sessionResourceStore: options.productMode === "chat" ? {
      /** Chat 必须由独立存储入口绑定临时附件清理，缺失装配时禁止假成功。 */
      async deleteBySession() { throw new NodeChatError("CHAT_ATTACHMENT_STORE_REQUIRED"); },
    } : createNodeSessionResourceStore(options.workspaceRoot ?? options.cwd ?? process.cwd()),
    userQuestionStore: createNodeUserQuestionStore(storeOptions),
    /**
     * Stage 2：Work 模式装配真实 SRT adapter（绑定 canonical workspaceRoot；tempRoot
     * 必须由宿主显式验证后提供）；Chat 保持 unavailable stub——Chat 不开放 Work 工具，
     * 即使伪造 full_access 也不能获得进程沙箱能力。workspaceRoot 缺失时同样 fail-closed。
     */
    sandboxPort: options.productMode === "chat" || options.workspaceRoot === undefined
      ? createUnavailableSandboxPort()
      : createNodeSandboxPort({
          workspaceRoot: options.workspaceRoot,
          stateRoot: options.stateRoot,
          ...(options.sandboxTempRoot !== undefined ? { tempRoot: options.sandboxTempRoot } : {}),
        }),
  };
}

/** 创建只包含 Node Context/Skill/MCP 的能力加载器。 */
export { createNodeCapabilityLoader };
