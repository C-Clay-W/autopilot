/**
 * @autopilot-agent/core — 稳定公开 API 入口
 *
 * 本文件只暴露宿主（Web / CLI / Desktop）需要的稳定能力：
 * - RAG Agent：createRAGAgent() / createAgent()
 * - Runtime Facade：createAgentRuntime()（Phase 2 新增）
 * - 数据库快照：createDatabaseSnapshot() / getDefaultDatabaseSource()
 * - 工作区文件枚举：listWorkspaceFiles()（供 CLI @文件提及等宿主候选索引）
 * - 必要的公共 DTO 类型
 *
 * 实验性底层能力（Kernel、工具构造函数等）已迁移到 `@autopilot-agent/core/experimental`。
 * 旧导出（ingestExcel 等）保留向后兼容。
 */
import { loadInternalModule, AgentFlow } from "./internal/agent-flow";
import { toRagError, type RagErrorCode } from "./internal/rag-error";
import {
  deleteKnowledgeResource as deleteKnowledgeResourceInternal,
  listKnowledgeResources as listKnowledgeResourcesInternal,
} from "./internal/lib/vector-store";
import { createAgentRuntime, type AgentOptions as InternalAgentOptions, type RagCapability } from "./internal/agent-runtime";
import type { ChatMessage, VectorOutput } from "./internal/types";
import { createReadFileTool } from "./internal/tools/builtins/read-file-tool";
import { ToolExecutor } from "./internal/tools/tool-executor";
import { ToolRegistry } from "./internal/tools/tool-registry";
import type { ToolEvent, ToolExecutionOptions, ToolExecutionRequest, ToolExecutionResult, ToolModelDefinition, ToolPermissionMode } from "./internal/tools/types";

// ── 类型导出 ────────────────────────────────────

export type {
  VectorInput,
  VectorOutput,
  ChatMessage,
  AgentToolCall,
} from "./internal/types";

export type { AgentCompactionResult, AgentInjectedInput, AgentInputInboxCapability, AgentLease, AgentRunInput, RagCapability } from "./internal/agent-runtime";
export type { CreateDatabaseSearchCapabilityOptions, DatabaseAggregationKeyword, DatabaseFilterOperatorKeyword, DatabaseQueryPlan, DatabaseQueryPlannerInput, DatabaseQueryProfile, DatabaseSearchCapability, DatabaseSearchPolicy, DatabaseSearchRequest, DatabaseSearchResult, RagSourcePolicy } from "./internal/database-search";

// ── Runtime 公开 Facade（Phase 2 / Phase 3）───────────
export { createAgentRuntime } from "./runtime/public";
export { JOB_RECORD_VERSION, normalizeJobServiceUrl, jobServicePort, sameServiceOrigin } from "./runtime/domain";
export type { AgentRuntime, AgentRuntimeFacade, CreateAgentRuntimeOptions } from "./runtime/public";
export type {
  Session,
  SessionPersistenceMode,
  SessionStatus,
  Project,
  CreateProjectInput,
  CredentialRef,
  ResolvedCredential,
  ModelRef,
  ReasoningEffort,
  ReasoningProfile,
  SessionRunConfig,
  FrozenRunConfig,
  Turn,
  TurnStatus,
  Job,
  JobStatus,
  JobOwner,
  JobOwnerLiveness,
  JobControlState,
  JobExecutionFacts,
  JobLastControl,
  JobView,
  JobListView,
  JobReadView,
  JobOutputSnapshot,
  JobSafeOutputSnapshot,
  JobSafeOutputStreamSnapshot,
  JobSafeOutputStreamView,
  JobOutputView,
  StartJobInput,
  PollJobInput,
  JobPollResult,
  FileMutation,
  FileMutationOperation,
  FileMutationStatus,
  PrepareFileMutationInput,
  UndoTransaction,
  ApprovalDecision,
  PersistentGrant,
  SubmitApprovalInput,
  FindPersistentGrantInput,
  UserQuestionOption,
  UserQuestionItem,
  UserQuestionAnswerItem,
  UserQuestionRequest,
  UserQuestionAnswer,
  StoredUserQuestion,
  TodoStatus,
  TodoItem,
  TodoCounts,
  TodoSnapshot,
  TodoWriteResult,
  InboxInput,
  InboxDelivery,
  InboxStatus,
  InboxBoundary,
  InboxAttachmentRef,
  InboxSkillRef,
  PostInboxInput,
  DrainInboxInput,
  ClaimNextInboxInput,
  ConsumeInboxInput,
  ListInboxInput,
} from "./runtime/domain";
export type {
  AgentEvent,
  AgentEventEnvelope,
  CreateEventEnvelopeInput,
  AgentContentBlock,
  AgentJsonObject,
  AgentMessage,
  AgentMessageRole,
  AgentToolPairingScan,
  AgentCheckpoint,
  PublicCheckpointView,
  RunConfig,
  ProviderRuntimeSettings,
  CompactPolicy,
  LimitConfig,
  ResolvedAgentRuntimeLimits,
  AgentRuntimeSafetyLimits,
  ResolveRunConfigInput,
  StartTurnInput,
  ContinueTurnInput,
  CancelTurnInput,
  SteerTurnInput,
  CompactTurnInput,
  CompactTurnResult,
  FrozenRunConfigView,
  AgentTerminationBudget,
  AgentTerminationReason,
  AgentTerminationView,
  RecoverableTurnStatus,
  RecoverableApprovalView,
  RecoverableTurnView,
  AgentErrorCode,
  McpCapability,
  McpServerConfig,
  WebCapability,
  WebFetchCapability,
  WebFetchCapabilityErrorCode,
  WebFetchResult,
  WebSearchCapability,
  WebSearchCapabilityErrorCode,
  WebSearchResult,
  WebSearchSource,
  AgentMessageMigrationFailure,
  AgentMessageMigrationResult,
  AgentMessageMigrationSuccess,
} from "./runtime/protocol";
export {
  AgentRuntimeError,
  WebFetchCapabilityError,
  WebSearchCapabilityError,
  parseMcpConfig,
  getMcpServerConfigHash,
  getMcpServerGrantConstraint,
  resolveRunConfig,
  AGENT_RUNTIME_LIMIT_DEFAULTS,
  AGENT_RUNTIME_LIMIT_HARD_LIMITS,
  AGENT_RUNTIME_SAFETY_DEFAULTS,
  AGENT_RUNTIME_SAFETY_HARD_LIMITS,
  resolveAgentRuntimeLimits,
  resolveAgentRuntimeSafetyLimits,
  resolveLimitConfig,
  createEventEnvelope,
  sanitizeAgentTerminationView,
  sanitizeCheckpoint,
  sanitizeEventForExternal,
  sanitizeAgentMessagesForExternal,
  migrateAgentMessages,
  CanonicalMessageError,
  isAgentToolPairingBalancedAt,
  isAgentToolPairingBalancedBefore,
  normalizeAgentMessages,
  scanAgentToolPairing,
  validateAgentMessages,
} from "./runtime/protocol";
export type {
  RuntimePorts,
  SessionStore,
  CheckpointStore,
  TranscriptStore,
  CredentialStore,
  ProjectStore,
  EventSink,
  Clock,
  WorkspaceAdapter,
  WorkspaceInfo,
  TurnStore,
  ApprovalStore,
  InputInbox,
  LeaseStore,
  JobStore,
  JobOwnerProbe,
  JobStoreWriteCondition,
  FileMutationStore,
  SessionResourceStore,
  UserQuestionStore,
  GetUserQuestionInput,
  SaveUserQuestionAnswerInput,
  SaveUserQuestionAnswerResult,
  SandboxPort,
  ExternalPermissionProjector,
  ExternalPermissionSnapshot,
} from "./runtime/ports";
export { SandboxPortError, createUnavailableSandboxPort } from "./runtime/ports";
export type {
  SandboxMode,
  SandboxEnforcement,
  SandboxPolicy,
  SandboxCapabilityReport,
  SandboxExecutionRequest,
  SandboxPreparedCommand,
  ManagedExecutionControl,
  ManagedExecutionChannel,
  SandboxErrorCode,
} from "./runtime/domain";
export {
  SANDBOX_ERROR_CODES,
  SANDBOX_POLICY_VERSION,
  isSandboxPolicyDenialCode,
  isSandboxAvailabilityFailureCode,
  resolveSandboxMode,
  computeSandboxPolicyDigest,
} from "./runtime/domain";
export {
  EXTERNAL_FILE_CONSTRAINT_PREFIX,
  isExternalFileConstraint,
  externalFileConstraintTarget,
  formatExternalFileRule,
  parseExternalPermissionRule,
  isValidExternalPermissionRule,
  externalRuleCoversRule,
} from "./runtime/domain";
export type { ExternalFileOperation, ParsedExternalPermissionRule } from "./runtime/domain";
export type { ProjectService } from "./runtime/application/project-service";
export type { SessionService, CreateSessionInput } from "./runtime/application/session-service";
export type { TurnService, TurnState } from "./runtime/application/turn-service";
export type { ApprovalService } from "./runtime/application/approval-service";
export type { InputInboxService } from "./runtime/application/input-inbox-service";
export type { JobService, SessionJobService } from "./runtime/application/job-service";
export type { UndoService, UndoPreview, UndoResult } from "./runtime/application/undo-service";
export type { UserQuestionService, UserQuestionSubmissionService, AgentUserQuestionCapability, CreateUserQuestionRequestInput, SubmitUserQuestionAnswerInput } from "./runtime/application/user-question-service";
export {
  MemorySessionStore,
  MemoryCheckpointStore,
  MemoryTranscriptStore,
  MemoryCredentialStore,
  MemoryProjectStore,
  MemoryEventSink,
  DefaultClock,
  MemoryWorkspaceAdapter,
  MemoryTurnStore,
  MemoryApprovalStore,
  MemoryInputInbox,
  MemoryJobStore,
  MemoryFileMutationStore,
  MemorySessionResourceStore,
  MemoryUserQuestionStore,
  createMemoryPorts,
} from "./runtime/adapters/memory";

// ── Provider 抽象（Phase 3 / Talk-Plan0805 准备工作）─────────────────
export type { ModelSamplerFactory, CreateModelSamplerInput, ModelSamplerFactoryOptions } from "./runtime/provider/model-sampler-factory";
export type { FrozenProviderConfig } from "./runtime/provider/frozen-provider-config";
export type { ApiProtocol, ProtocolProfile, ProviderRouteProfile, ProviderProtocolAdapter, ProviderProtocolAdapterInput } from "./runtime/provider";
export { ProviderProtocolAdapterRegistry } from "./runtime/provider";
export {
  createDefaultModelSamplerFactory,
  createConfiguredModelSampler,
  createFirstPartyModelSampler,
  listModelCapabilities,
  getModelCapability,
  createVisionAnalyzer,
  resolveFirstPartyModelSampleOptions,
  resolveModelSampleOptions,
  createDefaultModelBehaviorProfile,
} from "./runtime/provider";
export type {
  CreateFirstPartyModelSamplerInput,
  ModelCapability,
  VisionAnalyzer,
  FirstPartyEffortSource,
  ResolvedFirstPartyModelSample,
  ModelBehaviorProfile,
} from "./runtime/provider";
export {
  normalizeProviderBaseUrl,
  resolveAutopilotSettings,
  isExternalPermissionDiagnostic,
} from "./runtime/config/autopilot-settings";
export type {
  AutopilotSettingsScope,
  AutopilotSettingsSource,
  ResolvedAutopilotSettings,
  ResolvedExternalPermissionSettings,
  ResolvedFirstPartySettings,
  ResolvedRagConnectionSettings,
  ResolvedRagSettings,
  ResolvedSandboxSettings,
  ResolvedWebSearchSettings,
  RagConnectionRole,
  SettingsDiagnostic,
} from "./runtime/config/autopilot-settings";
export type { ModelSampleOptions } from "./internal/types";
export type { CompletionDecision, CompletionIntentSignal, CompletionPolicy, CompletionPolicyState } from "./internal/kernel/completion-policy";
export { createMutationCompletionPolicy } from "./internal/kernel/completion-policy";
// Context Usage 安全展示 DTO（Talk-Plan0828 Stage 1）：只导出类型，不导出私有 anchor 与投影实现。
export type {
  ContextUsageBreakdownView,
  ContextUsageCategoryKind,
  ContextUsageCategoryView,
  ContextUsageView,
} from "./internal/kernel/context-budget";

// ── Runtime Bootstrap / Trust（Phase 2.5）───────────
export {
  createRuntimeBootstrapService,
  createSafeBootstrapConfig,
  WorkspaceTrustError,
} from "./runtime/bootstrap";
export type {
  CapabilityLoader,
  CreateRuntimeBootstrapServiceOptions,
  RuntimeBootstrapService,
  SafeBootstrapConfig,
  WorkspaceTrustEntry,
  WorkspaceTrustPolicy,
  WorkspaceTrustStatus,
} from "./runtime/bootstrap";
export type { AgentContextSnapshot, ContextBudgetSnapshot, FrozenInstruction, FrozenMemorySnippet } from "./internal/agent-context";
export type { AgentSkillsCapability, LoadedSkill, PreparedSkillCommand, SkillCatalogEntry, SkillDiscoveryCandidate, SkillResource } from "./internal/tools/builtins/skill-tool";
export type { ModelSampler } from "./internal/kernel/model-sampler";
export { createDefaultModelSampler } from "./internal/kernel/model-sampler";

export type {
  IngestOptions,
  IngestResult,
  IngestProgressEvent,
  ParseExcelOptions,
  AskStreamOptions,
  SheetInfo,
} from "./internal/agent-flow";

export type {
  ToolApprovalDecision,
  ApprovalDisplayFacts,
  ToolDisplayDetail,
  ToolJobDisplayFacts,
  ToolDisplayFacts,
  ToolApprovalRequest,
  ToolError,
  ToolEvent,
  ToolExecutionMeta,
  ToolExecutionOptions,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolInterruptionState,
  ToolModelDefinition,
  ToolPermissionMode,
  ToolActionFacts,
  ToolPolicyResult,
} from "./internal/tools/types";

export type {
  RerankOutcome,
  RerankPolicy,
  RerankResult,
  RerankRuntime,
  RerankVisionImage,
} from "./internal/lib/rerank";

export type {
  RerankRole,
  RerankDocument,
  RerankProviderRequest,
  RerankProviderResult,
  RerankProviderAdapter,
} from "./internal/lib/rerank-provider";

export type {
  DatabaseErrorCode,
} from "./internal/database-error";

export {
  DatabaseError,
  DATABASE_ERROR_CODES,
  readDatabaseErrorCode,
  toDatabaseError,
} from "./internal/database-error";

export type {
  DatabaseInspection,
  DatabaseSnapshotConfig,
  DatabaseSnapshotReadCapability,
  DatabaseSyncResult,
  MySQLSourceConfig,
  SnapshotColumnDescription,
  SnapshotQueryResult,
  SnapshotTableDescription,
} from "./internal/database-snapshot";

export type { DeleteKnowledgeResourceResult, KnowledgeResource } from "./internal/lib/vector-store";
export { createKnowledgeResourceId, deriveKnowledgeTableName, isKnowledgeResourceId } from "./internal/knowledge-resource-store";
export type { KnowledgeResourceManifest, KnowledgeResourceStatus, PdfPageMetadata, RagEvidence, TableProfile } from "./internal/knowledge-resource-store";
export type { RagStorageOptions } from "./internal/rag-storage";
export type { RagErrorCode } from "./internal/rag-error";
export { RagError, RAG_ERROR_CODES, readRagErrorCode, toRagError } from "./internal/rag-error";

export { createDatabaseSnapshot, getDefaultDatabaseSource } from "./internal/database-snapshot";
export { createDatabaseSearchCapability } from "./internal/database-search";

// ── 工作区文件枚举（CLI @文件提及候选索引）───────────
export { listWorkspaceFiles } from "./internal/tools/workspace-files";
export type { ListWorkspaceFilesInput, ListWorkspaceFilesResult } from "./internal/tools/workspace-files";

// Windows 包管理器共享受信解析：Node Adapter 沙箱路径与 Core 直执路径共用。
export { resolveWindowsPackageManagerCommand } from "./internal/tools/process-utils";

/** 创建 RAG Agent 时可选注入的工具运行边界；未传 workspaceRoot 时 RAG 仍可正常使用。 */
export interface RAGAgentOptions {
  workspaceRoot?: string;
  permissionMode?: ToolPermissionMode;
  onToolEvent?: (event: ToolEvent) => void;
  /** Workspace 级 RAG 根；Web 正式路径在 Trust 后显式注入。 */
  storage?: import("./internal/rag-storage").RagStorageOptions;
  /** 专用 Rerank 运行时；真实 Key 只能由服务端闭包按需解析。 */
  rerank?: import("./internal/agent-flow").AgentFlowRerankOptions;
  /** 文本与多模态 Embedding 独立运行连接；按单次操作冻结。 */
  embedding?: import("./internal/agent-flow").AgentFlowEmbeddingOptions;
}

/** Excel 入库选项（旧名，向后兼容，推荐用 IngestOptions + type: 'excel'） */
export interface ExcelIngestOptions {
  tableName?: string;
  clearFirst?: boolean;
  headerRow?: number;
  sheetName?: string;
}

/** Excel 入库结果（旧名，向后兼容，推荐用 IngestResult） */
export interface ExcelIngestResult {
  tableName: string;
  totalRows: number;
  columns: string[];
  previewRows: Record<string, unknown>[];
}

/** RAG 查询器接口 */
export interface RAGQuerier {
  query: (prompt: string) => Promise<string>;
}

/** RAG Agent 实例接口 */
export interface RAGAgent {
  /** 统一入库入口 — 按 options.type 分发 */
  ingest: (filePath: string, options: import("./internal/agent-flow").IngestOptions) => Promise<import("./internal/agent-flow").IngestResult>;
  /** 仅解析 Excel 为行数据 */
  parseExcelFile: (filePath: string, options?: import("./internal/agent-flow").ParseExcelOptions) => Promise<Record<string, unknown>[]>;
  /** 列出 Excel 工作表名称 */
  listExcelSheets: (filePath: string) => Promise<string[]>;
  /** 获取 Excel 工作表概览 */
  getExcelSheetInfo: (filePath: string, sheetName?: string) => Promise<import("./internal/agent-flow").SheetInfo>;
  /** 读取受控存储目录中的图片二进制，供应用层安全展示 PDF 来源图 */
  getStoredImage: (fileName: string) => Promise<{ buffer: Buffer; mimeType: string }>;
  /** 从原子 manifest 枚举当前 Workspace 的资源。 */
  listResources: () => Promise<import("./internal/knowledge-resource-store").KnowledgeResourceManifest[]>;
  /** 显式从 LanceDB 重建当前 Workspace 的持久关键词索引。 */
  rebuildLexicalIndexes: (tableName?: string) => Promise<{ tableName: string; recordCount: number }[]>;
  /** 删除当前 Workspace 的单个 manifest 资源。 */
  deleteResource: (resourceId: string) => Promise<{ resourceId: string; deleted: boolean; deletedRecordCount: number }>;
  /** 通过资源身份读取有界文本或图片预览，不接受存储路径。 */
  getResourcePreview: (resourceId: string, signal?: AbortSignal) => Promise<{ buffer: Buffer; mimeType: string }>;
  /** 从原始 PDF 按需渲染单页预览。 */
  getPdfPageImage: (resourceId: string, pageNumber: number, signal?: AbortSignal) => Promise<{ buffer: Buffer; mimeType: "image/png" }>;
  /** 文档搜索 — 语义搜索 LanceDB，返回匹配的行数据 */
  search: (query: string, topK?: number, tableName?: string) => Promise<import("./internal/types").VectorOutput[]>;
  /** 多表检索编排：返回均衡多来源候选，不比较不同 Embedding 空间的原始分数。 */
  searchAcrossTables: (query: string, topK?: number, tableName?: string) => Promise<import("./internal/agent-flow").SearchAcrossTablesResult>;
  /** 智能问答 — 语义搜索 + LLM 后处理分析，返回自然语言回答（支持历史对话上下文） */
  ask: (question: string, topK?: number, tableName?: string, history?: ChatMessage[]) => Promise<{ answer: string; sources: VectorOutput[] }>;
  /** 流式智能问答 — 语义搜索 + LLM 流式输出；可通过 options.includeSources 省略 SSE 来源事件。 */
  askStream: (question: string, topK?: number, tableName?: string, history?: ChatMessage[], options?: import("./internal/agent-flow").AskStreamOptions) => Response;
  /** 仅输出模型可见的工具名称、描述和 JSON Schema。 */
  getToolDefinitions: () => ToolModelDefinition[];
  /** 按 callId、工具名和输入执行 P4 工具；审批、失败和取消均返回结构化终态。 */
  executeTool: (request: ToolExecutionRequest, options?: ToolExecutionOptions) => Promise<ToolExecutionResult>;
  /** 为 createAgent({ rag }) 提供最小 RAG capability；不是通用工具执行入口。 */
  getRagCapability: () => RagCapability;
}

/** 标准 Agent 的公共选项；contextCompaction 由 Runtime 内部组装不对外。 */
export interface AgentOptions extends Omit<InternalAgentOptions, "rag" | "contextCompaction" | "capabilityCeiling" | "chatCapability" | "chatAttachmentGrants" | "clock" | "onSafeToolBatch"> {
  /** @deprecated 仅兼容旧调用方；不会读取或装配该能力。 */
  rag?: RAGAgent | RagCapability;
}

/** compact 的公开输入视图；私有采样器由 Runtime 内部注入，不接受外部传入。 */
export type PublicCompactInput = Omit<import("./internal/agent-runtime").AgentCompactInput, "sampler">;

/** 标准 Agent 实例的公共接口（旧兼容 facade；Phase 3 起改名为 AgentInstance，避免与 Runtime 公开 AgentRuntime 冲突）。 */
export interface AgentInstance {
  getToolDefinitions: () => ToolModelDefinition[];
  run: (input: import("./internal/agent-runtime").AgentRunInput) => AsyncGenerator<import("./internal/agent-runtime").AgentLoopEvent>;
  resume: (input: import("./internal/agent-runtime").AgentRunInput) => AsyncGenerator<import("./internal/agent-runtime").AgentLoopEvent>;
  compact: (input: PublicCompactInput) => Promise<import("./internal/agent-runtime").AgentCompactionResult>;
  cancel: () => void;
}

// ── createRAGAgent（推荐入口）──────────────────

/** 将异步 RAG 公共操作的任意底层异常收敛为统一错误。 */
async function runRagOperation<T>(operation: () => Promise<T>, fallbackCode: RagErrorCode): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toRagError(error, fallbackCode);
  }
}

/** 将同步创建 RAG 响应时的异常收敛为统一错误。 */
function runRagSynchronousOperation<T>(operation: () => T, fallbackCode: RagErrorCode): T {
  try {
    return operation();
  } catch (error) {
    throw toRagError(error, fallbackCode);
  }
}

/** 列出旧全局 RAG 资源，并统一收敛资源层错误。 */
export function listKnowledgeResources(): Promise<import("./internal/lib/vector-store").KnowledgeResource[]> {
  return runRagOperation(function run() { return listKnowledgeResourcesInternal(); }, "RAG_RESOURCE_OPERATION_FAILED");
}

/** 删除旧全局 RAG 资源，并统一收敛资源层错误。 */
export function deleteKnowledgeResource(tableName: string, fileName: string): Promise<import("./internal/lib/vector-store").DeleteKnowledgeResourceResult> {
  return runRagOperation(function run() { return deleteKnowledgeResourceInternal(tableName, fileName); }, "RAG_RESOURCE_OPERATION_FAILED");
}

/**
 * 创建 RAG Agent 实例 — 推荐入口
 *
 * @example
 * const agent = createRAGAgent();
 * await agent.ingest("/path/to/file.xlsx", { type: "excel", tableName: "my_table" });
 * const rows = await agent.parseExcelFile("/path/to/file.xlsx");
 * const sheets = await agent.listExcelSheets("/path/to/file.xlsx");
 */
export function createRAGAgent(options: RAGAgentOptions = {}): RAGAgent {
  const a = new AgentFlow(options.storage, options.rerank, options.embedding);
  const registry = new ToolRegistry();
  registry.register(createReadFileTool());
  const executor = new ToolExecutor(registry, {
    workspaceRoot: options.workspaceRoot,
    permissionMode: options.permissionMode ?? "ask",
    onToolEvent: options.onToolEvent,
  });
  return {
    ingest: function ingest(filePath, options) { return runRagOperation(function run() { return a.ingest(filePath, options); }, "RAG_INGEST_FAILED"); },
    parseExcelFile: function parseExcelFile(filePath, options) { return runRagOperation(function run() { return a.parseExcelFile(filePath, options); }, "RAG_PARSE_FAILED"); },
    listExcelSheets: function listExcelSheets(filePath) { return runRagOperation(function run() { return a.listExcelSheets(filePath); }, "RAG_PARSE_FAILED"); },
    getExcelSheetInfo: function getExcelSheetInfo(filePath, sheetName) { return runRagOperation(function run() { return a.getExcelSheetInfo(filePath, sheetName); }, "RAG_PARSE_FAILED"); },
    getStoredImage: function getStoredImage(fileName) { return runRagOperation(function run() { return a.getStoredImage(fileName); }, "RAG_RESOURCE_OPERATION_FAILED"); },
    listResources: function listResources() { return runRagOperation(function run() { return a.listResources(); }, "RAG_RESOURCE_OPERATION_FAILED"); },
    rebuildLexicalIndexes: function rebuildLexicalIndexes(tableName) { return runRagOperation(function run() { return a.rebuildLexicalIndexes(tableName); }, "RAG_RESOURCE_OPERATION_FAILED"); },
    deleteResource: function deleteResource(resourceId) { return runRagOperation(function run() { return a.deleteResource(resourceId); }, "RAG_RESOURCE_OPERATION_FAILED"); },
    getResourcePreview: function getResourcePreview(resourceId, signal) { return runRagOperation(function run() { return a.getResourcePreview(resourceId, signal); }, "RAG_RESOURCE_OPERATION_FAILED"); },
    getPdfPageImage: function getPdfPageImage(resourceId, pageNumber, signal) { return runRagOperation(function run() { return a.getPdfPageImage(resourceId, pageNumber, signal); }, "RAG_RESOURCE_OPERATION_FAILED"); },
    search: function search(query, topK, tableName) { return runRagOperation(function run() { return a.search(query, topK, tableName); }, "RAG_SEARCH_FAILED"); },
    searchAcrossTables: function searchAcrossTables(query, topK, tableName) { return runRagOperation(function run() { return a.searchAcrossTables(query, topK, tableName); }, "RAG_SEARCH_FAILED"); },
    ask: function ask(question, topK, tableName, history) { return runRagOperation(function run() { return a.ask(question, topK, tableName, history); }, "RAG_ANSWER_FAILED"); },
    askStream: function askStream(question, topK, tableName, history, streamOptions) { return runRagSynchronousOperation(function run() { return a.askStream(question, topK, tableName, history, streamOptions); }, "RAG_ANSWER_FAILED"); },
    getToolDefinitions: function getToolDefinitions() { return registry.getModelDefinitions(); },
    executeTool: function executeTool(request, executionOptions) { return executor.execute(request, executionOptions); },
    getRagCapability: function getRagCapability() {
      /** 创建绑定单个 Turn Rerank 快照的 capability。 */
      function createCapability(rerankPolicy?: import("./internal/lib/rerank").RerankPolicy): RagCapability {
        return {
        search: function search(query, topK, tableName) { return runRagOperation(function run() { return a.search(query, topK, tableName); }, "RAG_SEARCH_FAILED"); },
        searchAcrossTables: function searchAcrossTables(query, topK, tableName) { return runRagOperation(function run() { return a.searchAcrossTables(query, topK, tableName); }, "RAG_SEARCH_FAILED"); },
        prepareRagSearch: function prepareRagSearch(query, topK, tableName, focusedPdfFileName, focusedResourceId, signal) { return runRagOperation(function run() { return a.prepareRagSearch(query, topK, tableName, focusedPdfFileName, focusedResourceId, signal, rerankPolicy); }, "RAG_SEARCH_FAILED"); },
        readVisualEvidence: function readVisualEvidence(visualEvidenceRef, signal) { return runRagOperation(function run() { return a.readVisualEvidence(visualEvidenceRef, signal); }, "RAG_RESOURCE_OPERATION_FAILED"); },
        withRerankPolicy: function withRerankPolicy(policy) { return createCapability(policy ? { ...policy } : undefined); },
        };
      }
      return createCapability(options.rerank?.defaultPolicy);
    },
  };
}

/** 创建标准 Agent 实例；它不承担 RAG 入库/问答兼容 API。 */
export function createAgent(options: AgentOptions = {}): AgentInstance {
  return createAgentRuntime({ ...options, rag: undefined });
}

// ── useRAG ──────────────────────────────────────

/**
 * RAG 钩子
 */
export function useRAG(): RAGQuerier {
  const a = createRAGAgent();
  return {
    query: async function query(prompt: string): Promise<string> {
      const { answer } = await a.ask(prompt);
      return answer;
    },
  };
}

// ── 向后兼容导出（内部委托给 AgentFlow）───────

/**
 * 解析 Excel 文件并返回行数据
 * @deprecated 推荐使用 createRAGAgent().parseExcelFile()
 */
export async function parseExcelFile(
  filePath: string,
  options?: import("./internal/agent-flow").ParseExcelOptions
): Promise<Record<string, unknown>[]> {
  return createRAGAgent().parseExcelFile(filePath, options);
}

/**
 * 列出 Excel 工作表名称
 * @deprecated 推荐使用 createRAGAgent().listExcelSheets()
 */
export async function listExcelSheets(filePath: string): Promise<string[]> {
  return createRAGAgent().listExcelSheets(filePath);
}

/**
 * 获取 Excel 工作表概览
 * @deprecated 推荐使用 createRAGAgent().getExcelSheetInfo()
 */
export async function getExcelSheetInfo(
  filePath: string,
  sheetName?: string
): Promise<import("./internal/agent-flow").SheetInfo> {
  return createRAGAgent().getExcelSheetInfo(filePath, sheetName);
}

/**
 * Excel 文件入库：解析 → 向量化 → 写入 LanceDB 独立表
 *
 * @deprecated 推荐使用 createRAGAgent().ingest(filePath, { type: "excel", ... })
 *
 * @param filePath Excel 文件路径
 * @param options 入库选项
 * @returns 入库结果
 */
export async function ingestExcel(
  filePath: string,
  options: ExcelIngestOptions = {}
): Promise<ExcelIngestResult> {
  const { tableName, clearFirst, headerRow, sheetName } = options;
  return createRAGAgent().ingest(filePath, { type: "excel", tableName, clearFirst, headerRow, sheetName });
}

/** 仅解析上传字节，复用现有文档解析模块，不创建 RAG Agent、存储或向量索引。 */
export async function parseDocument(input: { bytes: Uint8Array; mimeType: string; signal?: AbortSignal }): Promise<{ text: string; pages?: readonly Uint8Array[] }> {
  /** 与其他公开解析 API 复用错误边界，模块加载失败也不透传原始路径。 */
  return runRagOperation(async function parseUploadedDocument() {
    const parser = await loadInternalModule<typeof import("./internal/lib/document-parser")>("Li9pbnRlcm5hbC9saWIvZG9jdW1lbnQtcGFyc2Vy");
    return parser.parseDocument(input);
  }, "RAG_PARSE_FAILED");
}

// ── 数据库浏览工具（仅开发调试用）─────────────

let _dbViewer: Record<string, unknown> | null = null;

async function loadVectorStore() {
  if (!_dbViewer) {
    let req: NodeRequire;
    try {
      const { createRequire } = await import("node:module");
      req = createRequire(import.meta.url);
    } catch {
      req = eval("require") as NodeRequire;
    }
    const vsPath = Buffer.from("Li9pbnRlcm5hbC9saWIvdmVjdG9yLXN0b3Jl", "base64").toString();
    _dbViewer = req(vsPath);
  }
  return _dbViewer;
}

export async function getLanceDBInfo(tableName?: string) {
  const vs = await loadVectorStore();
  const db = await (vs as any).initVectorStore();

  const result: Record<string, unknown> = {};
  const allNames: string[] = await db.tableNames();

  if (tableName) {
    const table = await db.openTable(tableName);
    const totalRows: number = await table.countRows();
    const rawData = await table.query().toArray();
    const data = Array.isArray(rawData) ? rawData : [];

    result.tables = allNames;
    result.currentTable = tableName;
    result.total = totalRows;
    result.returned = data.length;
    result.rows = data.map((r: any) => {
      if (!r || typeof r !== "object") return {};
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (k.startsWith("_")) continue;
        if (k === "vector" && (Array.isArray(v) || (v as any)?.byteLength > 0))
          cleaned[k] = `[${Array.isArray(v) ? v.length : (v as any)?.length || "?"}维向量]`;
        else if (k === "metadata" && typeof v === "string")
          try { cleaned[k] = JSON.parse(v); } catch { cleaned[k] = v; }
        else cleaned[k] = v;
      }
      return cleaned;
    });
  } else {
    result.tables = await Promise.all(allNames.map(async (n: string) => {
      try {
        const t = await db.openTable(n);
        const c: number = await t.countRows();
        const s = await t.schema();
        return {
          name: n, totalRows: c,
          columns: (s.fields || []).map((f: any) => ({ name: f.name, type: String(f.type || "unknown") })),
        };
      } catch { return { name: n, totalRows: -1, columns: [] }; }
    }));
  }
  return result;
}

// Chat 公开类型只描述受信只读端口，不暴露内部工具或状态路径。
export type { ProductMode, ChatRetrievalMode, CapabilityCeiling } from "./runtime/domain/product-mode";
export type { HostMutationProtection, ProtectedMutationTarget } from "./runtime/ports/host-mutation-protection";
export type { ExternalExecutionTarget, ExternalExecutionApproval, ExternalExecutionAuthorization, ExternalWriteCapability } from "./runtime/domain/external-execution";
export type { ExternalFileApproval } from "./runtime/domain/external-permissions";
export type { SandboxDegradeApproval } from "./runtime/domain/sandbox-policy";
export type { ChatCapability, ChatCapabilityBinding, ChatAttachmentGrant, ChatKnowledgeCapability, ChatRagEvidence, ChatRagEvidenceBatch } from "./runtime/protocol/chat-capability";
export type { WorkPreviewCapability, WorkPreviewPrepareRequest, WorkPreviewPrepareResult, WorkPreviewOpenWhen } from "./runtime/protocol/work-preview-capability";
