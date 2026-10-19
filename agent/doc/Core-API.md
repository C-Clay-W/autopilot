# @autopilot-agent/core API 参考

> 面向 Web、CLI、Desktop 和 Node 宿主的稳定公开 API 使用手册。Core 默认入口的源码真相位于 `packages/core/src/index.ts`；生产 Node Port 的实现入口位于配套包 `@autopilot-agent/adapters`，源码真相为 `packages/adapters/src/index.ts`。本文档描述当前可用契约，而非开发过程。

## 文档维护规则

本节是维护 `Core-API.md` 的完整规则。每次变更 `@autopilot-agent/core` 公开 API 时必须遵守。

1. **以源码为准**：先核对 `packages/core/src/index.ts` 的运行时导出、类型导出及实现签名；本文档、示例和类型不得以旧 Plan、旧 dist 或历史记录为依据。
2. **按所属小节就地更新**：已有 API 的参数、类型、返回值、约束、错误或示例变化时，更新它原有的小节；只有新增公开入口或公开类型分类时才新增小节，禁止在文末追加“本次新增”“Pxx”“Stage xx”一类内容。
3. **每个可调用 API 必须完整说明**：至少写明签名、参数、返回值、使用限制和最小示例；涉及安全、持久化、信任、权限、兼容或废弃时，必须单独写出注意事项。
4. **类型与示例同步**：公开输入、输出、事件或联合值改变时，同步更新相邻类型定义、类型索引和示例。示例使用占位 workspace、模型和凭据，不写真实密钥、绝对个人路径或内部状态。
5. **只记录现行契约**：本文档不保存 Phase、Stage、日期化实施过程、RC/打包/测试证据、发布记录、问题排查或已废弃方案；这些内容属于内部开发记录，不在公开参考手册范围。
6. **注意事项要经源码复核**：只保留当前实现可证明的输入限制、安全边界、默认值、兼容性和调用顺序；删除已过期的宿主实现细节、历史踩坑和无法由当前源码确认的结论。
7. **稳定边界清楚**：默认入口 `@autopilot-agent/core` 是本文档范围；`@autopilot-agent/core/experimental` 单独标记为实验性，`@autopilot-agent/core/internal/*` 禁止宿主引用，不能被包装成官方用法。
8. **变更后自检**：检查导入路径、函数/方法名称、参数顺序、默认值、联合类型、返回值和所有代码块；删除源码中已不存在的 API，明确标注仍保留的兼容 API。

---

## 目录

1. [边界与导入](#1-边界与导入)
2. [Runtime：持久化 Agent 宿主 API](#2-runtime持久化-agent-宿主-api)
3. [RAG：文档入库、检索与问答](#3-rag文档入库检索与问答)
4. [数据库快照与知识资源](#4-数据库快照与知识资源)
5. [工具执行与权限](#5-工具执行与权限)
6. [Provider、设置与模型能力](#6-provider设置与模型能力)
7. [Bootstrap 与工作区 Trust](#7-bootstrap-与工作区-trust)
8. [辅助与兼容 API](#8-辅助与兼容-api)
9. [公开类型索引](#9-公开类型索引)
10. [实验性与内部边界](#10-实验性与内部边界)

---

## 1. 边界与导入

### 1.1 入口选择

| 入口 | 稳定性 | 用途 |
|---|---|---|
| `@autopilot-agent/core` | 稳定 | 本文档覆盖的宿主、RAG、Runtime、Trust、Provider 和类型 API。 |
| `@autopilot-agent/adapters` | 稳定 | Node 宿主的生产 Runtime Port 实现、状态根和 Trust 适配；与 Core 的 `RuntimePorts` 契约配套使用。 |
| `@autopilot-agent/core/experimental` | 实验性 | Kernel、底层采样器和工具构造函数；不可作为生产宿主的稳定依赖。 |
| `@autopilot-agent/core/internal/*` | 禁止 | 内部实现路径，`package.json` exports 已限制，宿主不得导入。 |

Node、CLI 或桌面生产宿主从 Core 和 Adapter 的稳定入口静态导入：

```ts
import { createAgentRuntime, createRAGAgent } from "@autopilot-agent/core";
import {
  createNodeRuntimePorts,
  initializeNodeStateRoot,
  resolveNodeStateRoot,
} from "@autopilot-agent/adapters";
```

Next.js Route 是否使用静态 import，由宿主的打包配置决定。不得从 Route 导入 `internal/*`，也不得把浏览器请求直接连接到工具执行、Provider 凭据或数据库快照同步。

### 1.2 两类主入口

| 目标 | 推荐 API | 说明 |
|---|---|---|
| 持久化会话、Turn、审批、steer、恢复 | `createAgentRuntime()` 或 `createRuntimeBootstrapService()` | Web / CLI / Desktop 的正式宿主入口。 |
| 文档入库、搜索、传统 RAG 问答 | `createRAGAgent()` | 返回无会话状态的 `RAGAgent`。 |
| 兼容旧的单次 Agent Loop 调用 | `createAgent()` | 返回 `AgentInstance` compatibility facade；新宿主优先 Runtime。 |

---

## 2. Runtime：持久化 Agent 宿主 API

### 2.1 `createAgentRuntime(options)`

创建共享 Runtime facade。宿主只通过 facade 管理 Project、Session、Turn、审批与输入；不得绕过它直接删除 checkpoint、lease、transcript 或 session 状态。

```ts
// 仅在工作区已通过 Trust 后执行；stateRoot 由 composition root 决定。
const workspaceRoot = "/workspace/demo";
const stateRoot = resolveNodeStateRoot({ workspaceRoot });
initializeNodeStateRoot(stateRoot);

const runtime = createAgentRuntime({
  ports: createNodeRuntimePorts({
    stateRoot,
    workspaceRoot,
    userSettingsPath: "/safe-host-settings.json",
  }),
  defaultRunConfig: {
    workspaceRoot,
    permissionMode: "ask",
  },
});
```

```ts
interface CreateAgentRuntimeOptions {
  ports: RuntimePorts;
  defaultRunConfig?: RunConfig;
  /** 仅拥有结构化回答入口的宿主启用；CLI 默认不启用。 */
  enableUserQuestions?: boolean;
}

interface AgentRuntime {
  projects: ProjectService;
  sessions: SessionService;
  turns: TurnService;
  approvals: ApprovalService;
  inbox: InputInboxService;
  questions: UserQuestionSubmissionService;
  jobs: JobService;
  undo: UndoService;
  shutdown?(): Promise<void>;
}
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|:--:|---|
| `ports` | `RuntimePorts` | 是 | 全部持久化与平台能力的实现集合。Node 生产宿主使用 `@autopilot-agent/adapters` 的 `createNodeRuntimePorts()`；数据库/Keychain 等其他平台可提供等价完整实现，不能缺项。 |
| `defaultRunConfig` | `RunConfig` | 否 | Runtime 默认配置；新 Turn 可由 Project、Session 和本次调用按字段覆盖。 |
| `enableUserQuestions` | `boolean` | 否 | 仅 Web 等具备结构化答案提交入口的宿主设为 `true`；关闭时 `ask_user_question` 不注册到模型定义。`runtime.questions` 仍是受校验的提交服务，不会使 CLI 获得恢复权限。 |

`createNodeRuntimePorts(options)` 是仓库已经提供的 Node 生产实现，不需要宿主自行重写 Store。它要求显式 `stateRoot`，可接收 `workspaceRoot`、`cwd`、`env`、`productMode` 与仅供 CredentialStore 按需读取的 `userSettingsPath`，并一次装配 Session、Checkpoint、Transcript、Credential、Project、Event、Workspace、Turn、Approval、InputInbox、Lease、Job、Undo mutation 及 Session resource 的全部 Port。相同 `stateRoot` 的两次装配可恢复同一份 durable 状态。默认是 Work；Chat 使用下述 `createNodeChatStorage()`，获得拒绝工作区访问的端口和正确的附件清理绑定。

`TranscriptStore` 是 durable Transcript 的唯一写入者。`EventSink` 只供宿主观察、转发或丢弃 Runtime 事件，禁止把事件写回同一 Runtime 的 TranscriptStore；ephemeral Session 仍会经过 EventSink，但不会因此落盘。Node 默认 EventSink 在没有额外观察者时丢弃事件，协调器仅在 Session 为 durable 时调用 `TranscriptStore.append()`。

状态根必须由 composition root 决定，不能从 prompt、模型输出或 HTTP 请求体推导；Work 先完成工作区 Trust，再调用 `initializeNodeStateRoot(stateRoot)`，最后创建 Node Port。CLI 和 Web 均通过 Core 的 `createRuntimeBootstrapService()` 在其 Trust 后 `createPorts` 回调中遵守这一顺序。

Node durable schema 当前为 **v6**。v5→v6 冻结 Job owner/revision/CAS 契约；缺少 `jobRecordVersion/owner/revision` 的旧 Job 只读兼容，不由新 Runtime 认领。v4 及更旧布局仍在副本中逐级迁移，旧无 mode Session 补写为 Work；已有明确 Chat 身份保持原值，不根据标题或消息猜模式。缺少 Project 的旧记录只在存在唯一且带工作区根的已有 Project 时补齐，否则拒绝迁移；损坏记录、错域及非法字段组合也拒绝，保留原数据和备份。迁移使用独立进程锁和可恢复切换目录，备份不跟随链接。`createNodeSessionStore({ stateRoot, productMode? })` 默认 Work，Chat 须显式指定；get/list/save 均验证所属产品，磁盘写入不能改变已有产品、检索模式、Project 身份或 `workContextVersion`。损坏 JSON 不再作为不存在或从列表中静默跳过。

#### Node Adapter 错误协议

Node Session 身份拒绝复用 Core `AgentRuntimeError`：`SESSION_MODE_MISMATCH`、`CHAT_RETRIEVAL_MODE_LOCKED`、`WORKSPACE_REQUIRED` 均通过 `.code` 识别，不解析 message。独立用户 Home 无法解析时复用 Adapter 已有 `UserConfigDirectoryError("AUTOPILOT_HOME_UNRESOLVED")`。

`@autopilot-agent/adapters` 另导出 `NodeStateError` / `NodeStateErrorCode`、`NodeChatError` / `NodeChatErrorCode`。两类异常的 `message` 固定等于 `code`，不包含输入、路径或底层异常正文；它们不属于 Core 工具错误协议。

| 类型 | 错误码与含义 |
|---|---|
| `NodeStateError`：记录/文件系统 | `STATE_SESSION_CORRUPTED` 表示 Session JSON 或基本记录损坏；`STATE_STORAGE_UNAVAILABLE` 表示文件操作不可用；`STATE_STORAGE_UNSAFE_PATH` 表示共享 Work/Chat 存储路径不安全。读取 I/O 失败不作为 JSON 损坏。 |
| `NodeStateError`：schema | `STATE_SCHEMA_UNSAFE_PATH`、`STATE_SCHEMA_BUSY`、`STATE_SCHEMA_RECOVERY_REQUIRED`、`STATE_SCHEMA_MANIFEST_CORRUPTED`、`STATE_SCHEMA_VERSION_INVALID`、`STATE_SCHEMA_VERSION_UNSUPPORTED`、`STATE_SCHEMA_MIGRATION_MISSING`、`STATE_SCHEMA_MIGRATION_FAILED`。副本迁移阶段失败统一使用最后一项，具体原因由恢复诊断的 `reasonCode` 提供。 |
| `NodeChatError`：临时附件 | `CHAT_ATTACHMENT_UNAVAILABLE`、`CHAT_ATTACHMENT_CANCELLED`、`CHAT_ATTACHMENT_PARSER_UNAVAILABLE`、`CHAT_ATTACHMENT_CLEANUP_FAILED`；清理或删除中的未知 I/O 失败采用清理失败码，主动取消保留取消码。 |
| `NodeChatError`：身份与装配 | `CHAT_STATE_ROOT_INVALID`、`CHAT_SESSION_DELETING`、`CHAT_UPLOAD_MODE_MISMATCH`、`CHAT_ATTACHMENT_STORE_REQUIRED`、`CHAT_KNOWLEDGE_UNAVAILABLE`。 |

Session Store、schema 管理器、Chat 路径/附件/装配边界精确识别已声明的类型名称与 code，并重建安全消息；不根据 `CHAT_*` 文本前缀透传异常。附件捕获范围包括锁前初始化、上传前置处理及同步展示投影。`authorizeRef()` 仍以 false 表示授权失败，Core 工具边界仍将附件失败转换为固定的工具错误。

迁移失败的 `NodeStateError.getRecoveryDiagnostic()` 返回可选 `NodeStateRecoveryDiagnostic` 副本：`{ fromVersion, toVersion, backupPath?, reasonCode }`。诊断保存在私有字段，不能通过 JSON 序列化错误对象取得；不设置原始 cause，也不把恢复路径写入 message。宿主需要恢复时显式读取，不得将该诊断直接返回浏览器或写入模型事件。原数据和备份仍按迁移协议保留。

#### Node Chat 存储与配置

`resolveNodeChatStatePaths({ globalStateRoot? })` 不接受工作区或 cwd；显式全局根须为绝对路径。固定布局为全局根下 `chat/state`（durable）、`chat/attachments`（临时文件）和 `chat/knowledge`（单一知识空间）。临时文件不进入 durable schema 备份，因此回滚会话状态不会恢复已清除的字节。`createNodeChatStorage({ globalStateRoot?, env?, userSettingsPath?, now?, parseDocument? })` 返回 `{ paths, ports, attachments }`；初始化只创建前两个数据域，知识根按 RAG 能力延迟创建。

`createNodeSettingsLoader()` 同时提供原有 `NodeSettingsLoader.load/watch(workspaceRoot)` 与增量 `NodeUserSettingsLoader.loadUser()/watchUser(onReload)`。User-only 快照为 `{ settings, paths: { user } }`，只读取/监听用户配置及其父目录，不构造 Project/Local 路径；原有仅实现 Work 接口的宿主可继续使用。`resolveNodeUserSettingsPath(homeDirectory?, pathApi?)` 要求绝对 Home，复用现有安全读取、Core settings 解析与目录重载机制。

`attachments` 的宿主方法如下；它们不是模型工具或 HTTP Route：

| 方法 | 当前契约 |
|---|---|
| `put({ sessionId, displayName, bytes, signal? })` | 只允许持久化 none/web Chat；服务端生成 UUID ref、名称、检测 MIME、SHA256、字节数与时间，原子提交原始字节和解析缓存。单文件 20 MiB、图片 5 MiB；不使用客户端时间、路径或引用。 |
| `list(sessionId)` | 返回当前未过期根附件的安全元数据；页图不自动加入初始授权目录。 |
| `authorizeRef(sessionId, ref, kind)` | 每次复查当前会话、类型、过期和删除态，失败统一 false。 |
| `readAttachment(sessionId, ref, signal?)` | 返回最多 16,000 字符缓存文本与受控页图 grant；页图继承父文件 TTL。 |
| `readBytes(sessionId, ref, signal?)` | 当前会话内读取原文件/页图，校验安全路径、长度和 SHA256，返回字节和检测 MIME，不返回路径。 |
| `cleanupExpired({ limit?, signal? })` | 默认一批 32 项（可设 1–128），按 createdAt/ref 从最早开始；先重试中断清理，再删除到期项，返回本批已清理 ref。 |
| `startMaintenance(onError, signal?)` | 启动时逐批清理，随后每小时维护；返回停止函数，timer 不阻止退出；错误只报告固定码。Host 生命周期必须显式调用并停止它。 |
| `deleteBySession(sessionId)` | 作为 SessionResourceStore 被 Core 调用；先写最小删除标记，拒绝新上传/Session/Turn 写入，再删除字节、缓存及结构化展示引用；失败留日志供重试，知识资源不受影响。 |

所有临时附件固定 `expiresAt = createdAt + 30×24h`。同一临时域的读、提交和清理共享跨进程锁，解析在锁外执行并在提交前重新验证身份。过期后读取立即拒绝，不等待维护轮次；会话投影读取/保存也过滤失效附件，清理移除附件名、MIME 和结构化引用，保留历史正文。删除标记保留在临时域，`isSessionDeleting(sessionId)` 供 Host 恢复时识别并通过 `runtime.sessions.delete()` 重试完整会话收尾；Store 维护只负责其附件和展示引用，不自行替代 Core 删除 durable 状态。

纯 UTF-8 文本和受支持图片可直接保存。PDF、DOCX、XLSX、XLS 在字节类型识别后仍须由受信 `parseDocument({ bytes, mimeType, signal })` 成功返回 `{ text, pages? }`；未装配解析器则返回 `CHAT_ATTACHMENT_PARSER_UNAVAILABLE`。解析器应复用应用现有文档链并处理 signal，不得执行向量化/入库。最多 20 个页图，单图 5 MiB、页图总计 20 MiB；缓存和 staging 与父附件一同清理。该 Store 不复制正式 RAG pipeline。

`createNodeChatCapabilityLoader({ storage, visionAnalyzer?, loadKnowledge? })` 返回 Core `chatLoader(binding)`：复查持久化检索模式后，none/web 只装配临时附件；rag 才初始化固定知识根，并将 `knowledgeRoot` 与 `knowledgeSpaceId: "chat-knowledge-v1"` 交给受信 canonical 检索适配。`loadKnowledge` 返回 `knowledge/authorizeRef/readImage`，不能改变知识空间 ID。`createNodeCapabilityLoader(...).loadChatWeb(binding: ChatCapabilityBinding | Pick<ChatCapabilityBinding, "retrievalMode">): Promise<WebCapability | undefined>` 在任何 settings/credential 读取前拒绝 none/rag；web 只调用 `loadUser()`，复用既有安全 Search/Fetch。最小调用为 `loader.loadChatWeb({ retrievalMode: "web" })`，仍兼容完整 binding；该受信装配端口不执行 Session 授权，宿主必须由 Core 持久身份控制其调用，不能直接采用浏览器字段。Web Chat Host 已绑定临时上传解析、生命周期、固定知识根的 canonical 检索及仅在 web 身份调用的 Web loader；搜索配置或凭据缺失时只有受控 Fetch，下一 Turn 重新装配。

`createNodeCapabilityLoader().loadContext(workspaceRoot, query?)` 保留项目指令发现，但旧 Memory 来源未验证，当前不召回任何 Memory；有 query 时返回固定诊断 `LEGACY_MEMORY_REVIEW_REQUIRED`。公开兼容函数 `retrieveNodeMemories(stateRoot, workspaceRoot, query, maxItems?)` 返回空数组，不读取或迁移旧文件。路径辅助函数继续可供用户审阅，不能作为向 Work 注入旧内容的授权。

`createMemoryPorts()` 仅适用于 contract test 或无持久化的 headless smoke；它是 Core 为测试提供的内存实现，不能替代生产 Node Port。

`shutdown()` 存在时，CLI/Desktop 等拥有进程生命周期的宿主必须在正常退出前调用它；它只终止当前 Runtime 启动的活动非 PTY Job，不会重新附着历史进程。

### 2.2 Project 服务：`runtime.projects`

| 方法 | 签名 | 说明 |
|---|---|---|
| `create` | `(input: CreateProjectInput) => Promise<Project>` | 创建 Project。 |
| `get` | `(id: string) => Promise<Project \| null>` | 读取 Project；不存在时抛 `PROJECT_NOT_FOUND`。 |
| `list` | `() => Promise<Project[]>` | 列出可见 Project。 |
| `save` | `(project: Project) => Promise<void>` | 保存完整 Project DTO。 |
| `delete` | `(id: string) => Promise<boolean>` | 删除 Project，返回是否删除。 |

`Project` 用于保存项目级默认运行配置；不要将真实 Provider key 或宿主私有路径写入它。

### 2.3 Job 服务：`runtime.jobs`

Job 启动、停止与恢复契约：`StartJobInput.signal?: AbortSignal` 只约束启动交付，交付前取消会清理半启动进程，成功返回后 Turn 取消不再停止 Job。`StartJobInput.sandbox` 为必填字段（`{ port: SandboxPort, policy: SandboxPolicy }`），必须携带 ToolExecutor 已解析确认的冻结沙箱范围；缺失时 `start` 以 `SANDBOX_UNAVAILABLE` fail-closed 拒绝，不创建 Job 记录、不启动进程。启动路径的包装顺序固定为受信命令解析（`resolveManagedCommand`，Windows npm/npx 固定受信 CLI 与 realpath containment）→ `SandboxPort.prepare` → spawn；prepare 抛出的 `SandboxPortError`（稳定 `SANDBOX_*` 码）原样透出。沙箱执行资源与 Job 终态绑定：spawn 失败与真实终态（进程 close 后终态化，含 kill/shutdown 路径）都幂等 `release(executionId)`，不依赖存储写入成功。scoped get/read/stop 先验证记录归属，再执行 owner 恢复；poll 与 get 使用同一恢复逻辑。Windows 沙箱停止必须获得私有执行能力的 container_empty 证据和包装 close，taskkill 成功本身不能认证容器为空；缺能力、超时或失败保持 stopping。

`JobListView.totalCount?: number` 与 `activeCount?: number` 为当前绑定 Session 全量计数，不受本页 limit 影响；活动包括 starting/running/stopping。安全输出的 stdout/stderr cursor 使用独立代次，不能互换。超长敏感记录丢弃至该记录换行；启动环境中敏感键对应的已知值纳入脱敏，不向宿主返回这些值。

| 方法 | 签名 | 说明 |
|---|---|---|
| `start` | `(input: StartJobInput) => Promise<Job>` | 启动已由 ToolExecutor/PolicyEngine 授权且已确认可沙箱执行的非 shell、非 PTY Job。公共宿主不得借此绕过工具执行门；`sandbox` 缺失即 `SANDBOX_UNAVAILABLE`。 |
| `poll` | `(input: PollJobInput) => Promise<JobPollResult>` | 按 stdout/stderr byte cursor 返回增量受限输出，并给出下一 cursor 与保留窗口起点。 |
| `readOutput` | `({ id, stdoutCursor?, stderrCursor? }) => Promise<JobOutputView>` | 返回 Core 清理和脱敏后的双流安全窗口；cursor 与 `poll` 的 raw byte cursor 完全独立。 |
| `write` | `({ id, data }) => Promise<void>` | 向活动 Job 写入受限 stdin；关闭后不能重开。 |
| `kill` | `(id) => Promise<Job>` | 仅停止当前 Runtime 持有句柄的 Job；先进入 `stopping`，平台停止命令和目标 `close` 均确认后才返回 `stopped`。终态重复调用幂等。 |
| `list` / `get` | `(workspaceId) => Promise<Job[]>` / `(id) => Promise<Job \| null>` | 读取 durable Job 元数据。 |
| `forSession` | `({ workspaceId, sessionId }) => SessionJobService` | 创建已绑定当前 Work Session 的安全管理视图；新 Agent/宿主必须使用该入口，不把底层 `Job` 私有字段作为 DTO。 |

Job 绑定 workspace 与 Session，不支持 PTY、detach 或跨进程重新附着。新记录固定 `jobRecordVersion:2`，带私有 owner `{runtimeInstanceId, hostProcessId}`、从 0 单调增长的 `revision` 和终态 `finishedAt`。新记录随存安全沙箱摘要 `Job.sandbox?: JobSandboxSummary`（`{ mode, policyDigest, policyVersion }`，与 `FrozenRunConfig` 同源摘要算法）：只含模式与冻结 policy 摘要，不含代理 env、完整 deny 路径明细、沙箱执行句柄或命令派生敏感数据；旧 v2 记录缺省该字段不参与恢复判定。只有原 Runtime 的内存句柄是可停止的正证据；其他存活 owner 返回 `JOB_OWNER_UNAVAILABLE`，无法确认或旧无 owner 记录返回 `JOB_OWNER_UNKNOWN`。只有 owner 明确死亡时，Core 才用 owner+revision 条件写恢复为 `interrupted`；PID 存活本身不证明 Runtime 身份。

默认入口还导出常量 `JOB_RECORD_VERSION`，当前值为 `2`，表示 durable Job 记录格式版本；宿主不应把它当作运行中的 Job 状态。

Job 启动登记与 Session 删除共用 Session 锁。`starting/running/stopping` 以及 owner 不明的旧活动记录都会以 `SESSION_HAS_ACTIVE_JOBS` 阻断删除。spawn 成功事件到达后才进入 `running`；spawn 失败或 spawn 后首次状态转换保存失败会清理半启动进程并留下失败记录。输出变化最多每秒合并保存一次，终态强制 flush。Windows 后台 `npm/npx` 由 Core 解析为当前 Node 安装旁的固定 CLI JS，并继续使用 `shell:false`；记录与 Policy 仍使用调用方原始的逻辑 program/argv。

`SessionJobService` 在每次操作前复查 Session 是带 Project 归属的 Work，且 Project 的 canonical `workspaceRoot` 与绑定 `workspaceId` 一致。跨 Session/Workspace 的 Job ID 统一按当前范围不存在处理。其方法为：

| 方法 | 输入 | 返回与约束 |
|---|---|---|
| `list` | `{ limit?: 1..100, pageCursor? }` | 默认 20；活动优先，终态按 `finishedAt` 倒序；返回 `JobListView` 与只能原样回传的进程内签名 cursor。 |
| `read` | `{ jobId, stdoutCursor?, stderrCursor?, waitMs?: 0..30000, signal? }` | 返回 `JobReadView`；单次 stdout/stderr 各最多 8 KiB，`waitOutcome` 明确为 `snapshot/terminal/timeout`，取消只结束等待。 |
| `stop` | `{ jobId, source: "agent" \| "host" }` | 仅原 Runtime 内存句柄可停止；真实终态后返回 `JobView`，并记录不含命令/PID 的 `lastControl`。 |

`JobView` 只含 `jobId/status/controlState/canStop/revision`、时间、退出/失败码、有限输出计数、`lastControl` 与可选 `execution`；不含 program、args、cwd、owner 或 PID。`controlState` 为 `owned | foreign_owner | owner_unknown | terminal`。Agent 工具只在 Work 注册：`start_background_job` 成功结果为安全 `{ jobId, status, startedAt, sandbox: { mode } }`，另有 `list_background_jobs`、`read_background_job` 和 `stop_background_job`。stop 只接受精确 jobId，在当前 Session 归属且 Runtime 持有句柄或已终态时免额外操作审批，不复用 grant；Skill、产品能力与执行期归属检查仍生效。read 的工具超时为 35 秒，给最大 30 秒等待保留收尾预算。

`execution` 为安全执行事实：`phase` 仅为 `wrapper_spawn_failed | wrapper_running | wrapper_exit | target_spawn_error_reported`，`targetState` 为 `unknown | not_started`，可选 `signal/win32Code`。`running` 仅说明包装进程成功 spawn，不证明目标 ready。stderr 固定签名只能形成 `target_spawn_error_reported` 提示，不能认证目标启动、改变审批或停止确认；目标状态保持 unknown。原始 stderr 通过既有有限安全输出读取，关闭信号和包装退出码独立保留；旧记录可无 execution。

```ts
interface PollJobInput {
  id: string;
  stdoutCursor?: number;
  stderrCursor?: number;
}

interface JobPollResult {
  job: Job;
  stdout: string;
  stderr: string;
  nextStdoutCursor: number;
  nextStderrCursor: number;
  stdoutStartCursor: number;
  stderrStartCursor: number;
  truncated: boolean;
}
```

首次 poll 可省略 cursor；之后必须将 `nextStdoutCursor` 和 `nextStderrCursor` 原样回传，才能避免重复消费输出。cursor 按 UTF-8 原始字节单调计数，不是字符串长度。当 `truncated` 为 `true` 且请求 cursor 小于对应 `*StartCursor` 时，较早的输出已超出固定内存窗口，宿主只能从该起点重新展示，不能假设可补齐缺口。

`readOutput` 使用 `projectionVersion:1 + epoch + offset` 编码的不透明 cursor，stdout/stderr 分流。Core 以 `StringDecoder` 处理跨 chunk UTF-8，删除 ANSI/OSC/控制字符，屏蔽敏感键值、已知敏感值和绝对路径；未完成片段上限 8 KiB，安全窗口上限 32 KiB。窗口淘汰返回 `gap:true`，非法版本或代次返回 `resetRequired:true`。原始 `Job.output` 和 `poll` 仅为服务端兼容面，模型和新宿主不得展示或混用其 cursor。

### 2.4 Undo 服务：`runtime.undo`

Undo 只回滚当前 Session 中最近一个由 canonical `write_file` / `edit_file` 成功写入的 Turn 的 create、edit 或 overwrite 文件变更。它不是模型工具，也不接受自然语言触发；可信宿主必须先展示 preview，再取得独立的用户确认后才能执行。

```ts
const preview = await runtime.undo.preview({ sessionId: session.id });

if (preview.status === "available" && userConfirmed) {
  const result = await runtime.undo.execute({
    sessionId: session.id,
    confirmed: true,
  });
}
```

| 方法 | 签名 | 返回 | 使用限制 |
|---|---|---|---|
| `preview` | `({ sessionId }) => Promise<UndoPreview>` | 最近可回滚 Turn 的脱敏文件清单，或不可用原因 | 只读；不得据此自动执行。 |
| `execute` | `({ sessionId, confirmed: true }) => Promise<UndoResult>` | `completed` 或 `failed`，并附已恢复、已补偿和冲突的相对路径 | `confirmed` 必须为字面量 `true`；宿主必须在用户独立确认后传入。 |

```ts
interface UndoPreview {
  status: "available" | "unavailable";
  turnId?: string;
  files: Array<{
    path: string;
    operation: "create" | "edit" | "overwrite" | "undo";
  }>;
  reason?: "UNDO_NOT_FOUND" | "UNDO_NON_REVERSIBLE" | "UNDO_CONFLICT" | "WORKSPACE_NOT_TRUSTED";
}

interface UndoResult {
  status: "completed" | "failed";
  turnId?: string;
  restoredPaths: string[];
  compensatedPaths: string[];
  conflicts: string[];
}
```

每次 preview 和真实替换都会验证 workspace Trust、Policy、canonical 路径、当前字节 SHA-256 与私有 snapshot blob hash；任一不匹配即 fail closed，不能强制覆盖。包含 NUL 字节的二进制内容、单文件快照超过 512 KiB，或 Session 总快照超过 5 MiB 的 mutation 会保留审计但标记为不可 Undo。同一路径在一个 Turn 内多次修改时，Undo 按 mutation 逆序恢复，只以该路径最后一次 mutation 的 `after` SHA 作为初始预检值。多文件回滚由 durable transaction journal、同目录 staging 和补偿处理；重启或失败后会先按 journal 与真实 SHA 收敛：能完整补偿到 Undo 前状态的失败事务保留审计但不阻塞用户再次 preview/确认，存在未知内容或竞争冲突时才保持不可用。preview、结果和审计事件不含文件正文、绝对路径或 blob ref。`run_command`、Job、MCP、网络、数据库及其他外部副作用不可 Undo。

`FileMutation`、`PrepareFileMutationInput`、`UndoTransaction` 与 `FileMutationStore` 是默认入口导出的 Adapter 契约，用于实现私有 WAL/blob/journal；普通宿主不得直接创建 mutation、读取 blob 或绕过 `runtime.undo`。生产 Port 必须提供持久化实现；`createMemoryPorts()` 内置的 `MemoryFileMutationStore` 仅用于 contract test 或 headless smoke。

`FileMutationStore.withWorkspaceLock(workspaceRoot, operation, canonicalTargets?)` 在 workspace 临界区内，对传入的 canonical 绝对目标去重并按固定顺序取锁；生产实现必须让同一 OS 用户、不同 workspace/stateRoot 的同目标共享锁域。write/edit 与 Undo/recovery 传入实际目标，取得锁后重验身份与 SHA。Node 使用 OS 用户 home 下固定 `.autopilot/file-mutation-locks`，不从 HOME/TEMP 或各 workspace 配置选锁域；活 owner 不因锁年龄被抢占，等待超时不进入临界区。Memory 实现仅保证同进程实例互斥。

### 2.5 Session 服务：`runtime.sessions`

```ts
const session = await runtime.sessions.create({
  productMode: "work",
  projectId: "project-docs",
  title: "README 审阅",
  persistenceMode: "durable",
  defaultRunConfig: { permissionMode: "ask" },
});

await runtime.sessions.rename(session.id, "README 修订");
```

| 方法 | 签名 | 关键规则 |
|---|---|---|
| `create` | `(input: CreateSessionInput) => Promise<Session>` | 未传 `id` 时由 Core 生成；默认 `durable`；已有 ID 不可覆盖；新会话写入产品身份。 |
| `list` | `() => Promise<Session[]>` | 返回当前 Runtime stateRoot 中的 Session。 |
| `get` | `(id: string) => Promise<Session \| null>` | 不存在时抛 `SESSION_NOT_FOUND`。 |
| `save` | `(session: Session) => Promise<void>` | 只保存既有 Session；更新 `updatedAt`，拒绝修改产品、检索模式及已有 Project 归属。 |
| `setDefaultRunConfig` | `(id, runConfig) => Promise<Session>` | 写入 Session 级默认配置。 |
| `rename` | `(id, title) => Promise<Session>` | 标题会 `trim`；空值或超过 200 字符抛 `SESSION_TITLE_INVALID`。 |
| `delete` | `(id) => Promise<boolean>` | 活动 Turn 存在时抛 `TURN_ALREADY_RUNNING`；否则先清理 Session-owned 宿主资源，再清理 lease、inbox、approval、checkpoint、transcript、turn、Job、文件 mutation 和 session。 |

Session 身份由服务端宿主创建来源决定，不能从浏览器的任意 RunConfig 推断：

```ts
type ProductMode = "chat" | "work";
type ChatRetrievalMode = "none" | "web" | "rag";

const chat = await runtime.sessions.create({
  productMode: "chat",
  chatRetrievalMode: "none",
  title: "普通问答",
});
```

`CreateSessionInput` 接受 `id?`、`productMode?`、`chatRetrievalMode?`、`projectId?`、`persistenceMode?`、`title?`、`defaultRunConfig?`。显式 `work` 必须提供当前宿主工作区对应的有效 Project；`chat` 必须提供合法的检索模式且不能带 `projectId`，创建 Chat 不访问 WorkspaceAdapter。持久化 Session 从创建起冻结模式；未持久化的草稿由宿主管理。新旧调用均不能用已有 `id` 覆盖 Session。

兼容既有 Work 调用方时，省略 `productMode` 默认写入 `work`；同时缺少 `projectId` 时，仅通过注入的 WorkspaceAdapter 解析当前工作区并复用/创建其 Project，不读取 cwd 猜测工作区。旧持久化记录缺少模式时在 Core 兼容读取边界按 Work 处理，不在读取期间落盘迁移；非法字段组合抛 `SESSION_MODE_MISMATCH`，错误工作区 Project 抛 `WORKSPACE_REQUIRED`。`save()` 修改合法 Chat 检索模式抛 `CHAT_RETRIEVAL_MODE_LOCKED`，修改产品/归属或移除已写模式抛 `SESSION_MODE_MISMATCH`。创建和查询返回副本，不能通过对象别名修改 Store 中的身份。新 Work Session 由 Core 写入只读 `workContextVersion: 1`，调用方不能通过 `save()` 给旧记录补写或移除此来源版本。

`RuntimePorts.sessionResourceStore` 是默认入口导出的 `SessionResourceStore` 契约：宿主实现 `deleteBySession(sessionId)`，用来清理生命周期只属于该 Session 的外围资源。它必须幂等，且清理失败会中止删除，避免 Core 状态已删除而宿主附件遗留。Web 图片附件等资源必须通过该 Port 清理；CLI、Web 与 Desktop 不得各自绕过 `runtime.sessions.delete()`。

### 2.6 Turn 服务：`runtime.turns`

#### 运行层级：Session > Turn > run > step

| 层级 | 是否公开契约 | 说明 |
|---|---|---|
| `Session` | 是 | 会话级容器，冻结产品身份与默认配置；`runtime.sessions` 管理。 |
| `Turn` | 是 | 持久化、可恢复的任务生命周期单位，携带冻结配置与 checkpoint；`runtime.turns.start/continue` 是宿主唯一入口。 |
| `run()` | 否 | 一次 Turn 的内部执行入口，位于 `createAgentRuntime()` 内部 facade；它不是一个可被宿主调用的业务实体，也不比 Turn 更大。 |
| `runKernel()` | 否 | `run()` 委托的实际执行内核，`Session > Turn` 全链只有这一个实现。 |
| `step` | 否 | Kernel 内部单次循环：采样 → 工具批次 → 完成判断，一轮可包含多个工具；不是公开概念，显式 `maxSteps` 限制当前内部执行段的循环数。 |

一个外层 Turn 生命周期**可能包含多次内部 `run()` 尝试**：上下文溢出时，Runtime 会在同一 `turnId` 内执行一次 reactive compact，再以新的 running checkpoint 重新调用内部 `run()`；因此「Turn 数」与「Kernel 执行次数」不是一一对应的。这条关系对宿主可观测，但只有事件（`context_overflow`、`context_compact_started`、`context_compacted`）是公开契约，`run()` / `runKernel()` / `step` 本身不对外导出为稳定 API。

#### `start(input)`：启动新 Turn

```ts
for await (const event of runtime.turns.start({
  sessionId: session.id,
  content: "阅读 README.md，概括项目用途。",
  runConfig: { maxSteps: 8 },
})) {
  // 将已脱敏的 AgentEvent 投影为 CLI、SSE 或 UI。
}
```

```ts
interface StartTurnInput {
  sessionId: string;
  turnId?: string;
  content?: string;
  messages?: AgentMessage[];
  activeSkills?: Array<{ skillId: string; contentHash: string }>;
  /** 仅由已领取 queue 的可信宿主设置；普通新 Turn 不传。 */
  continuity?: { source: "claimed_queue" };
  runConfig?: Partial<RunConfig>;
  signal?: AbortSignal;
}
```

- `content` 与 `messages` 用于提供首轮输入；复杂宿主可传 `messages`，普通调用传 `content`。
- 新 Turn 冻结解析后的运行配置；优先级为单次 Turn > Session > Project > Runtime 默认值。
- 新 Turn 已写入但凭据/模型装配在首个 checkpoint 前失败时，保留原异常码（如 `MISSING_CREDENTIAL`），同时将 Turn 和 Session 收尾为 failed 并释放租约；不伪造执行事件。修复凭据后可以启动新 Turn，不会将新输入误判为仍在运行任务的 steer。
- `workspaceTrusted` 只能由 Bootstrap 在 Trust 成功后注入 Runtime 默认配置，不能由 Project、Session 或本次 Turn 伪造。
- `continuity` 不是浏览器 DTO：只有已成功 `claimNext()` 并将输入标为 consumed 的宿主可传 `{ source: "claimed_queue" }`。它令新 Turn 继承上一任务链 Todo；普通新 Turn 创建独立任务链，不会读取旧 Todo。
- `start` 的硬门禁：Session 已有活动 Turn（`running`、`awaiting_approval`、`waiting_approval`）时抛 `TURN_ALREADY_RUNNING`，跨进程还存在新鲜 lease 检查。因此活动 Turn 期间**不能**再 `start` 新 Turn；此时用户输入只有两条路——`steer` 注入当前 Turn，或按 `queue` 排队等待当前 Turn 结束后由可信宿主领取。<br>这条门禁与 `continuity` 是同一因果链：queue 必须靠 `claimNext()` → `consume()` → `start({ continuity: { source: "claimed_queue" } })` 落地，而 `continuity` 只有在「已确认没有活动 Turn 并成功领取」之后才有意义。host 在领取后启动失败时，必须回收已 claim 的输入（`inbox.cancel`），避免输入永久停留在 `claimed`。

#### `continue(input)`、`cancel(input)` 与状态查询

| 方法 | 签名 | 说明 |
|---|---|---|
| `continue` | `(input: ContinueTurnInput) => AsyncIterable<AgentEvent>` | 仅从 `awaiting_approval`、`awaiting_user_input`、`interrupted(_recoverable)` 或 `limit_reached` checkpoint 继续；completed/failed/running 会返回 `TURN_NOT_RESUMABLE` 或 `TURN_ALREADY_RUNNING`。它忽略传入的 `runConfig`，强制复用该 Turn 的冻结配置；回答暂停时必须携带已提交答案所属的 `requestId`。 |
| `cancel` | `(input: CancelTurnInput) => Promise<void>` | 请求取消指定活动 Turn。 |
| `getState` | `({ sessionId, turnId? }) => Promise<TurnState>` | 返回 Turn、安全 checkpoint 摘要和脱敏事件；省略 `turnId` 时返回整个 Session transcript，指定时只返回目标 Turn。checkpoint 只含 `turnId/status/stepCount`、空的 `messages/completedCallIds`、可选 Skill 身份及 Session 输入去重所需的 `consumedInputIds`；canonical 消息和调用事实只由 Core 私有存储用于恢复。 |
| `getRecoverableState` | `({ sessionId, turnId? }) => Promise<RecoverableTurnView \| null>` | 返回最小恢复视图；`recoverable` 由 Core 确认，`termination` 仅含白名单原因和可选预算数值，适合 UI 与 CLI。 |
| `getFrozenRunConfig` | `({ sessionId, turnId? }) => Promise<FrozenRunConfigView \| null>` | 返回脱敏后的冻结模型与推理配置。 |
| `getContextUsage` | `({ sessionId, turnId? }) => Promise<ContextUsageView \| null>` | 只读返回最新私有 checkpoint 的安全 Context Usage 快照：冻结模型窗口、三态总量（`measured`/`projected`/`estimated`）、固定分类 breakdown、free/compact buffer/over-limit。无 checkpoint、`turnId` 不匹配或 DTO 任一不变量非法时 fail closed 为 `null`；`null` 表示当前没有可展示事实，宿主不得显示 0% 或猜测窗口。只接受 `sessionId`/`turnId`，不接受 messages/tools 等计算输入；宿主不得读取私有 `usageAnchor` 或自行重算。Live 更新走 `context_usage_updated` 事件（同值去重，`usage: null` 仅表示明确清空旧状态），刷新与重启恢复走本查询；两者消费同一份安全快照。 |

```ts
for await (const event of runtime.turns.continue({
  sessionId: session.id,
  turnId: "turn-001",
  approval: { approvalId: "approval-001", decision: "allow" },
})) {
  // 继续消费事件
}
```

#### `steer(input)` 与 `compact(input)`

`steer` 是投递入口，`delivery` 决定随后走完全不同的两条链；两者不要混为一谈：

| `delivery` | 语义 | 绑定 | 执行时机与归属 |
|---|---|---|---|
| `steer` | 引导当前运行中的 Turn | 必须携带当前 `turnId` | 由 Kernel 在安全边界注入**同一 Turn**，不新建 Turn。 |
| `queue` | 排入 Session 级 durable inbox 的后续任务 | 不绑定 Turn | 当前 Turn 结束后，由可信宿主 `claimNext()` → `consume()` → `turns.start()` 消费并新建 Turn。Kernel 从不领取 queue。 |

steer 的注入边界是四个离散的安全点，Kernel 只在完整工具批次或采样边界之间注入，绝不拆开 canonical tool-call/result 原子组：

| 边界 | 位置 |
|---|---|
| `before_sample` | 本轮采样开始前 |
| `after_sample` | 采样结束后、执行工具前 |
| `after_tools` | 一整组工具结果写回后 |
| `before_complete` | 判定 Turn 完成前 |

边界名称与 `InboxBoundary` 类型一致。若用户输入在最后一个安全边界之后才到达，Core 不会破坏已完成的 Turn 强行插入；这类遗留输入只能由宿主在终态后领取并另起 Turn（领取顺序为 steer 优先、同类 FIFO）。

| 方法 | 签名 | 说明 |
|---|---|---|
| `steer` | `(input: SteerTurnInput) => Promise<InboxInput>` | 投递 steer 或 queue 输入；可含幂等 `clientMessageId`、受控附件和 Skill 引用。返回的是 inbox 输入记录，不是执行保证。 |
| `compact` | `(input: CompactTurnInput) => Promise<CompactTurnResult>` | 压缩指定 Turn 的上下文；只在完整 canonical tool-call/result 配对切点切换投影，不删除原始 Session 记录。手动触发时 Turn 仍在运行中会抛 `TURN_ALREADY_RUNNING`（不排队、不延迟执行），须等 Turn 结束后再调用。返回显式 `outcome`：`changed` 表示消息投影实际替换、显式丢弃旧 usageAnchor，并以 estimated 降级快照发布 `context_usage_updated`；`skipped` 表示无可压缩历史（`reason: "no_compactable_history"`），checkpoint、anchor 与 usage 均不变且不发布事件。`CompactTurnResult.contextUsage` 携带 compact 后最新安全快照（无冻结窗口时为 `null`）。宿主不得以 `summary === ""` 推断 skipped，不得把 `preTokens`/`postTokens` 当 Provider 实测（它们是本地估算）。 |

`compact` 与内部 `run()` 的关系：Runtime 在收到 `CONTEXT_OVERFLOW` 时会执行**一次** reactive compact，然后以新的 running checkpoint 重新调用内部 `run()`（同一 `turnId`、保留 `completedCallIds` 与 Todo）。第二次溢出或 compact 失败会发出 `context_compact_circuit_open` 并以 `turn_failed` 失败关闭，不会重放已完成的工具调用。

压缩机制的完整性描述——**五位一体设计**：80% 阈值预算器、采样前安全点自动压（`auto`）、换窗口主动压（`proactive`）、供应商溢出被动压（`reactive`，带熔断）与手动压（`manual`，带运行守卫）。五条触发路径共用同一压缩引擎（按普通 user 回合分组、尾部保留、canonical 切点安全校验、摘要后组装，收尾校验 `postTokens ≤ targetTokens`），区别只在触发时机、消息来源与守卫条件：

| 触发路径 | 触发时机 | 行为与守卫 |
|---|---|---|
| `auto`：80% 阈值预算器 + 采样前安全点 | 每次 `before_sample` 安全点采样前，预算器判定达线 | Kernel 原地替换消息、作废 usageAnchor、写 running checkpoint 并发 `context_compacted`；未配置上下文窗口的 provider 不启用此路径 |
| `proactive`：换窗口主动压 | Turn 启动时上一 Turn 上下文窗口 > 当前 Turn 上下文窗口 | 先压缩一次再执行本 Turn；失败发 `context_compact_failed` 并以 `turn_failed` 关闭 |
| `reactive`：供应商溢出被动压（带熔断） | Provider 报 `CONTEXT_OVERFLOW` | 压缩后以新 running checkpoint 重跑内部 `run()` 一次；仍溢出或压缩失败发 `context_compact_circuit_open` 并以 `turn_failed` 失败关闭 |
| `manual`：宿主调用 `turns.compact()`（带运行守卫） | 宿主显式触发 | 消息来源是 durable checkpoint 而非内存投影；Turn 在本进程运行中，或 checkpoint 被其他 Runtime 的新鲜 lease 持有且本进程非 owner 时拒绝（`TURN_ALREADY_RUNNING`）；成功后写回 checkpoint 并显式丢弃旧 usageAnchor（旧锚点对新消息序列无效） |

`auto` 路径的阈值预算器按比例推导，不依赖魔法数字：**触发线 = min(窗口 × 0.80, 窗口 − 输出预留 − 安全 buffer)**。输出预留取 `sampleOptions.maxTokens`（默认 8,192），安全 buffer 取 max(8,192, 窗口 × 2%)，两条约束取更严者。provider 配置可显式指定 `compactThresholdTokens`，但最终触发线只取显式值与派生值的较小者，不会放宽派生约束。保留策略由 `RunConfig.compactPolicy`（`CompactPolicy { preserveRecentTurns, targetTokens }`）控制，未显式冻结 policy 时默认保留最近 4 个回合、target 70,400 token。

```ts
await runtime.turns.steer({
  sessionId: session.id,
  turnId: "turn-001",
  content: "先停止修改，只列出风险。",
  delivery: "steer",
  clientMessageId: "web-message-42",
});
```

### 2.7 审批与输入服务

| 服务 | 方法 | 用法与约束 |
|---|---|---|
| `runtime.approvals` | `submit(input)` | 提交 `{ sessionId, turnId, approvalId, decision }`；Core 会校验冻结的 call、工具、输入 hash 与授权范围。 |
|  | `getDecision(input)` | 查询指定审批决定。 |
|  | `hasPersistentGrant(input)` | 查询某 workspace/session、工具和 constraint 是否命中持久授权。 |
|  | `listPersistentGrants(input?)` | 列出持久授权，可按 `workspaceRoot` / `sessionId` 过滤；公开投影剔除外部执行约束的 canonical 私有身份（`executionTarget` / `externalRule`），并保留 `projection` 记住状态。 |
|  | `revokePersistentGrant(input)` | 按 `{ workspaceRoot, sessionId, toolName, constraint }` 精确撤销：先删 grant 权威，再删工作区 local 投影规则；返回 `{ deleted, ruleRemoved }`。 |
| `runtime.inbox` | `post(input)` | 写入 steer 或 queue 输入。 |
|  | `claimNext(input)` / `consume(input)` | 按 steer 优先、同类 FIFO 领取并消费输入。 |
|  | `list(input)` / `drain(input)` / `cancel(inputId)` | 读取、批量领取或取消输入。 |
| `runtime.questions` | `submit(input)` | 提交 `{ sessionId, turnId, requestId, answers }`；Core 只在 `awaiting_user_input` 且三重归属一致时原子保存。随后 `turns.continue({ sessionId, turnId, requestId })` 从可信 Store 回灌原工具结果。 |

`allow_session` 与 `allow_workspace` 只可由 `approvals.submit()` 建立；宿主不得自行写入授权存储。`ask` 模式下 `run_command` 只接受 `allow_once` 或 `deny`。任务文件集合审批（`constraint: "task-files:v1"`）与外部文件集合审批（`constraint: "task-ext-files:v1"`）的 `allow_once` 语义均为"批准本任务文件集合"：`submit()` 保存 `scope: "allow_session"` 且带 `turnId` / `taskFiles` 的集合 grant，`PersistentGrant` 因此新增可选 `turnId` 与 `taskFiles` 字段；该类 grant 不进入普通 `hasPersistentGrant` 命中路径，仅由 write/edit 的成员检查消费——工作区集合按工作区相对路径精确匹配（`path:` 约束），外部集合按 canonical 绝对路径经 comparable 归一精确匹配（`ext-file:` 约束），均绑定声明操作，不含父目录或递归语义；两类集合 grant 互相独立，工作区集合批准不自动放行外部目标。

外部 `allow_workspace` 的 local 投影失败时，`submit()` 返回 `projection: "pending"`，该持久 grant 不生效。Node 投影 add/remove 在文件锁内严格读取现有配置：只有不存在可视为空；JSON 损坏、顶层非对象或不可读均保留原字节并拒绝，诊断为 `EXTERNAL_RULE_SETTINGS_INVALID` / `EXTERNAL_RULE_SETTINGS_UNREADABLE`（不安全链接为 `EXTERNAL_RULE_TARGET_UNSAFE`）。撤销先删除 grant，投影删除失败返回 `{ deleted: true, ruleRemoved: false }`，不重建权威。

`ask_user_question` 是按宿主 capability 注册的交互 Tool，不是审批或命令入口。它只在 Web 等具备结构化 answerer 的宿主可见：模型请求后 Turn 进入 `awaiting_user_input`，答案经 `questions.submit()` 持久化，再由同一 Turn 的 `continue({ requestId })` 读取。CLI 保持该 Tool 不可见；必要澄清由普通助手正文完成并正常结束当前 Turn，下一条 prompt 依靠同 Session 的 canonical history 继续。

### 2.8 运行配置与事件

```ts
interface RunConfig {
  toolAllowlist?: readonly string[];
  chatLoader?: (binding: ChatCapabilityBinding) => Promise<ChatCapability | undefined>;
  workspaceRoot?: string;
  workspaceTrusted?: boolean;
  modelRef?: ModelRef;
  reasoningProfile?: ReasoningProfile;
  credentialRef?: CredentialRef;
  permissionMode?: "ask" | "auto_approve" | "full_access";
  rag?: RagCapability;
  web?: WebCapability;
  webLoader?: () => Promise<WebCapability | undefined>;
  databaseSearch?: DatabaseSearchCapability;
  databaseSearchPolicy?: { enabled: boolean };
  ragSourcePolicy?: RagSourcePolicy;
  context?: AgentContextSnapshot;
  skills?: AgentSkillsCapability;
  inputInbox?: AgentInputInboxCapability;
  focusedPdfFileName?: string;
  maxSteps?: number;
  maxToolRetries?: number;
  /** 单个活动执行段的运行时长安全上限；仅在 start 时冻结。 */
  maxDurationMs?: number;
  /** 当前 Turn 的显式累计 Provider token 安全上限；缺省关闭，跨 Continue 保留，仅在 start 时冻结。 */
  maxTotalTokens?: number;
  modelSampler?: ModelSampler;
  modelSamplerFactory?: ModelSamplerFactory;
  mcp?: McpCapability;
  compactPolicy?: CompactPolicy;
  /** OS 沙箱模式；仅 Runtime 宿主默认值可设置，Turn/Session/Project 覆盖不生效，缺省 workspace-write。 */
  sandboxMode?: SandboxMode;
  /** 宿主显式验证的受控临时目录；仅 Runtime 宿主默认值可设置，缺失时不回退环境 TEMP/TMP。 */
  sandboxTempRoot?: string;
}
```

- `toolAllowlist` 只收窄工具集合。Runtime 静态上限、动态 settings 上限和 Turn override 取交集；产品模式只从 Session 读取。新 Turn 的 `FrozenRunConfig.capabilityCeiling` 保存模式和工具名上限，`FrozenRunConfigView.capabilityCeiling` 只投影这份安全摘要。Chat 另在私有冻结配置保存附件 grant，公开视图不包含它。
- Chat start 只接受当前 `content`，拒绝外部 `messages` 或 Skill 上下文；`turnId` 不能覆盖已有 Turn。Chat override 不能替换宿主 sampler、`chatLoader`、Web loader、Workspace、RAG、Skill、MCP 或数据库能力。continue 复查 Session 与冻结模式，工具名及附件 ref 均受原快照限制；Chat 缺少冻结身份或模式不一致时抛 `SESSION_MODE_MISMATCH`。Work 新 Turn 由 Core 写入 `workContextVersion: 1`；有任一旧 Turn 缺少该版本或 Work ceiling、孤立 checkpoint/transcript，或无可信 Turn 的旧展示内容时，start/continue/steer/compact 抛 `WORK_HISTORY_READ_ONLY`。`getState()` 返回同名 `readOnlyReason` 并保持受限 checkpoint 原样，`getRecoverableState()` 返回 null；旧文件和历史不自动删除。新边界下完整的 Work 任务正常恢复。
- `credentialRef` 只保存引用 `{ provider, key }`，真实 API key 只由 `CredentialStore` 解析。
- `web` 是 Trust 后由宿主注入、只存在于当前进程的能力容器，不会进入 `FrozenRunConfig`、checkpoint、event 或持久化配置；`search` / `fetch` 子能力可独立存在，缺少某项时对应 `web_search` / `web_fetch` 工具完全不可见。完整 Search query 与结果只在同一进程的当前采样链中短暂存在；写入 durable checkpoint 前，调用参数与工具结果会替换为保持配对关系的安全占位，恢复后如仍需该信息必须重新搜索。
- `AgentMessage` 是唯一运行时 canonical 消息：`text`、`reasoning`、`tool-call`、`tool-result` 四类 block 不含 Provider wire 字段。恢复发现未闭合调用时会先写入确定性 error result；`TOOL_OUTCOME_UNKNOWN` 不代表执行失败，而是要求先验证外部副作用。
- `AgentEvent` 是对外事件联合；所有携带 checkpoint 的事件都使用同一最小生命周期视图，`messages` 与 `completedCallIds` 固定为空数组，只保留安全 Skill 身份。`getState()` 的 checkpoint 另可带 `consumedInputIds` 供 Web 输入去重；宿主不得收到 canonical 消息、pending calls、工具参数/结果、`runtimeBudget`、`usageAnchor`、Provider 原文或凭据。
- `tool_progress` 只在长时工具执行期间产生，`tail` 为命令输出最后 ≤160 字符的节流尾部，仅用于运行中的实时进展展示；不得作为终态摘要持久化，也不进入 transcript。
- 终态事件和 `getRecoverableState()` 可携带 `termination: { reason?, recoverable, budget? }`。原因仅为 `runtime_budget | token_budget | repeated_tool_calls | write_verification | stale_lease | turn_limit_reached`；预算仅允许 `runtime_budget` 的非负安全整数毫秒值或 `token_budget` 的非负安全整数 Token 值。旧事件缺少投影时保留 Core 确认的恢复布尔值，不伪造原因或数值。
- `todo_write` 是自动允许的内部状态工具。每次只接受完整替换列表 `todos`（0–20 项，`content + activeForm + status`，三态且未完成时恰有一个 `in_progress`）；成功后产生 `todo_updated`，携带当前任务链身份、受限 Todo 文案和 Core 计算的计数。completed 只表示计划状态，不表示测试、文件修改或发布成功。同一调用可附带可选 `fileTargets`（≤50 项，`path` 为工作区相对路径 + `operation: "create" | "edit"`）声明本任务的修改文件清单：此时该调用转为 `task-files:v1` 审批（`allowedDecisions` 仅 `allow_once`/`deny`），用户批准后 Core 保存绑定当前 Turn 的集合授权；本 Turn 内 `write_file`/`edit_file` 对清单成员按声明操作自动放行，非成员、新目标与外部路径仍走既有逐次审批。跨 Turn 集合自然失效；同一 Turn 的增量声明按 `path+operation` 合并。已知要修改多个工作区外文件时，可改用可选 `externalFileTargets`（≤50 项，`path` 为绝对文件系统路径，拒绝相对路径、`..`、UNC 与备用数据流语法）声明外部文件清单：转为独立的 `task-ext-files:v1` 审批（与工作区集合分卡、单独一次批准，`allowedDecisions` 同样仅 `allow_once`/`deny`），Core 在声明期把每个目标 canonical 化冻结进清单（symlink 按解析后的真实目标身份），解析进工作区的声明被拒绝并提示改用 `fileTargets`；两类声明不得混在一次调用。批准后本 Turn 内对清单内精确外部文件的对应修改自动放行，授权不含父目录或递归语义；外部 deny/ask 规则快照收窄仍先于集合命中。
- Todo 快照只由 `todo_updated` 投影；`sanitizeEventForExternal()` 会把对应 `tool_result.output` 降为 counts，避免浏览器从原始工具结果重建列表。绝对路径和常见凭据片段会在 Todo schema 阶段拒绝。
- `maxDurationMs` 与显式的 `maxTotalTokens` 均在每个 Turn 冻结；前者是单个活动执行段的时长上限，默认关闭，可由 `AGENT_MAX_DURATION_MS` 或 RunConfig 显式启用且无固定平台封顶；后者是跨 Continue 累计的 Provider token 上限，默认关闭，可通过 `AGENT_MAX_TOTAL_TOKENS` 或 RunConfig 显式启用，硬上限 10,000,000 tokens。等待、审批和用户回答期间不消耗新的执行段时长；Continue 取得执行 lease 并开始运行时重开时长段，但保留同一 Turn 的显式 token 累计。预算在完整工具批次等安全边界检查：`runtime_budget` 触顶产生 `interrupted_recoverable`，`continue()` 保持同一 Turn 与累计 token 预算；显式 `token_budget` 耗尽则产生 `failed` 终态，Core 拒绝继续执行。旧模式/旧默认值不在当前契约范围，本轮不提供迁移保证。上下文水位仍由现有 auto compact 管理；跨 Turn 的 Goal 全局预算仍需由 Goal 域单独聚合。
- 连续相同的工具名、规范化参数和结果摘要会触发无进展护栏：第 3 次注入提醒、第 5 次强提醒、第 8 次以 `interrupted_recoverable` 暂停（`interruptionReason: "repeated_tool_calls"`）。参数/结果变化、成功 mutation、Todo 推进或 steer 会重置计数；只保留脱敏哈希与次数，`sanitizeCheckpoint()` 不向宿主公开该私有状态。
- Durable Runtime 在每个完整的模型采样与工具批次结果之后保存 `status: "running"` checkpoint，再开始下一次采样；快照包含 canonical 消息、`completedCallIds`、剩余 `pendingCalls`、Todo、usage 与安全预算，并用 lease 的 `safeBoundarySeq` 保持写入顺序。进程在该边界后重启时，已完成工具不会重放；若仍有未闭合调用，则恢复沿用 `TOOL_OUTCOME_UNKNOWN` 的 fail-closed 语义，要求先验证外部状态。
- `resolveRunConfig()`、`resolveAgentRuntimeLimits()`、`resolveLimitConfig()` 是纯函数，可用于宿主预览解析结果；实际 continue 仍只使用冻结配置。
- 沙箱契约：`FrozenRunConfig` 冻结 `sandboxMode`、`sandboxTempRoot`、`sandboxPolicyDigest`（mode/workspaceRoot/tempRoot 的 SHA-256，不含敏感路径明细）与 `sandboxPolicyVersion: 1`。`sandboxMode` 与审批 `permissionMode` 正交，未知值在 `resolveRunConfig` 抛 `SANDBOX_MODE_INVALID`；`danger-full-access` 只能来自宿主默认值，模型输入、工具参数、持久 grant 与 Chat 请求体均不可达。Continue 沿用冻结值；旧 checkpoint 缺 sandbox 字段时在恢复边界幂等迁移为 `read-only`（fail-safe，不可继承宽能力）。`RuntimePorts.sandboxPort` 为 mandatory 字段，未接入真实 backend 的装配必须显式提供 `createUnavailableSandboxPort()`（一切进程执行 `SANDBOX_UNAVAILABLE`）；`SandboxPort.prepare` 只接受已校验的结构化 `program + args + canonical cwd + 冻结 policy + commandId`，输出可直接 spawn 的 argv + env，Core 不感知平台实现。稳定错误码 `SANDBOX_UNAVAILABLE` / `SANDBOX_NOT_PROVISIONED` / `SANDBOX_POLICY_DENIED` / `SANDBOX_RUNNER_FAILED` / `SANDBOX_SCOPE_CONFLICT` / `SANDBOX_CLEANUP_FAILED`；policy denial（沙箱正常且拒绝）与 runner failure/unavailable（目标命令未安全启动）语义不得混淆。
- 沙箱 settings 与 Node Adapter：settings 新增 `sandbox` 安全字段——`mode`（仅 User scope，且只允许 `read-only`/`workspace-write`；`danger-full-access` 不允许从 settings 文件声明）与 `allowedDomains`（仅 User scope）；`deniedRead`/`deniedWrite` 任意 scope 按并集收窄；裸 `*`、未知字段与非空字符串数组一律产生 `SETTINGS_SANDBOX_INVALID` / `SETTINGS_SANDBOX_MODE_FORBIDDEN` / `SETTINGS_SANDBOX_SCOPE_FORBIDDEN` 诊断。Node 装配侧 `createNodeRuntimePorts` 在 Work 模式（提供 `workspaceRoot`）下装配 `createNodeSandboxPort({ workspaceRoot, tempRoot })`，`sandboxTempRoot` 必须由宿主显式验证后传入（CLI 使用 Trust 后的 `<workspace>/.autopilot/tmp`）；Chat 模式或缺 root 保持 unavailable stub。Node adapter 绑定单一 canonical root（policy root 不一致抛 `SANDBOX_SCOPE_CONFLICT`），macOS 用 Seatbelt 且 prepare 输出 enforcement=full，`TMPDIR` 以受控 tempRoot 前缀覆盖 SRT 注入的 `/tmp/claude`；Windows 已接入原生 argv、公共匹配 runner 和会话 ACL/WFP 初始化；初始化失败、网络未就绪和 danger-full-access 均 fail-closed。`status().enforcement=full` 仅表示本次会话 OS 约束就绪，不代表完整 Windows 兼容性或发布验收；SRT 0.0.78 的 Windows stdio stdin 转发缺失、Job 全树停止实机失败，Stage4/6 尚未验收通过（r008）。`readWindowsSandboxCapability` / `runWindowsSandboxSetup` 提供脱敏 status 与显式安装入口（UAC 取消不视为错误）；错误映射不透传 SRT 原始文案。`AgentRuntime.shutdown()` 顺序为 `jobs.shutdown()` → `sandboxPort.shutdown()`（幂等）。
- 前台与后台命令沙箱接入与审批自动放行：`run_command` 与 `start_background_job` 是仅有的两个进程类工具入口，除宿主可信配置的 `danger-full-access` 单次直执（见下条）外执行路径不存在裸 spawn——`ToolExecutor` 对这两个工具强制解析沙箱范围并注入沙箱事实（绑定缺失或 `status()` 能力不可执行时以 `sandbox.available=false` fail-closed deny `SANDBOX_UNAVAILABLE`，不转普通审批、不裸跑）；已确认可执行时把 `SandboxExecutionScope`（port + 冻结 policy）注入执行上下文。前台：`run-command-tool` 先用 `getPlatformExecutable` 完成平台可执行名解析，再经 `SandboxPort.prepare({ commandId, program, args, cwd, policy })` 生成包装 argv 后 spawn（`env` 为 `process.env` 与 prepare 输出合并），close/error/超时/取消全部终态幂等 `release(executionId)`，成功结果携带安全沙箱事实 `sandbox: { enforcement, mode }`。后台：`start-background-job-tool` 缺少已解析范围时同样抛 `SANDBOX_UNAVAILABLE`，并把范围交给 `JobService.start`（见 2.3：受信解析 → `prepare` → spawn、全终态 `release`、durable 记录只保存安全 policy 摘要）；prepare 失败不产生 running Job，稳定 `SANDBOX_*` 错误码原样投影为工具错误。`PolicyEngine` 的 G4 分支：仅当调用已确认可在沙箱内执行（`sandbox.available === true`）且 `auto_approve + workspaceTrusted` 时，外部副作用/未知风险命令才自动放行；ask 模式保持 `allow_once-only` 逐次审批，hard deny、Skill、grant、`full_access` 与既有收紧分支顺序不变。绑定注入链：`turn-runtime-config-resolver.buildAgentOptions` 仅在 Work Turn 注入 `{ port: RuntimePorts.sandboxPort, mode: FrozenRunConfig.sandboxMode（缺省 fail-safe 为 read-only）, tempRoot: sandboxTempRoot }`，经 `RunContext.sandbox` 传入 Kernel；Chat 不注入。
- 沙箱启动失败降级与拒绝终态：进程类调用执行前对沙箱范围做最多 3 次探测（探测只读 `status()`，不启动目标命令，重试安全），仍失败按模式分流——`read-only` 与 `workspace-write` 一律维持 fail-closed deny（沙箱不可用时不存在受控执行通道，无法证明授权状态保护与外部写门禁，无沙箱直执不提供任何权限豁免，`start_background_job` 与外部写命令同等 fail-closed）；`danger-full-access` 是宿主可信配置的明确无隔离授权，直接执行不经过沙箱失败流程（PolicyEngine 沙箱事实注入 `available:true` 维持与沙箱可用时一致的放行行为，执行结果 `enforcement: "unavailable"` 不得展示为隔离）；Windows 下 `npm`/`npx`/`pnpm` 直接执行前与沙箱路径共用同一受信解析——转换为可信 `node.exe` + 对应 CLI 脚本 + 结构化 argv，不经 shell 拼接，受信 CLI 不可用时命令不启动（`SANDBOX_UNAVAILABLE`）。workspace-write 的无沙箱降级审批（稳定约束 `no-sandbox-exec:v1`、卡片展示完整命令与脱敏诊断、批准后 `sandboxExecutionOverride: "direct"` 直执一次）已从执行链撤下：命令已记住（grant）、任务文件集合已批准、工作区已信任、`full_access`/`auto_approve` 均不能改变 fail-closed 结果；其冻结/原子消费权威底座（`SandboxDegradeApproval` + `consumeDegradeApproval`，跨重启经 `validateApproval` 核对 constraint 与 TTL）保留休眠，供未来受控执行方式（如独立执行身份＋宿主持有授权状态）复用。拒绝与诊断：deny 结果按 `errorCode` 区分环境阻塞（`SANDBOX_UNAVAILABLE`/`NOT_PROVISIONED`/`RUNNER_FAILED`，诊断以结构化 display 事实 `diagnostics` 投影，error message 只保留策略原因）与用户拒绝（`APPROVAL_REQUIRED`）；进程类调用的结果展示事实携带结构化 `executionMode`（`sandboxed`/`unisolated`/`unavailable`），展示层不得把 `unisolated`/`unavailable` 宣称隔离。命令审批展示事实（`ApprovalDisplayFacts`）另冻结可识别工作目录 `cwd`（本地 facts 提供 canonical 目录，未绑定 workspaceRoot 时为输入原文）与 `unknownScope`（命令声明外部效果但未声明精确目标时为 true，展示层给出"修改范围无法精确限定"提示，不得宣称"仅覆盖精确目标"）；`actionPreview` 保留既有长度预算与凭据脱敏，触达预算时附截断提示。Kernel 对一切 denied 终止写 `turn_failed`（checkpoint `status: "failed"`），文案按 errorCode 区分（沙箱→"沙箱不可用，无法提供已隔离执行，本次任务已停止"，用户拒绝→既有"不会尝试其他命令"），任务受阻不得显示为 `turn_completed`。用户拒绝不得触发自动重试。
- 文件工具 mutation 名义层：`write_file` / `edit_file` 按已确认的选项 A 直接修改真实工作区，不进入 OS 进程沙箱；两者在执行锁内、真实 mutation 前读取 Turn 冻结 `sandbox` 绑定模式——`read-only` 一律拒绝并返回 `FS_SANDBOX_DENIED`（文件工具域稳定错误码，区别于进程域 `SANDBOX_POLICY_DENIED`），且不产生任何磁盘变化，判定只消费冻结 mode、不依赖 SandboxPort capability；`workspace-write` 与 `danger-full-access` 均维持既有工作区围栏（锁内 canonicalize-then-contain、审批、mutation WAL、写后 hash、Undo 不回退），`danger-full-access` 不放宽工具 schema 与允许范围；tempRoot 只属于进程沙箱策略，不构成文件工具写白名单；缺沙箱绑定的旧上下文不虚构 read-only，沿用既有围栏行为。

#### Chat 只读 capability

`RunConfig.chatLoader(binding)` 仅由 Runtime 的受信默认配置提供，返回进程内 `ChatCapability | undefined`；绑定参数为 `{ sessionId, turnId, retrievalMode }`。模型、Route DTO 与持久化配置不能提供 capability 对象。Core 负责目录、执行校验和证据门；Node 的默认 Workspace capability loader 不装配 Chat 端口。

| 模式 | 工具目录上限 |
|---|---|
| Chat none | 无有效附件时为空；临时文档增加 `chat_attachment_read`，合法图片/渲染页 ref 增加 `chat_vision_analyze`。 |
| Chat web | 按已装配子能力增加 `web_search`、`web_fetch`；附件规则同 none。 |
| Chat rag | 已装配 Knowledge capability 时增加 `rag_search`；有视觉 capability 时增加 `chat_vision_analyze`，调用必须先取得当前合法证据 ref。不注册临时附件读取、Web、DB 或通用视觉工具。 |
| Work | 保留 Workspace 任务工具、Web、可选数据库、Trust 与审批；禁止 `rag_search`、旧 `lancedb_query` 和两个 Chat 专用工具，包括省略 ceiling 的兼容调用。 |

Registry 按上述上限注册，Executor 在 Schema/ActionFacts、审批和 handler 之前独立检查。产品越权工具返回兼容错误码 `CHAT_TOOL_FORBIDDEN`；整批调用任一未通过时，不产生 `tool_started` 或执行 handler。模式内缺失能力不会通过其他工具降级。Chat 的只读 Search/Fetch 不进入审批；需要新增域名审批的 Fetch 重定向返回 `WEB_URL_BLOCKED`。Work 的域名审批保留；通用 `vision_analyze` 的严格输入只接受任务图片 `path + prompt`，不再接受 RAG `visualEvidenceRef`。

`ChatCapability` 的字段和调用边界：

| 字段/方法 | 输入与输出 | 限制 |
|---|---|---|
| `attachments?` | `readonly ChatAttachmentGrant[]`；每项 `{ ref, sessionId, kind: "document" \| "image", expiresAt, displayName? }` | 新 Turn 冻结授权字段，恢复与 Host 当前目录取交集；可选名称只用于识别，不作为授权。 |
| `authorizeRef?` | `binding & { ref, kind, batchId?, signal? } → Promise<boolean>` | 每次读取前复查 Session、有效期、删除/撤销态及当前知识批次；最大等待 5 秒。 |
| `readAttachment?` | `binding & { attachmentRef, signal? } → Promise<{ text, pageImages?: readonly ChatAttachmentGrant[] }>` | 只读受控解析结果；文本 16,000 字符，最多 20 个页图；页图不能延长父附件有效期，不能跨会话；30 秒。 |
| `readImage?` | `binding & { ref, batchId?, signal? } → Promise<{ bytes: Uint8Array, mimeType }>` | Core 校验 PNG/JPEG/WEBP/GIF 魔数；单图 5 MiB，每 Turn 最多 4 次、总 20 MiB，读取 30 秒。 |
| `visionAnalyzer?` | 既有 `VisionAnalyzer.analyze()` | 只处理已授权图片，最长 60 秒；观察文字最多 8,000 字符；不返回字节、data URL 或路径。 |
| `knowledge?` | `ChatKnowledgeCapability` | 固定独立 Knowledge Space，不能混用 Workspace RAG；none/web 不保留此能力。 |

每次模型采样前投影当前临时附件目录（ref、类型和去路径显示名），由冻结授权与当前 Host 目录约束，不将目录写入历史或从模型消息恢复权限。RAG 视觉输出包含与当前 ref 关联的 evidenceId；同一图片再次识别后，采样与核验均只使用最新观察，旧观察保留在历史但不参与采样。有效批次中的格式/摘录错误允许一次固定指令纠正；被拒绝的正文不展示、不持久化，再次失败仍返回证据不足。

opaque ref 与 evidence ID 为 16–128 位字母、数字、下划线或连字符；工具 Schema 严格拒绝路径、URL、data URL 和附加字段。`chat_vision_analyze` 输入为二选一的 `attachmentRef` / `visualEvidenceRef` 加 1–4,000 字符 `prompt`；RAG 只接受当前检索产生的视觉 ref，none/web 只接受当前附件 ref。无效引用统一为 `CHAT_ATTACHMENT_UNAVAILABLE`。Host 必须在实际解析时继续复查真实存储状态，不能仅依赖 Core 目录。视觉预算随 checkpoint 保存，恢复保守计数；引用授权表不从历史消息恢复，RAG 必须重新检索，派生页图需要重新读取文档取得。

`ChatKnowledgeCapability` 包含 `knowledgeSpaceId`、`prepareSearch(binding & { query, topK, signal? }) → Promise<ChatRagEvidenceBatch>` 和 `validateEvidence(binding & { batch, signal? }) → Promise<boolean>`。Host 的检索适配应复用 canonical RAG pipeline。批次必须携带 `sessionId`、`turnId`、`knowledgeSpaceId`、opaque `batchId` 及 `evidence`；证据项为 `{ id, text, sufficient, sourceLabel?, sourceImageUrl?, visualEvidenceRef? }`，最多 20 项、每项 4,000 字符。可选 `sourceLabel` 为受信宿主提供的可读文件名及页码，最多 240 字符，不含路径或内部标识，参与完整批次复核。可选 `sourceImageUrl` 是受信宿主生成的站内图片预览地址，仅接受单斜杠开头及有界字母数字/斜杠/下划线/连字符，随批次完整校验；不承载模型视觉授权。`sufficient` 来自受信检索链，不能由模型或浏览器声明。错误归属、空/低质量证据、撤销/失效或 Provider 异常都视为不足。

RAG 正文在证据核验前缓冲，工具前叙述和推理摘要不作为事实流出。模型通过内部 `chat_submit_answer` 单独提交参数 `{"quotes":[{"evidenceId":"...","quote":"逐字摘录"}]}`，Core 检查当前批次仍有效，且每段摘录确实存在于对应文本证据或该 ref 已成功取得的视觉观察中，再生成带 `[1]` 等本答复编号的答复及来源列表。来源使用转义后的 `sourceLabel`，媒体按预览地址、其他来源按标签复用编号；未提供标签时显示“私有资料”。提供 `sourceImageUrl` 时在来源下附 Markdown 图片，宿主应限制为受控资源/实际 PDF 页预览。内部 ID 仍用于授权核验，不拼入新答复正文，不从模型生成的来源名或 URL 建立引用；旧历史正文不回写。视觉问答另支持 `{"visualAnswers":[{"evidenceId":"..."}]}`：必须属于当前有效批次、已成功取得最新视觉观察且带受信来源图片，Core 直接呈现该观察并附来源图。视觉 Provider 可围绕图片做适度概括并说明不确定性，不要求逐字 OCR；主模型不在该结构中另填事实。纯文本自由改写、伪引用、无有效观察等不满足边界的输出均不会直接展示。普通文字触发仅提供答案提交工具的强制收尾，非法结构或引用可按当前 Turn 纠正一次，恢复保留已用预算，新 Turn 独立计数；历史纠正指令只在采样投影中移除，durable 历史不改写。纠正耗尽返回“答案整理失败，未能生成可核验的引用，请重试。”，与真实空/无效证据或显式提交 `{ "insufficient": true }` 的“知识库未覆盖此问题或当前证据不足，请补充相关资料后重试。”分开。`insufficient` 不能与答案并存。提交是 Kernel 内部终态协议，不在 Executor 注册、不产生工具执行事件、不扩张 Chat 权限；混合提交与其他调用时整批不执行。空召回工具结果带 `CHAT_RAG_EVIDENCE_INSUFFICIENT`。此门保证来源可核验，不判断原始知识本身是否真实。新 steer 输入使旧批次失效。RAG 不加载 Web loader/credential，也不回退到公网或普通问答。

### 2.9 Runtime 协议辅助 API

| API | 签名 | 使用规范 |
|---|---|---|
| `parseMcpConfig` | `(raw: unknown) => McpCapability` | 纯解析 `.autopilot/mcp.json` 的对象或数组形式，不读文件、不启动 MCP 子进程；非法 server 会被跳过。`env` 仅允许非敏感固定值或 `{ credentialRef }`。server 可设置 `execution: "sandbox" | "host"`，缺省为 `host`；直接传入 Core 的 `McpServerConfig` 若省略该字段也按 `host` 处理。只有显式 `execution: "sandbox"` 才经 `SandboxPort`，且初始化失败保持 fail-closed。`host` 以宿主权限运行，状态与工具审批均显示 `unisolated`，并使用受控环境：PATH、显式 env/凭据与已存在的 Windows `SystemRoot`、`SystemDrive`、`ComSpec`、`PATHEXT`。Windows 缺失的 libuv required vars（`HOMEDRIVE`、`HOMEPATH`、`LOGONSERVER`、`PATH`、`SYSTEMDRIVE`、`SYSTEMROOT`、`TEMP`、`USERDOMAIN`、`USERNAME`、`USERPROFILE`、`WINDIR`）及 `TMP` 会以空字符串中和，防止 libuv 从宿主补回；Windows 环境键按大小写不敏感规则合并，显式配置/凭据覆盖默认值。其他宿主环境变量不继承。沙箱准备环境中的同名变量也按平台规则覆盖配置值。两种模式都要求 Workspace Trust、绑定当前有效配置的精确 grant 与逐次 MCP 工具审批。 |
| `getMcpServerConfigHash` | `(server: McpServerConfig) => string` | 为 name、command、args、cwd、受控 env 与有效执行方式（缺省按 `host`）生成稳定 hash；`execution: "host"` 与 `execution: "sandbox"` 均参与 hash。模式切换会使 grant 失效；旧算法未包含模式的 grant 不匹配新 hash，迁移后需重新授权。 |
| `getMcpServerGrantConstraint` | `(server: McpServerConfig) => string` | 返回绑定 `serverName + configHash` 的 `mcp_server_start` 持久授权约束；只有 Trust 和当前模式/配置对应的精确 grant 命中后才尝试启动。 |
| `createEventEnvelope` | `(input: CreateEventEnvelopeInput) => AgentEventEnvelope` | 纯工厂；同一 durable Turn 的 start/continue/recovery 由 Runtime 保持单调 `seq`，调用方提供 ISO 时间戳。 |
| `sanitizeCheckpoint` | `(checkpoint: AgentCheckpoint) => PublicCheckpointView` | 只投影生命周期字段、空消息/调用数组、安全 Skill 身份及可选 `consumedInputIds`；canonical 消息和工具事实不进入宿主状态。 |
| `sanitizeEventForExternal` | `(event: AgentLoopEvent) => AgentEvent` | 对终态与非终态 checkpoint 统一应用严格白名单；另将 `todo_write` 结果降为 counts、Web 工具结果降为安全事实并固定化错误文案。 |
| `sanitizeAgentTerminationView` | `(value: unknown, recoverableOverride?: boolean) => AgentTerminationView \| undefined` | 只接受终态原因、Core 恢复布尔值及与原因匹配的有限预算数值；未知字段或非法预算不会被复制。 |
| `resolveRunConfig` | `(input: ResolveRunConfigInput) => FrozenRunConfig` | 按 Turn > Session > Project > Runtime 默认值解析，并保持 Trust 只来自 Runtime 默认值。 |
| `resolveAgentRuntimeLimits` | `(request?: Partial<ResolvedAgentRuntimeLimits>) => ResolvedAgentRuntimeLimits` | 统一解析 `maxSteps` 和 `maxToolRetries`；未配置 `maxSteps` 时保持 `undefined`，不启用总 step 闸门。 |
| `resolveAgentRuntimeSafetyLimits` | `(request?: Partial<AgentRuntimeSafetyLimits>) => AgentRuntimeSafetyLimits` | 解析显式时长/Token 安全预算；时长不封顶，Token 仍受硬上限约束，不负责 Goal 跨 Turn 聚合。 |
| `resolveLimitConfig` | `(config: LimitConfig) => number \| undefined` | 非正数回退已配置默认值；请求值与默认值都缺省时返回 `undefined`，配置了 `hardLimit` 时才封顶。 |
| `AGENT_RUNTIME_LIMIT_DEFAULTS` / `AGENT_RUNTIME_LIMIT_HARD_LIMITS` | 常量 | `maxSteps` 默认关闭，显式正整数无固定平台封顶；`maxToolRetries` 硬上限为 `10`、默认值为 `5`。 |
| `AGENT_RUNTIME_SAFETY_DEFAULTS` / `AGENT_RUNTIME_SAFETY_HARD_LIMITS` | 常量 | 执行段时长和 Turn 累计 Token 默认关闭；时长无固定平台封顶，Token 硬上限为 `10,000,000`；不替代 Goal 域预算。 |
| `SANDBOX_ERROR_CODES` / `SANDBOX_POLICY_VERSION` | 常量 | 6 个稳定沙箱错误码与沙箱冻结语义版本（当前 `1`）；`isSandboxPolicyDenialCode` / `isSandboxAvailabilityFailureCode` 区分两类失败语义。 |
| `resolveSandboxMode` | `(value: unknown) => SandboxMode` | 只接受 `read-only` / `workspace-write` / `danger-full-access`；未知值抛 `SANDBOX_MODE_INVALID`，不静默回退。 |
| `computeSandboxPolicyDigest` | `({ mode, workspaceRoot?, tempRoot? }) => string` | 冻结 policy 的 SHA-256 安全摘要；确定且不泄露路径明文。 |
| `createUnavailableSandboxPort` / `SandboxPortError` | 工厂 / 错误类 | fail-closed 默认 Port（一切进程执行 `SANDBOX_UNAVAILABLE`）；错误 `code` 必须来自 `SANDBOX_ERROR_CODES`。 |

受管后台执行扩展：`SandboxExecutionRequest.managed?: boolean` 请求可选控制能力；`SandboxPreparedCommand.control?: ManagedExecutionControl` 只属于本次执行，不持久化。`protocolVersion: 1`、一次性 `bind(ManagedExecutionChannel)` 和 `stop(): Promise<{ evidence: "container_empty" }>` 使用宿主创建的私有双向字节流，不能用目标 stdin/stdout/stderr 或任意 PID 代替。重复 stop 复用进行中的能力调用；容器空回执与包装 `close` 都满足才落 `stopped`，失败保留 `stopping`/执行资源。Windows 沙箱缺少此能力时，taskkill 成功不能认证容器已清空。

POSIX 受管 Job 沿用创建时的 detached 进程组：TERM 后有界等待原组消失，宽限期耗尽再 KILL；根退出不单独证明组清空，自然根退出的终态清理也检查原组。ESRCH 表示组不存在，权限/其他探测错误失败；组探测不提供新的所有权授权。主动 setsid/脱组不在范围，数字组标识不能提供 Windows 容器句柄同等身份保证。

启动观察先于私有通道绑定：只有确认 wrapper 未创建的启动失败才记录 `wrapper_spawn_failed/not_started` 并释放；已创建 wrapper 后的绑定异常或私有 pipe 缺失返回 `JOB_SPAWN_FAILED`，同时保留活动登记、`targetState: unknown` 和执行资源，进入共享停止门禁。停止确认失败保持 `stopping`，后续 wrapper close 不提前释放；执行域空与 close 均满足后才能终态清理。

---

## 3. RAG：文档入库、检索与问答

### 3.1 `createRAGAgent(options?)`

创建 RAG 实例。实例不管理 Session、Turn 或 Provider 凭据；需要 Agent Loop 时，将其能力交给 Runtime，而不是把 Runtime 状态写入 RAG 实例。

```ts
const rag = createRAGAgent({
  workspaceRoot: "/workspace/knowledge-base",
  storage: { rootPath: "/server-state/chat/knowledge" },
  permissionMode: "ask",
  onToolEvent(event) {
    console.log(event.type, event.toolName);
  },
});
```

```ts
interface RAGAgentOptions {
  workspaceRoot?: string;
  permissionMode?: ToolPermissionMode;
  onToolEvent?: (event: ToolEvent) => void;
  storage?: RagStorageOptions;
  rerank?: {
    defaultPolicy?: RerankPolicy;
    resolveApiKey?: () => string | undefined | Promise<string | undefined>;
    fetch?: typeof fetch;
    adapter?: RerankProviderAdapter;
  };
  embedding?: {
    text?: EmbeddingConnection;
    multimodal?: EmbeddingConnection;
  };
}
```

| 选项 | 默认值 | 说明 |
|---|---|---|
| `workspaceRoot` | — | 文件与命令工具的工作区边界；宿主应传 canonical 路径。 |
| `permissionMode` | `"ask"` | 仅影响 `executeTool()` 的执行器。 |
| `onToolEvent` | — | 接收受控工具审计事件。 |
| `storage.rootPath` | 兼容默认目录 | 当前 RAG 实例的向量、来源、缓存、临时文件与 manifest 根。由受信应用显式注入知识根；Work 不装配此能力，Chat 知识适配不依赖 Workspace/cwd。 |
| `rerank` | — | 专用 Rerank 运行时。`resolveApiKey` 只能由受信服务端闭包提供；Key 不得进入 `RerankPolicy`、TurnStore、checkpoint、事件或浏览器。策略由受信 RAG 服务绑定，Work Runtime 不读取 Rerank 配置。 |
| `embedding` | — | 独立注入文本与多模态 Embedding 连接；每次入库或检索操作按角色冻结。每个连接至少包含 `provider`、`baseUrl`、`model`、`dimension`、`normalization`、`pipelineVersion: "rag-v2"` 与 `resolveApiKey`，可选 `fetch`；真实 Key 仍由受信闭包按需解析。 |

上面接口中的 `EmbeddingConnection` 是对源码 `AgentFlowEmbeddingOptions` 结构的文档化简称，不是默认入口单独导出的命名类型；实际导出类型为 `RAGAgentOptions.embedding` 所引用的结构。

#### 精排供应商适配

`rerank.adapter` 是受信宿主注入的 `RerankProviderAdapter`，省略时使用内置百炼适配器，原有 `RERANK_*` 配置无需变化。自定义供应商仍须配置对应的 `baseUrl`、模型名和 `resolveApiKey`；不会自动识别协议或回退到另一供应商。适配器只在运行时持有，不进入 `RerankPolicy` 或 Turn 快照。

```ts
interface RerankProviderAdapter {
  readonly id: string;
  readonly supportedRoles: readonly RerankRole[]; // "text" | "vision"
  createRequest(input: RerankProviderRequest): {
    url: string;
    headers: Record<string, string>;
    body: string;
  };
  parseResponse(payload: unknown, context: {
    model: string;
    role: RerankRole;
  }): RerankProviderResult[];
}
```

- `RerankProviderRequest` 包含 `baseUrl`、`apiKey`、`model`、`role`、`query` 和有序 `documents: RerankDocument[]`；文档为 `{ text: string; image?: string }`，图片是受控 Data URI。适配器应保持文档位置，若供应商返回自身 ID，应转换回输入索引。
- `createRequest` 只构造专用精排 POST 的 URL、请求头与字符串正文；共享层执行网络请求，限制超时并传播取消，仅对 429/5xx 重试一次。地址必须为 HTTPS 或本机 HTTP，拒绝 Chat completions 路径；不支持的模态在读取凭据和发送请求前降级。
- `parseResponse` 返回最相关在前的完整列表，每项为 `{ index: number; score?: number; relevant?: boolean }`。共享层验证索引完整、唯一、整数且未越界，分数若存在必须有限，`relevant` 若存在必须为布尔值；任一异常均整体降级并保留原始候选顺序。排名以适配器返回顺序为准，不在共享层按供应商分数重新排序。失败不会切换 Chat 模型打分。
- `score` 只用于该供应商的排序结果描述，不代表跨模型统一概率；仅返回排名时可省略。`relevant` 是适配器按对应模型策略作出的相关性判断，不等于事实正确或引用有效。内置百炼适配器仅对 `qwen3.7-text-rerank`（文本）和 `qwen3-vl-rerank`（视觉）沿用项目现有的 0.5 门槛；其他模型省略该判断。公共质量门还会检查正文/图片可用性，相关性未知时走原有正文词项匹配，不自动把高分或第一名当作充分证据。
- 上层仍接收 `RerankOutcome` 中的 `evidenceId/rank/relevanceScore`，供应商只能返回输入位置，证据 ID 由共享层映射。未提供分数时，结果候选的旧 `score` 保留为基础召回分数，`outcome.results[].relevanceScore` 为空，不伪造精排分数。

宿主注册自己的适配器（以下 `adapter` 由宿主实现上述接口）：

```ts
import { createRAGAgent, type RerankProviderAdapter } from "@autopilot-agent/core";

// 由服务端装配适配器及凭据，不接受浏览器传入可执行适配代码。
function createKnowledgeAgent(adapter: RerankProviderAdapter) {
  return createRAGAgent({
    storage: { rootPath: "/srv/app/knowledge" },
    rerank: {
      adapter,
      defaultPolicy: {
        enabled: true,
        baseUrl: "https://rerank.example.com",
        textModel: "vendor-text-rerank",
      },
      resolveApiKey() { return process.env.RERANK_API_KEY; },
    },
  });
}
```

### 3.2 `rag.ingest(filePath, options)`：统一入库

```ts
const result = await rag.ingest("/tmp/handbook.pdf", {
  type: "pdf",
  title: "产品手册",
  displayName: "产品手册.pdf",
  signal: abortController.signal,
  onProgress(event) {
    console.log(event.step, event.current, event.total);
  },
});
```

```ts
interface IngestOptions {
  type: "excel" | "text" | "pdf" | "image" | "video";
  tableName?: string;
  clearFirst?: boolean;
  headerRow?: number;
  sheetName?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  title?: string;
  onProgress?: (event: IngestProgressEvent) => void;
  signal?: AbortSignal;
  displayName?: string;
}

interface IngestResult {
  type: string;
  tableName: string;
  totalRows: number;
  totalChunks: number;
  columns: string[];
  previewRows: Record<string, unknown>[];
  resourceId?: string;
  status?: "completed" | "partial";
  failedPages?: number[];
}
```

| 字段 | 说明 |
|---|---|
| `type` | 必填。当前运行时支持 `excel`、`text`、`pdf`、`image`；`video` 仍是声明预留值，不得作为前端可选项。 |
| `tableName` / `clearFirst` | 仅保留给旧入库 helper 的兼容类型；统一 `rag.ingest()` 会忽略调用方表名与清表请求，由 Core 根据随机 `resourceId + embeddingSpaceId` 派生物理表，partial 重试也不会删除已成功页。 |
| `headerRow` / `sheetName` | Excel 专属；`headerRow` 为 0-based。 |
| `chunkSize` / `chunkOverlap` | Text/PDF 分块参数；默认由 Core 分块器决定。 |
| `onProgress` | 仅用于宿主进度展示；不要把 `chunkText` 原文输出到不可信日志。 |
| `signal` | 传播到 PDF worker、OCR、Embedding 与写入边界；取消终态为 `cancelled`，不得继续计费或写入。 |
| `displayName` | 经应用层校验的原始展示名；资源身份始终使用 Core 生成的 `resourceId`。 |

图片使用已有 Canvas 解码并规范化为 PNG，长边最多 2048 像素、结果最多 5 MiB、输入最多 20 MiB 和 4000 万像素；OCR、图文 Embedding、向量和关键词索引复用原页级管线。image manifest/tableProfile/evidence 是正式类型，来源按资源身份保存；失败或取消清理已写索引及图片。没有 OCR 时保留图像证据，必须成功视觉分析后才能摘录或呈现当前观察。Text/Excel 零分块返回 RAG_PARSE_FAILED，不生成虚假 completed 资源。

PDF 由 PyMuPDF worker 一次打开提取，低质量页才批量渲染并进入 Tesseract/已配置云 OCR 或 fused 路径；页质门结合文本可打印比、替代字符、文本块、图片/绘图数和图片覆盖率，不再仅依赖固定字符数。新记录保存 `resourceId + storedPdfFileName + pageNumber`，原始 PDF 是长期来源，页图只按需临时渲染。partial 重试仅重做 `failedPages`，使用稳定页 ID upsert 与内容缓存，不重复处理已成功页。Route 只需调用 `ingest(..., { type: "pdf" })`，不要复制 Core 的路由判断。

### 3.3 Excel 辅助方法

| 方法 | 签名 | 示例 | 注意事项 |
|---|---|---|---|
| `parseExcelFile` | `(filePath, options?) => Promise<Record<string, unknown>[]>` | `await rag.parseExcelFile(path, { sheetName: "Sheet1", headerRow: 0 })` | 只解析，不写向量库。 |
| `listExcelSheets` | `(filePath) => Promise<string[]>` | `await rag.listExcelSheets(path)` | 用于上传前选择工作表。 |
| `getExcelSheetInfo` | `(filePath, sheetName?) => Promise<SheetInfo>` | `await rag.getExcelSheetInfo(path, "Sheet1")` | 返回表名、行列数和表头。 |

```ts
interface ParseExcelOptions {
  sheetName?: string;
  headerRow?: number;
  dataStartRow?: number;
  skipEmptyRows?: boolean;
}

interface SheetInfo {
  sheetName: string;
  rowCount: number;
  colCount: number;
  headers: string[];
}
```

### 3.3.1 `parseDocument(input)`：无知识存储的上传解析

签名：`({ bytes: Uint8Array, mimeType: string, signal?: AbortSignal }) => Promise<{ text: string; pages?: readonly Uint8Array[] }>`。复用已有文本/DOCX、Excel、PDF 解析，不创建 RAG Agent、知识根或向量索引。只接受纯文本/Markdown、DOCX、XLSX/XLS、PDF MIME，输入 1 字节至 20 MiB；PDF 最多 20 页并返回页图，Excel 保持原解析器的首表规则。上传 Store 另行检查 magic、图片/页图大小、Session 归属与 TTL，不能把此纯解析函数当成授权入口。

```ts
import { parseDocument } from "@autopilot-agent/core";
const parsed = await parseDocument({ bytes: uploadedBytes, mimeType: "application/pdf", signal });
```

路径型解析器只访问本次生成的独占临时文件，所有终态清理；取消抛 `RAG_OPERATION_CANCELLED`，输入/解析失败收敛为 `RAG_PARSE_FAILED`。解析文本不代表 OCR 或模型视觉已成功；Chat 模型只能通过已授权附件引用读取解析结果。

### 3.4 搜索方法

#### `rag.search(query, topK?, tableName?)`

```ts
const rows = await rag.search("退款流程", 8, "product_handbook");
```

返回 `Promise<VectorOutput[]>`。它只在一个表中执行语义搜索，适合调用方明确知识表的场景。

#### `rag.searchAcrossTables(query, topK?, tableName?)`

```ts
const search = await rag.searchAcrossTables("退款流程", 8);
console.log(search.searchedTables, search.results);
```

未显式传表时，Core 从当前 Workspace 的 completed/partial manifest 做有界资源预路由；同一 query 在同一 `embeddingSpaceId` 只生成一次向量。每张候选表分别执行 Dense 与持久关键词索引召回，再仅按名次用 RRF 融合，不比较不同向量空间或检索器的原始分数。普通查询不会调用 `listVectorTextRecords()` 回读整张 LanceDB 表；缺失/损坏的关键词索引只降级为 Dense，不在查询热路径自动重建。

```ts
interface SearchAcrossTablesResult {
  searchedTables: string[];
  selectedTable: string | null;
  tableScores: Record<string, number>;
  results: VectorOutput[];
  allResults: VectorOutput[];
}
```

该方法按表内名次均衡合并候选，**不比较不同 embedding 空间的原始分数**。`tableName` 有值时只检索指定表；无值时交给 Core 编排。

### 3.5 问答方法

#### `rag.ask(question, topK?, tableName?, history?)`

```ts
const answer = await rag.ask(
  "退款多久到账？",
  5,
  "product_handbook",
  [{ role: "user", content: "我刚申请了退款。" }],
);
console.log(answer.answer, answer.sources);
```

签名：

```ts
(question: string, topK?: number, tableName?: string, history?: ChatMessage[])
  => Promise<{ answer: string; sources: VectorOutput[] }>;
```

`history` 是调用方提供的会话上下文；`RAGAgent` 本身不持有 `sessionId` 或磁盘会话。`ChatMessage.role` 为 `"system" | "user" | "assistant"`，内容为字符串。

#### `rag.askStream(question, topK?, tableName?, history?, options?)`

```ts
export async function POST(request: Request) {
  const { question } = await request.json();
  return rag.askStream(question, 5, undefined, undefined, {
    includeSources: true,
    includeProcess: true,
  });
}
```

签名：

```ts
(question: string, topK?: number, tableName?: string, history?: ChatMessage[], options?: AskStreamOptions)
  => Response;
```

此处的 `Response` 是标准 Web Fetch API（WHATWG）的全局 `Response`：Core 以 `new Response(ReadableStream, { headers })` 创建 SSE 响应。它不是 Node.js `http.ServerResponse`，也不是 `next/server` 的 `NextResponse`；在 Next.js Route Handler 中可直接 `return`，无需转换。

| `AskStreamOptions` 字段 | 说明 |
|---|---|
| `includeSources?` | 是否在 SSE 完成阶段带可展示来源。 |
| `includeProcess?` | 是否输出受控过程事件。 |
| `searchResults?` | Route 已准备的候选池，避免重复检索。 |
| `focusedPdfFileName?` | 受信宿主继承的 PDF 追问范围；不能接受浏览器伪造的文件路径。 |

### 3.6 PDF 图片、工具定义与 RAG capability

| 方法 | 签名 | 使用规范 |
|---|---|---|
| `getResourcePreview` | `(resourceId: string, signal?: AbortSignal) => Promise<{ buffer: Buffer; mimeType: string }>` | 用户管理预览：只读 completed/partial；PDF 首页 PNG、image 规范 PNG、Text/Excel/DOCX 有界文本（最多 16,000 字符，复用 20 MiB 解析上限）。拒绝路径/链接及删除态；错误由既有 RagError 收敛。 |
| `getStoredImage` | `(fileName: string) => Promise<{ buffer: Buffer; mimeType: string }>` | 仅供宿主从受控存储读取 PDF 来源图；浏览器只能传逻辑文件名，Route 必须做会话/资源边界校验。 |
| `rebuildLexicalIndexes` | `(tableName?: string) => Promise<{ tableName: string; recordCount: number }[]>` | 显式维护操作：从当前 Workspace 的 LanceDB 受控正文快照重建持久关键词索引；普通查询不调用。 |
| `getToolDefinitions` | `() => ToolModelDefinition[]` | 兼容工具入口仅返回 `read_file`；私有检索不再通过无产品绑定的工具执行器暴露。 |
| `executeTool` | `(request, options?) => Promise<ToolExecutionResult>` | 见[工具执行与权限](#5-工具执行与权限)；不能做成浏览器匿名执行端点。 |
| `getRagCapability` | `() => RagCapability` | 供受信 Chat 知识适配复用 canonical 检索；不直接注入 Work Runtime，也不是通用工具执行入口。 |

`RunConfig.rag/ragSourcePolicy/rerankPolicy/focusedPdfFileName` 保留旧宿主的类型兼容，但 Runtime 会清除它们，不触发检索或 Rerank。Chat 检索通过 `chatLoader` 的知识端口。canonical RAG 服务仍可使用 `RAGAgentOptions.rerank.defaultPolicy/resolveApiKey`；真实 Key 不进入持久化和浏览器。

文本候选只调用专用 `qwen3.7-text-rerank` endpoint；视觉条件成立时，Core 从当前 Workspace 原始 PDF 按需渲染有限候选页并调用 `qwen3-vl-rerank`。请求固定 `return_documents=false`，响应必须完整覆盖本批候选且每个 `index` 唯一、为整数并未越界；任何空、不完整、重复、越界或非法分数响应都会整体降级并保持上游顺序，不接受 Provider 回显正文，也不回退 `askLoopLLM()` / `askLLMWithImages()` 做 Chat Prompt 精排。429/5xx 只做一次小预算重试，4xx 不盲重试，取消会继续向上抛出。

canonical `prepareRagSearch` 返回能回查当前知识根 completed/partial manifest 的证据；无效候选移除，全部无效返回不足。`RagEvidence.sourceType` 支持 image，可选 `sufficient` 为保守质量判断：有专用精排分数时须 >= 0.5 且有可读文字或图像，否则须正文命中问题至少一个长度 >= 2 的词项；纯图片可用展示名匹配，再经实际视觉观察取证。PDF evidence.text 仅含当前页正文，不把文件名/标题/相邻摘要当成事实。词项门可能拒绝同义改写，并不证明事实相关性或源内容真实性；Chat 仍逐字校验摘录。空候选不触发 HyDE；检索 I/O/Provider 故障按 RAG_SEARCH_FAILED 收敛，不记录原始错误或冒充空库；查询 Embedding/HyDE 传递取消。Chat 知识适配负责将它们绑定到 Knowledge Space、Session、Turn 和批次，并按 Chat 证据门验证。PDF 底层使用 `rag-resource:<resourceId>:page:<pageNumber>`、图片使用 `rag-resource:<resourceId>:image` 引用，受信适配可映射为 Chat 受控视觉引用；Work `vision_analyze` 不再消费该来源。

### 3.7 RAG 统一错误

RAG 与 Agent Runtime 使用相互独立的错误协议。`AgentRuntimeError` / `AgentErrorCode` 只描述 Session、Turn、Provider 和 Runtime；`RagError` / `RagErrorCode` 只描述文档入库、资源、PDF/OCR、检索和问答。

```ts
class RagError extends Error {
  readonly code: RagErrorCode;
  readonly cause?: unknown;
}

const RAG_ERROR_CODES: readonly RagErrorCode[];
function readRagErrorCode(error: unknown): RagErrorCode | undefined;
function toRagError(error: unknown, fallbackCode: RagErrorCode): RagError;
```

`createRAGAgent()` 的异步公共方法会保留已有 `RagError`，把已知旧字符串码迁移到新码，并将其他底层异常按当前操作收敛为稳定 fallback；路径、Provider 正文和底层异常消息只能保留在服务端 `cause`，不能进入 Route、SSE 或日志展示。

| 范围 | `RagErrorCode` |
|---|---|
| 输入与生命周期 | `RAG_INVALID_INPUT`、`RAG_UNSUPPORTED_DOCUMENT_TYPE`、`RAG_OPERATION_CANCELLED` |
| 公共操作 fallback | `RAG_INGEST_FAILED`、`RAG_PARSE_FAILED`、`RAG_SEARCH_FAILED`、`RAG_ANSWER_FAILED` |
| 资源与存储 | `RAG_RESOURCE_NOT_FOUND`、`RAG_RESOURCE_OPERATION_FAILED`、`RAG_STORAGE_INVALID`、`RAG_VECTOR_SPACE_MISMATCH` |
| PDF | `RAG_PDF_RUNTIME_UNAVAILABLE`、`RAG_PDF_CORRUPTED`、`RAG_PDF_ENCRYPTED`、`RAG_PDF_ZERO_PAGES`、`RAG_PDF_PAGE_RANGE_INVALID`、`RAG_PDF_PAGE_EMPTY`、`RAG_PDF_ALL_PAGES_FAILED` |
| OCR | `RAG_OCR_UNAVAILABLE`、`RAG_OCR_FAILED`、`RAG_OCR_EMPTY` |

---

## 4. 数据库快照与知识资源

### 4.1 `createDatabaseSnapshot({ databaseName, snapshotRoot?, queryTimeoutMs? })`

数据库快照是“短连接只读源库 → 发布本地 SQLite/LanceDB 只读快照”的受控流程。浏览器只能传已注册的 `databaseName`，不能传 DSN、账号、密码或任意 SQL 连接参数。

```ts
const snapshot = createDatabaseSnapshot({
  databaseName: "inventory",
  snapshotRoot: "/service-state/workspaces/example/database-snapshots",
  queryTimeoutMs: 10_000,
});
const inspection = await snapshot.inspectSource();
const published = await snapshot.sync();

const databaseSearch = createDatabaseSearchCapability(snapshot.getReadCapability(), {
  profile: {
    tableAliases: { products: ["商品"] },
    columnAliases: { products: { "分类": "category" } },
    aggregationKeywords: [{ keywords: ["总数"], kind: "count" }],
  },
});

const runtime = createAgentRuntime({
  ports,
  defaultRunConfig: {
    databaseSearch,
  },
});
```

| 方法 | 签名 | 说明 |
|---|---|---|
| `inspectSource` | `() => Promise<DatabaseInspection>` | 只读检查源库、非敏感表和 Schema 摘要。 |
| `sync` | `() => Promise<DatabaseSyncResult>` | 同步并原子发布快照；失败不替换最后一次成功快照。 |
| `getReadCapability` | `() => DatabaseSnapshotReadCapability` | 为独立数据库 Adapter 提供只读 capability；不含 MySQL connection。 |

`snapshotRoot` 由宿主在 Trust 后解析；Web 默认使用当前 Workspace `stateRoot/database-snapshots`，SQLite manifest 与数据库语义 LanceDB 均位于该根下。未显式传入时，兼容入口才使用服务端 `DATABASE_SNAPSHOT_PATH` / `LANCE_DB_PATH`。数据源注册项必须通过 `allowedTables` 显式允许同步表；字段敏感规则仍会在 allowlist 之后继续排除危险表列，缺少 allowlist 时不开放任何表。

`DatabaseSnapshotReadCapability` 提供 `getStatus()`、`describeSnapshotTables()`、`search(query, topK?)` 和 `snapshotQuery(sql)`。`describeSnapshotTables()` 只返回已发布 manifest 中的安全表名、表注释及列名/类型/注释；`snapshotQuery` 只接受单条只读 `SELECT` / JOIN / 聚合 SQL，拒绝修改、DDL、多语句、注释绕过、系统表和跨快照访问。执行结果统一读取至 201 行后最多返回 200 行，因此只有真实超限时 `truncated=true`。`queryTimeoutMs` 默认 10 秒、最大 30 秒；SQL.js/WASM 在服务端 Node Worker 中执行，超时会终止 Worker，不阻塞 Node 主事件循环或浏览器渲染线程。

`createDatabaseSearchCapability(readCapability, options?)` 把快照包装为独立的 `DatabaseSearchCapability`。`options.profile` 可注入表/列别名、聚合词、注释后缀、筛选操作符、多值分隔符与停用词；Core 默认不包含任何固定语言关键词、业务表、字段或领域 Prompt。未注入语言 Profile 时，Core 不会把某种语言的操作符编译成精确列筛选，但仍可执行语言无关的受控值检索和语义降级。`options.planAmbiguousQuery` 是可选的受控歧义规划器，其结果会重新校验为当前快照存在的表/列/操作符，输入不含数据库名、样本行或连接信息。

Runtime 仅在当前 Turn 冻结的 `DatabaseSearchPolicy.enabled=true` 时注册 `database_search`；Work 禁止 `rag_search`，新 Turn 不注册 `snapshot_query` / `database_query`。`DatabaseSearchRequest` 以 `kind: "semantic" | "sql"` 区分自然语言检索和受控 SQL：前者先尝试确定性列值、聚合和值检索，无法确定或零命中时才使用 `topK` 语义兜底；确定性命中会返回 `kind="sql"` 的完整结构化行，后者始终返回结构化行。结构化结果不进入 Rerank，也不按语义 `topK` 截断；语义结果会移除 sourceId、内部 databaseName 和同步时间。

### 4.2 快照类型

```ts
interface DatabaseSnapshotConfig {
  sourceId: string;
  databaseName: string;
  sqlitePath: string;
  lanceDbScope: string;
  version: string;
  syncedAt: string;
  status: "current" | "stale";
}

interface SnapshotQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  involvedTables: string[];
  snapshot: Pick<DatabaseSnapshotConfig, "databaseName" | "version" | "syncedAt" | "status">;
  truncated: boolean;
}

interface SnapshotTableDescription {
  tableName: string;
  comment: string;
  columns: Array<{ name: string; type: string; comment: string }>;
}

interface DatabaseQueryProfile {
  aggregationKeywords?: Array<{ keywords: string[]; kind: "count" | "sum" | "avg" | "max" | "min" }>;
  columnAliases?: Record<string, Record<string, string>>;
  commentSuffixes?: string[];
  filterOperators?: Array<{ keywords: string[]; operator: "equals" | "contains" }>;
  tableAliases?: Record<string, string[]>;
  valueSeparators?: string[];
  valueStopwords?: string[];
}
```

敏感表、凭据与个人敏感字段、二进制/JSON 敏感列均不得进入快照、向量文本或模型上下文。普通 RAG 检索不会自动回连源 MySQL。

### 4.3 数据库错误协议

数据库能力不复用文档 `RagErrorCode`。配置、来源解析、快照状态、同步、语义检索和只读 SQL 使用独立的 `DatabaseError` / `DatabaseErrorCode`；已知错误必须保留真实细分类别，未知底层异常才按当前操作收敛为 `DATABASE_INSPECTION_FAILED`、`DATABASE_SYNC_FAILED`、`DATABASE_SEMANTIC_SEARCH_FAILED`、`DATABASE_QUERY_FAILED` 或 `DATABASE_SEARCH_FAILED`。`database_search` 进入 Agent Tool 执行边界时沿用同一个数据库 code 写入结构化 `ToolError`，不得统一模糊为 `TOOL_EXECUTION_FAILED`。

公开辅助包括 `DATABASE_ERROR_CODES`、`readDatabaseErrorCode()` 和 `toDatabaseError()`。稳定分类分别覆盖配置缺失、JSON 非法、不是数组、数据源项不完整，来源名非法、未登记、默认来源为空或多来源歧义，连接认证失败、连接超时、连接失败，标识符非法、同步账号非只读、快照未同步/清单损坏/本地文件缺失、SQL 非只读/系统访问/表越界/超时，以及各操作的未知失败 fallback；底层 `cause` 不进入模型或浏览器响应。

### 4.3 `getDefaultDatabaseSource()`

签名：`() => Pick<MySQLSourceConfig, "database" | "displayName">`。

返回唯一已注册源的安全标识；当前注册表不是唯一源时会抛错。仅服务端可信管理流程可使用；不要用它推导或暴露连接配置。

### 4.4 知识资源管理

```ts
const resources = await listKnowledgeResources();
const deleted = await deleteKnowledgeResource("product_handbook", "handbook.pdf");
```

| API | 签名 | 返回 | 限制 |
|---|---|---|---|
| `listKnowledgeResources` | `() => Promise<KnowledgeResource[]>` | 表名、文件名、来源与记录数 | 不返回向量或正文；跳过 `mysql_*` 快照表。 |
| `deleteKnowledgeResource` | `(tableName, fileName) => Promise<DeleteKnowledgeResourceResult>` | 删除记录数、图片数及是否移除空表 | 拒绝快照表、非法表名和路径型文件名。 |

资源管理只能处理文档向量资源，不能删除或修改数据库 SQLite/LanceDB 快照。

受信知识管理使用绑定知识根的 RAG 实例方法：`rag.listResources()` 只读原子 manifest，缺失与损坏/链接分别处理，后两者返回 RAG_STORAGE_INVALID，不静默跳过，`rag.deleteResource(resourceId)` 同步清理该资源的向量、关键词记录与来源文件，`rag.getPdfPageImage(resourceId, pageNumber, signal?)` 从原始 PDF 按需渲染；`rag.getResourcePreview(resourceId, signal?)` 返回上述有界预览，例如 `const preview = await rag.getResourcePreview(resource.resourceId, signal)`，宿主收到 buffer/mimeType 后设置安全响应头；`rag.rebuildLexicalIndexes(tableName?)` 仅用于显式修复。上表按 `tableName + fileName` 的函数仅为旧全局数据兼容，不得用于新的多 Workspace Route。

---

## 5. 工具执行与权限

### 5.1 `rag.executeTool(request, options?)`

此旧兼容执行器仅保留受控 `read_file`；`rag_search`/`lancedb_query` 返回 `CHAT_TOOL_FORBIDDEN`。应用级知识检索使用绑定根的 RAG 服务，模型检索只通过 Chat 的受控端口。

```ts
const result = await rag.executeTool({
  callId: "call-001",
  toolName: "read_file",
  input: { path: "README.md" },
});

if (result.status === "approval_required") {
  // 将 result.approval 投影到可信宿主的审批 UI。
}
```

```ts
interface ToolExecutionRequest {
  callId: string;
  toolName: string;
  input: unknown;
  approval?: { approvalId: string; decision: ToolApprovalDecision };
}

interface ToolExecutionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
```

`ToolExecutionResult` 是以下状态的联合：

| 状态 | 含义 |
|---|---|
| `success` | 含 `output`、执行 `meta` 与安全 `display`。 |
| `approval_required` | 含冻结的 `ToolApprovalRequest` 与安全 `display`；应交给 Runtime 审批服务处理。 |
| `denied` / `error` | 含受控 `ToolError` 与可用时的安全 `display`。 |
| `cancelled` / `timeout` | 含 `error`、`meta`、可否重试的 `interruption` 与可用时的安全 `display`。 |

### 5.2 权限模式与安全边界

`ToolPermissionMode` 有三个值：`ask`（单次审批）、`auto_approve`（自动审批）、`full_access`（完全访问）。它只决定「本次操作是否需要弹审批卡」，不是授权凭证本身，也不改变任何硬门禁。

```ts
type ToolPermissionMode = "ask" | "auto_approve" | "full_access";
type ToolApprovalDecision = "allow_once" | "allow_session" | "allow_workspace" | "deny";
```

| 模式 | 是否弹卡 | 可提交的审批决定 |
|---|---|---|
| `ask` | 除只读操作外都需要人工审批。 | 普通工具为四选一 `allow_once` / `allow_session` / `allow_workspace` / `deny`；`run_command` 只允许 `allow_once` / `deny`；当前归属精确 Job 停止免额外审批。 |
| `auto_approve` | 只自动放行 `read_only`，以及工作区可信（`workspaceTrusted === true`）时的 `write` / `workspace_mutating`；`external_side_effect`、`unknown`、`destructive` 仍人工审批。 | 当前归属精确 Job 停止免额外审批；其余需审批工具四选一。 |
| `full_access` | 跳过全部一般审批，但不改变下方任何硬门禁。 | 不适用，该模式不产生审批。 |

各模式在具体操作上的行为：

| 操作类型 | `ask` | `auto_approve` | `full_access` |
|---|---|---|---|
| `requiresApproval: false` 的只读操作 | 直接执行 | 直接执行 | 直接执行 |
| 工作区写入（`write_file` / `edit_file`） | 弹卡 | 工作区可信则自动执行，否则弹卡 | 直接执行 |
| 已识别只读命令（`pwd` / `rg` / `git status` / `git diff` / `git log`） | 弹卡 | 自动执行 | 直接执行 |
| 已识别工作区变更命令（`mkdir` / `touch` / `git add`） | 弹卡 | 工作区可信则自动执行，否则弹卡 | 直接执行 |
| 网络或外部副作用命令（`curl` / `wget` / `npm install`） | 弹卡 | 仍弹卡 | 直接执行 |
| 未知命令或含工作区外路径参数的命令 | 弹卡 | 仍弹卡 | 直接执行 |
| 硬拒绝命令（`rm` / `del` / `rmdir` / `git clean` / `git reset --hard` / `format` / `shutdown`） | `deny` | `deny` | `deny` |
| `web_fetch` | 首次访问该域名弹卡 | 仍弹卡 | 直接执行 |
| `vision_analyze` | 弹卡 | 自动执行 | 直接执行 |
| `stop_background_job` | 当前归属精确 Job 免额外审批 | 当前归属精确 Job 免额外审批 | 仍校验归属 |
| `web_search` | 直接执行 | 直接执行 | 直接执行 |

注意事项：

- `ask` 的语义是「对标记为需要审批的操作询问」，不是「所有工具逐次询问」。只读工具自报 `requiresApproval: false`，在所有模式下都不弹卡。
- `ask` 模式下 `run_command` 仅接受绑定 canonical 工作目录、平台、平台解析后的程序身份与完整 argv 的精确命令约束（`cmd:v2:<sha256>`）参与持久授权：用户选择「记住此命令」后，完全相同的命令（程序身份、参数与工作目录一致）在本工作区自动放行，参数或目录不同必须重新确认；审批范围冻结为 `["allow_once", "allow_workspace", "deny"]`。程序身份按平台解析：Windows 上 `.cmd`/`.exe` 后缀与大小写属同一等价解析，其余平台扩展名与大小写都是实际可执行文件身份的一部分，不折叠。无精确约束（旧 `program:` 宽约束或缺失）时保持逐次确认且不查询命中；历史 `cmd:v1` 约束不再签发，**其授权也不再命中**。记住命令不涉及无沙箱降级：沙箱连续启动失败一律 fail-closed deny，无沙箱降级审批已撤下。`stop_background_job` 不使用持久授权，当前归属精确 Job 免额外审批，外部或不确定 owner 不能控制。
- `full_access` 只放宽审批交互，不绕过工作区路径解析、Schema 校验、read-before-edit、命令硬拒绝、destructive guard、命令 `shell: false` 与 program/args 校验，以及 `web_fetch` 的 URL/DNS/重定向安全门。
- 持久授权（`allow_session` / `allow_workspace`）只可由 `approvals.submit()` 建立，宿主不得自行写入授权存储。

#### 5.2.1 唯一决策点与判定顺序

所有工具调用在 Schema 校验后，先由本地工具代码生成 `ToolActionFacts`，再交给唯一的内部 `PolicyEngine.evaluate()` 作出决定。判定顺序固定，靠前的分支优先短路：

| # | 判定 | 结果 |
|---|---|---|
| 1 | 工具本地 `ActionFacts` 与 Registry `metadata` 的安全边界不一致 | `deny` |
| 2 | 已完成的本地硬门禁（`hardDenyReason`，例如破坏性命令） | `deny` |
| 3 | 当前激活 Skill 的 `allowedTools` 交集不含本次工具 | `deny` |
| 4 | `requiresApproval` 不为真（只读操作） | `allow` |
| 5 | 命中 Runtime 持久授权 | `allow` |
| 6 | `permissionMode === "full_access"` | `allow` |
| 7 | `permissionMode === "auto_approve"` 且风险被自动放行矩阵接受 | `allow` |
| 8 | 以上都不成立 | `approval_required`，同时冻结 `allowedDecisions` |

自动放行矩阵只有一条：`read_only` 恒放行；`write` 与 `workspace_mutating` 仅在 `workspaceTrusted === true` 时放行；其余风险（含 `external_side_effect`、`unknown`、`destructive`）一律不自动放行。

该顺序决定了两条安全语义：Skill 白名单比 `full_access` 更硬，`full_access` 也不能执行 Skill 未授权的工具；`full_access` 在持久授权之后判定，因此它不会改变已有授权的语义。

`ToolApprovalRequest.allowedDecisions` 是由 `PolicyEngine` 在生成审批时冻结的可提交范围，并随 `approval_required` 一起持久化。`ApprovalService` 只校验和提交该范围内的决定，不重新计算策略；历史审批事件缺少该字段时按最保守的 `["allow_once", "deny"]` 回退，不会把旧数据升级为持久授权。

#### 5.2.2 风险分级与命令分类

`ToolRisk` 取值为 `write`、`command`，或命令专用的 `CommandRisk`：`read_only`、`workspace_mutating`、`external_side_effect`、`unknown`、`destructive`。

`run_command` 与 `start_background_job` 的风险来自结构化 argv 前缀匹配：

| argv 前缀 | 风险 | 判定 |
|---|---|---|
| `pwd`、`rg`、`git status`、`git diff`、`git log` | `read_only` | 需要审批 |
| `mkdir`、`touch`、`git add` | `workspace_mutating` | 需要审批 |
| `curl`、`wget`、`npm install` | `external_side_effect` | 需要审批 |
| `rm`、`del`、`rmdir`、`git clean`、`git reset --hard`、`format`、`shutdown` | `destructive` | 硬拒绝 |
| 未匹配任何规则 | `unknown` | 需要审批 |

匹配按结构化 argv 逐段精确比较，不使用字符串前缀；参数中出现绝对路径、UNC 路径或 `..` 时，即使已识别命令也降级为 `unknown`。命令始终使用 `program + args` 与 `shell: false`，不支持 Shell 解释、管道或多命令。`ToolMetadata` 只声明副作用、并发、重试和超时，不是授权凭证。

#### 5.2.3 持久授权的作用域与匹配

| 决定 | 作用范围 | 落盘方式 |
|---|---|---|
| `allow_once` | 仅本次调用 | 不写持久存储 |
| `allow_session` | 当前 Session 内同一工具与同一约束 | 写入 session 级授权 |
| `allow_workspace` | 当前工作区内同一工具与同一约束 | 写入 workspace 级授权 |

授权粒度是 `stableConstraint`，不是本次完整输入 hash：

| 工具 | 约束 |
|---|---|
| `write_file` / `edit_file` | `path:<工作区相对路径>` |
| `run_command`（工作区内命令） | `cmd:v2:<sha256>`，绑定 canonical 工作区、canonical 工作目录、平台、平台解析后的程序身份（Windows 折叠等价的 `.cmd`/`.exe` 与大小写，其余平台不折叠）与完整结构化 argv；旧 `program:<归一化程序名>` 宽约束与旧 `cmd:v1` 约束已停用，历史授权不再命中 |
| `run_command` / `start_background_job`（外部写目标） | 外部精确执行约束 `ext-exec-file:v1:<sha256>`（复用外部执行权威链） |
| `start_background_job`（普通任务） | `program:<归一化程序名>` |
| `web_fetch` | `web-fetch-host:<小写域名>` |
| `vision_analyze` | `vision-analyze:workspace` |
| `stop_background_job` | `job:<jobId>`，且该工具不使用持久授权 |

工具未提供 `stableConstraint` 时回退为本次完整输入 hash，此时授权只对完全相同的输入生效。匹配时优先使用 workspace 级授权，再使用 session 级授权。

#### 5.2.4 已有装配工具的当前行为

已装配的 `web_search` 仅外发有界 `query`，用户级启用即构成该最小公开搜索外发的授权，不逐次审批；它串行使用 `web:search` 资源键、默认 15 秒/最大 30 秒且不自动重试。`web_fetch` 只接受无 userinfo 的 HTTP(S) URL，按小写目标域名生成审批与持久 grant 约束，在 `ask` 模式首次访问该域名需要审批；它按域名最多并发 2 个、默认 20 秒/最大 45 秒且不自动重试。Work `vision_analyze` 只读取工作区相对图片并外发给冻结的视觉 Provider：`ask` 仍可逐次审批，`allow_session` / `allow_workspace` 使用稳定约束 `vision-analyze:workspace`，`auto_approve` 按只读风险自动执行，`full_access` 也不再显示一般审批；所有模式仍保留工作区路径、Schema、能力和 Provider 失败门禁。

#### 5.2.5 决策链路与展示边界

默认入口仅公开事实与决策的类型，不公开可绕过 `ToolExecutor` 的策略调用。`ToolDisplayFacts` 与 `ApprovalDisplayFacts` 是 Presentation 的唯一安全展示输入：只含 title key、工作区相对目标、受限指标和冻结审批范围；后台工具另以 `ToolDisplayFacts.job` 携带 action、可选 jobId/observedStatus、有限计数、waitOutcome，以及仅在启动时出现的脱敏 `programLabel`。`programLabel` 只允许 executable basename，统一小写并去掉 `.exe/.cmd`，不得包含目录或参数。MCP 工具审批的 `actionPreview` 可显示 Core 本地生成的执行隔离事实：`OS 沙箱隔离` 或 `未隔离（宿主直接运行）`；不得从 `output`、`preview`、原始命令参数或 MCP stderr 重建展示内容。

`ToolDisplayFacts.detail` 是可选的可判别联合 `ToolDisplayDetail`，只由 `ToolExecutor` 从 `read_file`、`glob_files`、`grep_files`、`web_search`、`web_fetch` 成功结果的受控 serialized output 生成，其余工具与运行中、审批、denied、error、cancelled、timeout 终态都不携带：

- `read_file`：正斜杠相对路径、实际 `startLine`/`endLine`/`totalLines`、`returnedLines` 与 `truncated`；未读到任何行时 `endLine: null`。不携带 `content`、`sha256`、`encoding`。
- `glob_files`：受限相对路径列表、`shownCount`、仅在 Core 可证明时出现的 `totalCount` 与 `executionTruncated`；display 预算裁剪时另有 `displayTruncated: true`。
- `grep_content`：按路径升序分组的命中行；`matchedLineCount` 是命中行数、恒等于 `lineNumbers.length`，与 count 模式的 submatch 次数不是同一语义；context 行与匹配文本不进入明细，文件组和单文件行号均受 display 预算限制。
- `grep_paths` / `grep_counts`：相对路径列表 / 每文件 submatch `count`；不伪造行号，display 预算裁剪时另有 `displayTruncated: true`。
- `web_search`：只含归一化后实际返回给 Agent 的 `sourceCount` 与 `truncated`，不含 query、答案、标题、摘要或 URL。
- `web_fetch`：只含最终 URL 的小写 `host`、受限 `contentType` 与 `truncated`，不含 URL 路径/query/fragment、标题或网页正文。

`totalCount` / `totalMatchedLineCount` / `totalFileCount` 只在工具执行阶段没有丢弃结果时出现，禁止由 `shown*`、数组长度或 `truncated` 推断；`displayTruncated: true` 是 Core display 预算已裁剪的独立事实，即使总数未知也必须保留，与执行截断和 Web 局部折叠相互独立。旧 transcript 缺少该新增字段时保持兼容回退。

### 5.3 `read_file` 分页读取与 `edit_file` 安全编辑

`read_file` 保持现有分页输入，不新增 `startLine`、`endLine` 等同义参数：

```ts
const result = await rag.executeTool({
  callId: "read-architecture",
  toolName: "read_file",
  input: { path: "docs/architecture.md", offset: 401, limit: 80 },
});
```

| 输入/输出字段 | 语义 |
|---|---|
| `offset` | 1-based 起始行，默认 `1`。 |
| `limit` | 返回行数，默认 `200`，最大 `1000`。 |
| `content`、`startLine`、`endLine`、`totalLines`、`truncated` | 仅为请求行区间的正文和分页元数据；模型不会收到未请求区间。 |
| `sha256` | 仅完整读取时返回完整原始字节 hash；部分读取返回 `null`。Core 仍在内部保存完整 hash 与已观察行区间，供后续 stale/read-before-edit 校验，不将全文或 snapshot 投影给模型。 |

文件必须是工作区内的普通 UTF-8/UTF-16 文本。`read_file` 流式扫描原始字节：单次最多 `8 MiB`、单行最多 `64 Ki` 个 UTF-16 code units、单次 `content` 最多 `256 KiB`（UTF-8 编码字节）。超出扫描、单行或返回上限时返回 `FILE_TOO_LARGE`；非法编码或二进制返回 `BINARY_FILE`；取消返回 `EXECUTION_CANCELLED`。读取期间文件发生变化返回 `FILE_STALE`，宿主必须重新读取，不能把该结果用于编辑。

`edit_file` 会按每个实际替换 span（包括行内子串）校验目标文本及其前后相邻行均位于同一已观察区间，并在写入前复核完整 hash 与 mtime；`replaceAll: true` 的每一处命中都必须通过该校验，范围外编辑返回 `FILE_NOT_READ`，并发变化返回 `FILE_STALE`。成功编辑只保留并按行偏移更新原有观察区间，绝不会把未读取的整份文件标记为已观察。为保持同一安全容量，超过 `8 MiB` 的文件也不能由 `edit_file` 编辑。`full_access` 不绕过这些限制。Turn 冻结沙箱模式为 `read-only` 时，`write_file` / `edit_file` 在锁内 mutation 前返回 `FS_SANDBOX_DENIED` 且磁盘零变化。

---

## 6. Provider、设置与模型能力

这些 API 供可信宿主在 Trust 后装配 Provider 与设置；不要在浏览器公开 Provider 解析结果或 `ResolvedCredential`。

### 6.1 模型采样器工厂

| API | 签名 | 用途 |
|---|---|---|
| `createDefaultModelSamplerFactory` | `(options?: ModelSamplerFactoryOptions) => ModelSamplerFactory` | 创建默认 Provider sampler 工厂；可通过 `options.adapters` 注入协议 Adapter，未提供时注册内置 Anthropic Messages 与 OpenAI Chat Completions Adapter。带 `ModelRef` 的创建请求必须提供受支持且已冻结的 `providerConfig.apiProtocol`；未配置 `ModelRef` 时才使用 headless 回退。 |
| `createFirstPartyModelSampler` | `(input) => ModelSampler` | 按冻结的 firstParty endpoint、认证和模型创建 Anthropic Messages sampler。 |
| `createConfiguredModelSampler` | `(sampleOptions?: ModelSampleOptions, behaviorProfile?: ModelBehaviorProfile) => ModelSampler` | 使用给定采样选项和行为规范创建 OpenAI Chat Completions sampler；这是兼容旧内部调用路径的直接构造函数，不接收或解析 `apiProtocol`。需要按冻结协议选择 Adapter 时使用 `createDefaultModelSamplerFactory()`。 |
| `createDefaultModelSampler` | `() => ModelSampler` | 默认入口公开的 headless 回退 sampler；不读取 Settings/CredentialStore，也不负责生产凭据装配。未配置 `ModelRef` 时，Factory 会使用它。 |
| `createVisionAnalyzer` | `(input) => VisionAnalyzer` | 构造受控视觉分析能力。 |

`ProviderProtocolAdapterRegistry` 是默认入口公开的协议 Adapter 注册表，供受信宿主扩展或诊断协议路由；它不从未知协议回退到其他 Adapter。

```ts
class ProviderProtocolAdapterRegistry {
  register(adapter: ProviderProtocolAdapter): void;
  get(apiProtocol: ApiProtocol): ProviderProtocolAdapter;
  getSupportedApiProtocols(): ApiProtocol[];
}
```

`register()` 拒绝同一 `apiProtocol` 的重复实现；`get()` 对未注册协议抛 `UNSUPPORTED_API_PROTOCOL`。Adapter 收到的 `ProviderProtocolAdapterInput` 包含冻结的 `ModelRef`、可选凭据、推理配置、采样选项和 `FrozenProviderConfig`。

### 6.2 模型能力与采样设置

| API | 签名 | 说明 |
|---|---|---|
| `listModelCapabilities` | `() => readonly ModelCapability[]` | 列出内建通用模型能力。 |
| `getModelCapability` | `(provider, modelId) => ModelCapability \| undefined` | 精确查询模型能力。 |
| `resolveModelSampleOptions` | `(input) => ModelSampleOptions` | 从冻结模型引用解析协议层采样选项。 |
| `resolveFirstPartyModelSampleOptions` | `(modelRef, reasoningProfile, options?) => ResolvedFirstPartyModelSample` | 将 requested effort 解析为实际 Messages payload，并冻结 effective effort。 |
| `createDefaultModelBehaviorProfile` | `() => ModelBehaviorProfile` | 创建默认 Agent 行为规范。 |

`ModelSampleOptions.reasoningEffort` 只允许 `low | medium | high | max`。firstParty 对来自 CC `env.CLAUDE_CODE_EFFORT_LEVEL` 的明确 `max` 请求冻结并原样发送为 Messages `output_config.effort: "max"`；目标兼容端点不支持时必须返回其明确错误，Runtime 不得伪装回退为 `high`。

### 6.3 设置 API

```ts
const settings = resolveAutopilotSettings(sources);
const normalizedBaseUrl = normalizeProviderBaseUrl("https://provider.example/v1/");
```

| API | 说明 |
|---|---|
| `resolveAutopilotSettings(sources)` | 按 User、Project、Local scope 归一化 Claude Code 风格的可信设置源，返回 `ResolvedAutopilotSettings` 和诊断。 |

User scope 可通过顶层 `maxOutputTokens` 配置单次模型输出上限，只接受 `1..1,000,000` 的安全整数。该值由新 Turn 冻结为 Provider `maxTokens`；Project/Local 不能覆盖，缺失时由 Provider Adapter 使用 `8192` 兼容兜底，且它与 Turn 累计预算 `maxTotalTokens` 无关。
| `normalizeProviderBaseUrl(value)` | 接受 `unknown`，规范化合法 HTTP(S) Provider base URL；不合法时返回 `undefined`。 |
| `createMutationCompletionPolicy(maxRecoveryAttempts = 1)` | 创建默认完成策略；仅当成功的 `write_file` / `edit_file` 产生未验证路径时要求对目标路径调用 `read_file`，不从用户自然语言推断写入意图；用于 Agent 完成判断，不是 UI 规则。 |

`ResolvedAutopilotSettings` 只消费顶层 `env`、`model`、`availableModels`、`modelOverrides`、`alwaysThinkingEnabled`、`effortLevel` 与 User-only `webSearch`、`visionModel`、`rag` 子集。`webSearch:false` 显式禁用并产生 `webSearchDisabled:true`，阻止默认继承；连接对象必须精确为 `{ provider, baseUrl, model, credentialRef: { provider, key } }`，其中 provider 当前只接受 `deepseek | openai-compatible | xiaomi-mimo` 且必须与凭据引用一致；Project/Local 覆盖拒绝。快照产生不含明文 Key 的完整 `ResolvedWebSearchSettings`，旧的 DS-only `{ credentialRef }` 形状兼容规范化为官方 Anthropic 地址和 deepseek-flash 模型，具体 provider 是否受支持仍由 Node Adapter 注册边界判断。User `env` 白名单包含 `ANTHROPIC_BASE_URL`、二选一的 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`、模型 alias、`CLAUDE_CODE_EFFORT_LEVEL`、compact window、timeout 及三个 Search 固定凭据字段；Project/Local 不得提供这些 `env` 字段。`ANTHROPIC_MODEL` 优先于顶层 `model`；Opus/Sonnet/Haiku alias、单跳 `modelOverrides` 和 User allowlist 会在同一快照中收敛。`modelCandidates` 是不含凭据的内部候选目录：显式 `availableModels` 优先，缺失时由主模型、三个默认 alias 与 subagent 模型稳定去重生成；Project/Local 不能向其中注入候选。认证原文不会进入快照，只有受控 `credentialRef` 可供受信任 Node 宿主延迟解析。顶层 `effortLevel` 只接受 `low | medium | high`；显式 `max` 必须来自 `env.CLAUDE_CODE_EFFORT_LEVEL`，并在 Messages payload 中原样冻结。`CLAUDE_CODE_SUBAGENT_MODEL`、自动压缩阈值和 Provider timeout 会冻结到 Turn 私有配置；当前 Runtime 未创建子 Agent，不会拿该字段替换主模型。`schemaVersion`、`providers.*`、`models.primary`、`models.vision` 等旧结构一律返回诊断且不转换；未知 Claude Code 顶层字段不进入 Runtime 快照。

User-only `visionModel` 可为受信 `providerRoutes` 中的 `route/model` 字符串或 `false`，产生 `ResolvedAutopilotSettings.visionModelRef?: ModelRef | false`。显式旧视觉 route 当前只接受 OpenAI Chat Completions；视觉分析器支持该协议及主连接 Anthropic Messages（含 anthropic-version 头）；非法模型/协议安全关闭并返回诊断，Project/Local 不能覆盖。未声明时 Web/CLI 默认继承主连接，Web 仅在缺少主连接时兼容旧 env；false 明确关闭。Web/CLI 将该角色映射到既有 `providerSettings.visionModelRef/vision`，Core 对当前 Turn 冻结路由；Chat 继续运行仍使用冻结路由，且当前 Host 撤销能力仍能阻断访问。

User route 的 `models[]` 条目可声明可选 `contextWindowTokens`（1..10_000_000 的安全整数；越界、浮点或字符串等非法值按既有风格整体拒绝该 route 并报 `SETTINGS_PROVIDER_ROUTE_INVALID`；缺省保持原快照形状）。冻结链以内置能力目录为权威，目录未登记的第三方模型以 route 声明兜底生成 `FrozenProviderConfig.contextWindowTokens`，窗口到位后 Context 预算与 `turns.getContextUsage()` 投影自动恢复，缺省或窗口不足（不大于输出预留加安全缓冲）时仍 fail closed 为 unknown。

### 6.4 Node Web capability loader

Core 的 Web capability 方法与 DTO：

```ts
interface WebCapability {
  search?: WebSearchCapability;
  fetch?: WebFetchCapability;
}
interface WebSearchSource { title: string; url: string; snippet?: string }
interface WebSearchResult { answer: string; sources: WebSearchSource[]; truncated: boolean }
interface WebSearchCapability {
  search(input: { query: string; signal?: AbortSignal }): Promise<WebSearchResult>;
}
interface WebFetchResult {
  url: string;
  finalUrl: string;
  title?: string;
  content: string;
  contentType: string;
  truncated: boolean;
}
interface WebFetchCapability {
  fetch(input: {
    url: string;
    prompt?: string;
    signal?: AbortSignal;
    redirectsRemaining?: number;
  }): Promise<WebFetchResult>;
}
```

- `query` 是公开搜索文本；builtin 限制 1–4,000 字符，结果最多 10 个来源、answer 24 KiB、总输出 64 KiB。Search 执行超时默认值与上限均为 300 秒，覆盖请求和完整响应读取。`signal` 贯穿实际请求与读取，取消后不得继续跳转或自动重试。
- `url` 是明确的 HTTP(S) 地址；builtin 与 Node URL policy 均限制 2,000 字符且禁止 userinfo；`prompt` 可选、1–4,000 字符。`redirectsRemaining` 仅由 Core 的进程内重定向绑定提供，缺省 10，模型 Schema 不暴露该字段。Node Adapter 拒绝非 0–10 整数预算。`url` 是本次已批准调用的起始地址（跨域重新审批后更新为目标），`finalUrl` 是最终地址。Fetch 每次执行段的默认超时与上限均为 60 秒，覆盖 DNS、同域跳转与响应读取；跨域审批等待不计入执行段，批准后开启新执行段，但保留剩余跳数。
- `WebSearchCapabilityError(code, message)` 的 code 为 `CAPABILITY_UNAVAILABLE | WEB_SEARCH_PROVIDER_REJECTED | WEB_SEARCH_RATE_LIMITED`。`WebFetchCapabilityError(code, message, redirect?)` 的 code 为 `WEB_URL_BLOCKED | WEB_REDIRECT_REQUIRES_APPROVAL | WEB_RESPONSE_TOO_LARGE | WEB_CONTENT_TYPE_UNSUPPORTED`，可选 `redirect: { url: string; remainingRedirects: number }` 只用于跨域重新审批；它是进程内数据，不能序列化进错误、事件或 checkpoint。Core 不采用 Adapter message，始终输出固定安全文案。
- Web capability 错误按 Error 名称、稳定码与重定向字段形状识别，不依赖某一份 CJS/ESM 构造器身份；未知码与畸形载荷仍返回通用失败。跨域 URL 必须再次通过工具 Schema/Policy 与 Adapter DNS 校验，剩余跳数不得增长。
- Node Search Adapter 在独立请求中附加 UTC 日期与来源核验指令，只接受包含已完成搜索动作的完成态响应，返回最后一条完整消息及其结构化引用。无引用仍可以返回答案，但展示明确说明“搜索服务未返回结构化引用”，不能据此推导公开资料不存在或答案已完成时效核验。
- 原始搜索结果/网页正文只供当前进程采样。公开成功 `tool_result.output` 分别收窄为 `{ sourceCount, truncated }` / `{ host, contentType, truncated }`，无安全 detail 时只返回 `{ redacted: true }`。旧 transcript 的公开读取出口会再次应用当前脱敏规则，原存储记录保持不变。durable checkpoint 的 Web tool-call/pendingCalls 输入为 `{ redacted: true }`，结果保留安全占位及配对。
- 待审批 Web 原参数只在同一 Runtime 内暂存，最长 10 分钟、最多 32 个待审批 Turn，不保存网页正文；完成时释放。同一 Runtime 内恢复使用原参数；即使进程未退出，创建新 Runtime 也不能恢复原参数。Runtime 重建、超时或淘汰后，原待执行批次以 `WEB_INPUT_UNAVAILABLE` 闭合，再交模型重新规划。用户拒绝时直接结束，不重新采样或外发。已完成网络调用不自动重发；需要正文时必须重新请求并遵守当前策略。

最小宿主示例（均在 Trust 后）：

```ts
import { createNodeCapabilityLoader } from "@autopilot-agent/adapters";
import { WebFetchCapabilityError } from "@autopilot-agent/core";
const loader = createNodeCapabilityLoader({ settingsLoader });
const web = await loader.loadWeb(workspaceRoot);
// 生产宿主应将 loader 交给 Bootstrap，再由 Runtime 的工具审批链调用能力。
const bootstrapOptions = { ...trustedBootstrapOptions, capabilityLoader: loader };
// 自定义 Adapter 拒绝跨域时：
throw new WebFetchCapabilityError("WEB_REDIRECT_REQUIRES_APPROVAL", "需要目标域审批", {
  url: "https://destination.example/page", remainingRedirects: 4,
});
```

Node 另提供 `createNodeUserSettingsService` 分类原子保存与安全状态、`createNodeRagRuntime` 四角色运行连接装配。RAG 与 Search 在操作实例创建时冻结凭据；新实例读取新设置，Key 不进入安全快照。文本 Embedding 请求发送配置 dimensions，空间变化或旧元数据未知阻断检索，不自动删库或重建。

`@autopilot-agent/adapters` 的网络能力入口导出中性的 `createNodeCapabilityLoader(options)`；具体 Search Adapter、endpoint 与协议常量不从包入口导出。Trust 后调用 `loadWeb(workspaceRoot)`：安全 `fetch` 始终可用，`search` 仅在 User-only `webSearch` 完整连接可解析、凭据可用且 provider 已注册时加入；未注册 provider 或凭据失败均 fail closed，不影响 Fetch。

```ts
import { createNodeCapabilityLoader } from "@autopilot-agent/adapters";

const loader = createNodeCapabilityLoader({
  stateRoot,
  settingsLoader,
});
const web = await loader.loadWeb(workspaceRoot);
```

当前 Search Provider 注册表（Node Adapter 内）维护三行：`deepseek` → Anthropic Messages 适配器（Base URL 追加 `/v1/messages`，声明 `web_search_20250305` server tool，`max_uses: 5`、`max_tokens: 4096`，模型固定 `deepseek-flash`；解析 `web_search_tool_result` 块与 text 块 `citations[].cited_text` 摘要，认证同时携带 `x-api-key` 与 Bearer）；`openai-compatible` → Responses 适配器（Base URL 追加 `/responses`，`stream: false`、`reasoning: { effort: "none" }` 与唯一 `tools: [{ type: "web_search" }]`）；`xiaomi-mimo` → Chat Completions 适配器（Base URL 追加 `/chat/completions`，内置 `web_search` 工具固定 `force_search: true`、`max_keyword: 3` 并关闭 thinking，模型固定 `mimo-v2.5`，来源取 `message.annotations[].url_citation`）。Search 模型独立于主问答模型与思考设置；新增受支持厂商 = 注册表加一行，仅当厂商使用新 wire 协议时才新增适配器。DS 主 Key 仅在官方 Anthropic 主地址下可复用，此时 Search 固定为 DeepSeek 官方 Anthropic 地址（`/v1/messages`）与 `deepseek-flash`。Adapter 在解析 JSON 前将响应限制为 1 MiB，再输出最多 24 KiB answer、10 个无 userinfo 的 HTTP(S) 来源；未知 item/annotation 忽略，非完成态、畸形或超限响应安全失败。401/403/5xx 归一为 `WEB_SEARCH_PROVIDER_REJECTED`，429 为 `WEB_SEARCH_RATE_LIMITED`，缺失凭据为 `CAPABILITY_UNAVAILABLE`；Core 根据错误码使用固定文案，不采用 Adapter message 或 Provider 正文。

同一 loader 的 Fetch Adapter 仅接受无 userinfo 的 HTTP(S) URL；每一跳都重新解析全部 A/AAAA 结果并拒绝私网、回环、链路本地、metadata、保留和特殊用途地址，连接层固定使用已校验地址以封闭 DNS rebinding。连接固定 family 并禁用自动地址族选择与连接池复用，lookup 异步返回已校验地址。跨域在解析新域名前返回带进程内目标和剩余跳数的 `WEB_REDIRECT_REQUIRES_APPROVAL`；Core 将目标重新送入 Schema/Policy/grant/Approval 链，审批哈希重新绑定目标输入，批准后直接请求目标，不重发首域。所有同域/跨域跳转共用最多 10 跳预算；拒绝会终止本批后续调用。原始响应与解压输出各受 10 MiB 硬门，只接受 HTML/XHTML、纯文本、Markdown 与 JSON；HTML 由 `linkedom` DOM 解析并移除脚本、样式和嵌入节点，模型文本最多 100,000 字符。稳定 Fetch 错误为 `WEB_URL_BLOCKED`、`WEB_REDIRECT_REQUIRES_APPROVAL`、`WEB_RESPONSE_TOO_LARGE`、`WEB_CONTENT_TYPE_UNSUPPORTED`，Core 只显示固定文案。

---

## 7. Bootstrap 与工作区 Trust

### 7.1 `createSafeBootstrapConfig(overrides?)`

生成 Trust 前允许读取的最小配置。

```ts
const config = createSafeBootstrapConfig({
  host: "cli",
  workspaceRoot: "/workspace/demo",
  logLevel: "info",
  skipTrustCheck: false,
});
```

Trust 前只允许解析 argv、环境中的安全参数、工作区候选和 Trust 状态；不得加载 Provider、MCP、Skill、Memory、工作区设置或任何凭据。

### 7.2 `createRuntimeBootstrapService(options)`

```ts
const service = createRuntimeBootstrapService({
  config: createSafeBootstrapConfig({ host: "cli" }),
  workspaceAdapter: ports.workspaceAdapter,
  trustPolicy,
  createPorts: async function createPortsForWorkspace() {
    return ports;
  },
  capabilityLoader: {
    async loadProvider() { return createDefaultModelSamplerFactory(); },
  },
});

const runtime = await service.bootstrap();
```

每次 `bootstrap()` 都创建新的 Runtime，并不缓存实例。需要连续执行 start、审批、continue、cancel 的宿主必须缓存并复用同一 Runtime；否则会失去进程内 Web 待审批参数及原 Turn 的取消控制器。工作区之间必须隔离实例。

| 方法 | 签名 | 说明 |
|---|---|---|
| `bootstrap` | `() => Promise<AgentRuntime>` | 执行 safe → trust → runtime 全流程。 |
| `safeBootstrap` | `() => Promise<SafeBootstrapConfig>` | 仅读取安全配置。 |
| `establishTrust` | `() => Promise<{ workspaceRoot, trustEntry }>` | 解析、canonicalize 并确认 Trust。 |
| `createRuntime` | `(workspaceRoot) => Promise<AgentRuntime>` | 在 Trust 已建立后装配 Runtime。 |

`WorkspaceTrustPolicy` 由宿主实现 `getTrustStatus`、`isTrusted`、`grantTrust`、`denyTrust`、`revokeTrust`。新工作区必须保持 `pending` 并由用户明确授信；`WorkspaceTrustError` 会携带 `workspaceRoot` 与 `trusted | denied | pending | expired` 状态。

`createAgent()` 的旧 `rag`、`focusedPdfFileName`、`focusedResourceId` 参数仅保留类型兼容，不调用 `getRagCapability()`、不注册私有检索。Kernel 不再持有旧 RAG bridge 或空检索 stub；实验性 Tool context 的对应字段只保留弃用类型。

`CapabilityLoader` 不再定义或调用 `loadRag`；旧宿主即使附带同名字段也不会执行。私有知识只能由受信 Chat 宿主通过 `RunConfig.chatLoader` 提供，复用 canonical RAG 实现，不经过 Work Bootstrap。

`CapabilityLoader.loadWeb?(workspaceRoot)` 在 Trust 建立后被调用，并返回进程内 `WebCapability | undefined`。Bootstrap 同时绑定进程内 `RunConfig.webLoader`；每次 start/continue 在执行前重新校验 Trust 并加载 Web 能力，空值覆盖旧能力。关闭用户级 Search 配置在下一次 start/continue 生效；已执行中的调用保留本次能力快照。主模型 continue 仍使用原冻结配置。返回空值或只返回一个子能力时，Runtime 分别隐藏不可用的 Web 工具；宿主不得在 Trust 前读取 Web 设置或凭据，也不得把 capability 对象写入 Session/Turn 持久化数据。

---

## 8. 辅助与兼容 API

### 8.1 `useRAG()`

```ts
const { query } = useRAG();
const answer = await query("解释退款流程");
```

签名：`() => RAGQuerier`，其中 `RAGQuerier.query(prompt)` 返回 `Promise<string>`。适用于旧的简易单问查询；需要来源、表选择、流式输出或会话时使用 `createRAGAgent()`。

### 8.2 `getLanceDBInfo(tableName?)`

签名：`(tableName?: string) => Promise<Record<string, unknown>>`。

当前实现直接初始化 Vector Store：未传表名时返回表和 Schema 摘要；传表名时执行该表的完整 `query().toArray()`，再移除 `_` 开头字段并将向量替换为维度摘要。Core 本身不在此函数内执行 Trust、宿主或结果数量授权，因此它只是受信开发调试约定，不是面向浏览器的生产查询 API；生产检索使用 `rag.search()` 或 `rag.searchAcrossTables()`。

### 8.3 已废弃 Excel 顶层导出

| 旧 API | 替代 API |
|---|---|
| `parseExcelFile(filePath, options?)` | `createRAGAgent().parseExcelFile(filePath, options?)` |
| `listExcelSheets(filePath)` | `createRAGAgent().listExcelSheets(filePath)` |
| `getExcelSheetInfo(filePath, sheetName?)` | `createRAGAgent().getExcelSheetInfo(filePath, sheetName?)` |
| `ingestExcel(filePath, options?)` | `createRAGAgent().ingest(filePath, { type: "excel", ...options })` |

旧导出仅为兼容保留；新代码不得继续新增调用。

### 8.4 `createAgent(options?)`：兼容 facade

签名：`(options?: AgentOptions) => AgentInstance`。

它提供 `run()`、`resume()`、`compact()`、`cancel()`、`getToolDefinitions()` 的旧单实例调用方式。新的 Web/CLI/Desktop 宿主应使用 `createAgentRuntime()` 管理 durable Session 和 Turn；不要混用 `AgentInstance` 的 `run()` 与 `runtime.turns.start()` 来驱动同一会话。

### 8.5 canonical 消息辅助 API

这些函数操作默认入口公开的 Provider 中立 V2 canonical 消息。它们只做归一化、校验、工具配对扫描、迁移或对外脱敏，不接受模型或浏览器传入的授权结论，也不替代 Runtime 的持久化边界。

| API | 签名 | 说明 |
|---|---|---|
| `normalizeAgentMessages` | `(messages: readonly AgentMessage[]) => AgentMessage[]` | 归一化 V2 消息及内容块；非法结构抛 `CanonicalMessageError`。 |
| `scanAgentToolPairing` | `(messages: readonly AgentMessage[]) => AgentToolPairingScan` | 扫描工具调用/结果配对，可用于允许待完成配对的恢复边界。 |
| `validateAgentMessages` | `(messages: readonly AgentMessage[]) => AgentMessage[]` | 校验完整 canonical 消息并返回可持久化的归一化结果；不完整工具配对会失败。 |
| `isAgentToolPairingBalancedBefore` / `isAgentToolPairingBalancedAt` | `(messages: readonly AgentMessage[], cutIndex: number) => boolean` | 判断 compact 或投影切点前/处是否保持工具调用与结果配对。 |
| `sanitizeAgentMessagesForExternal` | `(messages: AgentMessage[]) => AgentMessage[]` | 删除 reasoning block 与 Adapter 私有 replay state，生成对外安全副本。 |
| `migrateAgentMessages` | `(input: { messageSchemaVersion?: unknown; messages: unknown; allowPending?: boolean }) => AgentMessageMigrationResult` | 将 V1/V2 durable 消息安全迁移到 V2；失败时返回 `CANONICAL_MESSAGE_INVALID` 与原始消息，不伪造成功。 |

`CanonicalMessageError` 的 `code` 固定为 `CANONICAL_MESSAGE_INVALID`。`sanitizeAgentMessagesForExternal()` 不修改输入数组；`migrateAgentMessages()` 也不改写原始 durable 记录。

### 8.6 知识资源身份辅助 API

| API | 签名 | 说明 |
|---|---|---|
| `createKnowledgeResourceId` | `() => string` | 生成 `resource_` 加 32 位小写十六进制随机标识，不从文件名或内容派生。 |
| `isKnowledgeResourceId` | `(value: string) => boolean` | 校验资源标识形状；不接受路径或任意文件名。 |
| `deriveKnowledgeTableName` | `(resourceId: string, embeddingSpaceId: string) => string` | 按资源标识与完整 Embedding 空间派生稳定物理表名；资源标识非法或 Embedding 空间为空时抛 `RAG_STORAGE_INVALID`。 |

宿主应保存 `resourceId` 与 `embeddingSpaceId`，不要自行拼接 LanceDB 物理表名；资源表名属于 Core 存储实现细节。

### 8.7 `listWorkspaceFiles(input)`：工作区文件枚举

枚举工作区文件，返回稳定排序的工作区相对路径列表；供 CLI `@文件` 候选索引等宿主能力复用。它不是模型工具，不进入工具目录，也不经过审批链。

```ts
import { listWorkspaceFiles } from "@autopilot-agent/core";

const { files, truncated } = await listWorkspaceFiles({
  workspaceRoot: "/workspace/demo",
  maxFiles: 20000,
  signal: controller.signal,
});
```

```ts
interface ListWorkspaceFilesInput {
  /** 工作区根的绝对路径；枚举范围不会超出该目录。 */
  workspaceRoot: string;
  /** 返回路径数量上限，默认 20000。 */
  maxFiles?: number;
  /** 取消信号；取消、超时与启动失败均收敛为 AgentRuntimeError。 */
  signal?: AbortSignal;
}

interface ListWorkspaceFilesResult {
  /** 工作区相对路径（正斜杠、localeCompare 稳定排序）。 */
  files: string[];
  /** 结果不完整时为 true（ripgrep 输出截断或超过 maxFiles）。 */
  truncated: boolean;
}
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|:--:|---|
| `workspaceRoot` | `string` | 是 | 工作区根目录；为空、不存在或不是目录时抛 `INVALID_INPUT`。 |
| `maxFiles` | `number` | 否 | 返回路径上限，默认 `20000`；必须为正整数，超过上限时结果截断并标注 `truncated`。 |
| `signal` | `AbortSignal` | 否 | 取消信号；取消、超时与 ripgrep 启动失败均收敛为 `RUNTIME_ERROR`。 |

使用限制：

- 内部以项目固定的 ripgrep 二进制执行 `rg --files`（尊重 `.gitignore`，`--hidden` 保留点文件），并排除 `.git/.svn/.hg/node_modules/.next/dist/coverage`；与 `glob_files` 工具共享同一份排除规则。
- 只做文件名枚举，不读取文件内容；`truncated: true` 表示列表不完整，宿主不得假设结果穷尽。
- 失败统一抛 `AgentRuntimeError`：输入问题为 `INVALID_INPUT`，执行问题为 `RUNTIME_ERROR`（原始错误保留在 `cause`）。

---

## 9. 公开类型索引

以下类型均从默认入口导出。使用时优先 `import type`；字段很多的 DTO 以 TypeScript 声明为准，本手册在相关 API 小节说明其输入输出语义。

| 分类 | 公开类型 |
|---|---|
| 基础 RAG | `VectorInput`、`VectorOutput`、`ChatMessage`、`AgentToolCall`、`IngestOptions`、`IngestResult`、`IngestProgressEvent`、`ParseExcelOptions`、`ExcelIngestOptions`、`ExcelIngestResult`、`SheetInfo`、`AskStreamOptions`、`RAGAgent`、`RAGAgentOptions`、`RAGQuerier`、`RagErrorCode`、`RagStorageOptions`、`KnowledgeResource`、`DeleteKnowledgeResourceResult`、`KnowledgeResourceManifest`、`KnowledgeResourceStatus`、`PdfPageMetadata`、`RagEvidence`、`TableProfile` |
| Runtime facade | `AgentRuntime`、`AgentRuntimeFacade`、`CreateAgentRuntimeOptions`、`RuntimePorts`、`SessionStore`、`CheckpointStore`、`TranscriptStore`、`CredentialStore`、`ProjectStore`、`EventSink`、`Clock`、`WorkspaceAdapter`、`WorkspaceInfo`、`TurnStore`、`ApprovalStore`、`InputInbox`、`LeaseStore`、`JobStore`、`JobStoreWriteCondition`、`JobOwnerProbe`、`FileMutationStore`、`SessionResourceStore`、`UserQuestionStore`、`GetUserQuestionInput`、`SaveUserQuestionAnswerInput`、`SaveUserQuestionAnswerResult`、`ProjectService`、`SessionService`、`CreateSessionInput`、`TurnService`、`TurnState`、`ApprovalService`、`InputInboxService`、`UserQuestionService`、`UserQuestionSubmissionService`、`AgentUserQuestionCapability`、`CreateUserQuestionRequestInput`、`SubmitUserQuestionAnswerInput`、`JobService`、`SessionJobService`、`UndoService`、`UndoPreview`、`UndoResult` |
| Runtime domain | `ProductMode`、`ChatRetrievalMode`、`CapabilityCeiling`、`Session`、`SessionPersistenceMode`、`SessionStatus`、`Project`、`CreateProjectInput`、`Turn`、`TurnStatus`、`Job`、`JobStatus`、`JobOwner`、`JobOwnerLiveness`、`JobControlState`、`JobLastControl`、`JobView`、`JobListView`、`JobReadView`、`JobOutputSnapshot`、`JobSafeOutputSnapshot`、`JobSafeOutputStreamSnapshot`、`JobSafeOutputStreamView`、`JobOutputView`、`JobSandboxSummary`、`StartJobInput`、`PollJobInput`、`JobPollResult`、`FileMutation`、`FileMutationOperation`、`FileMutationStatus`、`PrepareFileMutationInput`、`UndoTransaction`、`UserQuestionOption`、`UserQuestionItem`、`UserQuestionAnswerItem`、`UserQuestionRequest`、`UserQuestionAnswer`、`StoredUserQuestion`、`TodoStatus`、`TodoItem`、`TodoCounts`、`TodoSnapshot`、`TodoWriteResult`、`ModelRef`、`ReasoningEffort`、`ReasoningProfile`、`SessionRunConfig`、`FrozenRunConfig`、`CredentialRef`、`ResolvedCredential` |
| Turn 协议 | `ChatCapabilityBinding`、`ChatCapability`、`ChatAttachmentGrant`、`ChatKnowledgeCapability`、`ChatRagEvidenceBatch`、`ChatRagEvidence`、`RunConfig`、`ResolveRunConfigInput`、`CompactPolicy`、`ProviderRuntimeSettings`、`LimitConfig`、`ResolvedAgentRuntimeLimits`、`AgentRuntimeSafetyLimits`、`StartTurnInput`、`ContinueTurnInput`、`CancelTurnInput`、`SteerTurnInput`、`CompactTurnInput`、`CompactTurnResult`、`AgentEvent`、`AgentEventEnvelope`、`CreateEventEnvelopeInput`、`AgentMessage`、`AgentMessageRole`、`AgentJsonObject`、`AgentContentBlock`、`AgentToolPairingScan`、`AgentCheckpoint`、`PublicCheckpointView`、`FrozenRunConfigView`、`AgentTerminationBudget`、`AgentTerminationReason`、`AgentTerminationView`、`RecoverableTurnStatus`、`RecoverableApprovalView`、`RecoverableTurnView`、`AgentMessageMigrationSuccess`、`AgentMessageMigrationFailure`、`AgentMessageMigrationResult`、`AgentErrorCode` |
| 审批与输入 | `ApprovalDecision`、`PersistentGrant`、`SubmitApprovalInput`、`FindPersistentGrantInput`、`InboxInput`、`InboxDelivery`、`InboxStatus`、`InboxBoundary`、`InboxAttachmentRef`、`InboxSkillRef`、`PostInboxInput`、`DrainInboxInput`、`ClaimNextInboxInput`、`ConsumeInboxInput`、`ListInboxInput` |
| 工具 | `ToolPermissionMode`、`ToolApprovalDecision`、`ApprovalDisplayFacts`、`ToolDisplayFacts`、`ToolDisplayDetail`、`ToolJobDisplayFacts`、`ToolApprovalRequest`、`ToolExecutionRequest`、`ToolExecutionOptions`、`ToolExecutionResult`、`ToolExecutionMeta`、`ToolInterruptionState`、`ToolError`、`ToolEvent`、`ToolModelDefinition`、`ToolActionFacts`、`ToolPolicyResult` |
| Context/Skill/MCP/Web | `AgentContextSnapshot`、`ContextBudgetSnapshot`、`ContextUsageView`、`ContextUsageBreakdownView`、`ContextUsageCategoryKind`、`ContextUsageCategoryView`、`FrozenInstruction`、`FrozenMemorySnippet`、`AgentSkillsCapability`、`SkillCatalogEntry`、`SkillDiscoveryCandidate`、`LoadedSkill`、`SkillResource`、`PreparedSkillCommand`、`McpCapability`、`McpServerConfig`、`WebCapability`、`WebSearchCapability`、`WebSearchCapabilityError`、`WebSearchCapabilityErrorCode`、`WebSearchResult`、`WebSearchSource`、`WebFetchCapability`、`WebFetchCapabilityError`、`WebFetchCapabilityErrorCode`、`WebFetchResult` |
| Provider/设置 | `ModelSampler`、`ModelSamplerFactory`、`CreateModelSamplerInput`、`ModelSamplerFactoryOptions`、`CreateFirstPartyModelSamplerInput`、`ModelSampleOptions`、`ModelCapability`、`FirstPartyEffortSource`、`ResolvedFirstPartyModelSample`、`ModelBehaviorProfile`、`VisionAnalyzer`、`FrozenProviderConfig`、`ApiProtocol`、`ProtocolProfile`、`ProviderRouteProfile`、`AnthropicMessagesProtocolProfile`、`OpenAiChatCompletionsProtocolProfile`、`ProviderProtocolAdapter`、`ProviderProtocolAdapterInput`、`CompletionDecision`、`CompletionIntentSignal`、`CompletionPolicy`、`CompletionPolicyState`、`AutopilotSettingsScope`、`AutopilotSettingsSource`、`ResolvedAutopilotSettings`、`ResolvedFirstPartySettings`、`ResolvedRagConnectionSettings`、`ResolvedRagSettings`、`RagConnectionRole`、`ResolvedWebSearchSettings`、`SettingsDiagnostic` |
| Trust/Bootstrap | `SafeBootstrapConfig`、`WorkspaceTrustEntry`、`WorkspaceTrustStatus`、`WorkspaceTrustPolicy`、`CapabilityLoader`、`CreateRuntimeBootstrapServiceOptions`、`RuntimeBootstrapService` |
| 快照、资源与 Rerank | `DatabaseError`、`DatabaseErrorCode`、`MySQLSourceConfig`、`DatabaseSnapshotConfig`、`DatabaseInspection`、`DatabaseSyncResult`、`DatabaseSnapshotReadCapability`、`SnapshotColumnDescription`、`SnapshotTableDescription`、`SnapshotQueryResult`、`DatabaseSearchCapability`、`CreateDatabaseSearchCapabilityOptions`、`DatabaseSearchPolicy`、`DatabaseSearchRequest`、`DatabaseSearchResult`、`DatabaseAggregationKeyword`、`DatabaseFilterOperatorKeyword`、`DatabaseQueryProfile`、`DatabaseQueryPlan`、`DatabaseQueryPlannerInput`、`RagSourcePolicy`、`KnowledgeResource`、`DeleteKnowledgeResourceResult`、`RerankPolicy`、`RerankRuntime`、`RerankOutcome`、`RerankResult`、`RerankVisionImage`、`RerankRole`、`RerankDocument`、`RerankProviderRequest`、`RerankProviderResult`、`RerankProviderAdapter` |
| 兼容 Agent | `AgentOptions`、`AgentInstance`、`PublicCompactInput`、`AgentCompactionResult`、`AgentInjectedInput`、`AgentInputInboxCapability`、`AgentLease`、`AgentRunInput`、`RagCapability` |
| 工作区文件枚举 | `ListWorkspaceFilesInput`、`ListWorkspaceFilesResult` |

---

## 10. 实验性与内部边界

默认入口只承诺本手册前文的稳定 API。本节列出的 Kernel 与工具构造 API 从 `@autopilot-agent/core/experimental` 显式导入；它们面向 headless runner、CLI 原型和测试，**签名、行为或导出均可能在小版本中调整**。`createDefaultModelSampler` 同时由默认入口导出，属于默认入口公开 API；experimental 入口提供同名导出时，稳定性判断以默认入口的说明为准。生产 Web、CLI、Desktop 宿主应优先使用 `createAgentRuntime()`，不得以实验性入口绕过 Bootstrap、Trust、Policy 或审批。

需要澄清的是「实验性」在此只描述**导出稳定性**，不是架构地位：`runKernel()` 就是生产 `runtime.turns.start()` / `continue()` 的唯一执行内核，`createAgentRuntime()` 内部同样委托它。「实验性」不代表它是一条平行的可选路径，也不代表宿主可以自行拼装 `RunContext` 来代替 Runtime —— 那样会绕过 Session、Turn 持久化、lease、脱敏与审批链。结论：实现上是主干，导出上不承诺稳定。

```ts
import {
  createAgentKernel,
  createReadFileTool,
  ToolRegistry,
} from "@autopilot-agent/core/experimental";
import { createDefaultModelSampler } from "@autopilot-agent/core";
```

### 10.1 Agent Kernel

| API | 签名 | 说明 |
|---|---|---|
| `createAgentKernel` | `(context: RunContext) => AgentKernel` | 创建可恢复的无 UI 执行闭环。 |
| `runKernel` | `(context: RunContext) => AsyncGenerator<AgentLoopEvent>` | 不创建包装对象，直接返回同一 Kernel 事件流。**这也是生产 `runtime.turns.start()` / `continue()` 实际使用的执行内核**；`createAgentRuntime()` 内部以同一函数驱动 Turn，所谓「实验性」仅指该导出不承诺跨小版本稳定。 |
| `AgentKernel.run` | `() => AsyncGenerator<AgentLoopEvent>` | 执行或从 `checkpoint` 恢复当前 Turn；内部仅 `yield* runKernel(context)`。 |

Kernel 的执行单位是 `step`：每次循环完成一次模型采样、一批工具调用与完成判断。宿主可见的是事件流（`turn_started`、`tool_*`、`turn_completed` 等），`step` 本身不是公开契约。Kernel 只消费 Runtime 已冻结的 `RunContext`，不负责 Session 持久化、lease、Turn 记录或脱敏 DTO —— 这些都在 Runtime 层完成。

```ts
const registry = new ToolRegistry();
registry.register(createReadFileTool());

const kernel = createAgentKernel({
  turnId: "turn-demo",
  messages: [{ role: "user", content: [{ type: "text", text: "读取 README.md" }] }],
  toolRegistry: registry,
  permissionContext: { mode: "ask", workspaceTrusted: true },
  modelSampler: createDefaultModelSampler(),
  workspaceRoot: "/workspace/demo",
});

for await (const event of kernel.run()) {
  // 投影已脱敏的 Kernel 事件；持久化由调用方负责。
}
```

`RunContext` 是 Kernel 的完整依赖注入对象，字段如下：

| 字段 | 类型 | 说明 |
|---|---|---|
| `turnId`、`messages` | `string`、`AgentMessage[]` | 本次 Turn 的稳定 ID 与已组合好的上下文消息。 |
| `toolRegistry`、`permissionContext`、`modelSampler` | `ToolRegistry`、`PermissionContext`、`ModelSampler` | 必填执行依赖。 |
| `checkpoint`、`inheritedUsageAnchor`、`approval` | 恢复状态 | 仅用于可信持久化层恢复，不能来自模型或浏览器请求。 |
| `workspaceRoot`、`signal`、`maxSteps`、`maxToolRetries`、`maxDurationMs`、`maxTotalTokens` | 执行边界 | `workspaceRoot` 必须为宿主已验证路径；这些值由 Runtime 在 Turn 开始时解析并冻结，Kernel 只消费冻结结果，不在恢复时重读环境变量；`maxSteps` 与 `maxDurationMs` 缺省关闭、显式正整数不设固定平台封顶，前者按一次内部执行段的采样/工具循环计数（一轮可调用多个工具），Continue 重开执行段并复用冻结额度；`maxToolRetries` 与 `maxTotalTokens` 仍受各自硬上限约束，后者跨 Continue 累计。 |
| `chat`、`skills`、`contextSnapshot`、`inputInbox`、`activeSkills` | 已冻结能力 | 由应用层在 Turn 启动前解析；Kernel 不读取 AGENTS、Memory、Skill 或 Session 文件。 |
| `fileMutationStore`、`sessionId`、`visionAnalyzer` | 受控扩展能力 | 只允许 Runtime 应用层绑定，不能由模型伪造。Kernel RunContext 不再携带旧私有 RAG 的 PDF 文件名或资源聚焦字段；Chat 知识访问由受控 `chat` 端口承载。 |
| `contextCompaction`、`completionPolicy`、`modelSampleOptions`、`onToolEvent` | 策略与投影 | 调用方负责提供已经解析的配置或脱敏事件处理。 |

`PermissionContext` 的 `mode` 必填，取值为 `ask`、`auto_approve` 或 `full_access`；`workspaceTrusted` 缺省时按未信任处理。`resolvePersistentGrant` 与 `validateApproval` 必须查询/校验调用方持久化的可信记录，不能接受模型传入的授权结论。

### 10.2 模型采样端口

```ts
interface ModelSampler {
  readonly behaviorProfile?: ModelBehaviorProfile;
  sample(
    messages: AgentMessage[],
    tools: AgentModelToolDefinition[],
    options: { signal?: AbortSignal; maxTokens?: number } & ModelSampleOptions,
    onDelta?: (delta: string) => void,
  ): Promise<AgentSampleResult>;
}

function createDefaultModelSampler(): ModelSampler;
```

`ModelSampleOptions.toolChoice?: { name: string }` 是受信 Kernel 的单次结构化收尾选项。自定义 sampler 必须将其映射为指定工具的强制选择或明确报告不支持，不可默默忽略。内置 Chat Completions Adapter 映射为 `tool_choice: { type: "function", function: { name } }`，Messages Adapter 映射为 `{ type: "tool", name, disable_parallel_tool_use: true }`。仅该次收尾关闭思考、使用 temperature 0，不发送 reasoning effort/topP；普通采样继续原样使用冻结配置，不修改用户设置，也不对 Provider 4xx 伪装回退。来源校验保留，强制工具选择不替代 schema 和事实校验。

自定义 `ModelSampler` 必须完整返回模型正文、工具调用、结束原因和可用 usage；`onDelta` 只能发送可见正文。`createDefaultModelSampler()` 是内部 headless 回退，不读取 Settings/CredentialStore，也不适合作为生产宿主的凭据装配方式。

### 10.3 标准工具构造函数

每个构造函数都返回 `AgentToolDefinition`，必须先注册到同一个 `ToolRegistry`，再交给 Kernel。工具元数据只描述调度，不构成权限放行；实际执行仍经 Kernel 的 `PermissionContext`、Trust、PolicyEngine 和审批链。

| 构造函数 | 工具名 | 输入 | 当前约束 |
|---|---|---|---|
| `createGlobFilesTool()` | `glob_files` | `{ pattern, path?: ".", limit?: 1..500, offset?: number }` | 只读；稳定排序、尊重 gitignore，排除 VCS、依赖、构建产物。结果含 `files/returned/offset/truncated`，且仅在 ripgrep 输出未被截断时含可证明的 `total`。 |
| `createGrepFilesTool()` | `grep_files` | `{ pattern, path?: ".", glob?, outputMode?: "content" \| "files_with_matches" \| "count", caseInsensitive?, context?: 0..5, limit?: 1..500, offset? }` | 只读；敏感文件不进入内容结果，单行与序列化结果均受限。结果含 `mode/matches/returned/offset/truncated`，且仅在 ripgrep 输出未被截断时含 `total`；content 模式的 `total` 按命中行计，不含 context 行。 |
| `createReadFileTool()` | `read_file` | `{ path, offset?: number, limit?: 1..2000 }` | 默认从第 1 行读取最多 2000 行；已知目标位置时按 offset/limit 定位。只读；支持 UTF-8/UTF-16 文本，单次扫描最多 8 MiB、返回正文最多 256 KiB，超出正文上限需缩小范围；二进制拒绝。 |
| `createEditFileTool()` | `edit_file` | `{ path, oldString, newString, replaceAll?: boolean }` | 写入；必须先由 `read_file` 建立可信观察范围，限制在已观察行内编辑并校验文件未变化。 |
| `createWriteFileTool()` | `write_file` | `{ path, content, expectedSha256? }` | 写入；新建可不传 hash，覆写已有文件必须回传 `read_file` 给出的 SHA-256。 |
| `createRunCommandTool()` | `run_command` | `{ program, args?: string[], cwd?: ".", timeoutMs?: 1..120000 }` | 以 `shell: false` 执行单个前台命令；不支持管道、多命令或交互输入，stdout/stderr 固定内存保留。 |

工具构造函数不是浏览器 API。调用方必须只注入已 canonicalize 的 `workspaceRoot`，传递 `AbortSignal`，并将 `ToolExecutionContext` 中的 `agentFlow`、授权回调和 mutation store 绑定到可信宿主状态。不得直接调用工具 `execute()` 以绕过 `ToolExecutor`；写入、外部命令和动态命令仍必须先经审批。

### 10.4 `ToolRegistry`

```ts
class ToolRegistry {
  register<TInput, TOutput>(definition: AgentToolDefinition<TInput, TOutput>): void;
  unregister(toolName: string): void;
  get(toolName: string): AgentToolDefinition<unknown, unknown>;
  getModelDefinitions(): ToolModelDefinition[];
}
```

- `register()` 拒绝非法或重复的工具名，以及缺少/放宽调度 metadata 的定义。
- `unregister()` 只供受控 capability 生命周期在 shutdown 后移除临时工具；不要在运行中替换工具实现。
- `get()` 未找到时抛稳定 `TOOL_NOT_FOUND` 错误。
- `getModelDefinitions()` 仅投影名称、说明和 JSON Schema，不包含 handler、权限、路径或凭据。

`@autopilot-agent/core/internal/*` 不属于公共契约。不得为了获取私有 checkpoint、Provider 请求、工具 handler、数据库连接或文件路径而引用它；任何输出到浏览器的数据仍须经过 Runtime 的脱敏 DTO/事件边界。

### 写后验证可恢复边界（2026-10-12）

默认完成策略依据真实 changedPaths/verifiedPaths，精确列出未验证路径；一次有限提醒仍未读回时以 interrupted_recoverable/write_verification 暂停，不强制完成。Continue 保留原 Turn、canonical messages、真实写入与 completedCallIds；该恢复段仅暴露/允许 read_file 与最终总结，Skill 限制仍取交集。私有 mutationGate.verificationOnly 随安全批次 checkpoint 保留，拒绝重复写入不会走 completed 捷径。其他 failed 仍不可 Continue，不改旧 failed 记录或真实文件。
