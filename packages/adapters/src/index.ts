/**
 * @autopilot-agent/adapters — 跨宿主共享的 Node Runtime Port 与 capability 实现。
 *
 * 本入口只暴露 Node 文件存储、Workspace/Trust、Clock、Context/Skill/MCP loader；
 * Web HTTP、SSE、React DTO 和 CLI 进程生命周期不属于本包。
 */

export { NodeChatError, NodeStateError } from "./node/node-errors";
export type { NodeChatErrorCode, NodeStateErrorCode, NodeStateRecoveryDiagnostic } from "./node/node-errors";
export { createNodeRuntimePorts } from "./node/create-node-runtime-ports";
export { createNodeChatStorage } from "./node/create-node-chat-storage";
export type { CreateNodeChatStorageOptions, NodeChatStorage } from "./node/create-node-chat-storage";
export { resolveNodeChatStatePaths } from "./node/chat-state";
export type { NodeChatStatePaths } from "./node/chat-state";
export { createNodeChatCapabilityLoader, NODE_CHAT_KNOWLEDGE_SPACE_ID } from "./node/create-node-chat-capability-loader";
export type { NodeChatCapabilityLoaderOptions } from "./node/create-node-chat-capability-loader";
export { createNodeChatAttachmentStore, CHAT_ATTACHMENT_TTL_MS } from "./node/stores/node-chat-attachment-store";
export type { NodeChatAttachmentStore, NodeChatAttachmentStoreOptions, NodeChatAttachment, NodeChatParsedDocument } from "./node/stores/node-chat-attachment-store";
export { createNodeJobStore } from "./node/stores/node-job-store";
export { createNodeJobOwnerProbe } from "./node/job-owner-probe";
export { createNodeFileMutationStore } from "./node/stores/node-file-mutation-store";
export { createNodeSessionResourceStore } from "./node/stores/node-session-resource-store";
export { createNodeUserQuestionStore } from "./node/stores/node-user-question-store";
export type { NodeRuntimePortsOptions } from "./node/create-node-runtime-ports";
export { createNodeSandboxPort, serializePosixCommand, buildSrtRuntimeConfig } from "./node/sandbox/node-sandbox-port";
export type { NodeSandboxPortOptions } from "./node/sandbox/node-sandbox-port";
export { readWindowsSandboxCapability, runWindowsSandboxSetup } from "./node/sandbox/windows-sandbox-setup";
export type { WindowsSandboxSetupOptions } from "./node/sandbox/windows-sandbox-setup";
export { createNodeCapabilityLoader } from "./node/create-node-capability-loader";
export type { NodeCapabilityLoader } from "./node/create-node-capability-loader";
export { createNodeRagRuntime } from "./node/rag/node-rag-runtime";
export type { CreateNodeRagRuntimeOptions } from "./node/rag/node-rag-runtime";
export { createNodeSettingsLoader, resolveNodeSettingsPaths, resolveNodeUserSettingsPath } from "./node/settings/node-settings-loader";
export type { CreateNodeSettingsLoaderOptions, LoadedNodeSettings, LoadedNodeUserSettings, NodeSettingsLoader, NodeUserSettingsLoader, NodeSettingsPaths } from "./node/settings/node-settings-loader";
export { ensureUserConfigDirectory, UserConfigDirectoryError } from "./node/settings/user-config-directory";
export type { EnsureUserConfigDirectoryOptions, UserConfigDirectoryErrorCode } from "./node/settings/user-config-directory";
export { createNodeSettingsWriter } from "./node/settings/node-settings-writer";
export type { NodeSettingsWriter } from "./node/settings/node-settings-writer";
export { createNodeExternalPermissionProjector } from "./node/settings/node-external-permission-projector";
export type { CreateNodeExternalPermissionProjectorOptions } from "./node/settings/node-external-permission-projector";
export { isSafeSettingsFile } from "./node/settings/node-settings-loader";
export { createNodeUserSettingsService, NodeUserSettingsError } from "./node/settings/node-user-settings-service";
export type { MainModelCatalogResult, MainSettingsCategoryInput, MainSettingsCategoryUpdate, RagSettingsCategoryConnectionInput, RagSettingsCategoryInput, UserSettingsStatus, UserSettingsWriteResult, WebSearchSettingsCategoryInput } from "./node/settings/node-user-settings-service";
export { getNodeMemoryDirectory, getNodeMemoryWorkspaceId, getLegacyWebMemoryDirectory, retrieveNodeMemories } from "./node/capabilities/memory-retriever";
export { loadMcpConfigFromWorkspace } from "./node/capabilities/mcp-loader";
export { discoverInstructions } from "./node/capabilities/instruction-store";
export type { InstructionDiscovery, NodeFrozenInstruction } from "./node/capabilities/instruction-store";
export { createContextBudget, estimateTokens, DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_COMPACT_TRIGGER_RATIO, DEFAULT_COMPACT_TARGET_RATIO } from "./node/capabilities/context-budget";
export type { NodeContextBudgetSnapshot } from "./node/capabilities/context-budget";
export { createSkillsCapability } from "./node/capabilities/skill-discovery";

export { createNodeWorkspaceAdapter } from "./node/workspace-adapter";
export { createNodeTrustPolicy, createNodeTrustStore } from "./node/trust-policy";
export type { NodeTrustEntry } from "./node/trust-policy";
export { createNodeWorkspaceRegistry } from "./node/workspace-registry";
export type { WorkspaceRegistry, WorkspaceRegistryEntry } from "./node/workspace-registry";
export { canonicalizeNodePath, createNodeWorkspaceId, getNodeStatePaths, resolveNodeGlobalStateRoot, resolveNodeStateRoot, resolveNodeTrustRoot, ensureNodeStateRoot, initializeNodeStateRoot, assertNodeStateSchema, getNodeStateCorruptionDiagnostics, getNodeStateSchemaDiagnostic, NODE_STATE_SCHEMA_VERSION, NODE_WORKSPACE_ID_VERSION } from "./node/state-root";
export type { NodeStateCorruptionDiagnostic, NodeStatePaths } from "./node/state-root";
export { createNodeStateSchemaManager } from "./node/state-schema-manager";
export type { CreateNodeStateSchemaManagerOptions, NodeStateSchemaDiagnostic, NodeStateSchemaManager, NodeStateSchemaMigration } from "./node/state-schema-manager";

export { createNodeApprovalStore } from "./node/stores/node-approval-store";
export { createNodeCheckpointStore } from "./node/stores/node-checkpoint-store";
export { createNodeCredentialStore } from "./node/stores/node-credential-store";
export type { CreateNodeCredentialStoreOptions } from "./node/stores/node-credential-store";
export { createNodeEventSink } from "./node/stores/node-event-sink";
export { createNodeInputInbox } from "./node/stores/node-input-inbox";
export { createNodeLeaseStore } from "./node/stores/node-lease-store";
export { createNodeProjectStore } from "./node/stores/node-project-store";
export { createNodeSessionStore } from "./node/stores/node-session-store";
export type { NodeSessionStoreOptions } from "./node/stores/node-session-store";
export { createNodeTranscriptStore } from "./node/stores/node-transcript-store";
export { createNodeTurnStore } from "./node/stores/node-turn-store";
export { createNodeClock } from "./node/stores/node-clock";
export type { NodeCapabilityLoaderOptions, NodeStoreOptions, NodeTrustPolicyOptions, NodeWorkspaceAdapterOptions } from "./node/types";
