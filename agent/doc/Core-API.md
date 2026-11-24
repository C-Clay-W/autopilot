# @autopilot-agent/core API 参考

> 面向 Web、CLI、Desktop 和 Node 宿主的稳定公开 API 使用手册。Core 默认入口的源码真相位于 `packages/core/src/index.ts`；生产 Node Port 的实现入口位于配套包 `@autopilot-agent/adapters`，源码真相为 `packages/adapters/src/index.ts`。本文档描述当前可用契约，而非开发过程。

## 文档维护规则

本节是维护 `Core-API.md` 的完整规则。每次变更 `@autopilot-agent/core` 公开 API 时必须遵守。

1. **以源码为准**：先核对 `packages/core/src/index.ts` 的运行时导出、类型导出及实现签名；本文档、示例和类型不得以旧的计划稿、旧 dist 或历史记录为依据。
2. **按所属小节就地更新**：已有 API 的参数、类型、返回值、约束、错误或示例变化时，更新它原有的小节；只有新增公开入口或公开类型分类时才新增小节，禁止在文末追加“本次新增”、阶段编号或日期化变更一类内容。
3. **每个可调用 API 必须完整说明**：至少写明签名、参数、返回值、使用限制和最小示例；涉及安全、持久化、信任、权限、兼容或废弃时，必须单独写出注意事项。
4. **类型与示例同步**：公开输入、输出、事件或联合值改变时，同步更新相邻类型定义、类型索引和示例。示例使用占位 workspace、模型和凭据，不写真实密钥、绝对个人路径或内部状态。
5. **只记录现行契约**：本文档不保存按编号划分的执行阶段、日期化过程、打包与验证证据、发布记录、问题排查或已废弃方案；开发过程与发布记录另行维护。
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
| `@autopilot-agent/core/ui` | 稳定 | Intelligent UI 的纯数据组件目录、校验、计算函数和安全文档投影；浏览器可用，不导入 React 或 DOM。 |
| `@autopilot-agent/core/failure` | 稳定 | 浏览器安全的固定 Provider 失败提示、中立原因校验及旧失败 profile 迁移；不依赖 Core 根入口、Node 或原生模块。 |
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

### 1.2 纯数据 UI 子路径：`@autopilot-agent/core/ui`

该子路径提供 Core 的受限 JSON 目录，不渲染 React、不执行模型生成的代码，也不依赖 DOM。它接受白名单组件、状态引用、有限比较条件和注册纯计算函数；单文档最多 64 KiB、128 个元素、树深 12、24 个 state 键，state 最多 16 KiB。组件和字段限额以导出的目录 schema 为准。包同时提供 ESM/CJS、`exports.types` 与面向旧 TypeScript Node 模块解析的 `typesVersions.ui` 声明映射，均指向同一 `dist/ui` 契约。

```ts
import { validateUiDocumentInput, type UiDocumentPayload } from "@autopilot-agent/core/ui";

const payload: UiDocumentPayload = validateUiDocumentInput(modelToolInput);
```

| 导出 | 签名/类型 | 契约 |
|---|---|---|
| `UI_COMPONENT_NAMES` / `UI_COMPONENT_SCHEMAS` | 只读白名单及对应 Zod schema | 19 个组件：Stack、Grid、Card、Text、Metric、Tabs、Disclosure、NumberInput、Slider、Select、DataTable、LineChart、BarChart、Button、ItemList、Timeline、Steps、ChoiceGroup、Flowchart。`ItemList.items` 为 1–20 项，标题 1–80 字、说明至多 300 字；`Timeline.items` 为 1–20 项，label 至多 40 字，标题 1–80 字、说明至多 300 字；`Steps.items` 为 2–8 项并使用相同标题/说明限制，绑定初值为 0 起整数索引。`ChoiceGroup` 的 label 至多 40 字、选项为 2–8 个唯一标量值，选项 label 至多 40 字、说明至多 300 字。Steps 与 ChoiceGroup 和原 NumberInput、Slider、Select 一样以 `statePath` 绑定，归一后改用 `props.value: { $bindState: JSON Pointer }`。DataTable 可选筛选列必须存在且每行值为同一字符串或数值类型；`sortable` 缺省为 false，Web 仅对同类型列排序。图表 `series` 接受固定数据或 `savingsGrowth` 的 `select: "series"` 表达式；不接受任意 state 引用作为序列。 |
| `UI_COMPUTED_FUNCTION_NAMES` / `UI_COMPUTED_FUNCTIONS` | 只读函数名及纯函数目录 | 仅 `savingsGrowth`、`weightedAverage`、`sum`；不接受任意属性路径、eval 或动态函数名。`savingsGrowth` 只支持 `args.select: "final" \| "series"`，分别返回有限数值或符合图表目录的单条逐年序列。 |
| `UI_DOCUMENT_SCHEMA_VERSION` | 常量 `1` | 当前安全 UI 文档协议版本。 |
| `Flowchart` props | `{ direction: "TB" \| "LR", description, nodes, edges }` | `description` 为 1–500 字的文字等价说明；1–24 个节点 `{ id, label, kind?: "process" \| "decision" \| "terminal" }`，标签1–40字；0–48条边 `{ id, from, to, label? }`，边标签最多24字。节点/边ID为1–40个字母数字、下划线或短横线，各自唯一；拒绝重复关系和悬空引用，允许分支/回路。仅Chat Intelligent UI，不为CLI装配。 |
| `uiDocumentInputSchema` | Zod schema | 检查 `{ title, fallbackText, spec: { root, elements, state? } }`；`elements` 是以节点 ID 为键的动态 map，元素按 19 类 `type` 约束匹配的 `props`，并限制元素外层 `children/slots/visible/on`。动态 map 不转换成数组；单独 parse 仍不替代完整语义校验。 |
| `validateUiDocumentInput(value)` | `(unknown) => UiDocumentPayload` | 复用同一元素 schema 后继续深度校验限额、引用树、state 和计算参数；NumberInput、Slider、Select、Steps 与 ChoiceGroup 的 `statePath` 必须指向已声明标量 state 并转换为 renderer 的 `$bindState`。Steps 初值须为范围内整数，ChoiceGroup 初值须匹配唯一选项。Button 的 `continue_chat` 分支要求 `fields` 且 `props.action` 与外层 `on.press.action` 相同；`reset_state` 分支仅含 `action/text`，同样要求外层动作匹配，不接收 `fields`。两类按钮都只由 Web 本地交互处理，不扩展 Core 执行权限。工具是否可见仍由受信 Chat none capability 控制。 |
| `createUiDocument(payload, uiId)` | `(UiDocumentPayload, string) => UiDocument` | 生成安全投影副本；`uiId` 必须为 `ui_` 加 32 位小写十六进制摘要。 |
| `projectUiDocument(value)` | `(unknown) => UiDocument` | 校验协议版本、ID、完整已归一化 spec 和文档大小，再复制白名单字段。 |

`UiDocumentPayload`、`UiDocument`、`UiSpec` 等类型从子路径导出；`UiDocument` 也从默认 Core 入口导出，供 `AgentEvent` 使用。宿主只有在受信 Chat none/web capability 显式启用 `interactiveUi` 时才会看到 `render_ui`；一次成功调用只发布一个独立 `ui_document`，同一 Turn 可按主题需要调用多次形成 0–3 份文档。已发布调用身份随私有 checkpoint 保存，恢复时由该 Turn 的持久 `ui_document` 事件补齐，重建 Runtime 不重置配额。失败校验和未发布调用不计入已发布配额，同调用身份不重复发布，不同 Turn 独立计数；私有预算不进入公开 checkpoint、transcript 或 DTO。成功事件携带归一后的安全文档，工具返回模型的内容固定为 `{ delivered: true }`。UI 实例 state 的客户端交互不写回 Core；用户继续任务仍应由宿主提交可见的新消息。

真实内置 `render_ui` 的单独输入结构拒绝，在受信 Chat none/web 且 capability ceiling 与 `context.chat` 模式匹配、工具实际暴露时，仅返回固定安全错误并进入本 Turn 的无工具文字收口；非法内容不dispatch或发布。深层语义拒绝同样只允许后续文字，剩余步骤/token限额保持，私有恢复状态与UI已发布配额分开保留，不进入公开checkpoint/DTO。混合批次、权限/引用授权、其他工具与同名伪造定义维持原预检失败策略，不因通用 `INVALID_INPUT` 恢复；文字收口阶段不自动修spec或追加Provider恢复。

### 1.3 纯失败辅助子路径：`@autopilot-agent/core/failure`

该子路径仅提供固定错误提示、封闭的中立原因校验，以及为旧 History DTO 保留的 `deepseek_official` profile 迁移。它不包含 Provider 请求、数据库或 Runtime 能力；Web 客户端可静态导入，不会经过 Core 根入口。包提供 ESM/CJS、`exports.types` 与面向旧 TypeScript Node 模块解析的 `typesVersions.failure` 声明映射，均指向同一 `dist/failure` 契约。根入口仍保留相同函数的兼容导出。`sanitizeAgentProviderFailureDetail(value)` 校验可选协议标识，供消费者统一处理。

```ts
import {
  getAgentProviderFailureMessage,
  normalizeLegacyProviderFailureReason,
  sanitizeAgentProviderFailureReason,
  type AgentProviderFailureReason,
} from "@autopilot-agent/core/failure";
```

| 导出 | 签名/类型 | 契约 |
|---|---|---|
| `AgentProviderFailureReason` | 闭合字符串联合 | 仅含 invalid_request、authentication_failed、billing_insufficient、quota_exhausted、rate_limited、service_unavailable。 |
| `getAgentProviderFailureMessage(errorCode, reason?)` | `(unknown, unknown?) => string \| undefined` | 仅返回固定安全提示，不拼接上游自由文本。 |
| `sanitizeAgentProviderFailureReason(errorCode, reason)` | `(unknown, unknown) => AgentProviderFailureReason \| undefined` | 只接受与既有 Provider 错误分类匹配的原因。 |
| `sanitizeAgentProviderFailureDetail(value)` | `(unknown) => string \| undefined` | 仅保留 `code:` / `type:` 加 1–32 位有界协议标识，首位须为字母或数字；过滤常见凭据形式，非法值返回 `undefined`。格式检查不能证明未知上游标识没有敏感内容。 |
| `normalizeLegacyProviderFailureReason(errorCode, profile, status)` | `(unknown, unknown, unknown) => AgentProviderFailureReason \| undefined` | 仅迁移已知旧 profile 与匹配状态，不改变既有反馈 ID、stage、HTTP 状态或恢复分类。 |

### 1.4 两类主入口

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
  facts: RuntimeFacts;
  threads: { bind(context: ThreadHostContext): ThreadFacade };
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
| `defaultRunConfig` | `RunConfig` | 否 | Runtime 默认配置；模型、推理、凭据、权限与执行预算按 Turn > Session > Project > Runtime 解析。Trust、沙箱及进程内能力仅来自受信宿主。 |
| `enableUserQuestions` | `boolean` | 否 | Web 和 Desktop 受管 AP 等具备答案提交入口的 Work 宿主设为 `true`；普通 CLI 默认关闭新问题工具。关闭仅影响新工具注册，`runtime.questions` 仍可校验/保存历史暂停问题的答案；继续执行须遵循原 Turn 的宿主归属与恢复规则。 |

可信宿主的 `RunConfig.hostToolsLoader` 可以通过 `beforeExecute(toolName)` 核对普通工具准入。参数来自实际工具定义，现有无参数回调仍可使用。由同一宿主通过此 loader 注册的工具按原绑定合同执行。

`createNodeRuntimePorts(options)` 是仓库已经提供的 Node 生产实现，不需要宿主自行重写 Store。它要求显式 `stateRoot`，可接收 `workspaceRoot`、`cwd`、`env`、`productMode` 与仅供 CredentialStore 按需读取的 `userSettingsPath`，并一次装配 Session、Thread、Checkpoint、Transcript、Credential、Project、Event、Workspace、Turn、Approval、InputInbox、Lease、Job、Undo mutation 及 Session resource 的全部 Port。相同 `stateRoot` 的两次装配可恢复同一份 durable 状态。默认是 Work；Chat 使用下述 `createNodeChatStorage()`，获得拒绝工作区访问的端口和正确的附件清理绑定。

`TranscriptStore` 是 durable Transcript 的唯一写入者。`EventSink` 只供宿主观察、转发或丢弃 Runtime 事件，禁止把事件写回同一 Runtime 的 TranscriptStore；ephemeral Session 仍会经过 EventSink，但不会因此落盘。Node 默认 EventSink 在没有额外观察者时丢弃事件，协调器仅在 Session 为 durable 时调用 `TranscriptStore.append()`。

状态根必须由 composition root 决定，不能从 prompt、模型输出或 HTTP 请求体推导；Work 先完成工作区 Trust，再调用 `initializeNodeStateRoot(stateRoot)`，最后创建 Node Port。CLI 和 Web 均通过 Core 的 `createRuntimeBootstrapService()` 在其 Trust 后 `createPorts` 回调中遵守这一顺序。

Node durable schema 当前为 **v8**，与 npm 包版本独立。Trust 后的 `initializeNodeStateRoot(stateRoot)` 自动将带合法 manifest 的已知旧版逐级升级，包含 v6→v7 的 Work 缺省身份补齐及 v7→v8 的可信协作创建来源恢复。迁移复用原 schema manager：完整备份→副本转换/校验→切换；失败保留原数据和恢复备份。重复打开当前版不重复升级/备份；未知新版不降级，无标识非空根不猜测布局。有活跃迁移锁、写锁或新鲜 Turn 租约时明确等待，不切换正在使用的状态根。

当前格式的 Session get/list 仍只读，拒绝缺少产品身份的损坏记录，不在普通查询中迁移；保存不得改变既有产品、Project、协作创建身份或协作工具上限。旧协作进展保留在会话视图，缺失的 `taskId/turnId/taskProgressSeq` 不推断；新进展仍绑定真实任务，任务页不吸收无归属旧进展。`ThreadProgressView` 和 `AgentThreadProgressPage.items` 的任务/Turn 身份对这些旧进展可缺省。`TranscriptStore.readPage(sessionId, { cursor?, limit })` 返回 `{ items, nextCursor?, cursor? }`；`nextCursor`仅表示仍有历史页，可选`cursor`是本页末尾位置（包括已到尾部），用于下一次仅读取新增事件。读取不初始化目录；分页限制 1–100，截断行报损坏，文件替换后游标过期。空缺文件可返回空页而无游标。

#### Node Adapter 错误协议

Node Session 身份拒绝复用 Core `AgentRuntimeError`：`SESSION_MODE_MISMATCH`、`CHAT_RETRIEVAL_MODE_LOCKED`、`WORKSPACE_REQUIRED` 均通过 `.code` 识别，不解析 message。独立用户 Home 无法解析时复用 Adapter 已有 `UserConfigDirectoryError("AUTOPILOT_HOME_UNRESOLVED")`。

`@autopilot-agent/adapters` 另导出 `NodeStateError` / `NodeStateErrorCode`、`NodeChatError` / `NodeChatErrorCode`。两类异常的 `message` 固定等于 `code`，不包含输入、路径或底层异常正文；它们不属于 Core 工具错误协议。

| 类型 | 错误码与含义 |
|---|---|
| `NodeStateError`：记录/文件系统 | `STATE_SESSION_CORRUPTED` 表示 Session JSON 或基本记录损坏；`STATE_STORAGE_UNAVAILABLE` 表示文件操作不可用；`STATE_STORAGE_UNSAFE_PATH` 表示共享 Work/Chat 存储路径不安全。读取 I/O 失败不作为 JSON 损坏。 |
| `NodeStateError`：schema | `STATE_SCHEMA_UNSAFE_PATH`、`STATE_SCHEMA_BUSY`、`STATE_SCHEMA_RECOVERY_REQUIRED`、`STATE_SCHEMA_MANIFEST_CORRUPTED`、`STATE_SCHEMA_VERSION_INVALID`、`STATE_SCHEMA_VERSION_UNSUPPORTED`、`STATE_SCHEMA_MIGRATION_MISSING`、`STATE_SCHEMA_MIGRATION_FAILED`。已知旧版初始化自动升级；失败码不等于旧数据已丢失。 |
| `NodeChatError`：临时附件 | `CHAT_ATTACHMENT_UNAVAILABLE`、`CHAT_ATTACHMENT_CANCELLED`、`CHAT_ATTACHMENT_PARSER_UNAVAILABLE`、`CHAT_ATTACHMENT_CLEANUP_FAILED`；清理或删除中的未知 I/O 失败采用清理失败码，主动取消保留取消码。 |
| `NodeChatError`：身份与装配 | `CHAT_STATE_ROOT_INVALID`、`CHAT_SESSION_DELETING`、`CHAT_UPLOAD_MODE_MISMATCH`、`CHAT_ATTACHMENT_STORE_REQUIRED`、`CHAT_KNOWLEDGE_UNAVAILABLE`。 |

Session Store、schema 管理器、Chat 路径/附件/装配边界精确识别已声明的类型名称与 code，并重建安全消息；不根据 `CHAT_*` 文本前缀透传异常。附件捕获范围包括锁前初始化、上传前置处理及同步展示投影。`authorizeRef()` 仍以 false 表示授权失败，Core 工具边界仍将附件失败转换为固定的工具错误。

`getNodeStateSchemaDiagnostic(stateRoot)` 返回已完成迁移的版本与备份诊断；`NodeStateError.getRecoveryDiagnostic()` 返回失败恢复事实。两者的备份路径仅供受信宿主使用，不进入 HTTP、SSE 或模型上下文。

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

`createNodeChatCapabilityLoader({ storage, interactiveUi?, visionAnalyzer?, loadKnowledge? })` 返回 Core `chatLoader(binding)`：复查持久化检索模式后，none/web 只装配临时附件；`interactiveUi` 缺省关闭，只有 `true` 且 binding 为 Chat none/web 时返回 `ChatCapability.interactiveUi: true`；rag 才初始化固定知识根，并将 `knowledgeRoot` 与 `knowledgeSpaceId: "chat-knowledge-v1"` 交给受信 canonical 检索适配。`loadKnowledge` 返回 `knowledge/authorizeRef/readImage`，不能改变知识空间 ID。`createNodeCapabilityLoader(...).loadChatWeb(binding: ChatCapabilityBinding | Pick<ChatCapabilityBinding, "retrievalMode">): Promise<WebCapability | undefined>` 在任何 settings/credential 读取前拒绝 none/rag；web 只调用 `loadUser()`，复用既有安全 Search/Fetch。最小调用为 `loader.loadChatWeb({ retrievalMode: "web" })`，仍兼容完整 binding；该受信装配端口不执行 Session 授权，宿主必须由 Core 持久身份控制其调用，不能直接采用浏览器字段。Web Chat Host 默认启用 `interactiveUi`，宿主可用 `capability.interactiveUi: false` 关闭；它同时绑定临时上传解析、生命周期、固定知识根的 canonical 检索及仅在 web 身份调用的 Web loader。搜索配置或凭据缺失时只有受控 Fetch，下一 Turn 重新装配。

`createNodeCapabilityLoader().loadContext(workspaceRoot, query?)` 保留项目指令发现，但旧 Memory 来源未验证，当前不召回任何 Memory；有 query 时返回固定诊断 `LEGACY_MEMORY_REVIEW_REQUIRED`。公开兼容函数 `retrieveNodeMemories(stateRoot, workspaceRoot, query, maxItems?)` 返回空数组，不读取或迁移旧文件。路径辅助函数继续可供用户审阅，不能作为向 Work 注入旧内容的授权。

`createMemoryPorts(workspaceRoot = "/tmp/test-workspace"): RuntimePorts` 每次创建一组隔离的内存 Port，只适用于无持久化的进程内场景，不能替代生产 Node Port；默认沙箱为不可用 Port，进程执行会 fail closed。其 Session Store 的 `get`/`list` 返回深拷贝，`save`/`createIfAbsent` 保存输入深拷贝；修改调用方对象不会隐式写回存储。SessionService 仍保留面向第三方 Store 的兼容隔离与身份校验。

默认入口还导出可单独装配的 `MemorySessionStore`、`MemoryCheckpointStore`、`MemoryTranscriptStore`、`MemoryCredentialStore`、`MemoryProjectStore`、`MemoryEventSink`、`MemoryTurnStore`、`MemoryApprovalStore`、`MemoryInputInbox`、`MemoryJobStore`、`MemoryFileMutationStore`、`MemorySessionResourceStore`、`MemoryUserQuestionStore` 和 `DefaultClock`（均无参构造），以及 `MemoryWorkspaceAdapter(root: string, markers: string[] = [])`。它们实现相应 Port；`DefaultClock.now()` 返回毫秒时间。最小用法为 `const runtime = createAgentRuntime({ ports: createMemoryPorts("/workspace/demo") });`；需要替换一个 Port 时修改该组装对象，再创建 Runtime。

`shutdown()` 存在时，CLI/Desktop 等拥有进程生命周期的宿主必须在正常退出前调用它；它只终止当前 Runtime 启动的活动非 PTY Job，不会重新附着历史进程。

### 执行事实：`runtime.facts`

`facts.read({ sessionId, cursor?, limit })` 从既有 transcript 只读一页；`limit` 为 1—100，返回 `{ items: RuntimeFact[], cursor?, nextCursor? }`。过滤正文事件后 items 可以为空，调用者仍须保存 cursor，并在 nextCursor 存在时续读。Store 游标绑定 Session，失效/非法游标沿 Store 明确报错。仅 durable Session 可重放，不存在或 ephemeral 返回 `FACTS_SESSION_UNAVAILABLE`。

`facts.snapshot({ sessionId })` 返回 `RuntimeFactSnapshot`：协议 1、Session、cursor、`consistency: "overlap"` 和执行摘要（Turn、状态、执行可信度、lastSeq、结果、等待及交互身份/状态）。先读取 transcript 游标再查询既有执行视图，随后从该游标续读允许重复，不能假定跨 Store 原子快照。未知仍为 unconfirmed，Snapshot 不制造历史事件；审批/问题决定以执行视图核对的持久 Store 为准。

`RuntimeFact` 包含 `protocol: 1`、`source: "core"`、eventId、sessionId、turnId、sequence、timestamp、eventType、payload；eventId 为原 `[sessionId, turnId, seq]` 的 JSON 编码，sequence 只在同一 Turn 内排序。生命周期、工具、审批请求、问题和 Inbox 事件沿原名称；payload 只含适用 callId/requestId/approvalId/inputId/status。不带正文、工具名称/输入/输出、checkpoint、凭据或错误原文。`projectRuntimeFact(envelope)` 供受信 EventSink 投影实时提示，非目录事件返回 null；持久续读是恢复依据，回调不构成消费确认。

```ts
const page = await runtime.facts.read({ sessionId, limit: 100 });
const snapshot = await runtime.facts.snapshot({ sessionId });
// 宿主先持久消费 page，再保存对应 cursor；Snapshot 只校准状态。
```

### 2.1.1 会话协作基础：`runtime.threads`

恢复示例：`await boundThreads.resume({ protocolVersion: 1, groupId, requestId, threadId, expectedTurnId })`。受信宿主使用该 API 时必须已有显式恢复授权；模型只能经 `resume_thread` 的逐次审批入口。`read_thread.thread.relativeLink` 提供实际目标入口，`messages[].deliveryReason` 仅投影当前交付的安全阻塞枚举；用户指定子会话执行预览时必须显式向该目标 send，服务/审批/预览归属不能转移到主会话。

`runtime.threads.bind(context)` 只供受信宿主调用；根入口的 `createThreadFacade(ports: RuntimePorts, context: ThreadHostContext): ThreadFacade` 提供相同的独立装配入口（例如 `const threads = createThreadFacade(ports, context)`），沿用同一身份、Trust 和授权要求。`context` 包含 `workspaceId`、由真实状态根确定的不透明 `stateRootId`、`projectId`、可信 `actor`、人类已授权且由宿主收窄的 `allowedTools`、合法 `modelCatalog` 与可选的 `hostOnline`。不得从模型参数或不可信请求直接构造此上下文。`actor` 为 `{ kind: "human", principalId }` 或 `{ kind: "thread", threadId, turnId }`，通信动作要求组内成员与活动 Turn；创建无组范围要求精确的 Session.activeTurnId 与真实 running Turn。宿主仍须先验证 Work Trust；共享板和消息不会形成审批。`hostOnline` 只由宿主按“本进程是否已接管驱动”填写，缺省表示未知，不据此猜测离线。

模型工具的 create/list/read/send/wait/state/progress/interrupt 支持可选 groupId；服务端按本次 Actor 和目标共同授权范围解析，无匹配拒绝、多个匹配要求显式选择，不缓存上次组。已有目标仅由人类 associate 加入，来源不授予权限。

普通 Work Turn 在受信宿主和当前 Project 范围内装配协作工具，不以创建来源或旧组启用决定普通会话能力。首次 create 可在唯一启用组复用，或由可信自身活动 Turn 按需创建新范围；已停用组不自动复活。多个启用组时拒绝歧义。新会话工具不采用协作组的持久目录上限；显式工具限制、Trust 和宿主限制仍有效。`FrozenRunConfig.threadsEnabled` 记录开始时的协作装配，恢复缺失/false 不追加工具，原 capabilityCeiling 继续取交集。 Work 审批/暂停恢复时重新取得受信宿主动态协作能力，保留原先可用的 wait_threads/read_progress/report_progress；主模型仍冻结，权限仅在安全恢复边界采用受信人类修订。当前 Node durable schema 为 8；已知旧根在 Trust 后经 `initializeNodeStateRoot()` 逐级迁移，普通协作查询不迁移或回填。旧游标不自动改写，仍须匹配当前状态根与视图。任务进展保留会话累计 progressSeq，同时新增每 task 单调 taskProgressSeq；task 查询使用独立序号并仅合并同任务/Turn 的相邻普通摘要，容量仍按每 Session 32 条保留，淘汰计数不补正文。任务 pendingProgress 含该任务已淘汰条目，会话累计计数保持原语义。run 当前在 ThreadDelivery pending/blocked 排队，目标空闲后逐条独立 Turn；若存在 inputId，以 durable Inbox consumed.turnId 为准，未消费不视为已执行。


```ts
const threads = runtime.threads.bind({
  workspaceId: "workspace-id", stateRootId: "opaque-state-root-id", projectId: "project-id",
  actor: { kind: "human", principalId: "host-user" },
  allowedTools: ["read_file"], modelCatalog: [],
});
const { group } = await threads.enable({ protocolVersion: 1, requestId: "request-uuid", rootThreadId: "session-id" });
const child = await threads.create({ protocolVersion: 1, groupId: group.groupId, parentThreadId: "session-id", requestId: "create-uuid" });
const receipt = await threads.send({ protocolVersion: 1, groupId: group.groupId, threadId: child.threadId, requestId: "message-uuid", mode: "notify", content: "请查看结果" });
```

| 方法 | 输入及返回 | 限制 |
|---|---|---|
| `capabilities({ protocolVersion: 1 })` | 返回支持的操作、模式与限额 | 描述 Core 当前提供的持久、投递与观察能力；不含宿主在线状态。 |
| `enable({ protocolVersion, requestId, rootThreadId, groupId? })` | `{ protocolVersion, group }` | 仅人类、当前工作区无活动 Turn 的空闲 Work Session，或最近 Turn 与其 checkpoint 均确认成功完成的 Work Session；限额等可恢复状态不允许。不自动吸收已有会话。根会话已有组时复用同一组：启用状态按幂等回执返回，已停用时重新启用并重新校验会话状态与工作区；传入 `groupId` 时必须与根会话实际所属组一致。 |
| `disable({ protocolVersion, requestId, groupId })` | `{ protocolVersion, groupId, enabled: false }` | 仅人类；拒绝后续 create/send/state.update/interrupt，保留成员、历史、回执与未交付项；不停止活动 Turn，需要停止时先显式 interrupt。重复停用幂等。 |
| `groups({ protocolVersion, cursor?, limit? })` / `groupOf({ protocolVersion, threadId, groupId? })` | 组列表（含已停用）/ 单个会话归属或 `group: null` | 仅人类且只返回本工作区管理归属匹配其 principal 的组；归属取 `ownerPrincipalId`，既有人类创建组可取创建者 principal。多组归属须显式 groupId，否则拒绝歧义。投影成员与冻结的 `allowedTools`，不含内部创建者、owner、回执、意图或交付记录。 |
| `create({ protocolVersion, groupId, requestId, parentThreadId, title?, roleLabel?, modelRef?, reasoningEffort? })` | `{ protocolVersion, threadId, groupId, parentThreadId, relativeLink }` | Thread ID 即 Session ID；模型必须在宿主目录；复用普通 Session 创建规则；普通能力与 permissionMode 按同条件 Runtime/Project/Session 配置解析，不复制创建者一次性批准。创建不启动 Turn。可信 creationSource 记录真实 human/thread actor 与 requestId，collaborationCreationId 仅用于幂等和碰撞保护，二者不可改写。 |
| `associate({ protocolVersion, groupId, threadId, requestId })` | `{ groupId, threadId }` | 仅受信人类 owner 显式关联当前 stateRoot Store 中的同 workspace/Project 普通 Work Session；使用 Session 锁、CAS 和幂等请求，不启动 Turn，不复制来源或权限。thread actor 禁止调用。 |
| `list({ protocolVersion, groupId, cursor?, limit? })` | 成员 `items` 和可选 `nextCursor` | 只列授权组，默认 20、最大 100。 |
| `read({ protocolVersion, groupId, threadId, cursor?, limit? })` | 会话安全摘要、最近助手展示消息 `latestMessages`、`history` 和可选游标 | history 含事件类型与助手 `answer_delta` 文本；不返回工具参数/结果、批准或 checkpoint。`answer_reset` / `answer_discard` 保留为事件类型供客户端处理。 |
| `send({ protocolVersion, groupId, threadId, requestId, mode?, content, replyTo?, expectedTurnId? })` | `{ messageId, mode, expectedTurnId?, taskId?, deliverySeq, deliveryStatus, hostOffline? }` | 省略mode仅允许可信thread actor向组内parentThreadId为自身的孩子发送：running默认steer并捕获精确activeTurn，idle/completed/failed默认run，其他等待/需恢复状态拒绝；人类和其他关系仍须显式mode，不扩大组授权。首次持久意图冻结解析决策，原省略请求重试不随目标终态/换轮重选；省略与显式mode属于不同幂等摘要。显式steer必须给正确expectedTurnId，显式run忙时仍排队，handoff必须显式run。run返回taskId=messageId；接受不代表已消费或成功。hostOffline只在实际run且宿主明确离线时出现。 |
| `tasks({ protocolVersion, groupId, threadId })` | `{ items }` | 只读该组中真实 thread actor 从指定发起会话发送的最近20条run任务；每项只含taskId、目标标题/ID、交付和对应真实Turn状态，不取目标Session latest，不把人类消息冒充某会话派工。用于任务活动条，不启动执行。 |
| `messages({ protocolVersion, groupId, threadId, cursor?, limit? })` / `messageStatus({ protocolVersion, groupId, threadId, messageId })` | 消息页（含当前位置 `cursor`） / 单条交付状态、可选 `inputId`、`turnId`、`inputState` 与 `execution` | 按目标序号分页；inputState只来自已交付消息精确匹配messageId/clientMessageId、inputId和turnId的持久Inbox记录，结构为{inputId, turnId, status}；status=consumed才表示消费，pending/blocked/未提交消息不投影消费证据。execution只投影真实Turn，不与消费或任务成功混淆。 |
| `interrupt({ protocolVersion, groupId, requestId, threadId, expectedTurnId })` | `{ accepted, controlId, hostOffline }` | `hostOffline` 仅在受信宿主明确离线时为 true，无活动执行 lease 不证明宿主离线。只持久化给实际 owner 的中断意图；接受不代表已停止，实际结束仍以 Turn 状态为准。等待审批/用户输入的会话即使 activeTurnId 为空也可接受，但 expected Turn 必须属于目标、为当前最近 Turn，且与 Session/当前 checkpoint 的等待身份和状态一致；owner消费迟到意图时再次核对，之后由 `turns.cancel` 在既有lease内重读并收尾为 `interrupted`；需恢复会话仍不在此路径。 |
| `resume({ protocolVersion, groupId, requestId, threadId, expectedTurnId })` | `{ accepted: true, controlId, recoveryAction? }` | 共同组授权内精确恢复 interrupted/limit checkpoint 的原 Turn，当前 Session/最近 Turn/checkpoint 必须一致；不生成消息、Inbox 或新任务。同一暂停 checkpoint 去重，旧 Turn/组外目标拒绝，等待审批或回答不能越过。Runner 先 CAS 一次领取，再走原 `turns.continue` 和 FrozenRunConfig；accepted 不是已启动。领取后无法确认执行时 `recoveryAction: "open_target_continue"`，进入目标 Web Continue 或 CLI `/resume`，不自动重放副作用。 |
| `wait({ protocolVersion, groupId, targets, timeoutMs, signal? })` | `{ results: [{ threadId, taskId?, reason, cursor, pendingProgress, summary }], timedOut }` | targets 可携带 taskId；任务视图仅查询对应 run 的 delivery/真实 Turn，不采用 Session latest；省略 taskId 是显式会话观察。游标绑定 taskId，不能跨任务或混用会话视图。只观察：不启动、不恢复、不取消目标。`reason` 为 `snapshot` / `changed` / `progress` / `attention` / `terminal` / `timeout` / `aborted`：只有新摘要时记 `progress`，需关注/终态优先于进展，本次未变化的目标记 `snapshot`。`pendingProgress` 是自给定游标以来新写入的摘要条数（含已被淘汰条目），只给计数不带正文。1–8 个不同目标，`timeoutMs` 0–30000，超时或取消只结束本次等待；取消立即返回，不必等下一轮复读。游标按目标独立绑定工作区、状态根、组与视图；先订阅再复读，存储不支持订阅时按 150 毫秒有界复读兜底。 |
| `readState({ protocolVersion, groupId })` / `updateState({ protocolVersion, groupId, requestId, expectedRevision, operations })` | 显式板及 revision / 新 revision | CAS 冲突拒绝；不自动注入上下文。调用方不得放入凭据、审批、checkpoint 或宿主绝对路径；校验不保证识别所有秘密。 |
| `reportProgress({ protocolVersion, groupId, requestId, kind, summary, evidence? })` | `{ progressSeq, taskId, taskProgressSeq }` | 仅 `actor.kind === "thread"`：从当前真实 Turn 与 run 投递/消费事实派生唯一 taskId，普通后续 Turn 或多任务歧义拒绝，不继承最近任务。目标固定为 actor 所属会话，模型不能自报来源。`kind` 取 `progress` / `milestone` / `blocked` / `completed` / `failed`；`summary` 非空且 ≤ 2048 字节，超限拒绝不截断。`evidence` 只接受当前报告 Turn 或本任务 run messageId。completed/failed 摘要是模型自报；执行终态仍由对应 Turn 决定。写入不触发执行，也不产生投递。 |
| `readProgress({ protocolVersion, groupId, threadId, taskId?, cursor?, limit?, kinds? })` | `{ items, cursor, compacted, nextCursor? }` | 按目标进展序号差量读取；连续 `progress` 合并为一条（`summary` 取最新、`mergedCount` 记条数），其余类别逐条保留。`kinds` 过滤后仍推进游标；`compacted` 只报告游标之前被容量淘汰的普通进度条数。不启动、不恢复、不确认已读，也不返回会话历史。 |
| `events({ protocolVersion, groupId, cursor?, limit? })` | 安全事件、当前位置 `cursor` 及可选下一页游标 | 协作事件使用独立 groupSeq；缺失记录返回需恢复，读取不补写或启动。 |

组停用后仍可读取：`read` / `list` / `messages` / `messageStatus` / `readState` / `events` 继续可用并照旧校验工作区、Project、成员与人类归属；`wait` 与所有写入返回 `THREAD_SCOPE_DENIED`。事件新增 `group_enabled` / `group_disabled` 两种 kind，客户端对未知 kind 安全忽略。

每个命令均要求协议版本 1。消息正文最多 32 KiB，共享板最多 64 KiB、深度 8；进展摘要单条最多 2048 字节、每目标保留 32 条（超出时只淘汰最旧 `progress`，关键类别不丢不并）、单页 1–50 条（默认 20）；组控制聚合最多 4 MiB；新工作准入将每个未完成创建或消息意图按 16 KiB 计入预留，控制数据与预留之和不超过 3 MiB，另留 1 MiB 余量。请求幂等域为工作区、可信 actor、操作及 requestId，同键同内容重试返回原身份，不同组或内容冲突。写入异常可能留下持久意图；原请求可重试完成记账，不能据此声称外部副作用 exactly-once。读/消息/事件游标绑定状态根身份、工作区、组、视图和格式；不可用或损坏时明确报错。`ThreadServiceError.code` 使用 `THREAD_*` 或 `INVALID_INPUT` / `MODEL_NOT_FOUND`；不向外透传底层路径。`RuntimePorts.threadStore` 是必需项，含 `listGroups()` 供宿主发现目标，以及可选 `subscribe(groupId, listener)` 只做本进程唤醒（不是事实来源，判定仍以复读快照为准）。受管成员 Session 删除返回 `THREAD_HAS_PENDING_WORK`，不级联删除子会话。

Turn 装配侧按会话收窄：当前工作区启用组成员可使用协作工具；宿主提供可信 `humanPrincipalId` 时，同 Project 的普通 Work 新 `start` 也可注册工具，在首次 `create_thread` 时才按需建立根组。Chat 永不注册；非成员 `continue` 与孤立协作子 Session 不获得根组自举权限。组归属读取失败不会阻断普通 Turn，实际协作调用仍对损坏或越权状态明确拒绝。

该 Facade 不含模型调用、Agent 工具与 Web/CLI 路由；`run` 是否真正执行取决于是否有在线宿主 Runner 领取，持久回执不能推断为已执行。

新委派目标在首次创建intent中冻结发起Session当前已选permissionMode偏好，缺省回退精确发起Turn（人类入口仅当前activeTurn）的frozen值，再回退Project偏好；只复制该受控模式，不复制具体批准、Trust、文件授权、凭据、预算或Job。重试使用原intent和Session，显式目标defaultRunConfig及历史冻结Turn不追改；未增加模型可选的权限提升参数，旧intent缺字段兼容。组目录的title投影以当前Session.title为准，普通工具目标摘要优先可读标题，缺失时用安全占位，精确ID仍保留机器协议/路由与明确控制详情。

### 2.1.2 宿主投递与执行：`createThreadDeliveryService` / `createNodeThreadRunner`

显式 handoff 的 `ThreadMessage` 同时持久化 `handoffDisplay { title, instruction, summary }` 供受信宿主构造展示；`content` 仍是完整模型输入，`handoff` 保留文档引用。该快照在发送时生成，不从正文解析，也不改变请求幂等身份。

`createThreadDeliveryService(ports, ports.threadStore, context)` 由受信宿主调用，`context` 为 `{ workspaceId, stateRootId, ownerId, executionHost? }`。它只处理已持久化的交付事实，不读取模型参数、不接受自报来源。

`ThreadHostContext` 与 `ThreadsCapability` 可由受信装配提供 `executionHost` 稳定档位。CLI 使用 `cli-work-v1`，Web 使用 `web-work-v1`。启用组、模型建组、关联、嵌套创建和投递保留目标档位。已存在有效档位优先，查看或跨端发送不会覆盖。旧缺省目标由真实 Turn 对应的本工作区领取 owner、创建意图或原 Turn 冻结的 Web 专属能力证明后，经组 CAS 补齐成员与缺省投递。具名宿主拒绝未知档位或冲突投递，旧未具名宿主仅兼容未具名记录。直接 `turns.start/continue` 同样校验成员归属，继续还校验原冻结 Web 能力。人类提交决定和只读历史保持原权限规则。`ownerId` 仍表示具体进程，补齐不改变领取、lease 或原 Turn。旧进程需要重启加载该检查。

人类 Facade 提供 `bindExecutionHost({ protocolVersion: 1, groupId, threadId, expectedRevision, executionHost })`，返回 `{ protocolVersion: 1, groupId, threadId, executionHost }`。`executionHost` 仅接受 `cli-work-v1 | web-work-v1`。通过 `list` 或 `groupOf` 的安全 `revision` 取得 CAS 版本，`list.items` 保留可选 `executionHost`。组授权人类可对尚无执行事实的歧义旧目标精确确认，也可对原执行权威completed、无活跃owner/claim的缺省目标选择新Turn档位，版本过期或已知档位冲突返回 `THREAD_STATE_CONFLICT`，活动执行/领取、等待/中断、结果未确认及其他无法证明兼容性的旧执行事实返回 `THREAD_RECOVERY_REQUIRED`。模型 actor 返回 `THREAD_SCOPE_DENIED`，无模型工具绑定此方法。最小调用示例为 `const snapshot = await threads.list({ protocolVersion: 1, groupId }); await threads.bindExecutionHost({ protocolVersion: 1, groupId, threadId, expectedRevision: snapshot.revision, executionHost: "cli-work-v1" });`。

| 方法 | 输入及返回 | 说明 |
|---|---|---|
| `listGroups()` / `readGroup(groupId)` | 组标识 / 组控制快照或 `null` | 供宿主发现目标；不跨工作区。 |
| `claimDeliveries({ activeThreads, limit?, snapshot? })` | 可启动的 `{ groupId, message, delivery }[]` | 只领取 `run`；同一目标仅一条在途领取。本宿主驱动的活动 Turn 上的 `steer`/`notify` 直接幂等桥接到 Inbox（`clientMessageId = messageId`），`notify` 在目标空闲时不进入触发执行的队列。 |
| `heartbeat({ groupId, messageId })` | `boolean` | 只续租本 owner 的领取；非本 owner 不写存储。 |
| `completeDelivery({ groupId, messageId, turnId })` / `failDelivery({ groupId, messageId, reason })` / `releaseDelivery({ groupId, messageId })` | `void` | 按真实 Turn 回填、明确失败或退回 pending；退回仅用于未启动任何 Turn 的领取。 |
| `reconcile({ staleMs?, activeMessageIds?, snapshot? })` | `{ requeued, delivered, recoveryRequired, observing }` | 只有心跳失联且不在本宿主活动集合中的领取才收敛；已有 Turn 回填、无 Turn 或输入未被消费退回、运行中且有有效执行 lease 只观察、无法判定副作用标 `recovery_required`。 |
| `pendingInterrupts()` / `settleInterrupt({ groupId, controlId, applied })` | 待执行中断意图 / `void` | 实际取消只能由持有 Turn 的 owner 执行；`applied` 仅表示该 owner 已发出取消。 |
| `recordHostOffline(groupId)` | `void` | 停机时留下可解释事件，不清空待处理消息。 |

`createNodeThreadRunner({ delivery, runtime, ports, pollIntervalMs?, heartbeatMs?, staleMs?, reconcileEveryMs?, onError? })` 在宿主进程内消费 `turns.start` 的完整异步流，不另建模型循环，也不调用审批入口。`stop()` 停止新领取、取消本 owner 的 Turn、退回未启动的领取并返回 `{ stopped, cancelledTurnIds, unconfirmedTurnIds, releasedMessageIds }`；取消后仍为 `running` 的 Turn 计入未确认项。`heartbeatMs` 缺省取 `staleMs` 的三分之一上限 5 秒，避免 Turn 冷启动窗口被误判失联。Runner 不接管其他 owner、不跨工作区、不保证任意外部副作用 exactly-once。

`querySnapshot()` 为受信宿主取得当前工作区已启用组的控制副本；`pendingInterrupts(snapshot?)`、`pendingResumes(snapshot?)`、`pendingInteractionContinuations(snapshot?)`、`claimDeliveries` 与 `reconcile` 可共享本 tick 的候选快照。快照不授权写入：领取、宿主兼容性和控制更新仍实时读取并 CAS；本 tick 后新增候选由下一 tick 发现。Runner 活动轮默认 250ms，空闲按轮递增至 2s；本进程 kick 立即唤醒且执行中的 kick 不丢失，外部变更依靠下一轮持久扫描发现（间隔加当前查询耗时），不靠无限缓存。Node 控制副本缓存最多 128 项 / 8MiB，每次读取仍校验路径与文件签名。

`InputInbox` 输入新增可选 `origin`（`{ kind: "human", principalId? }` 或 `{ kind: "thread", threadId, turnId? }`）：由受信宿主填写，Kernel 注入时以“来自协作会话”标注呈现，仍走 user 载体但不产生人类批准。同一 `clientMessageId` 重投时正文或来源不同会抛 `INBOX_INPUT_CONFLICT`，不得覆盖已投递内容。

旧缺省目标的completed绑定在原Session短锁内使用既有lease acquire/release保护，组revision CAS仍是领取/绑定竞争的提交边界。最新Turn、checkpoint、终态投影必须共同确认同一completed身份，Session为idle/completed且无activeTurnId，checkpoint无pendingCalls/pendingUserQuestion，控制无claimed/executing。新鲜owner阻止绑定。已知档位冲突继续拒绝，模型actor不具备入口。此动作只选择之后新Turn的执行宿主，原Turn、冻结配置、答案/决定及结果保留。Work start在取得lease后再次校验档位，准备期间迟到的旧Runtime无法越过人类绑定，拒绝时释放lease且不创建伪Turn。

### 2.1.3 Agent 协作工具：`create_thread` 等 11 个内置工具

受信 Work 宿主在 `createAgentRuntime({ defaultRunConfig: { threads } })` 注入 `ThreadsCapability`（`{ workspaceId, stateRootId, projectId, allowedTools, modelCatalog, executionHost?, humanPrincipalId?, allowRootGroupBootstrap?, onThreadCreated?, handoff? }`；`humanPrincipalId` 是根组的人类管理 owner，`onThreadCreated` 是子会话创建后的进程内唤醒回调，`handoff` 是宿主注入的交接写入 Port。能力只存在于进程内，不写入 `FrozenRunConfig`、Session 或公开 DTO）。`createThreadsToolBinding`只在受信executionHost为web-work-v1时派生可选presentationHost=web供模型协作展示指引使用，缺省宿主的指引保持原契约。Turn 层 `runConfig` 不能注入或替换它。Runtime 在每个 Work Turn 用当前 `sessionId`/`turnId` 绑定 `{ kind: "thread", threadId, turnId }` 作为 actor；Chat 即使收到该能力也不注册工具。缺少绑定能力的 Work Turn 与现有产品一致，不出现协作工具。

仅普通 Work 新 `start` 可为同 Project、无组且不是协作子 Session 的根会话临时注册首次建组所需工具；`continue`、Chat 与协作子 Session 不获得根组自举权限。`list_threads` 在当前 Turn 无组时返回空列表，不写存储；首次 `create_thread` 校验精确活动 Session/Turn 后按需建立根组，再创建子会话。组保留真实 `ThreadActor` 作为创建来源，并把 `humanPrincipalId` 单独记为管理 owner；停用组不会被静默复活。成功创建后只调用进程内 `onThreadCreated`，不替代 `run` 投递或启动目标 Turn。

| 工具 | 输入（敏感身份字段不可由模型提供） | 行为与返回 |
|---|---|---|
| `create_thread` | `title?`、`roleLabel?`、`modelRef?`、`reasoningEffort?` | 在当前组内创建 Work Session，返回 `threadId / parentThreadId / groupId / relativeLink`；创建不启动推理。父会话与组来自绑定，模型不能指定。 |
| `list_threads` | `cursor?`、`limit?` | 只列当前组成员；默认 20、最大 100。 |
| `read_thread` | `threadId`、`cursor?`、`limit?` | 返回会话摘要、最近 Turn、`latestMessages`、`messages` 页与 `history`；messages.deliveryStatus来自交付事实。已交付且消息/输入/Turn身份精确一致时，inputState返回持久Inbox的{inputId, turnId, status}；只有status=consumed才可报告已消费，delivered、pending、blocked或缺失证据均不能推断消费。不启动、不恢复、不确认已读。 |
| `send_thread` | `threadId`、`mode?`、`content`、`replyTo?`、`expectedTurnId?`、`handoff?: { title, markdown }` | 返回 `{ accepted: true, executionStatus: "unconfirmed", consumptionStatus: "unconfirmed", messageId, mode, expectedTurnId?, taskId?, deliverySeq, deliveryStatus, handoffRef? }`；仅给本会话创建的孩子可省略mode：运行中默认steer并捕获精确Turn，空闲默认run，审批/用户输入等待拒绝。显式run忙时仍排队；显式steer须正确expectedTurnId；交接必须显式run。首个持久意图冻结mode/expectedTurnId；接受不表示消费或执行完成。 |
| `wait_threads` | `targets[]`、`timeoutMs` | 只观察 1–8 个目标，`timeoutMs` 0–30000；返回 `results[].reason`（snapshot/changed/progress/attention/terminal/timeout/aborted）、`pendingProgress` 计数与每目标游标。只有新摘要时返回 `progress`，父会话据此用 `read_progress` 读差量；等待结果不含摘要正文。不启动、不恢复、不取消目标。 |
| `read_shared_state` | 无（省略 arguments 按空对象处理） | 返回共享板 `value / revision / updatedAt / updatedBy`；不自动注入其他会话上下文。 |
| `update_shared_state` | `expectedRevision`、`operations[]`（set/remove） | CAS 更新，冲突返回 `THREAD_STATE_CONFLICT`；不自动合并，也不启动会话。 |
| `report_progress` | `kind`、`summary`（≤600 字符，服务层另限 2048 字节）、`evidence?: { turnId?, messageId? }` | 为当前真实 run 任务写入进展，来源固定为当前会话和 Turn；无唯一任务归属时拒绝。返回 `{ progressSeq, taskId, taskProgressSeq }`。`progress` 是可合并、可在容量压力下淘汰的普通进度，`milestone/blocked/completed/failed` 逐条保留。不启动、不恢复会话，也不代替 `send_thread` 的显式通信。 |
| `read_progress` | `threadId`、`taskId?`、`cursor?`、`limit?`、`kinds?` | 只返回有界摘要页，不含子会话历史、工具调用或原始输出；连续普通进度已合并（`mergedCount` 记条数），`compacted` 说明游标之前被淘汰的普通进度条数。游标只能原样回传同一目标，重复回传不重复返回。需要消息或历史时改用 `read_thread`。 |
| `interrupt_thread` | `threadId`、`expectedTurnId` | 返回 `{ accepted, controlId, hostOffline }`；只持久化给实际 owner，接受不代表已停止，实际结束以 Turn 状态为准；审批/用户输入等待的目标同样可以中断，收尾由持有执行的宿主完成。 |
| `resume_thread` | `groupId?`、`threadId`、`expectedTurnId` | 所有权限模式均需要本次 `allow_once/deny` 人类确认；审批约束冻结目标 checkpoint，不能跨到后来一次暂停。返回 `{ accepted, controlId, recoveryAction? }`；只恢复原轮，不把 `run` 变为恢复。重复请求不积压任务，等待审批/回答仍在目标处理。 |

工具事实与权限：读类工具 `effect: "none"`、`risk: "read_only"`；普通协作状态变更沿用组授权。`send_thread` 携带 handoff 时属于工作区文件写入，受既有写入能力上限、Skill、只读沙箱、宿主保护域与统一审批策略约束；组授权不代替文件写权限。`ThreadService` 每次调用重新校验组成员、工作区、Project 与目标成员；已接受的交接重试沿用原快照，不因文件变化或缺失而改写消息。所有协作工具均接受可选 `groupId`，仅用于选择已有授权组；父会话、`requestId` 与 actor 由绑定提供：`requestId` 由稳定 `toolCallId` 派生（`sha256([toolName, callId])`），因此同一调用重试不会重复创建会话或投递消息；模型不能自报可信身份。

`attention`仅表示需要关注，不能等同审批。等待summary的可选`attentionKind`为`approval | user_input | continuation_failed | continuation_pending | execution_unconfirmed | execution_lost | interaction_unconfirmed`，仍由现有execution/waiting/interaction事实派生；只有waiting=approval且interactionState=pending才提示审批。系统协作提示与工具定义遵守相同约定，未知或失联不能引导Ctrl+A审批或主动恢复。`unconfirmedReason`只含`snapshot_changed | checkpoint_missing | lease_mismatch | turn_summary_lag | boundary_unconfirmed`，不导出私有lease/路径/正文。

持续观察的timeout也同步快照与游标；新游标、pendingProgress或真实终态仍沿原模型观察责任处理，先读进展再交模型，不能只推进等待游标而吞掉进展。无新事实的timeout不记录重复工具结果、不重采样、不重复投递约定。读取执行视图时，仅同Turn、同lease/owner且前后仍running、safeBoundarySeq单调前进允许作为同执行代次；前后owner身份继续复核，暂停/回退/换执行代次仍重读，两次无法一致返回snapshot_changed，不强改running。

`wait_threads` 不声明工具级超时：等待自身的 `timeoutMs` 是唯一超时来源，到点返回 `timedOut: true` 的观察结果，不会退化成工具 `EXECUTION_TIMEOUT` 终态；父 Turn 取消仍会结束本次等待。

`wait_threads` 携带精确 `taskId` 且 `timeoutMs > 0` 的实际等待，默认保留当前Turn的任务观察责任；无需另传跟随标志。`timeoutMs: 0` 仅查询即时快照，不新建观察责任，显式 `followUntilTerminal: true` 可在快照时建立责任，此时每个目标必须带精确 `taskId`。成功观察后当前Kernel以私有兼容checkpoint字段保留任务/等待游标/独立进度游标；模型可根据已有canonical成功run/wait回执确认身份，再通过上述实际等待或显式字段建立观察；Core不根据用户话术自动恢复责任。普通派工、未带taskId的会话观察与未显式跟随的即时快照不自动承担该责任。阶段正文不会completed：未终态时继续只读wait，timeout无新事实不重新采样；Runtime以兼容事件`thread_wait`报告结构化等待事实（`phase: waiting | processing | none`、`pending/running/approvals`为0..8安全整数且运行加审批不超过未完成数），不含目标身份/正文/审批参数，仅阶段或数量变化时发布。`waiting`表示当前观察已暂停采样，`processing`表示有新事实交回父任务，`none`清理旧等待；新Turn、独立工具执行和终态同样清理CLI等待展示。未知/排队/待回答不计为running；新的关注代次、真实状态或进展唤醒后再交回模型。取消、插话和既有时长/token预算保持有效，完成后没有额外调度器。相同已读attention会阻塞；关注代次来自冻结pending call/request身份摘要，不只比较waiting_approval字符串。

持续观察的pendingProgress通过既有read_progress按独立游标消费，不搬目标历史。目标成功Todo真实列表转换自动用report_progress发布有界累计阶段事实，真正进入审批/问答发布blocked；记录仍受当前task/组权限约束，Todo自报完成不等于执行终态。语义阶段、最终结论仍可由模型主动report_progress补充。用户插话会唤醒当前等待并交模型理解；模型用followUntilTerminal=false、timeoutMs=0撤销给定精确task观察，用可选reportingInstructions（1–1024字）明确更新任意汇报约定。Core不识别关键词或固定汇报模式，只按字段更新并将有界文本原样加来源标注后向仍运行的精确目标Turn投递steer，暂停时保留待投递，失败返回工具事实。模型默认不得自行增加中途静默；实际自然语言语义和报告文字仍由模型承担，未保证任意表述的主体识别。


组解析：每次调用按可信 actor、显式可选 `groupId` 与本次目标重新解析共同授权范围，不缓存上次组。无匹配时拒绝（无组的 `list_threads` 返回空列表），多组歧义要求显式选择；读类操作可读取已停用组，写入与等待仍须启用。组停用或成员变化立即参与下一次校验。协作错误码原样进入工具错误；未知存储异常统一返回 `THREADS_UNAVAILABLE` / `TOOL_EXECUTION_FAILED`，不透传路径或原始异常正文。

协作工具可用时，Runtime 同时向模型注入一段协作使用约定（`agent-runtime.ts` 的 `getThreadWorkflowInstructions`）：派工把汇报要求写进任务正文、普通进度与 `milestone/blocked/completed/failed` 的区别、两种游标分开维护且进度读取不退回 `read_thread`；`reason=attention` 表示目标正等待审批或用户回答，是暂停而非结束，除用户要求介入外应继续等待至 `terminal`，不提前收尾也不替目标提交审批。该约定只在注册协作工具的 Work Turn 出现，Chat 与未绑定能力的 Work 不注入；它只是使用说明，不改变上面任何工具语义，也不设固定汇报档位。

普通新 Work Turn 不以组持久目录限制工具，实际目录仍受当前受信宿主、显式能力上限与 Skill 限制。新子会话冻结并复制发起会话已选权限偏好，缺省回退精确发起 Turn、再回退 Project；不固定为 `ask`，也不复制一次性批准、Trust 或具体授权。旧有显式协作能力上限仍取交集。展示层只消费 `ToolDisplayFacts`（`titleKey: tool.thread.read.completed | tool.thread.write.completed`、不透明 `target`、动作摘要），不展示消息全文、共享板原始 JSON、审批内容或宿主路径。

#### 内部汇报约定与普通协作输入
- `ToolExecutionOptions.reportingAgreement?: {taskId: string; explicit: boolean}` 是 Kernel 发起内部 send_thread 时的受信执行元数据，经过原 Executor 验证/Policy 后仅交给该工具；不在模型 Schema 内，不能由工具参数生成。`AgentThreadsCapability.send` 可由该受信路径携带同名字段，绑定层复用 ThreadService.send；公开 ThreadFacade.send 拒绝 reportingAgreement/purpose。
- ThreadService 在原组 CAS/messageIntents 中按来源会话、目标 task 和最新有效约定去重，task 必须映射精确 expectedTurnId。相同约定复用原 message/request/delivery 身份；未提交意图失败后沿原身份重试。内容真实变更（包括改回曾用内容）产生新意图；默认约定沿用已有值，跨父 Turn 不无故覆盖。Kernel 仅在成功接受后清 agreementPending，重复 wait 与 checkpoint 恢复不重设同值 pending。
- 可选 `ThreadMessage.purpose = {kind: "reporting_agreement", taskId}` 沿原桥接投影为 `InboxOrigin` thread 分支的可选 `purpose: "reporting_agreement"`；旧记录缺省兼容，不升级 schema。内部约定以有明确来源的上下文进入模型，不作为人类写入需求重置写入意图/工具护栏；input_joined/input_consumed 与原投递审计保留。
- 普通用户需求沿原 send 身份幂等，两个不同来源请求即使正文完全相同也分别接受、投递；不做全局文本去重/限流，不新增提醒调度器。

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

Job 启动、停止与恢复契约：`StartJobInput.signal?: AbortSignal` 只约束启动交付，交付前取消会清理半启动进程，成功返回后 Turn 取消不再停止 Job。`StartJobInput.sandbox` 为必填判别联合：沙箱形态 `{ execution?: "sandboxed", port: SandboxPort, policy: SandboxPolicy }`，宿主执行形态 `{ execution: "host", policy: SandboxPolicy }`（无 port，用于 Windows 停用进程沙箱的装配），必须携带 ToolExecutor 已解析确认的冻结执行范围；缺失时 `start` 以 `SANDBOX_UNAVAILABLE` fail-closed 拒绝，不创建 Job 记录、不启动进程。沙箱形态的启动顺序固定为受信命令解析（`resolveManagedCommand`，Windows npm/npx/pnpm 固定受信 CLI 与 realpath containment）→ `SandboxPort.prepare` → spawn，prepare 抛出的 `SandboxPortError`（稳定 `SANDBOX_*` 码）原样透出；宿主形态复用同一受信命令解析后直接 spawn，不经 `prepare`，子进程即目标本身。沙箱执行资源与 Job 终态绑定：spawn 失败与真实终态（进程 close 后终态化，含 kill/shutdown 路径）都幂等 `release(executionId)`，不依赖存储写入成功。scoped get/read/stop 先验证记录归属，再执行 owner 恢复；poll 与 get 使用同一恢复逻辑。沙箱形态停止必须获得私有执行能力的 `container_empty` 证据和包装 close，taskkill 成功本身不能认证容器为空，缺能力、超时或失败保持 stopping；宿主形态不使用控制协议，停止以 `terminateManagedProcessTree` 加 close 观察为实际证据。持久摘要 `Job.sandbox` 在宿主形态标记 `execution: "host"`（digest 仍为冻结范围的真实计算），`JobExecutionFacts.phase` 相应使用 `host_running` / `host_spawn_failed`。

`JobListView.totalCount?: number` 与 `activeCount?: number` 为当前绑定 Session 全量计数，不受本页 limit 影响；活动包括 starting/running/stopping。安全输出的 stdout/stderr cursor 使用独立代次，不能互换。超长敏感记录丢弃至该记录换行；启动环境中敏感键对应的已知值纳入脱敏，不向宿主返回这些值。

| 方法 | 签名 | 说明 |
|---|---|---|
| `start` | `(input: StartJobInput) => Promise<Job>` | 启动已由 ToolExecutor/PolicyEngine 授权且已确认执行方式（沙箱或宿主执行）的非 shell、非 PTY Job。公共宿主不得借此绕过工具执行门；`sandbox` 缺失即 `SANDBOX_UNAVAILABLE`。 |
| `poll` | `(input: PollJobInput) => Promise<JobPollResult>` | 按 stdout/stderr byte cursor 返回增量受限输出，并给出下一 cursor 与保留窗口起点。 |
| `readOutput` | `({ id, stdoutCursor?, stderrCursor? }) => Promise<JobOutputView>` | 返回 Core 清理和脱敏后的双流安全窗口；cursor 与 `poll` 的 raw byte cursor 完全独立。 |
| `write` | `({ id, data }) => Promise<void>` | 向活动 Job 写入受限 stdin；关闭后不能重开。 |
| `kill` | `(id) => Promise<Job>` | 仅停止当前 Runtime 持有句柄的 Job；先进入 `stopping`，平台停止命令和目标 `close` 均确认后才返回 `stopped`。终态重复调用幂等。 |
| `list` / `get` | `(workspaceId) => Promise<Job[]>` / `(id) => Promise<Job \| null>` | 读取 durable Job 元数据。 |
| `forSession` | `({ workspaceId, sessionId }) => SessionJobService` | 创建已绑定当前 Work Session 的安全管理视图；新 Agent/宿主必须使用该入口，不把底层 `Job` 私有字段作为 DTO。 |

Job 绑定 workspace 与 Session，不支持 PTY、detach 或跨进程重新附着。新记录固定 `jobRecordVersion:2`，带私有 owner `{runtimeInstanceId, hostProcessId}`、从 0 单调增长的 `revision` 和终态 `finishedAt`。新记录随存安全沙箱摘要 `Job.sandbox`（类型可用 `NonNullable<Job["sandbox"]>` 引用）（`{ mode, policyDigest, policyVersion, execution?: "host" }`，与 `FrozenRunConfig` 同源摘要算法；`execution` 缺省视为沙箱，`"host"` 表示宿主直接执行且摘要仍是真实计算的冻结范围）：只含模式与冻结 policy 摘要，不含代理 env、完整 deny 路径明细、沙箱执行句柄或命令派生敏感数据；旧 v2 记录缺省该字段不参与恢复判定。只有原 Runtime 的内存句柄是可停止的正证据；其他存活 owner 返回 `JOB_OWNER_UNAVAILABLE`，无法确认或旧无 owner 记录返回 `JOB_OWNER_UNKNOWN`。只有 owner 明确死亡时，Core 才用 owner+revision 条件写恢复为 `interrupted`；PID 存活本身不证明 Runtime 身份。

默认入口还导出常量 `JOB_RECORD_VERSION`，当前值为 `2`，表示 durable Job 记录格式版本；宿主不应把它当作运行中的 Job 状态。

服务地址辅助函数均为纯解析，不探测监听或授予预览权限：

| API | 签名 | 契约与示例 |
|---|---|---|
| `normalizeJobServiceUrl` | `(value: string) => string \| undefined` | 仅接受 loopback HTTP(S) 根 origin，无 userinfo/query/fragment；补全实际端口。例：`normalizeJobServiceUrl("http://localhost")` 返回 `"http://localhost:80"`，非法值为 `undefined`。 |
| `jobServicePort` | `(serviceUrl: string) => number \| undefined` | 复用相同校验，返回有效端口；`jobServicePort("http://127.0.0.1:3000")` 为 `3000`。 |
| `sameServiceOrigin` | `(left: string, right: string) => boolean` | 协议、端口必须一致；localhost/127.0.0.1/IPv6 回环互为别名。例：`sameServiceOrigin("http://localhost:3000", "http://127.0.0.1:3000")` 为 `true`。 |

Job 启动登记与 Session 删除共用 Session 锁。`starting/running/stopping` 以及 owner 不明的旧活动记录都会以 `SESSION_HAS_ACTIVE_JOBS` 阻断删除。spawn 成功事件到达后才进入 `running`；spawn 失败或 spawn 后首次状态转换保存失败会清理半启动进程并留下失败记录。输出变化最多每秒合并保存一次，终态强制 flush。Windows 后台 `npm/npx` 由 Core 解析为当前 Node 安装旁的固定 CLI JS，并继续使用 `shell:false`；记录与 Policy 仍使用调用方原始的逻辑 program/argv。

`SessionJobService` 在每次操作前复查 Session 是带 Project 归属的 Work，且 Project 的 canonical `workspaceRoot` 与绑定 `workspaceId` 一致。跨 Session/Workspace 的 Job ID 统一按当前范围不存在处理。其方法为：

| 方法 | 输入 | 返回与约束 |
|---|---|---|
| `list` | `{ limit?: 1..100, pageCursor? }` | 默认 20；活动优先，终态按 `finishedAt` 倒序；返回 `JobListView` 与只能原样回传的进程内签名 cursor。 |
| `read` | `{ jobId, stdoutCursor?, stderrCursor?, waitMs?: 0..30000, signal? }` | 返回 `JobReadView`；单次 stdout/stderr 各最多 8 KiB，`waitOutcome` 明确为 `snapshot/terminal/timeout`，取消只结束等待。 |
| `stop` | `{ jobId, source: "agent" \| "host" }` | 仅原 Runtime 内存句柄可停止；真实终态后返回 `JobView`，并记录不含命令/PID 的 `lastControl`。 |
| `verifyServiceOwnership` | `{ jobId, serviceUrl }` | 复核声明地址仍由该 Job 的进程树监听：`owned` = 声明地址与记录一致、Job 活动且由本 Runtime 拥有、端口当前监听者属于该 Job 进程树；`unowned` = 任一环不成立；`unverifiable` = 当前平台/工具无法证明。核验用只读命令（Windows netstat + PowerShell CIM，macOS/Linux lsof/ss + ps），失败不退化为按端口放行。 |

`JobView` 只含 `jobId/status/controlState/canStop/revision`、时间、退出/失败码、有限输出计数、`lastControl`、可选 `execution` 与可选 `serviceUrl`；不含 program、args、cwd、owner 或 PID。`controlState` 为 `owned | foreign_owner | owner_unknown | terminal`。`start_background_job` 在审批前与 JobService 共用纯 `serviceUrl` origin 校验（不启动命令、不探测网络）。常驻服务使用受管 Job，超时后先核对事实，不能盲重试。`start_background_job` 可选声明 `serviceUrl`（仅 loopback http/https origin）：宿主在启动前检查声明端口未被占用，占用即拒绝启动（`INVALID_INPUT`）；声明只作为预览归属目标，不授予任何权限，监听归属仍以 `verifyServiceOwnership` 为准。Agent 工具只在 Work 注册：`start_background_job` 成功结果为安全 `{ jobId, status, startedAt, sandbox: { mode } }`，另有 `list_background_jobs`、`read_background_job` 和 `stop_background_job`。stop 只接受精确 jobId，在当前 Session 归属且 Runtime 持有句柄或已终态时免额外操作审批，不复用 grant；Skill、产品能力与执行期归属检查仍生效。read 的工具超时为 35 秒，给最大 30 秒等待保留收尾预算。

`execution` 为安全执行事实：`phase` 仅为 `wrapper_spawn_failed | wrapper_running | wrapper_exit | target_spawn_error_reported | host_spawn_failed | host_running`，`targetState` 为 `unknown | not_started`，可选 `signal/win32Code`。沙箱形态的 `running` 仅说明包装进程成功 spawn，不证明目标 ready；宿主形态没有包装进程，`host_running` 表示目标子进程本身已 spawn。stderr 固定签名只能形成 `target_spawn_error_reported` 提示，不能认证目标启动、改变审批或停止确认；目标状态保持 unknown。原始 stderr 通过既有有限安全输出读取，关闭信号和包装退出码独立保留；旧记录可无 execution。

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

`FileMutation`、`PrepareFileMutationInput`、`UndoTransaction` 与 `FileMutationStore` 是默认入口导出的 Adapter 契约，用于实现私有 WAL/blob/journal；普通宿主不得直接创建 mutation、读取 blob 或绕过 `runtime.undo`。生产 Port 必须提供持久化实现；`createMemoryPorts()` 内置的 `MemoryFileMutationStore` 只用于无持久化的进程内场景。

具备 mutation store 的 `write_file` 和 `edit_file` 在替换文件前先持久化 `prepared` 记录及前后字节的 SHA，并在替换后读取原始字节核验结果。工具异常仍向调用方报告失败，能确认落盘字节等于预期时记录 `applied`，其他可收敛结果记为 `failed`。遗留的 `prepared` 记录在 Undo 服务读取时根据实际 SHA 收敛。上述步骤只记录写入事实，工具失败或 Turn 失败均不触发文件回退。

文件恢复由宿主经 `runtime.undo` 发起。宿主先获取 preview，再取得用户确认并调用 `execute({ sessionId, confirmed: true })`。模型工具集不暴露此能力。Undo 自身使用独立事务日志和 staging，部分执行失败或重启后按事务与实际字节尝试补偿，回到该次 Undo 开始前的状态。

`FileMutationStore.withWorkspaceLock(workspaceRoot, operation, canonicalTargets?)` 在 workspace 临界区内，对传入的 canonical 绝对目标去重并按固定顺序取锁；生产实现必须让同一 OS 用户、不同 workspace/stateRoot 的同目标共享锁域。write/edit 与 Undo/recovery 传入实际目标，取得锁后重验身份与 SHA。Node 使用 OS 用户 home 下固定 `.autopilot/file-mutation-locks`，不从 HOME/TEMP 或各 workspace 配置选锁域；活 owner 不因锁年龄被抢占，等待超时不进入临界区。Memory 实现仅保证同进程实例互斥。

#### 写后验证可恢复边界

`write_file` / `edit_file` 在有 WAL 和无 mutation store 的 headless 路径都读取实际落盘原始字节并核对预期 hash，只有校验成功才返回 `diskVerified: true` 并满足物理写入完成条件；保存/落盘/校验失败不返回伪成功。模型仍需按任务复杂度审阅差异、按需读回和执行定向验证；物理确认不能替代业务或运行正确性。

默认完成策略依据真实 changedPaths/verifiedPaths，兼容旧 checkpoint 的未验证路径；一次有限提醒仍未读回时以 interrupted_recoverable/write_verification 暂停，不强制完成。Continue 保留原 Turn、canonical messages、真实写入与 completedCallIds；该恢复段仅暴露/允许 read_file 与最终总结，Skill 限制仍取交集。回读绑定固定版本并累计本次验证段已返回的完整行范围，写前观察范围不能充作写后验证，任意一行不能验证整个文件；旧缺版本快照由首次真实读回固定版本。版本失配不会标记已验证。私有 `verificationTargets` 与 `mutationGate.verificationOnly` 随安全批次 checkpoint 保留，拒绝重复写入不会走 completed 捷径。其他 failed 仍不可 Continue，不改旧 failed 记录或真实文件。

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
| `listDirectoryPage` | `({ projectId, cursor?, limit }) => Promise<SessionDirectoryPage>` | 只返回`items: {id,title?}[]`与`nextCursor?`，limit为1–100。只调用Store可选轻量能力，不支持时明确拒绝，不回退完整list。Node/Memory按稳定ID seek，每页最多扫描limit条记录，Project过滤可返回空页但仍有下一游标；游标绑定Project，Node还绑定状态根/产品域。 |
| `get` | `(id: string) => Promise<Session \| null>` | 不存在时抛 `SESSION_NOT_FOUND`。 |
| `save` | `(session: Session) => Promise<void>` | 只保存既有 Session；更新 `updatedAt`，拒绝修改产品、检索模式及已有 Project 归属。 |
| `setDefaultRunConfig` | `(id, runConfig) => Promise<Session>` | 写入 Session 级默认配置。 |
| `rename` | `(id, title) => Promise<Session>` | 标题会 `trim`；空值或超过 200 字符抛 `SESSION_TITLE_INVALID`。 |
| `delete` | `(id) => Promise<boolean>` | 协作组仍引用该 Session 时先抛 `THREAD_HAS_PENDING_WORK`；存在 `running` / `waiting_approval` / `waiting_user_input` Turn 时抛 `TURN_ALREADY_RUNNING`，活动 Job 抛 `SESSION_HAS_ACTIVE_JOBS`。通过检查后，先清理宿主资源，再清理 lease、inbox、approval、checkpoint、transcript、Turn、Job、mutation、用户问题及 Session；不存在返回 `false`。 |

`SessionStore.getDirectoryEntry?(id)`返回轻量身份/标题/活动事实，不包含presentation或checkpoint；Node以固定分片流式校验JSON并跳过消息，不解析或保留正文，允许扫描结构字节而不承诺零正文磁盘读取。目录不会初始化/迁移/写入状态，损坏结构、缺少产品身份与ID不匹配仍拒绝。Thread成员标题优先复用此能力，未实现该可选能力的外部Store保持既有get兼容路径；CLI本地目录不走重型fallback。没有新增durable schema版本。

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

受信宿主可额外传 `managedExecution: { hostId, requestId, threadPolicy: "disabled" }` 创建普通受管 Work Session。hostId/requestId 为 1—128 位字母、数字、下划线或连字符；禁止同时传 id、Chat 或 ephemeral。Core 对 `[hostId, requestId]` 求 SHA-256 作为稳定 Session ID，并在既有 Session 锁内幂等创建；重复请求复用原身份，不更新标题/默认配置，显式 Project 冲突拒绝。该字段不是浏览器/模型 DTO，不授予 Run 归属或派工资格。`save` 与 Node Store 均拒绝改变/移除受管身份；start/continue 按持久身份关闭 Thread 工具，Thread 服务同时拒绝受管 actor、enable root 与 associate 目标。切换视图、人工接管或新 Runtime 不解除限制；独立自由 Session 保持原能力。此兼容字段不提升 durable schema。

```ts
const managed = await runtime.sessions.create({
  managedExecution: { hostId: "desktop-host", requestId: "create-worker-1", threadPolicy: "disabled" },
});
```

Node 受管宿主可调用 `withNodeRuntimeOwner<T>(stateRoot, operation: () => Promise<T>): Promise<T>`（从 `@autopilot-agent/adapters` 导入），在整个 operation 期间持有既有跨进程文件锁。stateRoot 只由受信 bootstrap 提供；已存活或无法确认退出的 PID 不回收，竞争超时明确失败，operation 结束释放。不等于 Checkout 写资源锁，也不授予恢复旧执行的权限。例如 `await withNodeRuntimeOwner(stateRoot, async function serve() { await stopped; });`；`stopped` 应只在宿主停止且执行清理结束后完成。

兼容既有 Work 调用方时，省略 `productMode` 默认写入 `work`；同时缺少 `projectId` 时，仅通过注入的 WorkspaceAdapter 解析当前工作区并复用/创建其 Project，不读取 cwd 猜测工作区。当前格式记录缺少产品模式时，Core 与 Node Store 均拒绝；已知旧格式只能在 Trust 后的状态根初始化中迁移，不在普通读取期间落盘迁移；非法字段组合抛 `SESSION_MODE_MISMATCH`，错误工作区 Project 抛 `WORKSPACE_REQUIRED`。`save()` 修改合法 Chat 检索模式抛 `CHAT_RETRIEVAL_MODE_LOCKED`，修改产品/归属或移除已写模式抛 `SESSION_MODE_MISMATCH`。创建和查询返回副本，不能通过对象别名修改 Store 中的身份。新 Work Session 由 Core 写入只读 `workContextVersion: 1`，调用方不能通过 `save()` 给旧记录补写或移除此来源版本。

`RuntimePorts.sessionResourceStore` 是默认入口导出的 `SessionResourceStore` 契约：宿主实现 `deleteBySession(sessionId)`，用来清理生命周期只属于该 Session 的外围资源。它必须幂等，且清理失败会中止删除，避免 Core 状态已删除而宿主附件遗留。Web 图片附件等资源必须通过该 Port 清理；CLI、Web 与 Desktop 不得各自绕过 `runtime.sessions.delete()`。

Work 图片能力通过可选 `RuntimePorts.sessionImageStore` 读取当前工作区和 Session 内的规范化图片；缺失时图片读取失败。Node 宿主提供 `put` / `read`，读时复核身份及 SHA-256。`normalizeWorkImage` 接受最多 20 MiB、4000 万像素的 PNG/JPEG/WebP/GIF，发送副本宽高各不超过 2000、最多 3,932,160 字节和 5,242,880 个 Base64 字符；GIF 使用静态首帧。单条图片最多 10 张且副本合计最多 20 MiB。canonical / checkpoint 使用 ID、哈希与尺寸引用，采样时按冻结模型能力读取字节；受信目录将 DeepSeek v4 flash 与 `firstParty/deepseek-flash` 精确别名声明为图片输入，未知模型不推断支持。不支持图片时通过既有 `vision_analyze` 权限和审批链回退。

`normalizeWorkImage({ bytes, mimeType?, signal? })` 返回 `Promise<{ bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; width: number; height: number; gifFirstFrame: boolean }>`；例如 `const normalized = await normalizeWorkImage({ bytes: uploadedBytes, signal });`。它检查魔数/尺寸并按需缩放或转码，非法输入、取消或无法满足发送上限时拒绝；不负责 Session 授权、存储或稳定 Runtime 错误码映射。`SessionImageStore.put({ sessionId, name, mimeType?, bytes })` 返回 `SessionImageRef`，`read({ sessionId, id })` 返回 `{ image: SessionImageRef, bytes: Uint8Array }`；宿主每次读写仍须验证归属与 hash。

每次原生采样的图片 Base64 总量最多 28 MiB，其中工具图片最多 6 MiB，按实际 wire 出现次数计费。工具图片从最新结果向前保留，超出预算的旧图在请求中替换为明确省略提示；私有历史引用和附件文件不删除。用户上传图不因工具预算被省略；用户图总量超限时返回 `IMAGE_REQUEST_BUDGET_EXCEEDED` 并保留失败 checkpoint，提示压缩历史或减少图片。字节预算在编码前检查，属于本地资源保护值，不代替 Provider 自身限制。视觉回退每次仅读取下一个未完成图片，已成功分析的历史图不重复读取。

Work MCP 的标准 `content[].type="image"` 在工具序列化前交给同一 Session 的 `sessionImageStore.put` 规范化。每次结果最多接收十张、原始字节总计 20 MiB；缺少存储、坏图、超限均产生图片未提供说明，不把 Base64 写入工具正文、事件或 checkpoint。MCP `tools/call` 接收行硬上限为 28 MiB，其他响应仍受 60,000 字节限制；图片分流后的模型可见正文独立限制为 60,000 字节。图片引用只由本地工具投影生成，远端同名字段不能授予读取权限；既有 Trust、server grant、工具审批与 Session 清理保持原边界。

### 2.6 Turn 服务：`runtime.turns`

`getExecutionState({ sessionId, turnId?, signal? })` 与受信宿主辅助函数 `readTurnExecutionView(ports, input)` 共用只读安全投影，不调用 recoverStale、创建目录或恢复执行。身份绑定实际 Turn；同 Turn 继续用既有 leaseId/ownerId 与 per-Turn seq 区分执行段，读取后复核 checkpoint/owner/latest Turn，不能取得一致快照时返回 unconfirmed。当前实现通过原 TranscriptStore.readPage 冷读并增量追尾，保留当前 Turn 执行段的最小边界摘要，不以 UI 正文分页决定交互可见性。

投影分别提供 execution（active/inactive/unconfirmed/lost）、waiting（approval/user_input/threads）、result（completed/failed/interrupted/limit_reached）与 interaction.state（pending/decided/expired/unconfirmed）。active表示执行器持有匹配的新鲜所有权，不证明模型采样进度；心跳过期是lost，绝不表示成功。只有明确checkpoint/终态事件提供result，idle、Todo、进度、tokens或delivered均不能证明完成。可选 `LeaseStore.readCurrent(sessionId)` 只读当前所有权；旧Port未实现时运行状态降为待确认。

暂停/终态安全事件已写 transcript 后、EventSink/公开生成器消费前，执行协调器提交匹配checkpoint与Session/Turn摘要，停止心跳并释放原执行段。摘要失败明确向调用方抛出且独立尝试两份写入；已提交checkpoint保留有效请求，warning=summary_lag明确提示摘要滞后。旧流finally不重写已提交边界，不删除后继AbortController或释放不同owner。Runner已有Turn的流错误仍通知onError，delivered只确认运输结束，wait仍依据同一Core事实，未知状态返回attention。

pending请求引用脱敏原approval_required信封；已有决定显示decided，过期显示expired，不再作为可提交卡。恢复视图的execution/interactionState/warning共用此投影；decided保留精确approvalId供正常continue复用已有决定。提交仍由Core核对当前执行段、Session/Turn/approval/call、受支持内建工具的冻结归一参数、允许范围、TTL与已有决定；显示不授予执行权限。

#### 执行观察的增量读取与取消

`readTurnExecutionView(ports, { sessionId, turnId?, signal? })` 与 `runtime.turns.getExecutionState` 接受受信进程内可选 AbortSignal。取消在各异步边界阻止后续读取与结果返回，分页返回后先检查取消再提交派生摘要。该参数只用于宿主调用。

投影按原 Store 实例、Session、Turn 与字节游标保留当前执行段的 started、审批、终态及 thread_wait 边界，最多8个Session，每项最多1024条、2MiB。替换边界事件按实际保留字节计费。提交核对读取起点仍为当前摘要，迟到旧查询不会覆盖新的游标或执行段。lease、checkpoint代次、决定及control继续实时核对。游标过期只重建一次，旧超大/损坏事件沿getEvents原审计兼容规则回读，异常路径不缓存该摘要。

Node Transcript分页使用原16KiB读取块中的多条完整行，游标保留文件身份并增加可选size/stamp，接受旧游标。替换、截断及同尺寸时间戳变化使新游标过期。getEvents保持相邻同字节信封去重与损坏行诊断，返回数据保持调用方隔离。追加索引同样核对文件身份与同尺寸变化。

Node Checkpoint最新与历史Turn读取逐行异步审计完整JSONL，只保留目标最后记录，每条解析后让出事件循环。最新/历史副本共用8项、8MiB上限，写入清除该Session缓存，读取每次核对纳秒文件身份，返回独立副本。损坏行继续诊断且文件原样保留，底层流打开/中途错误会拒绝、关闭迭代器与流，并由原文件锁finally释放。Node Thread control解析副本另受8项、8MiB限制，实时文件身份变化/异常使缓存失效，CAS与外部更新仍以durable记录为准。

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
- 新 Turn 的会话基线取该 Session 最近一个可安全重建的终态 Turn（`completed`、`failed` 或 `interrupted`）。身份一致且消息可迁移时，保留失败或中断轮的原请求及已闭合工具结果。中断轮尾部未闭合调用在新轮历史中以 `TOOL_OUTCOME_UNKNOWN` 配对，旧 checkpoint 保留原样。无法安全重建时回退到更早记录。
- 新 Turn 冻结解析后的运行配置；模型、推理、凭据、权限及执行预算优先级为单次 Turn > Session > Project > Runtime 默认值。`workspaceRoot`、`compactPolicy` 与数据库策略只在 Turn / Runtime 层解析；Trust、沙箱与宿主能力另受可信来源限制。
- 新 Turn 已写入但凭据/模型装配在首个 checkpoint 前失败时，保留原异常码（如 `MISSING_CREDENTIAL`），同时将 Turn 和 Session 收尾为 failed 并释放租约；不伪造执行事件。修复凭据后可以启动新 Turn，不会将新输入误判为仍在运行任务的 steer。
- `workspaceTrusted` 只能由 Bootstrap 在 Trust 成功后注入 Runtime 默认配置，不能由 Project、Session 或本次 Turn 伪造。
- `continuity` 不是浏览器 DTO：只有已成功 `claimNext()` 并将输入标为 consumed 的宿主可传 `{ source: "claimed_queue" }`。它令新 Turn 继承上一任务链 Todo；普通新 Turn 创建独立任务链，不会读取旧 Todo。
- `start` 会先恢复 stale checkpoint，并拒绝仍持有新鲜 running checkpoint 或 Session lease 的并发执行（`TURN_ALREADY_RUNNING`）；创建前后还会核验 Work 历史来源与执行档位。当前实现不单凭 Session 的 `waiting_approval` / `waiting_user_input` 状态拒绝 `start`。宿主必须把已有暂停请求交给原 Turn 的审批/回答与 `continue` 流程，不能把 `start` 当作恢复入口。运行中输入用 `steer`；后续任务经 `queue` 排队，再由宿主 `claimNext()` → `consume()` → `start({ continuity: { source: "claimed_queue" } })`。`continuity` 仅声明任务链连续性，Core 不根据该标志自行领取或校验 Inbox。宿主负责将输入绑定到实际新 Turn，并在启动失败时收尾已领取输入。

#### `continue(input)`、`cancel(input)` 与状态查询

`turns.cancelLocalExecution?({ sessionId, turnId })` 仅abort当前Runtime真实持有的controller并返回boolean，不改写Session/Turn/checkpoint。调用先验证Turn属于该Session，远端或已无执行体返回false；true仅代表已发出本地取消，停止完成仍须权威checkpoint与终态确认。原 `cancel` 调用契约保留。

`continue({ sessionId, turnId })`对过期审批可重新签发原pending call的审批：仅当该精确Turn的权威恢复视图无有效approval身份时，由TurnService派生内部仅重签状态，复用原FrozenRunConfig、输入schema、Policy和约束；即使full_access或已有grant也只交付新待审批，不执行工具。有效当前审批缺决定时仍暂停，旧ID/错ID不能变成批准；新卡产生后重复Continue不生成额外任务。内部标记不属于HTTP/模型输入或durable schema。

`cancel({ sessionId, turnId })` 在任何 abort 或状态修改前验证 Turn 属于该 Session，错归属以 `TURN_NOT_FOUND` 拒绝。等待态取消复用 start/continue 的 Session lease，在持有期间重读目标 Turn、最近 Turn、Session 和当前 checkpoint 的同一等待身份；不一致以 `TURN_FROZEN_MISMATCH` 拒绝，租约始终释放。running 保留原本进程 controller 的 abort 语义，不以旧等待 Turn 改写新轮。


| 方法 | 签名 | 说明 |
|---|---|---|
| `continue` | `(input: ContinueTurnInput) => AsyncIterable<AgentEvent>` | 仅从 `awaiting_approval`、`awaiting_user_input`、`interrupted(_recoverable)` 或 `limit_reached` checkpoint 继续；completed/failed/running 会返回 `TURN_NOT_RESUMABLE` 或 `TURN_ALREADY_RUNNING`。它忽略传入的 `runConfig`，强制复用该 Turn 的冻结配置；回答暂停时必须携带已提交答案所属的 `requestId`。 |
| `cancel` | `(input: CancelTurnInput) => Promise<void>` | 请求取消指定活动 Turn；运行中、等待审批与等待用户回答的 Turn 均收尾为 `interrupted`（等待态没有活动执行体，收尾即取消），Session 与对应 `awaiting_*` checkpoint 一并置为 `interrupted`。 |
| `getState` | `({ sessionId, turnId? }) => Promise<TurnState>` | 返回 Turn、安全 checkpoint 摘要和脱敏事件；省略 `turnId` 时返回整个 Session transcript，指定时只返回目标 Turn。checkpoint 只含 `turnId/status/stepCount`、空的 `messages/completedCallIds`、可选 Skill 身份及 Session 输入去重所需的 `consumedInputIds`；canonical 消息和调用事实只由 Core 私有存储用于恢复。 |
| `getRecoverableState` | `({ sessionId, turnId? }) => Promise<RecoverableTurnView \| null>` | 返回最小恢复视图；`recoverable` 由 Core 确认，`termination` 仅含白名单原因和可选预算数值，适合 UI 与 CLI。 |
| `getFrozenRunConfig` | `({ sessionId, turnId? }) => Promise<FrozenRunConfigView \| null>` | 返回脱敏后的冻结模型与推理配置。 |
| `getContextUsage` | `({ sessionId, turnId? }) => Promise<ContextUsageView \| null>` | 只读返回最新私有 checkpoint 的安全 Context Usage 快照：冻结模型窗口、三态总量（`measured`/`projected`/`estimated`）、固定分类 breakdown、free/compact buffer/over-limit。无 checkpoint、`turnId` 不匹配或 DTO 任一不变量非法时 fail closed 为 `null`；`null` 表示当前没有可展示事实，宿主不得显示 0% 或猜测窗口。只接受 `sessionId`/`turnId`，不接受 messages/tools 等计算输入；宿主不得读取私有 `usageAnchor` 或自行重算。Live 更新走 `context_usage_updated` 事件（同值去重，`usage: null` 仅表示明确清空旧状态），刷新与重启恢复走本查询；两者消费同一份安全快照。 |
| `getTurnUsageSummary` | `({ sessionId, turnId? }) => Promise<TurnUsageSummaryView \| null>` | 只读返回最新私有 checkpoint 的 Turn 累计用量汇总：`totalTokens` 累计输入+输出（与安全预算 `runtimeBudget.totalTokens` 同源）、`elapsedMs` 当前执行段耗时（以最近一次安全边界刷新的 checkpoint 为准，终态后不再增长），完整分项时另含 `inputTokens`/`outputTokens`。供应商对本Turn全部已计输出均提供合法推理子项时，可选返回 `reasoningTokens`；它已包含在 `outputTokens` 中，不重复相加。缺失或部分覆盖不补造推理总量，旧checkpoint继续兼容。分项只在与 `totalTokens` 求和一致时整对提供；旧 checkpoint 缺分项、分项不完整或任一数值非法时降级为只含总量与耗时，无 checkpoint / `turnId` 不匹配时返回 `null`。数字全部来自 Kernel 同一采样累计点，宿主不得读取私有 `runtimeBudget` 或自行重算。Live 更新随 `context_usage_updated` 事件附带 `turnUsage`（同一安全边界、同一去重；旧 transcript 事件缺省该字段表示无新事实，宿主保留已有展示）；刷新与历史恢复走本查询。输入量按协议归一化：Anthropic Messages 把 `input_tokens` 与独立的缓存读/写桶相加，Chat Completions 的缓存命中字段已是 `prompt_tokens` 的子集不再相加，因此每个 token 只计一次、缓存命中部分包含在 `inputTokens` 内；这是 token 用量口径，不是计费金额。 |
| `getUsageSnapshot` | `({ sessionId, turnId? }) => Promise<{ contextUsage: ContextUsageView \| null; turnUsage: TurnUsageSummaryView \| null }>` | 只读一次最新私有 checkpoint，复用上述两个白名单投影并返回同一时点的事实；无 checkpoint 或 `turnId` 不匹配时两项均为 `null`，各投影继续沿用自身非法值失败规则。不触发恢复、执行或持久化，不接受计算输入、不暴露私有 checkpoint。状态栏同时需要两项时使用此方法；单项查询继续兼容。例：`const { contextUsage, turnUsage } = await runtime.turns.getUsageSnapshot({ sessionId });` |

```ts
for await (const event of runtime.turns.continue({
  sessionId: session.id,
  turnId: "turn-001",
  approval: { approvalId: "approval-001", decision: "allow" },
})) {
  // 继续消费事件
}
```

#### 已保存交互的持久继续交接

`runtime.turns.requestInteractionContinuation?({ sessionId, turnId, approvalId?, requestId? }): Promise<{ queued: boolean; controlId?: string }>` 仅供受信人类宿主调用。必须先通过原 approvals/questions 服务保存决定或答案，再携带其中一个精确请求身份。Core 从 Runtime 默认 threads capability 的 humanPrincipalId 和目标 Session 解析唯一启用组，校验工作区、成员、原 Turn 与当前暂停请求。有可用协作范围时通过原 Thread control CAS 持久接受并返回 queued=true/controlId。缺少人类协作能力或启用组时返回 queued=false，调用方继续原本机恢复流程。权限或边界不符会拒绝。

```ts
const handoff = await runtime.turns.requestInteractionContinuation?.({
  sessionId, turnId, requestId,
});
if (!handoff?.queued) {
  for await (const event of runtime.turns.continue({ sessionId, turnId, requestId })) {
    renderEvent(event);
  }
}
```

现有 controls 增加 kind=continue_interaction，状态依次为 pending、claimed、executing、completed，失败为 failed。claimed 表示兼容 Runner 领取，executing 以原 Turn 的首个 turn_started 确认。completed 只表示交接运输收敛，执行结果仍由原 Turn 的后续事件确认。失败码限定 BOUNDARY_CHANGED 与 CONTINUE_FAILED。同请求入口复用 controlId，failed 仅在原身份和暂停边界仍有效时允许重排。原 resume 控制继续沿 interrupted 契约。

pauseSeq 绑定原暂停事件位置，checkpointDigest 对交互控制只冻结 Turn/status/pendingCalls/pendingUserQuestion/completedCallIds。心跳和预算元数据变化允许兼容恢复。新 lease 的 safeBoundarySeq=0 且尚无后续 turn_started 时可安全重领，有新执行事件但结果未确认时保留原决定并拒绝自动重放。旧缺 pauseSeq 的控制沿原完整摘要规则读取。Node codec 校验新控制身份、状态、时间、owner、摘要及固定失败码，schema 仍为 8，原容量预算保持。

最新 Turn 在首个 checkpoint 前失败时，只有 Turn 和 Session 都已落失败状态、无活动 Turn 和租约，执行视图才投影为 inactive/failed。其余缺少 checkpoint 的情形保持待核查。

安全执行视图增加 executionHost 与顶层 continuation（controlId/state/requestId?/approvalId?/failureCode?）。 continuation 可选 failureDiagnostic 仅含封闭 stage=read_decision/continue/after_started、category=storage/runtime/os/unknown、白名单code、started及可选filePhase。started=false只表示Runner未观察到启动事件，不能单独作为未执行证明；精确目标身份仍在原控制意图，未知码归一CONTINUE_UNKNOWN，原始异常/命令/路径/凭据不持久化。sanitizeContinuationFailure()是相同白名单的安全投影。interaction.decision仅为approved/denied，不复制原决定正文。顶层可覆盖首事件前没有有效 interaction 的窗口，当前请求匹配时同时投影 interaction.continuation。后续新请求不会采用旧控制。interaction.question 为经 Core 规范化校验的 { requestId, questions }，不包含答案正文。Chat 安全视图保持独立于 Work Thread Store。

已保存交互的失败重试复用原controlId与决定，仍须原暂停checkpoint摘要一致；pauseSeq缺失、已观察启动或原边界后存在turn_started时拒绝重放。wait_threads摘要带interactionState、continuationState、interactionDecision，关注游标随交互/恢复状态变化；Kernel仅把interactionState=pending计入待审批，不修改真实暂停checkpoint。

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

`CompactTurnInput` 要求 `sessionId`、`turnId`、`trigger: "auto" | "manual" | "proactive" | "reactive"`，可带 `preserveRecentTurns`、`targetTokens`、`signal`；兼容 `messages?` 可覆盖 checkpoint 消息，仅可信迁移宿主使用。正常手动入口为 `await runtime.turns.compact({ sessionId, turnId, trigger: "manual" })`。返回 `CompactTurnResult` 另含 `summary/messages/preTokens/postTokens/preservedFromIndex`；其中消息属于受信宿主调用结果，不可直接当浏览器 DTO。

注意，当前 DeepSeek 与 OpenAI/GPT 均使用应用侧管理的摘要压缩，摘要由当前 Turn 冻结的 Provider 采样器生成；远程 Provider 仍会进行远程模型调用。当前尚未适配 OpenAI 原生云压缩（`/responses/compact` 或 `context_management`），Responses 协议同样使用该摘要流程。

摘要调用通常复用主对话原 system、实际工具定义与 canonical 消息前缀，在尾部追加摘要任务；摘要采样产生工具调用时直接失败，绝不执行。当前采样工具定义仅存于私有 checkpoint，旧数据缺失时按当前受信配置重建。受信模型窗口不足时，只能裁去压缩后本就原样保留的最近尾部；摘要请求必须仍覆盖全部待摘要旧历史，按本地估算同时核算图片、工具 schema、摘要任务与输出预留。最小完整前缀仍超窗口则采样前明确失败，保留原投影。图片沿用宿主身份/hash和请求图片预算；无图片输入能力时仅发送明确未观察的引用占位。压缩后历史重建会自然转冷，不能保证消除所有冷请求。

`compact` 与内部 `run()` 的关系：Runtime 在收到 `CONTEXT_OVERFLOW` 时会执行**一次** reactive compact，然后以新的 running checkpoint 重新调用内部 `run()`（同一 `turnId`、保留 `completedCallIds` 与 Todo）。第二次溢出或 compact 失败会发出 `context_compact_circuit_open` 并以 `turn_failed` 失败关闭，不会重放已完成的工具调用。

压缩机制的完整性描述——**五位一体设计**：80% 阈值预算器、采样前安全点自动压（`auto`）、换窗口主动压（`proactive`）、供应商溢出被动压（`reactive`，带熔断）与手动压（`manual`，带运行守卫）。五条触发路径共用同一压缩引擎（按普通 user 回合分组、尾部保留、canonical 切点安全校验、摘要后组装，收尾校验 `postTokens ≤ targetTokens`），区别只在触发时机、消息来源与守卫条件：

| 触发路径 | 触发时机 | 行为与守卫 |
|---|---|---|
| `auto`：80% 阈值预算器 + 采样前安全点 | 每次 `before_sample` 安全点采样前，预算器判定达线 | Kernel 原地替换消息、作废 usageAnchor、写 running checkpoint 并发 `context_compacted`；未配置上下文窗口的 provider 不启用此路径 |
| `proactive`：换窗口主动压 | Turn 启动时上一 Turn 上下文窗口 > 当前 Turn 上下文窗口 | 先压缩一次再执行本 Turn；失败发 `context_compact_failed` 并以 `turn_failed` 关闭 |
| `reactive`：供应商溢出被动压（带熔断） | Provider 报 `CONTEXT_OVERFLOW` | 压缩后以新 running checkpoint 重跑内部 `run()` 一次；仍溢出或压缩失败发 `context_compact_circuit_open` 并以 `turn_failed` 失败关闭 |
| `manual`：宿主调用 `turns.compact()`（带运行守卫） | 宿主显式触发 | 消息来源是 durable checkpoint 而非内存投影；Turn 在本进程运行中，或 checkpoint 被其他 Runtime 的新鲜 lease 持有且本进程非 owner 时拒绝（`TURN_ALREADY_RUNNING`）；成功后写回 checkpoint 并显式丢弃旧 usageAnchor（旧锚点对新消息序列无效） |

`auto` 路径的阈值预算器按比例推导，不依赖魔法数字：**触发线 = min(窗口 × 0.80, 窗口 − 输出预留 − 安全 buffer)**。输出预留取冻结 `sampleOptions.maxTokens`：优先用户输出上限并受已解析模型能力上限约束，缺省使用该能力的 `maxOutputTokens`，未知/旧能力才回退8,192；旧冻结快照亦可由 `maxOutputTokens` 提供预留。Chat/Responses请求默认期限为600,000ms，显式timeoutMs保持优先；Anthropic继续使用原SDK期限与thinking/effort语义。安全 buffer 取 max(8,192, 窗口 × 2%)，两条约束取更严者。provider 配置可显式指定 `compactThresholdTokens`，但最终触发线只取显式值与派生值的较小者，不会放宽派生约束。保留策略由 `RunConfig.compactPolicy`（`CompactPolicy { preserveRecentTurns, targetTokens }`）控制，未显式冻结 policy 时默认保留最近 4 个回合、target 70,400 token。

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

`allow_session` 与 `allow_workspace` 只可由 `approvals.submit()` 建立；宿主不得自行写入授权存储。`ask` 下普通工作区命令仅在精确 `cmd:v2` 约束时可接受 `allow_workspace`；Windows 宿主执行、危险/外部副作用保护和无精确约束的调用只接受 `allow_once` / `deny`，以冻结的 `allowedDecisions` 为准。任务文件集合审批（`constraint: "task-files:v1"`）与外部文件集合审批（`constraint: "task-ext-files:v1"`）的 `allow_once` 语义均为"批准本任务文件集合"：`submit()` 保存 `scope: "allow_session"` 且带 `turnId` / `taskFiles` 的集合 grant，`PersistentGrant` 因此新增可选 `turnId` 与 `taskFiles` 字段；该类 grant 不进入普通 `hasPersistentGrant` 命中路径，仅由 write/edit 的成员检查消费——工作区集合按工作区相对路径精确匹配（`path:` 约束），外部集合按 canonical 绝对路径经 comparable 归一精确匹配（`ext-file:` 约束），均绑定声明操作，不含父目录或递归语义；两类集合 grant 互相独立，工作区集合批准不自动放行外部目标。

`inboxOriginKey(origin?: InboxOrigin): string` 是纯来源比较键，不做授权：缺省或 human 返回 `"human"`；thread 返回包含 `threadId`、可选 `turnId/purpose` 的 JSON 编码。例：`inboxOriginKey({ kind: "human", principalId: "user" }) === "human"`。只有可信宿主可填写 `InboxOrigin`，不能从该键恢复人类身份或审批。

外部 `allow_workspace` 的 local 投影失败时，`submit()` 返回 `projection: "pending"`，该持久 grant 不生效。Node 投影 add/remove 在文件锁内严格读取现有配置：只有不存在可视为空；JSON 损坏、顶层非对象或不可读均保留原字节并拒绝，诊断为 `EXTERNAL_RULE_SETTINGS_INVALID` / `EXTERNAL_RULE_SETTINGS_UNREADABLE`（不安全链接为 `EXTERNAL_RULE_TARGET_UNSAFE`）。撤销先删除 grant，投影删除失败返回 `{ deleted: true, ruleRemoved: false }`，不重建权威。

`ask_user_question` 是按宿主 capability 注册的交互 Tool，不是审批或命令入口。它仅在显式启用 `enableUserQuestions` 的 Work 宿主可见（当前 Web 与 Desktop 受管 AP 已启用，Chat 不注册）：模型请求后 Turn 进入 `awaiting_user_input`，答案经 `questions.submit()` 持久化，再由同一 Turn 的 `continue({ requestId })` 读取。普通 CLI 默认不向模型注册新问题工具；必要澄清由普通助手正文完成并正常结束当前 Turn，下一条 prompt 依靠同 Session 的 canonical history 继续。CLI 仍可依据安全执行视图显示并回答历史暂停问题；提交后通过持久交接交由兼容原宿主继续，无组时沿已授权的本机 `continue` 入口，不能据此越过执行档位。相同归一化答案重试幂等，不同答案返回 `QUESTION_ALREADY_ANSWERED`。

### 2.8 运行配置与事件

受信宿主调用 `sessions.setDefaultRunConfig` 保存权限时，Core 为人类选择签发 `Session.permissionSelection`。新 Turn 记录已观察选择修订。恢复在原租约取得且 checkpoint 身份复核后，仅采纳更新的权限选择，并在 `Turn.permissionRevisions` 保存该执行段权限、选择修订、时间、租约身份与旧审批序号截止点。原 `frozenRunConfig` 和 Provider 快照保持历史事实，`continue.runConfig.permissionMode` 不构成提权入口。缺少新字段的旧记录沿用原冻结权限，后续显式保存权限即可在下一安全恢复采用。Chat 权限仍受原能力上限约束。

`getFrozenRunConfig()` 的 `permissionMode` 保留开始时的冻结事实，新增可选 `executionPermissionMode` 投影最近执行段权限。权限变化后的 pending call 重新经过原 Policy，不转发旧批准。修订落盘后即使执行段启动失败，重试也依据审批序号截止点持续撤下旧批准。私有修订审计不进入 getState 的公开 Turn 投影。危险/显式 ask/外部修改未授权时签发新审批，旧审批身份不能用于新执行段。中断时结果未知的调用仍按原恢复规则闭合，不直接重放。运行中的选择仅在下次安全恢复或新 Turn 生效。

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
  workPreview?: WorkPreviewCapability; // 可选 validatePreviewTarget(url): void 纯宿主校验，审批前复用执行规则
  workPreviewLoader?: () => Promise<WorkPreviewCapability | undefined>;
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
- Work 的能力对象、loader、sampler/factory、Provider settings、Context、Skill、MCP 和数据库能力只来自受信 Runtime 默认值，Turn override 不可替换。合法模型/推理/凭据引用、权限、步数/重试/时长/token 预算、compact 和 `databaseSearchPolicy` 仍由 `resolveRunConfig` 显式解析并冻结；continue 沿用原冻结值，工具 allowlist 仍可收窄，废弃 RAG 字段仍清除。
- `hostToolsLoader(binding)` 仅从受信 Runtime 默认配置装配，在 Work start/continue 时获得真实 Session/Turn；Turn override 不可替换，Chat 不调用。返回 `tools` 为既有工具定义结构（name/description、Zod inputSchema、metadata、createActionFacts、execute、serializeOutput），通过原 Registry/Policy/Executor 执行；可选 allowedTools 与当前/冻结上限取交集，不能放宽。loader、闭包和工具对象不持久化，冻结只保留允许工具名。可选 beforeExecute 由同一受信 loader 返回，在普通工具每次真实执行前（含重试、审批后恢复）调用；回调拒绝时工具 handler 不执行。该回调只约束普通工具，宿主在本次 loader 返回的工具对象按对象身份走自己的业务门，不按工具名/MCP metadata 豁免。回调来自 Runtime defaults，不能由 Turn override 注入，不进入持久快照；未装配时普通 Runtime 行为不变。宿主负责在 execute 内校验业务范围；业务意图不替代实际工具权限或人类审批。最小禁用示例：`createAgentRuntime({ ports, defaultRunConfig: { hostToolsLoader: async function boundTools({ sessionId, turnId }) { return { tools: [], allowedTools: [] }; } } })`。装配实际工具时使用 `RunConfig["hostToolsLoader"]` 推导类型，不导入 Core internal 路径。
- Chat start 只接受当前 `content`，拒绝外部 `messages` 或 Skill 上下文；`turnId` 不能覆盖已有 Turn。Chat override 不能替换宿主 sampler、`chatLoader`、Web loader、Workspace、RAG、Skill、MCP 或数据库能力。continue 复查 Session 与冻结模式，工具名及附件 ref 均受原快照限制；Chat 缺少冻结身份或模式不一致时抛 `SESSION_MODE_MISMATCH`。Work 新 Turn 由 Core 写入 `workContextVersion: 1`；有任一旧 Turn 缺少该版本或 Work ceiling、孤立 checkpoint/transcript，或无可信 Turn 的旧展示内容时，start/continue/steer/compact 抛 `WORK_HISTORY_READ_ONLY`。`getState()` 返回同名 `readOnlyReason` 并保持受限 checkpoint 原样，`getRecoverableState()` 返回 null；旧文件和历史不自动删除。新边界下完整的 Work 任务正常恢复。
- `credentialRef` 只保存引用 `{ provider, key }`，真实 API key 只由 `CredentialStore` 解析。
- `web` 是 Trust 后由宿主注入、只存在于当前进程的能力容器，不会进入 `FrozenRunConfig`、checkpoint、event 或持久化配置；`search` / `fetch` 子能力可独立存在，缺少某项时对应 `web_search` / `web_fetch` 工具完全不可见。完整 Search query 与结果只在同一进程的当前采样链中短暂存在；写入 durable checkpoint 前，调用参数与工具结果会替换为保持配对关系的安全占位，恢复后如仍需该信息必须重新搜索。
- `workPreview` 是 Trust 后由宿主注入、只存在于当前进程的 Work 预览能力；`workPreviewEnabled` 在新 Turn 冻结进 `FrozenRunConfig`（缺省 false，override 不可开启），能力对象本身不进入冻结配置。`open_preview` 工具仅 Work 且能力就绪时注册，Chat/CLI 永不可见；durable checkpoint 对其输入使用与 Web 工具相同的 `{ redacted: true }` 占位。契约详见 6.5。
- `AgentMessage` 是唯一运行时 canonical 消息：`text`、`image-ref`、`reasoning`、`tool-call`、`tool-result` 五类 block 不含 Provider wire 字段。恢复发现未闭合调用时会先写入确定性 error result；`TOOL_OUTCOME_UNKNOWN` 不代表执行失败，而是要求先验证外部副作用。
- `AgentEvent` 是对外事件联合；所有携带 checkpoint 的事件都使用同一最小生命周期视图，`messages` 与 `completedCallIds` 固定为空数组，只保留安全 Skill 身份。受信 Chat none/web 的 `render_ui` 成功后可产生 `ui_document`，仅包含 Core 校验/归一的 `UiDocument`；对应 `tool_result.output` 只含 `{ delivered: true }`。`getState()` 的 checkpoint 另可带 `consumedInputIds` 供 Web 输入去重；宿主不得收到 canonical 消息、pending calls、其他工具参数/结果、`runtimeBudget`、`usageAnchor`、Provider 原文或凭据。
- `tool_progress` 只在长时工具执行期间产生，`tail` 为命令输出最后 ≤160 字符的节流尾部，仅用于运行中的实时进展展示；不得作为终态摘要持久化，也不进入 transcript。
- `turn_failed` 经过 Runtime 事件记录边界时必带随机 UUID `feedbackId`，并在 EventSink 返回值与 durable Transcript 中保持相同。`errorCode`、`failureStage` 与可选 `providerHttpStatus` 只从白名单保留；阶段包括工具预检/执行、预算、上下文压缩、Provider 采样/恢复、完成策略和 Agent Loop。Provider 状态只允许整数 400–599。未知类别统一为 `TURN_EXECUTION_FAILED`，未知阶段统一为 `agent_loop`；原始异常、请求/响应正文、路径与堆栈不直接进入诊断字段，常见凭据形式会过滤，`error` 仍使用固定安全文案。可选 `providerFailureReason` 仅为闭合中立原因 `invalid_request | authentication_failed | billing_insufficient | quota_exhausted | rate_limited | service_unavailable`，与既有 `errorCode` 成对验证；脱敏器不解释厂商标记，旧 `providerFailureProfile` 不进入新公开事件。根入口 `getAgentProviderFailureMessage(errorCode, reason?)` 与 `sanitizeAgentProviderFailureReason(errorCode, reason)` 供 Web/CLI 共用；不读取响应正文、厂商名或 URL。Adapter 的 `normalizeProviderHttpFailure` 仅在可靠官方端点上解析少量固定业务 code/type，归一成中立原因及原有恢复分类；DeepSeek 官方状态、Z.ai/Kimi/百炼少量余额/额度/限流/过载事实受有限规则覆盖，不表示厂商全集。余额/额度为 `PROVIDER_REQUEST_REJECTED`，可靠限流/过载沿用原有有界恢复；未知 429 保守拒绝，不依据任意 message 触发重试。OpenAI 适配器既有上下文溢出识别优先，取消/超时边界保留。新增可选 `providerFailureDetail` 为 `code:` 或 `type:` 加 1–32 位字母、数字、下划线、点或连字符的协议标识，过滤常见凭据形式；仅来自结构化错误字段，不读取自由 message，不决定恢复。格式过滤无法证明标识不含短凭据或用户内容。Web/CLI、历史与 transcript 经同一校验保留该字段。`normalizeLegacyProviderFailureReason(errorCode, profile, status)` 仅用于旧持久字段升级，将匹配旧分类的已知事实转成中立原因；新事件不再携带厂商 profile。
- 终态事件和 `getRecoverableState()` 可携带 `termination: { reason?, recoverable, budget? }`。原因仅为 `runtime_budget | token_budget | repeated_tool_calls | write_verification | stale_lease | turn_limit_reached`；预算仅允许 `runtime_budget` 的非负安全整数毫秒值或 `token_budget` 的非负安全整数 Token 值。旧事件缺少投影时保留 Core 确认的恢复布尔值，不伪造原因或数值。
- `todo_write` 是自动允许的内部状态工具。每次只接受完整替换列表 `todos`（0–20 项，`content + activeForm + status`，三态且未完成时恰有一个 `in_progress`）；成功后产生 `todo_updated`，携带当前任务链身份、受限 Todo 文案和 Core 计算的计数。completed 只表示计划状态，不表示测试、文件修改或发布成功。同一调用可附带可选 `fileTargets`（≤50 项，`path` 为工作区相对路径 + `operation: "create" | "edit"`）声明本任务的修改文件清单：此时该调用转为 `task-files:v1` 审批（`allowedDecisions` 仅 `allow_once`/`deny`），用户批准后 Core 保存绑定当前 Turn 的集合授权；本 Turn 内 `write_file`/`edit_file` 对清单成员按声明操作自动放行，非成员、新目标与外部路径仍走既有逐次审批。跨 Turn 集合自然失效；同一 Turn 的增量声明按 `path+operation` 合并。已知要修改多个工作区外文件时，可改用可选 `externalFileTargets`（≤50 项，`path` 为绝对文件系统路径，拒绝相对路径、`..`、UNC 与备用数据流语法）声明外部文件清单：转为独立的 `task-ext-files:v1` 审批（与工作区集合分卡、单独一次批准，`allowedDecisions` 同样仅 `allow_once`/`deny`），Core 在声明期把每个目标 canonical 化冻结进清单（symlink 按解析后的真实目标身份），解析进工作区的声明被拒绝并提示改用 `fileTargets`；两类声明不得混在一次调用。批准后本 Turn 内对清单内精确外部文件的对应修改自动放行，授权不含父目录或递归语义；外部 deny/ask 规则快照收窄仍先于集合命中。
- Todo 快照只由 `todo_updated` 投影；`sanitizeEventForExternal()` 会把对应 `tool_result.output` 降为 counts，避免浏览器从原始工具结果重建列表。绝对路径和常见凭据片段会在 Todo schema 阶段拒绝。
- `maxDurationMs` 与显式的 `maxTotalTokens` 均在每个 Turn 冻结；前者是单个活动执行段的时长上限，默认关闭，可由 `AGENT_MAX_DURATION_MS` 或 RunConfig 显式启用且无固定平台封顶；后者是跨 Continue 累计的 Provider token 上限，默认关闭，可通过 `AGENT_MAX_TOTAL_TOKENS` 或 RunConfig 显式启用，硬上限 10,000,000 tokens。等待、审批和用户回答期间不消耗新的执行段时长；Continue 取得执行 lease 并开始运行时重开时长段，但保留同一 Turn 的显式 token 累计。预算在完整工具批次等安全边界检查：`runtime_budget` 触顶产生 `interrupted_recoverable`，`continue()` 保持同一 Turn 与累计 token 预算；显式 `token_budget` 耗尽则产生 `failed` 终态，Core 拒绝继续执行。旧模式/旧默认值不在当前契约范围，不提供迁移保证。上下文水位仍由现有 auto compact 管理；跨 Turn 的 Goal 全局预算仍需由 Goal 域单独聚合。
- 连续相同的工具名、规范化参数和结果摘要会触发无进展护栏：第 3 次注入提醒、第 5 次强提醒、第 8 次以 `interrupted_recoverable` 暂停（`interruptionReason: "repeated_tool_calls"`）。参数/结果变化、成功 mutation、Todo 推进或 steer 会重置计数；只保留脱敏哈希与次数，`sanitizeCheckpoint()` 不向宿主公开该私有状态。
- Durable Runtime 在每个完整的模型采样与工具批次结果之后保存 `status: "running"` checkpoint，再开始下一次采样；快照包含 canonical 消息、`completedCallIds`、剩余 `pendingCalls`、Todo、usage 与安全预算，并用 lease 的 `safeBoundarySeq` 保持写入顺序。进程在该边界后重启时，已完成工具不会重放；若仍有未闭合调用，则恢复沿用 `TOOL_OUTCOME_UNKNOWN` 的 fail-closed 语义，要求先验证外部状态。
- `resolveRunConfig()`、`resolveAgentRuntimeLimits()`、`resolveLimitConfig()` 不读写 Store，可用于宿主预览配置解析结果；限制层的环境默认值在模块加载时读取，解析期间不重读环境；实际 continue 仍只使用冻结配置。
- 沙箱契约：`FrozenRunConfig` 冻结 `sandboxMode`、`sandboxTempRoot`、`sandboxPolicyDigest`（mode/workspaceRoot/tempRoot 的 SHA-256，不含敏感路径明细）与 `sandboxPolicyVersion: 1`。`sandboxMode` 与审批 `permissionMode` 正交，未知值在 `resolveRunConfig` 抛 `SANDBOX_MODE_INVALID`；`danger-full-access` 只能来自宿主默认值，模型输入、工具参数、持久 grant 与 Chat 请求体均不可达。Continue 沿用冻结值；旧 checkpoint 缺 sandbox 字段时在恢复边界幂等迁移为 `read-only`（fail-safe，不可继承宽能力）。`SandboxPort.execution?: "host"` 静态声明该装配的进程执行方式（Windows 宿主执行 Port 声明 `"host"`，其余缺省表示沙箱），是执行方式的唯一来源，不依赖 `status()` 探测。`FrozenRunConfig.processExecution?: "sandbox" | "host"` 冻结本 Turn 的有效执行方式：`TurnService.start` 写入，`continue` 在进入执行链前与当前 Port 比对，不一致（包括缺省按沙箱的旧记录落到宿主装配）以 `TURN_FROZEN_MISMATCH` 拒绝并提示新建任务，旧审批零消费、目标零启动；不得用 `status()` 探测结果重解释既有授权。`RuntimePorts.sandboxPort` 为 mandatory 字段，未接入真实 backend 的装配必须显式提供 `createUnavailableSandboxPort()`（一切进程执行 `SANDBOX_UNAVAILABLE`）；`SandboxPort.prepare` 只接受已校验的结构化 `program + args + canonical cwd + 冻结 policy + commandId`，输出可直接 spawn 的 argv + env，Core 不感知平台实现。稳定错误码 `SANDBOX_UNAVAILABLE` / `SANDBOX_NOT_PROVISIONED` / `SANDBOX_POLICY_DENIED` / `SANDBOX_RUNNER_FAILED` / `SANDBOX_SCOPE_CONFLICT` / `SANDBOX_CLEANUP_FAILED`；policy denial（沙箱正常且拒绝）与 runner failure/unavailable（目标命令未安全启动）语义不得混淆。
- 外部权限段（`permissions`）只接受 `allow`/`deny`/`ask`。`allow` 仅 Local 投影生效，其它 scope 产生 `SETTINGS_PERMISSIONS_SCOPE_FORBIDDEN`；未知字段（如 Claude Code 的 `defaultMode`）产生 `SETTINGS_PERMISSIONS_UNSUPPORTED`，只丢弃该字段且不产生任何授权，同段的合法 `deny`/`ask` 收窄继续保留。`deny`/`ask` 出现无法解释的条目或 `permissions` 不是对象时产生 `SETTINGS_PERMISSIONS_UNSAFE` / `SETTINGS_PERMISSIONS_INVALID` 并置 `permissions.restricted`，外部限制判定与持久放行一律按拒绝处理（fail-closed）；`ExternalPermissionSnapshot.restricted` 由投影器透传该事实。投影写入在 `permissions` 不可解释时返回 `EXTERNAL_RULE_PERMISSIONS_UNSAFE`，不覆盖原字节。宿主可用 `isExternalPermissionDiagnostic()` 把权限诊断与模型/凭据分类隔离展示。
- 沙箱 settings 与 Node Adapter：settings 的 `sandbox` 安全字段——`mode`（仅 User scope，且只允许 `read-only`/`workspace-write`；`danger-full-access` 不允许从 settings 文件声明）与 `allowedDomains`（仅 User scope）；`deniedRead`/`deniedWrite` 任意 scope 按并集收窄；裸 `*`、未知字段与非空字符串数组一律产生 `SETTINGS_SANDBOX_INVALID` / `SETTINGS_SANDBOX_MODE_FORBIDDEN` / `SETTINGS_SANDBOX_SCOPE_FORBIDDEN` 诊断。Node 装配侧 `createNodeRuntimePorts` 在 Work 模式（提供 `workspaceRoot`）下按平台装配 SandboxPort：macOS 为 `createNodeSandboxPort({ workspaceRoot, stateRoot, tempRoot })`，Windows 为 `createNodeHostExecutionSandboxPort()`；`sandboxTempRoot` 必须由宿主显式验证后传入（CLI 使用 Trust 后的 `<workspace>/.autopilot/tmp`）；Chat 模式或缺 root 使用 `createUnavailableSandboxPort()`。Node adapter 绑定单一 canonical root（policy root 不一致抛 `SANDBOX_SCOPE_CONFLICT`）：macOS 使用 Seatbelt，prepare 输出 enforcement=full，`TMPDIR` 以受控 tempRoot 前缀覆盖 SRT 注入的 `/tmp/claude`；Windows 装配宿主执行 port（`backend: "host-execution"`、`enforcement: "unavailable"`），不加载 SRT、不要求 provision、不做系统变更，`prepare` 无条件以 `SANDBOX_UNAVAILABLE` 拒绝，`status()` / `setup()` 返回停用报告，`release()` / `shutdown()` 为空操作且幂等。初始化失败、网络未就绪与 danger-full-access 均 fail-closed；`status().enforcement=full` 仅表示本次会话 OS 约束就绪，不代表完整兼容性或发布验收。错误映射不透传 SRT 原始文案。`AgentRuntime.shutdown()` 顺序为 `jobs.shutdown()` → `sandboxPort.shutdown()`（幂等）。
- 前台与后台命令的执行范围与审批：`run_command` 与 `start_background_job` 是仅有的两个进程类工具入口，除宿主可信配置的 `danger-full-access` 单次直执（见下条）外执行路径不存在裸 spawn——`ToolExecutor` 对这两个工具强制解析执行范围并注入执行事实：沙箱装配下解析沙箱范围（绑定缺失或 `status()` 能力不可执行时以 `sandbox.available=false` fail-closed deny `SANDBOX_UNAVAILABLE`，不转普通审批、不裸跑），确认可执行后注入带 port 与冻结 policy 的 `SandboxExecutionScope`；Windows 宿主装配（`status().backend === "host-execution"`）注入无 port 的宿主范围（`execution: "host"`），不注入 `sandbox.available`，由 `PolicyEngine` 按风险、显式限制与权限模式分流。`ask` 的宿主命令逐次确认，`auto_approve` 对已确认只读和受信工作区变更自动放行，未知或外部副作用仍询问。`full_access` 放行更广普通调用，危险风险、显式 ask、全模式外部修改授权仍先于普通 grant 和模式。需要宿主审批时决定范围为 `["allow_once", "deny"]`。策略允许或单次批准后前台以 `sandboxExecutionOverride: "direct"` 宿主直执一次，后台把宿主范围交给 `JobService.start`。前台：`run-command-tool` 先用 `getPlatformExecutable` 完成平台可执行名解析，再经 `SandboxPort.prepare({ commandId, program, args, cwd, policy })` 生成包装 argv 后 spawn（`env` 为 `process.env` 与 prepare 输出合并），close/error/超时/取消全部终态幂等 `release(executionId)`，成功结果携带安全沙箱事实 `sandbox: { enforcement, mode }`。后台：`start-background-job-tool` 缺少已解析范围时同样抛 `SANDBOX_UNAVAILABLE`，并把范围交给 `JobService.start`（见 2.3：沙箱形态受信解析 → `prepare` → spawn，宿主形态受信解析 → spawn；两者全终态释放执行资源，durable 记录只保存安全 policy 摘要）；prepare 失败不产生 running Job，稳定 `SANDBOX_*` 错误码原样投影为工具错误。沙箱可用只证明执行隔离，不能把未知风险或外部副作用变成 `auto_approve` 自动放行。明确危险风险在普通 grant 与模式之前要求单次确认，硬拒绝继续拒绝。未解析的 npm 项目脚本保持 unknown，不能仅凭 build/test 名称认定安全。绑定注入链：`turn-runtime-config-resolver.buildAgentOptions` 仅在 Work Turn 注入 `{ port: RuntimePorts.sandboxPort, mode: FrozenRunConfig.sandboxMode（缺省 fail-safe 为 read-only）, tempRoot: sandboxTempRoot }`，经 `RunContext.sandbox` 传入 Kernel；Chat 不注入。
- 沙箱启动失败降级与拒绝终态：沙箱装配下，进程类调用执行前对沙箱范围做最多 3 次探测（探测只读 `status()`，不启动目标命令，重试安全），仍失败按模式分流（Windows 宿主装配不进入本分支：探测到 `status().backend === "host-execution"` 即直接构造宿主范围，审批按 `hostExecution` 的风险与权限分流）——`read-only` 与 `workspace-write` 一律维持 fail-closed deny（沙箱不可用时不存在受控执行通道，无法证明授权状态保护与外部写门禁，无沙箱直执不提供任何权限豁免，`start_background_job` 与外部写命令同等 fail-closed）；`danger-full-access` 是宿主可信配置的明确无隔离授权，直接执行不经过沙箱失败流程（PolicyEngine 沙箱事实注入 `available:true` 维持与沙箱可用时一致的放行行为，执行结果 `enforcement: "unavailable"` 不得展示为隔离）；Windows 下 `npm`/`npx`/`pnpm` 直接执行前与沙箱路径共用同一受信解析——转换为可信 `node.exe` + 对应 CLI 脚本 + 结构化 argv，不经 shell 拼接，受信 CLI 不可用时命令不启动（`SANDBOX_UNAVAILABLE`）。workspace-write 的无沙箱降级审批（稳定约束 `no-sandbox-exec:v1`、卡片展示完整命令与脱敏诊断、批准后 `sandboxExecutionOverride: "direct"` 直执一次）已从执行链撤下：命令已记住（grant）、任务文件集合已批准、工作区已信任、`full_access`/`auto_approve` 均不能改变 fail-closed 结果；其冻结/原子消费权威底座（`SandboxDegradeApproval` + `consumeDegradeApproval`，跨重启经 `validateApproval` 核对 constraint 与 TTL）保留休眠，供未来受控执行方式（如独立执行身份＋宿主持有授权状态）复用。拒绝与诊断：deny 结果按 `errorCode` 区分环境阻塞（`SANDBOX_UNAVAILABLE`/`NOT_PROVISIONED`/`RUNNER_FAILED`，诊断以结构化 display 事实 `diagnostics` 投影，error message 只保留策略原因）与用户拒绝（`APPROVAL_REQUIRED`）；进程类调用的结果展示事实携带结构化 `executionMode`（`sandboxed`/`unisolated`/`unavailable`），展示层不得把 `unisolated`/`unavailable` 宣称隔离。命令审批展示事实（`ApprovalDisplayFacts`）另冻结可识别工作目录 `cwd`（本地 facts 提供 canonical 目录，未绑定 workspaceRoot 时为输入原文）与 `unknownScope`（命令声明外部效果但未声明精确目标时为 true，展示层给出"修改范围无法精确限定"提示，不得宣称"仅覆盖精确目标"）；`actionPreview` 保留既有长度预算与凭据脱敏，触达预算时附截断提示。Kernel 对一切 denied 终止写 `turn_failed`（checkpoint `status: "failed"`），文案按 errorCode 区分（沙箱→"沙箱不可用，无法提供已隔离执行，本次任务已停止"，用户拒绝→既有"不会尝试其他命令"），任务受阻不得显示为 `turn_completed`。用户拒绝不得触发自动重试。
- 文件工具 mutation 名义层：`write_file` / `edit_file` 直接修改真实工作区，不进入 OS 进程沙箱；两者在执行锁内、真实 mutation 前读取 Turn 冻结 `sandbox` 绑定模式——`read-only` 一律拒绝并返回 `FS_SANDBOX_DENIED`（文件工具域稳定错误码，区别于进程域 `SANDBOX_POLICY_DENIED`），且不产生任何磁盘变化，判定只消费冻结 mode、不依赖 SandboxPort capability；`workspace-write` 与 `danger-full-access` 均维持既有工作区围栏（锁内 canonicalize-then-contain、审批、mutation WAL、写后 hash、Undo 不回退），`danger-full-access` 不放宽工具 schema 与允许范围；tempRoot 只属于进程沙箱策略，不构成文件工具写白名单；缺沙箱绑定的旧上下文不虚构 read-only，沿用既有围栏行为。

#### Chat 只读 capability

`RunConfig.chatLoader(binding)` 仅由 Runtime 的受信默认配置提供，返回进程内 `ChatCapability | undefined`；绑定参数为 `{ sessionId, turnId, retrievalMode }`。模型、Route DTO 与持久化配置不能提供 capability 对象。Core 负责目录、执行校验和证据门；Node 的默认 Workspace capability loader 不装配 Chat 端口。

| 模式 | 工具目录上限 |
|---|---|
| Chat none | 无附件且 Host 未开启交互 UI 时为空；受信 `ChatCapability.interactiveUi: true` 增加 `render_ui`，临时文档增加 `chat_attachment_read`，合法图片/渲染页 ref 增加 `chat_vision_analyze`。 |
| Chat web | 受信 `ChatCapability.interactiveUi: true` 时增加白名单展示工具 `render_ui`；已装配子能力仍独立控制 `web_search`、`web_fetch`，附件规则同 none。UI 不触发网络访问或改变搜索来源/证据规则。 |
| Chat rag | 已装配 Knowledge capability 时增加 `rag_search`；有视觉 capability 时增加 `chat_vision_analyze`，调用必须先取得当前合法证据 ref。不注册临时附件读取、Web、DB 或通用视觉工具。 |
| Work | 保留 Workspace 任务工具、Web、可选数据库、Trust 与审批；禁止 `rag_search`、旧 `lancedb_query` 和两个 Chat 专用工具，包括省略 ceiling 的兼容调用。 |

Registry 按上述上限注册，Executor 在 Schema/ActionFacts、审批和 handler 之前独立检查。产品越权工具返回兼容错误码 `CHAT_TOOL_FORBIDDEN`；整批调用任一未通过时，不产生 `tool_started` 或执行 handler。模式内缺失能力不会通过其他工具降级。Chat 的只读 Search/Fetch 不进入审批；需要新增域名审批的 Fetch 重定向返回 `WEB_URL_BLOCKED`。Work 的域名审批保留；通用 `vision_analyze` 接受任务图片 `path + prompt` 及可选 `expectedSha256`，后者用于在审批后实际读取图片时验证内容未变化；不接受 RAG `visualEvidenceRef`。

`ChatCapability` 的字段和调用边界：

| 字段/方法 | 输入与输出 | 限制 |
|---|---|---|
| `interactiveUi?` | 字面量 `true` | 受信 Host 开启的展示能力标记；仅 Chat none/web 可使 `render_ui` 进入工具目录，不携带 renderer、函数或外部资源。Web 工具和来源证据规则保持独立。 |
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
| `parseMcpConfig` | `(raw: unknown) => McpCapability` | 纯解析 `.autopilot/mcp.json` 的对象或数组形式，不读文件、不启动 MCP 子进程；非法 server 会被跳过。`env` 仅允许非敏感固定值或 `{ credentialRef }`。server 可设置 `execution: "sandbox" \| "host"`，缺省为 `host`；直接传入 Core 的 `McpServerConfig` 若省略该字段也按 `host` 处理。只有显式 `execution: "sandbox"` 才经 `SandboxPort`，且初始化失败保持 fail-closed。`host` 以宿主权限运行，状态与工具审批均显示 `unisolated`，并使用受控环境：PATH、显式 env/凭据与已存在的 Windows `SystemRoot`、`SystemDrive`、`ComSpec`、`PATHEXT`。Windows 缺失的 libuv required vars（`HOMEDRIVE`、`HOMEPATH`、`LOGONSERVER`、`PATH`、`SYSTEMDRIVE`、`SYSTEMROOT`、`TEMP`、`USERDOMAIN`、`USERNAME`、`USERPROFILE`、`WINDIR`）及 `TMP` 会以空字符串中和，防止 libuv 从宿主补回；Windows 环境键按大小写不敏感规则合并，显式配置/凭据覆盖默认值。其他宿主环境变量不继承。沙箱准备环境中的同名变量也按平台规则覆盖配置值。两种模式都要求 Workspace Trust、绑定当前有效配置的精确 grant 与逐次 MCP 工具审批。 |
| `getMcpServerConfigHash` | `(server: McpServerConfig) => string` | 为 name、command、args、cwd、受控 env 与有效执行方式（缺省按 `host`）生成稳定 hash；`execution: "host"` 与 `execution: "sandbox"` 均参与 hash。模式切换会使 grant 失效；旧算法未包含模式的 grant 不匹配新 hash，迁移后需重新授权。 |
| `getMcpServerGrantConstraint` | `(server: McpServerConfig) => string` | 返回绑定 `serverName + configHash` 的 `mcp_server_start` 持久授权约束；只有 Trust 和当前模式/配置对应的精确 grant 命中后才尝试启动。 |
| `createEventEnvelope` | `(input: CreateEventEnvelopeInput) => AgentEventEnvelope` | 纯工厂；同一 durable Turn 的 start/continue/recovery 由 Runtime 保持单调 `seq`，调用方提供 ISO 时间戳。 |
| `sanitizeCheckpoint` | `(checkpoint: AgentCheckpoint) => PublicCheckpointView` | 只投影生命周期字段、空消息/调用数组、安全 Skill 身份及可选 `consumedInputIds`；canonical 消息和工具事实不进入宿主状态。 |
| `sanitizeEventForExternal` | `(event: AgentLoopEvent) => AgentEvent` | 对终态与非终态 checkpoint 统一应用严格白名单；另将 `todo_write` 结果降为 counts、Web 工具结果降为安全事实、`render_ui` 结果降为 `{ delivered: true }`，并对白名单 `ui_document` 重新校验投影；`turn_failed` 只保留白名单诊断类别/阶段/状态与 UUID 反馈 ID，错误正文使用固定安全文案。 |
| `sanitizeAgentTerminationView` | `(value: unknown, recoverableOverride?: boolean) => AgentTerminationView \| undefined` | 只接受终态原因、Core 恢复布尔值及与原因匹配的有限预算数值；未知字段或非法预算不会被复制。 |
| `resolveRunConfig` | `(input: ResolveRunConfigInput) => FrozenRunConfig` | 模型、推理、凭据、权限及执行预算按 Turn > Session > Project > Runtime 解析；其他字段按各自契约解析，Trust/沙箱只来自 Runtime 默认值。 |
| `resolveAgentRuntimeLimits` | `(request?: Partial<ResolvedAgentRuntimeLimits>) => ResolvedAgentRuntimeLimits` | 统一解析 `maxSteps` 和 `maxToolRetries`；未配置 `maxSteps` 时保持 `undefined`，不启用总 step 闸门。 |
| `resolveAgentRuntimeSafetyLimits` | `(request?: Partial<AgentRuntimeSafetyLimits>) => AgentRuntimeSafetyLimits` | 解析显式时长/Token 安全预算；时长不封顶，Token 仍受硬上限约束，不负责 Goal 跨 Turn 聚合。 |
| `resolveLimitConfig` | `(config: LimitConfig) => number \| undefined` | 非正数回退已配置默认值；请求值与默认值都缺省时返回 `undefined`，配置了 `hardLimit` 时才封顶。 |
| `AGENT_RUNTIME_LIMIT_DEFAULTS` / `AGENT_RUNTIME_LIMIT_HARD_LIMITS` | 常量 | `maxSteps` 默认关闭，显式正整数无固定平台封顶；`maxToolRetries` 硬上限为 `10`，环境变量 `AGENT_MAX_TOOL_RETRIES` 未提供合法值时默认 `5`；`maxSteps` 可由 `AGENT_MAX_STEPS` 显式启用。 |
| `AGENT_RUNTIME_SAFETY_DEFAULTS` / `AGENT_RUNTIME_SAFETY_HARD_LIMITS` | 常量 | 执行段时长和 Turn 累计 Token 默认关闭；时长无固定平台封顶，Token 硬上限为 `10,000,000`；不替代 Goal 域预算。 |
| `SANDBOX_ERROR_CODES` / `SANDBOX_POLICY_VERSION` | 常量 | 6 个稳定沙箱错误码与沙箱冻结语义版本（当前 `1`）；`isSandboxPolicyDenialCode` / `isSandboxAvailabilityFailureCode` 区分两类失败语义。 |
| `resolveSandboxMode` | `(value: unknown) => SandboxMode` | 只接受 `read-only` / `workspace-write` / `danger-full-access`；未知值抛 `SANDBOX_MODE_INVALID`，不静默回退。 |
| `computeSandboxPolicyDigest` | `({ mode, workspaceRoot?, tempRoot?, externalWriteCapability? }) => string` | 冻结 policy 的 SHA-256 安全摘要；外部写能力存在时还纳入其版本和 capabilityDigest，不复制目标路径明细。 |
| `createUnavailableSandboxPort` / `SandboxPortError` | 工厂 / 错误类 | fail-closed 默认 Port（一切进程执行 `SANDBOX_UNAVAILABLE`）；错误 `code` 必须来自 `SANDBOX_ERROR_CODES`。 |

受管后台执行扩展：`SandboxExecutionRequest.managed?: boolean` 请求可选控制能力；`SandboxPreparedCommand.control?: ManagedExecutionControl` 只属于本次执行，不持久化。`protocolVersion: 1`、一次性 `bind(ManagedExecutionChannel)` 和 `stop(): Promise<{ evidence: "container_empty" }>` 使用宿主创建的私有双向字节流，不能用目标 stdin/stdout/stderr 或任意 PID 代替。重复 stop 复用进行中的能力调用；容器空回执与包装 `close` 都满足才落 `stopped`，失败保留 `stopping`/执行资源。缺少该能力时 taskkill 成功不能认证容器已清空。这是可选的公开 Port 扩展：内置 Node Adapter 当前不提供实现，外部 Port 仍可提供；宿主执行形态不使用控制协议，其停止证据为进程树终止加 `close` 观察。

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
  status?: KnowledgeResourceStatus;
  failedPages?: number[];
}
```

| 字段 | 说明 |
|---|---|
| `type` | 必填。当前运行时支持 `excel`、`text`、`pdf`、`image`；`video` 仍是声明预留值，不得作为前端可选项。 |
| `tableName` / `clearFirst` | 仅保留给旧入库 helper 的兼容类型；统一 `rag.ingest()` 会忽略调用方表名与清表请求，由 Core 根据随机 `resourceId + embeddingSpaceId` 派生物理表，partial 重试也不会删除已成功页。 |
| `headerRow` / `sheetName` | Excel 专属；`headerRow` 为 0-based，缺省为 `1`；`sheetName` 缺省取首表。 |
| `chunkSize` / `chunkOverlap` | Text 分块默认 `chunkSize: 512`、`chunkOverlap: 128`；Excel 也把这两个参数传给同一分块器。PDF 使用页级管线，不读取这两个分块参数。 |
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
const rows = await rag.search("退款流程", 8, ingestResult.tableName);
```

返回 `Promise<VectorOutput[]>`，`topK` 缺省为 `5`。它只在一个表中执行 Dense 语义搜索；未传 `tableName` 时沿用旧默认 `employee_test`，不会自动选择刚入库的资源。目标必须有当前知识根的 manifest 且 Embedding 空间匹配，否则抛 `RAG_VECTOR_SPACE_MISMATCH`。新调用方应使用入库结果的 `tableName`，或改用多表检索。

#### `rag.searchAcrossTables(query, topK?, tableName?)`

```ts
const search = await rag.searchAcrossTables("退款流程", 8);
console.log(search.searchedTables, search.results);
```

`topK` 缺省为 `5`。未显式传表时，Core 从当前绑定知识根的 completed/partial manifest 做有界资源预路由；同一 query 在同一 `embeddingSpaceId` 只生成一次向量。每张候选表分别执行 Dense 与持久关键词索引召回，再仅按名次用 RRF 融合，不比较不同向量空间或检索器的原始分数。普通查询不会调用 `listVectorTextRecords()` 回读整张 LanceDB 表；缺失/损坏的关键词索引只降级为 Dense，不在查询热路径自动重建。

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
  ingestResult.tableName,
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
| `rebuildLexicalIndexes` | `(tableName?: string) => Promise<{ tableName: string; recordCount: number }[]>` | 显式维护操作：从当前绑定知识根的 LanceDB 受控正文快照重建持久关键词索引；普通查询不调用。 |
| `getToolDefinitions` | `() => ToolModelDefinition[]` | 兼容工具入口仅返回 `read_file`；私有检索不再通过无产品绑定的工具执行器暴露。 |
| `executeTool` | `(request, options?) => Promise<ToolExecutionResult>` | 见[工具执行与权限](#5-工具执行与权限)；不能做成浏览器匿名执行端点。 |
| `getRagCapability` | `() => RagCapability` | 供受信 Chat 知识适配复用 canonical 检索；不直接注入 Work Runtime，也不是通用工具执行入口。 |

`RunConfig.rag/ragSourcePolicy/rerankPolicy/focusedPdfFileName` 保留旧宿主的类型兼容，但 Runtime 会清除它们，不触发检索或 Rerank。Chat 检索通过 `chatLoader` 的知识端口。canonical RAG 服务仍可使用 `RAGAgentOptions.rerank.defaultPolicy/resolveApiKey`；真实 Key 不进入持久化和浏览器。

文本与视觉候选交给 `rerank.adapter` 的相应角色专用接口；内置百炼默认分别使用 `qwen3.7-text-rerank` 和 `qwen3-vl-rerank`。视觉条件成立时，Core 从当前绑定知识根原始 PDF 按需渲染有限候选页。内置适配器请求固定 `return_documents=false`，响应必须完整覆盖本批候选且每个 `index` 唯一、为整数并未越界；任何空、不完整、重复、越界或非法分数响应都会整体降级并保持上游顺序，不接受 Provider 回显正文，也不回退 `askLoopLLM()` / `askLLMWithImages()` 做 Chat Prompt 精排。429/5xx 只做一次小预算重试，4xx 不盲重试，取消会继续向上抛出。

canonical `prepareRagSearch` 返回能回查当前知识根 completed/partial manifest 的证据；无效候选移除，全部无效返回不足。`RagEvidence.sourceType` 支持 image，可选 `sufficient` 为保守质量判断：专用适配器提供 `relevant` 时须为 true 且有可读文字或图像，否则按正文命中问题至少一个长度 >= 2 的词项判断；内置百炼两种已知模型采用 0.5 门槛；纯图片可用展示名匹配，再经实际视觉观察取证。PDF evidence.text 仅含当前页正文，不把文件名/标题/相邻摘要当成事实。词项门可能拒绝同义改写，并不证明事实相关性或源内容真实性；Chat 仍逐字校验摘录。空候选不触发 HyDE；检索 I/O/Provider 故障按 RAG_SEARCH_FAILED 收敛，不记录原始错误或冒充空库；查询 Embedding/HyDE 传递取消。Chat 知识适配负责将它们绑定到 Knowledge Space、Session、Turn 和批次，并按 Chat 证据门验证。PDF 底层使用 `rag-resource:<resourceId>:page:<pageNumber>`、图片使用 `rag-resource:<resourceId>:image` 引用，受信适配可映射为 Chat 受控视觉引用；Work `vision_analyze` 不再消费该来源。

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

`snapshotRoot` 由宿主在 Trust 后解析；Web 默认使用当前绑定知识根 `stateRoot/database-snapshots`，SQLite manifest 与数据库语义 LanceDB 均位于该根下。未显式传入时，兼容入口才使用服务端 `DATABASE_SNAPSHOT_PATH` / `LANCE_DB_PATH`。数据源注册项必须通过 `allowedTables` 显式允许同步表；字段敏感规则仍会在 allowlist 之后继续排除危险表列，缺少 allowlist 时不开放任何表。

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

### 4.4 `getDefaultDatabaseSource()`

签名：`() => Pick<MySQLSourceConfig, "database" | "displayName">`。

返回唯一已注册源的安全标识；当前注册表不是唯一源时会抛错。仅服务端可信管理流程可使用；不要用它推导或暴露连接配置。

### 4.5 知识资源管理

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

`ToolExecutor` 在 Schema 校验后统一解析工具请求中的 `timeoutMs`、metadata 默认值和最大值，普通调度与审批恢复使用同一规则。`ToolExecutionOptions.timeoutMs` 是受信内部执行预算（如重定向的剩余时间），只能进一步收紧请求及 metadata 上限，不能扩大已批准参数；取消和超时都不会把执行中的未知副作用标为可安全重试。

`ToolExecutionResult` 是以下状态的联合：

| 状态 | 含义 |
|---|---|
| `success` | 含 `output`、执行 `meta` 与安全 `display`。 |
| `approval_required` | 含冻结的 `ToolApprovalRequest` 与安全 `display`；应交给 Runtime 审批服务处理。 |
| `question_required` | 含持久化的 `UserQuestionRequest`；只在已启用结构化问答的 Runtime 工具链产生，随后暂停等待答案。 |
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
| `ask` | 需要审批的操作在无有效授权时询问。 | 普通工具四选一；精确 `cmd:v2` 普通命令可选 `allow_once` / `allow_workspace` / `deny`；Windows 宿主命令及受单次保护的动作仅 `allow_once` / `deny`。当前归属精确 Job 停止免额外审批。 |
| `auto_approve` | 只自动放行 `read_only`，以及工作区可信（`workspaceTrusted === true`）时的 `write` / `workspace_mutating`；`external_side_effect`、`unknown`、`destructive` 仍人工审批。 | 危险、未知进程、MCP 和一般外部副作用仅单次确认；其他范围以冻结的 `allowedDecisions` 为准。当前归属精确 Job 停止免额外审批。 |
| `full_access` | 跳过一般审批。删除、丢弃已有修改、`git push`、效果不明的进程和其他精确授权边界仍需人类确认。 | 受保护动作仅接受 `allow_once` 或 `deny`，明确拒绝继续生效。 |

各模式在具体操作上的行为：

| 操作类型 | `ask` | `auto_approve` | `full_access` |
|---|---|---|---|
| `requiresApproval: false` 的只读操作 | 直接执行 | 直接执行 | 直接执行 |
| 工作区写入（`write_file` / `edit_file`） | 弹卡 | 工作区可信则自动执行，否则弹卡 | 直接执行 |
| 已识别只读命令（`pwd` / `rg` / `git status` / `git diff` / `git log`） | 弹卡 | 自动执行 | 直接执行 |
| 已识别工作区变更命令（`mkdir` / `touch` / `git add`） | 弹卡 | 工作区可信则自动执行，否则弹卡 | 直接执行 |
| 已确认效果的一般外部动作 | 弹卡 | 仍弹卡 | 直接执行 |
| 删除、`git push`、脚本或效果不明的命令 | 弹卡 | 仍弹卡 | 仅单次确认 |
| 工作区外修改 | 精确授权 | 精确授权 | 精确授权 |
| 硬拒绝命令（`rm` / `del` / `rmdir` / `git clean` / `git reset --hard` / `format` / `shutdown`） | `deny` | `deny` | `deny` |
| `web_fetch` | 按域名审批 | 初始公开读取与同域跳转免普通审批，跨域另行审批 | 初始公开读取与同域跳转免普通审批，跨域另行审批 |
| `vision_analyze` | 弹卡 | 自动执行 | 直接执行 |
| `stop_background_job` | 当前归属精确 Job 免额外审批 | 当前归属精确 Job 免额外审批 | 仍校验归属 |
| `web_search` | 审批后搜索 | 已启用时免普通审批 | 已启用时免普通审批 |
| AP `browser` | Core 审批后进入桌面浏览器授权 | 公开导航与观察免 Core 通用审批，继续检查桌面浏览器授权 | 公开导航与观察免 Core 通用审批，继续检查桌面浏览器授权 |

注意事项：

- `ask` 的语义是「对标记为需要审批的操作询问」，不是「所有工具逐次询问」。普通只读工具的可信本地事实若为 `requiresApproval: false`，可跳过一般审批；显式外部 ask、能力/Skill 限制及其他前置门禁仍优先。
- 非宿主直执的普通 `ask` 模式 `run_command` 仅接受绑定 canonical 工作目录、平台、平台解析后的程序身份与完整 argv 的精确命令约束（`cmd:v2:<sha256>`）参与持久授权：用户选择「记住此命令」后，完全相同的命令（程序身份、参数与工作目录一致）通过更高优先级安全门后在本工作区可自动放行，参数或目录不同必须重新确认；审批范围冻结为 `["allow_once", "allow_workspace", "deny"]`。程序身份按平台解析：Windows 上 `.cmd`/`.exe` 后缀与大小写属同一等价解析，其余平台扩展名与大小写都是实际可执行文件身份的一部分，不折叠。无精确约束（旧 `program:` 宽约束或缺失）时保持逐次确认且不查询命中；历史 `cmd:v1` 约束不再签发，**其授权也不再命中**。记住命令不涉及无沙箱降级：沙箱连续启动失败一律 fail-closed deny，无沙箱降级审批已撤下。`stop_background_job` 不使用持久授权，当前归属精确 Job 免额外审批，外部或不确定 owner 不能控制。
- `full_access` 只放宽审批交互，不绕过工作区路径解析、Schema 校验、read-before-edit、命令硬拒绝、destructive guard、命令 `shell: false` 与 program/args 校验，以及 `web_fetch` 的 URL/DNS/重定向安全门。
- 持久授权（`allow_session` / `allow_workspace`）只可由 `approvals.submit()` 建立，宿主不得自行写入授权存储。

#### 5.2.1 唯一决策点与判定顺序

所有工具调用在 Schema 校验后，先由本地工具代码生成 `ToolActionFacts`，再交给唯一的内部 `PolicyEngine.evaluate()` 作出决定。判定顺序固定，靠前的分支优先短路：

| # | 判定 | 结果 |
|---|---|---|
| 1 | 工具本地 `ActionFacts` 与 Registry `metadata` 的安全边界不一致 | `deny` |
| 2 | 已完成的本地硬门禁（`hardDenyReason`，例如破坏性命令） | `deny` |
| 3 | 当前激活 Skill 的 `allowedTools` 交集不含本次工具 | `deny` |
| 4 | 注入的沙箱事实不可用，或外部修改被显式 deny | `deny` |
| 5 | `resume_thread`、显式外部 ask、单次保护，或非 full_access 的一般外部副作用 | `approval_required`，仅 `allow_once` / `deny` |
| 6 | `requiresApproval` 不为真且无外部修改 | `allow` |
| 7 | 外部修改缺少精确授权 | `approval_required`；宿主执行只允许单次决定 |
| 8 | `ask` 模式的宿主进程执行 | 单次确认，先于 grant |
| 9 | 命中 Runtime 持久授权 | `allow` |
| 10 | `permissionMode === "full_access"` | `allow` |
| 11 | `permissionMode === "auto_approve"` 且风险被自动放行矩阵接受 | `allow` |
| 12 | 以上都不成立 | `approval_required`，同时冻结 `allowedDecisions` |

Windows 无隔离宿主执行在询问档保持逐次确认。完全访问与为我审批仍保留已核实命令的模式分流。删除、丢弃修改、`git push` 以及未知进程的单次确认排在持久授权之前，作用于 `run_command` 与 `start_background_job`。硬门禁、Skill 白名单、沙箱失败和显式外部拒绝继续优先。

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
| `curl`、`wget`、`npm install`、`npm publish`、`git push` | `external_side_effect` | 所有模式均需单次确认 |
| `git restore`、非 hard 的 `git reset`、`git rebase`、`git commit --amend` 及已识别的 Git 删除/丢弃动作 | `destructive` | 所有模式均需单次确认 |
| `rm`、`del`、`rmdir`、`git clean`、`git reset --hard`、`format`、`shutdown` | `destructive` | 硬拒绝 |
| 未匹配任何规则 | `unknown` | 需要审批 |

普通规则按结构化 argv 前缀匹配；Git 保护还识别子命令前的全局选项及关键选项。受限 `git clean` dry-run 与只读分支列举归为只读，真正删除仍硬拒绝。可能执行程序或写文件的选项，以及绝对/UNC/`..` 路径，会把原只读或工作区变更判断降为 `unknown`；已确定的 destructive/外部副作用不因这些参数降级。命令始终使用 `program + args` 与 `shell: false`，不支持 Shell 解释、管道或多命令。`ToolMetadata` 只声明副作用、并发、重试和超时，不是授权凭证。

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

已装配的 `web_search` 仅外发有界 `query`，用户级启用是能力装配条件。Work 的 `auto_approve` 和 `full_access` 对已启用的公开搜索放行普通审批；它串行使用 `web:search` 资源键、默认与最大均为 300 秒且不自动重试。`web_fetch` 只接受无 userinfo 的 HTTP(S) URL，按小写目标域名生成审批与持久 grant 约束，在 `ask` 模式按域名审批。Work 的 `auto_approve` 和 `full_access` 对初始公开读取和同域跳转放行普通审批，跨域目标重新审批。它按域名最多并发 2 个、默认与最大均为 60 秒且不自动重试。Work `vision_analyze` 只读取工作区相对图片并外发给冻结的视觉 Provider：`ask` 仍可逐次审批，`allow_session` / `allow_workspace` 使用稳定约束 `vision-analyze:workspace`，`auto_approve` 按只读风险自动执行，`full_access` 也不再显示一般审批；所有模式仍保留工作区路径、Schema、能力和 Provider 失败门禁。 系统安排的会话图片回退在公开事件及历史重放中仅投影安全状态和审批身份，不暴露存储路径、原始工具参数或视觉观察；模型私有消息和 checkpoint 保持完整。

#### 5.2.5 决策链路与展示边界

默认入口仅公开事实与决策的类型，不公开可绕过 `ToolExecutor` 的策略调用。`ToolDisplayFacts` 与 `ApprovalDisplayFacts` 是 Presentation 的唯一安全展示输入：只含 title key、工作区相对目标、受限指标和冻结审批范围；后台工具另以 `ToolDisplayFacts.job` 携带 action、可选 jobId/observedStatus、有限计数、waitOutcome，以及仅在启动时出现的脱敏 `programLabel`。`programLabel` 只允许 executable basename，统一小写并去掉 `.exe/.cmd`，不得包含目录或参数。MCP 工具审批的 `actionPreview` 可显示 Core 本地生成的执行隔离事实：`OS 沙箱隔离` 或 `未隔离（宿主直接运行）`；不得从 `output`、`preview`、原始命令参数或 MCP stderr 重建展示内容。`ToolDisplayFacts.executionMode` 与 `ApprovalDisplayFacts.executionMode` 描述本次（或待审批）进程调用的执行方式（`sandboxed` / `unisolated` / `unavailable`）：待审批时措辞必须用“将”，不得显示成已执行。`ApprovalDisplayFacts.hostExecution: true` 只由宿主执行逐次确认分支设置，表示批准后将在当前用户权限下直接运行、无 OS 沙箱，同时表示声明目标只是预期范围而非进程约束；展示层不得用 `executionMode: "unisolated"` 反推平台或授权时长（`danger-full-access` 同样产生 `unisolated`）。命令类审批的 `unknownScope: true` 表示修改范围无法精确限定，宿主执行的命令一律按未知范围处理，展示层不得同时声称“仅覆盖精确目标”。

`ToolDisplayFacts.observation` 是可选的协作观察事实，包含目标/任务/操作哈希 `key`、阶段哈希 `phase` 与有界安全 `lines`。仅内置 `wait_threads/read_thread/read_progress` 从已校验身份和受控结果生成，游标与等待时长不进入分组身份；原始参数、消息正文、路径和游标不写入该字段。 新增可选 `approvalTargets`，仅列出请求内对应目标且权威waiting=approval、interactionState=pending的安全不透明身份，供Web生成简洁目标入口。旧事件缺省兼容。

`ToolDisplayFacts.detail` 是可选的可判别联合 `ToolDisplayDetail`，只由 `ToolExecutor` 从 `read_file`、`glob_files`、`grep_files`、`web_search`、`web_fetch` 成功结果的受控 serialized output 生成（`open_preview` 例外：由工具自带 `projectDisplayDetail` 从原始结果生成），其余工具与运行中、审批、denied、error、cancelled、timeout 终态都不携带：

- `read_file`：正斜杠相对路径、实际 `startLine`/`endLine`/`totalLines`、`returnedLines` 与 `truncated`；未读到任何行时 `endLine: null`。不携带 `content`、`sha256`、`encoding`。
- `glob_files`：受限相对路径列表、`shownCount`、仅在 Core 可证明时出现的 `totalCount` 与 `executionTruncated`；display 预算裁剪时另有 `displayTruncated: true`。
- `grep_content`：按路径升序分组的命中行；`matchedLineCount` 是命中行数、恒等于 `lineNumbers.length`，与 count 模式的 submatch 次数不是同一语义；context 行与匹配文本不进入明细，文件组和单文件行号均受 display 预算限制。
- `grep_paths` / `grep_counts`：相对路径列表 / 每文件 submatch `count`；不伪造行号，display 预算裁剪时另有 `displayTruncated: true`。
- `web_search`：只含归一化后实际返回给 Agent 的 `sourceCount` 与 `truncated`，不含 query、答案、标题、摘要或 URL。
- `web_fetch`：只含最终 URL 的小写 `host`、受限 `contentType` 与 `truncated`，不含 URL 路径/query/fragment、标题或网页正文。
- `open_preview`：只含 `previewId`、`hostLabel`、`copyUrl`、`openWhen` 与 `state: "prepared"`，以及仅在宿主核验并绑定受管 Job 后出现的 `jobId`、仅在无法证明服务归属时出现的 `autoOpen: false`；`hostLabel` 为安全主机标签，`copyUrl` 等于宿主批准的实际页面地址，不含凭据、query、宿主文件路径或内部映射。该明细由工具自带的 `projectDisplayDetail` 从原始结果生成（`previewId`/`jobId` 格式非法、`hostLabel` 或 `copyUrl` 越界、`state` 非 `prepared` 时整体 fail-closed 省略），不来自 serialized output。

`totalCount` / `totalMatchedLineCount` / `totalFileCount` 只在工具执行阶段没有丢弃结果时出现，禁止由 `shown*`、数组长度或 `truncated` 推断；`displayTruncated: true` 是 Core display 预算已裁剪的独立事实，即使总数未知也必须保留，与执行截断和 Web 局部折叠相互独立。旧 transcript 缺少该新增字段时保持兼容回退。

#### 5.2.6 受限 PowerShell 单文件删除

`run_command` 可可靠识别以下结构化入参为 `destructive`，`auto_approve` 与 `full_access` 均要求 `allow_once` 或 `deny`，普通持久 grant 不代替本次确认。

```json
{
  "program": "powershell.exe",
  "args": [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Remove-Item -LiteralPath 'r001-permissions-lollipop-auto.html' -ErrorAction Stop"
  ],
  "cwd": "."
}
```

`pwsh` 使用相同参数也可识别。三个启动参数的顺序固定，命令与参数名大小写不敏感。单引号内仅接受单一相对叶文件名，须以 ASCII 字母、数字或下划线起始，其余可含字母、数字、下划线、点、空格或连字符，不接目录分隔符、父目录、通配、盘符/流、变量展开或额外命令。`-LiteralPath` 保持字面目标，`-ErrorAction Stop` 使删除错误终止调用。宿主仍无 OS 沙箱，本识别器只提供可信危险事实，不把任意 PowerShell 脚本变成安全命令，也不保证目标实际文件类型。超出该精确格式仍沿现有 unknown 路径。已有 `rm`、`del`、`rmdir`、`git clean` 与 `git reset --hard` 等 hard deny 继续拒绝。

#### 5.2.7 外部权限规则辅助函数

以下默认入口 API 只操作规则语法或覆盖关系，不 canonicalize 文件、不核验存在性、不产生 grant 或放行。

| API | 签名 | 返回与限制 |
|---|---|---|
| `EXTERNAL_FILE_CONSTRAINT_PREFIX` | 常量 `"ext-file:"` | 外部文件约束前缀。 |
| `isExternalFileConstraint` | `(constraint: string \| undefined) => boolean` | 只检查前缀，不证明后缀是安全 canonical 路径。 |
| `externalFileConstraintTarget` | `(constraint: string \| undefined) => string \| undefined` | 提取前缀后目标，非外部约束返回 `undefined`。 |
| `formatExternalFileRule` | `(toolName: string, constraint: string) => string` | read/glob/grep→`Read`、write→`Write`、edit→`Edit`；不支持的工具或空目标抛错。错误正文可能包含参数，宿主不要直接展示。 |
| `parseExternalPermissionRule` | `(rule: string) => ParsedExternalPermissionRule \| null` | 解析 `Read/Write/Edit(绝对路径)` 与末尾 `/**` / `\**` 递归形式，拒绝 UNC、Windows 备用流、NUL/换行等；纯语法检查不替代路径解析。 |
| `isValidExternalPermissionRule` | `(rule: string) => boolean` | 等价于 parse 结果非 `null`。 |
| `externalRuleCoversRule` | `(denyRule: string, grantRule: string) => boolean` | 相同操作、精确目标或递归目录覆盖；Windows 盘符路径大小写不敏感。非法规则返回 `false`。 |

```ts
const rule = formatExternalFileRule("write_file", "ext-file:/external/report.txt");
const parsed = parseExternalPermissionRule(rule);
const covered = externalRuleCoversRule("Write(/external/**)", rule);
// rule/parsed/covered 只描述规则；实际写入仍走 Runtime 审批链。
```

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
| `limit` | 返回行数，默认及最大均为 `2000`；通读无需手动拆成小页。 |
| `content`、`startLine`、`endLine`、`totalLines`、`truncated` | 仅为请求行区间的正文和分页元数据；模型不会收到未请求区间。 |
| `sha256` | 仅完整读取时返回完整原始字节 hash；部分读取返回 `null`。Core 仍在内部保存完整 hash 与已观察行区间，供后续 stale/read-before-edit 校验；`versionSha256` 标识实际扫描的版本，不代表已观察未返回的正文。 |

文件必须是经 canonical 路径检查的普通 UTF-8/UTF-16 文本。工作区外读取仍须通过既有外部读取权限与 deny/ask 收窄；绝对路径本身不构成授权。`read_file` 流式扫描原始字节：单次最多 `8 MiB`、单行最多 `64 Ki` 个 UTF-16 code units、单次 `content` 最多 `256 KiB`（UTF-8 编码字节）。超出扫描或单行上限时返回 `FILE_TOO_LARGE`；正文按 `256 KiB` 及约 `25,000` token 的本地保守估算预算选择连续完整行前缀（包含 JSON/canonical 工具结果包络，不是 Provider 精确计数，不调用计数 API），超预算时返回 `budgetTruncated` / `nextOffset` 供续读。首行本身无法放入预算时明确拒绝，不记录为已观察。非法编码或二进制返回 `BINARY_FILE`；取消返回 `EXECUTION_CANCELLED`。读取期间文件发生变化返回 `FILE_STALE`，宿主必须重新读取，不能把该结果用于编辑。

同一文件版本、同一 `offset/limit`，且旧成功结果的完整对应正文仍在当前模型可见上下文时，`read_file` 返回 `unchanged: true` 和明确复用提示，省略重复 `content`。每次仍扫描实际字节核对版本；换范围、外部变更或旧正文因压缩/裁剪丢失时重新返回正文，不以 mtime 或持久 read state 代替可见性证据。

`edit_file` 会按每个实际替换 span（包括行内子串）校验目标文本及其前后相邻行均位于同一已观察区间，并在写入前复核完整 hash 与 mtime；`replaceAll: true` 的每一处命中都必须通过该校验，范围外编辑返回 `FILE_NOT_READ`，并发变化返回 `FILE_STALE`。成功编辑只保留并按行偏移更新原有观察区间，绝不会把未读取的整份文件标记为已观察。为保持同一安全容量，超过 `8 MiB` 的文件也不能由 `edit_file` 编辑。`full_access` 不绕过这些限制。Turn 冻结沙箱模式为 `read-only` 时，`write_file` / `edit_file` 在锁内 mutation 前返回 `FS_SANDBOX_DENIED` 且磁盘零变化。

---

跨 Turn 重建保留已校验的 canonical reasoning 与合法协议 replay。Anthropic 同协议有合法 replay 时原样回放 thinking/signature；跨协议或旧无 signature 历史只投影公开正文/工具，不伪造 thinking。损坏的同协议 replay 继续拒绝。宿主项目指令/Memory 快照与 Skill 目录按受控槽位更新，相同配置保持前缀稳定，真实变化替换当前快照。Anthropic 仅把会话首部 system 放入顶层；中途运行提醒保留历史位置，以合法 user 消息的提醒包装发送，稳定安全/项目规则仍位于高优先级首部；Chat Completions 使用协议支持的原位置 system。

## 6. Provider、设置与模型能力

这些 API 供可信宿主在 Trust 后装配 Provider 与设置；不要在浏览器公开 Provider 解析结果或 `ResolvedCredential`。

### 6.1 模型采样器工厂

| API | 签名 | 用途 |
|---|---|---|
| `createDefaultModelSamplerFactory` | `(options?: ModelSamplerFactoryOptions) => ModelSamplerFactory` | 创建默认 Provider sampler 工厂；可通过 `options.adapters` 注入协议 Adapter，未提供时注册内置 Anthropic Messages、OpenAI Chat Completions 与 OpenAI Responses Adapter。带 `ModelRef` 的创建请求必须提供受支持且已冻结的 `providerConfig.apiProtocol`；未配置 `ModelRef` 时才使用 headless 回退。 |
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
| `listModelCapabilities` | `() => readonly ModelCapability[]` | 保留旧三项能力目录（DeepSeek v4 flash/pro 与 qwen3-vl-flash）；不列出新 Responses route 的完整目录。 |
| `getModelCapability` | `(provider, modelId) => ModelCapability \| undefined` | 精确查询模型能力。 |
| `resolveModelSampleOptions` | `(input) => ModelSampleOptions` | 从冻结模型引用解析协议层采样选项。 |
| `resolveFirstPartyModelSampleOptions` | `(modelRef, reasoningProfile, options?) => ResolvedFirstPartyModelSample` | 将 requested effort 解析为实际 Messages payload，并冻结 effective effort。 |
| `createDefaultModelBehaviorProfile` | `() => ModelBehaviorProfile` | 创建默认 Agent 行为规范。 |

`ApiProtocol` 为 `anthropic-messages | openai-chat-completions | openai-responses`。`ProviderRouteProfile` 包含 `id/apiProtocol/baseUrl/credentialRef/models`，可带 `protocolProfile` 与 `compatibilityPreset: "openai" | "deepseek" | "generic"`；模型条目可带 `contextWindowTokens`、`capabilities` 与独立 profile。Profile 是整对象选择，不按字段混合。

| API | 签名 | 契约与示例 |
|---|---|---|
| `resolveRouteModelCapability` | `(route: ProviderRouteProfile, modelId: string) => 能力声明 & { contextWindowTokens?: number }` | 合并精确目录与 route 模型覆盖，再应用预设硬限制/协议收窄。非法 effort、默认 effort 不在列表或放宽已知硬限制时拒绝。例：`const capability = resolveRouteModelCapability(route, modelId);`。返回结构可从函数返回类型推导，不是单独导出的命名类型。 |
| `resolveRouteProtocolProfile` | `(route: ProviderRouteProfile, modelId: string) => ProtocolProfile \| undefined` | 模型 profile 优先于 route；Responses 再校验兼容预设并补缺省 profile，冲突抛 `INVALID_PROTOCOL_PROFILE`。例：`const profile = resolveRouteProtocolProfile(route, modelId);`。 |

Responses profile 为 `{ apiProtocol: "openai-responses", reasoningReplay: "none" | "encrypted" | "content" }`；该分支通过公开 `ProtocolProfile` 使用，分支命名类型没有从根入口单独导出。Responses Adapter 由工厂按冻结协议选择；不因 endpoint 或模型名猜测协议。

`ModelSampleOptions.reasoningEffort` 为 `none | low | medium | high | xhigh | max`，实际可用值由冻结 route 的模型能力与协议共同收窄；Anthropic 不支持 `xhigh`。firstParty 对来自 CC `env.CLAUDE_CODE_EFFORT_LEVEL` 的明确 `max` 请求冻结并原样发送为 Messages `output_config.effort: "max"`；目标兼容端点不支持时必须返回其明确错误，Runtime 不得伪装回退为 `high`。

`ModelCapability.promptCacheMode` 是逐模型的提示缓存策略声明，也是唯一允许发送协议缓存标记的来源：`explicit` 表示必须由本端在协议允许的稳定前缀边界发送 `cache_control`（Anthropic Messages 的最后一个工具定义、`system` 与对话前缀末尾，最多三个断点）；`server-auto` 表示服务端自动前缀缓存、本端不发标记（DeepSeek 官方上下文缓存默认开启）；`none` 表示未确认或不启用客户端标记，不代表服务端一定没有缓存。未登记模型一律按 `none` 处理，不得因厂商品牌或“兼容 Anthropic”推断支持。只有 `explicit` 才规范化非 assistant 的字符串 content 与断点位置，其余模式保持既有请求形状。

### 6.3 设置 API

```ts
const settings = resolveAutopilotSettings(sources);
const normalizedBaseUrl = normalizeProviderBaseUrl("https://provider.example/v1/");
```

| API | 说明 |
|---|---|
| `resolveAutopilotSettings(sources)` | 按 User、Project、Local scope 归一化 Claude Code 风格的可信设置源，返回 `ResolvedAutopilotSettings` 和诊断。 |

| `normalizeProviderBaseUrl(value)` | 接受 `unknown`，规范化合法 HTTP(S) Provider base URL；不合法时返回 `undefined`。 |
| `createMutationCompletionPolicy(maxRecoveryAttempts = 1)` | 创建默认完成策略；`write_file` / `edit_file` 只有真实磁盘字节读回与预期 hash 一致后才返回 `diskVerified: true`，正常可靠写入无需额外模型 `read_file`；旧未验证路径仍要求绑定版本及完整范围读回，不从用户自然语言推断写入意图；用于 Agent 完成判断，不是 UI 规则。 |

User scope 可通过顶层 `maxOutputTokens` 配置单次模型输出上限，只接受 `1..1,000,000` 的安全整数。该值由新 Turn 冻结为 Provider `maxTokens`；Project/Local 不能覆盖，新 Turn 优先采用 `reasoningProfile.maxTokens`，再取此设置；未指定则取解析后模型能力的 `maxOutputTokens`，未知能力才回退 `8192`，同时受模型能力输出上限约束，且它与 Turn 累计预算 `maxTotalTokens` 无关。

`ResolvedAutopilotSettings` 消费顶层 `env`、`model`、`availableModels`、`modelOverrides`、`alwaysThinkingEnabled`、`effortLevel`、`maxTurns`，以及受 scope 限制的 `providerRoutes`、`maxOutputTokens`、`webSearch`、`visionModel`、`rag`、`sandbox` 与 `permissions` 子集。`webSearch:false` 显式禁用并产生 `webSearchDisabled:true`，阻止默认继承；连接对象必须精确为 `{ provider, baseUrl, model, credentialRef: { provider, key } }`，其中 provider 当前只接受 `deepseek | openai-compatible | xiaomi-mimo` 且必须与凭据引用一致；Project/Local 覆盖拒绝。快照产生不含明文 Key 的完整 `ResolvedWebSearchSettings`，旧的 DS-only `{ credentialRef }` 形状兼容规范化为官方 Anthropic 地址和 deepseek-flash 模型，具体 provider 是否受支持仍由 Node Adapter 注册边界判断。User `env` 白名单包含 `ANTHROPIC_BASE_URL`、二选一的 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`、模型 alias、`CLAUDE_CODE_EFFORT_LEVEL`、compact window、timeout 及三个 Search 固定凭据字段；Project/Local 不得提供这些 `env` 字段。`ANTHROPIC_MODEL` 优先于顶层 `model`；Opus/Sonnet/Haiku alias、单跳 `modelOverrides` 和 User allowlist 会在同一快照中收敛。`modelCandidates` 是不含凭据的内部候选目录：显式 `availableModels` 优先，缺失时由主模型、三个默认 alias 与 subagent 模型稳定去重生成；Project/Local 不能向其中注入候选。认证原文不会进入快照，只有受控 `credentialRef` 可供受信任 Node 宿主延迟解析。顶层 `effortLevel` 只接受 `low | medium | high`；显式 `max` 必须来自 `env.CLAUDE_CODE_EFFORT_LEVEL`，并在 Messages payload 中原样冻结。`CLAUDE_CODE_SUBAGENT_MODEL`、自动压缩阈值和 Provider timeout 会冻结到 Turn 私有配置；当前 Runtime 未创建子 Agent，不会拿该字段替换主模型。`schemaVersion`、`providers.*`、`models.primary`、`models.vision` 等旧结构一律返回诊断且不转换；未知 Claude Code 顶层字段不进入 Runtime 快照。

User-only `visionModel` 可为受信 `providerRoutes` 中的 `route/model` 字符串或 `false`，产生 `ResolvedAutopilotSettings.visionModelRef?: ModelRef | false`。显式旧视觉 route 当前只接受 OpenAI Chat Completions；视觉分析器支持该协议及主连接 Anthropic Messages（含 anthropic-version 头）；非法模型/协议安全关闭并返回诊断，Project/Local 不能覆盖。未声明时 Web/CLI 默认继承主连接，Web 仅在缺少主连接时兼容旧 env；false 明确关闭。Web/CLI 将该角色映射到既有 `providerSettings.visionModelRef/vision`，Core 对当前 Turn 冻结路由；Chat 继续运行仍使用冻结路由，且当前 Host 撤销能力仍能阻断访问。

User route 的 `models[]` 条目可声明可选 `contextWindowTokens`（1..10_000_000 的安全整数；越界、浮点或字符串等非法值按既有风格整体拒绝该 route 并报 `SETTINGS_PROVIDER_ROUTE_INVALID`；缺省保持原快照形状）。冻结链以解析后的 route 模型能力为依据：目录、route 的 `models[].capabilities` 与 `contextWindowTokens` 合并，再应用预设硬限制及协议收窄，生成 `FrozenProviderConfig.contextWindowTokens`，窗口到位后 Context 预算与 `turns.getContextUsage()` 投影自动恢复，缺省或窗口不足（不大于输出预留加安全缓冲）时仍 fail closed 为 unknown。

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
- `WebSearchCapabilityError(code, message)` 的 code 为 `CAPABILITY_UNAVAILABLE | WEB_SEARCH_PROVIDER_REJECTED | WEB_SEARCH_RATE_LIMITED`。`WebFetchCapabilityError(code, message, redirect?, blockReason?)` 的 code 为 `WEB_URL_BLOCKED | WEB_REDIRECT_REQUIRES_APPROVAL | WEB_RESPONSE_TOO_LARGE | WEB_CONTENT_TYPE_UNSUPPORTED`，可选 `redirect: { url: string; remainingRedirects: number }` 只用于跨域重新审批；它是进程内数据，不能序列化进错误、事件或 checkpoint。可选的 `WebFetchBlockReason` 仅为 `WEB_URL_BLOCKED` 区分 `url_not_allowed`、`dns_failed`、`non_public_address` 和 `redirect_rejected`。Core 将这些原因映射为固定安全文案，未识别的原因使用通用提示。
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

### 6.5 Work preview capability

Core 的 Work 预览能力方法与 DTO（仅 Web Work 宿主装配，Chat/CLI 不提供）：

```ts
interface WorkPreviewCapability {
  preparePreview(request: WorkPreviewPrepareRequest): Promise<WorkPreviewPrepareResult>;
}
interface WorkPreviewPrepareRequest {
  url: string;
  jobId?: string;
  openWhen: "now" | "after_turn";
  workspaceId: string;
  sessionId: string;
  turnId: string;
  callId: string;
  signal?: AbortSignal;
}
interface WorkPreviewPrepareResult {
  previewId: string;
  hostLabel: string;
  copyUrl: string;
  openWhen: "now" | "after_turn";
  state: "prepared";
  jobId?: string;
  autoOpen?: boolean;
}
```

- `open_preview` 工具仅在受信宿主经 `CapabilityLoader.loadWorkPreview` 注入能力且存在 `{workspaceId, sessionId, turnId}` Turn 绑定的 Work Turn 注册；Chat 与 CLI 永不注册，override 注入能力或 loader 不生效。工具 metadata 为有副作用、串行（`workspace:open-preview`）、有界超时 35s、不自动重试；默认需要审批，URL模式审批预览只含 `url`、`jobId`、`openWhen`；静态模式改为相对 `staticPath`、固定服务动作及 `openWhen`。
- `open_preview` 输入支持 `url` 与 `staticPath` 二选一；`staticPath` 仅已存在的工作区内规范相对 `.html/.htm/.md/.markdown`，拒绝路径逃逸/隐藏段及外部canonical目标，不接受模型提供jobId。有Jobs能力时，经现有ToolExecutor沙箱/Windows宿主逐次确认后，仅复用同Session、同文件、同固定服务脚本的自有Job，或以固定Node单文件服务启动一个Job；端口由系统分配，不猜默认端口。服务仅loopback并仅公开所选HTML或安全渲染的Markdown（不提供目录/相邻资源），不接收任意命令。实际origin+文件名经既有PreviewService归属/就绪核验后prepared，停止和生命周期仍归同一Job；启动/归属不明失败不盲重启。CLI/Chat不新增该能力。
- `workPreviewEnabled` 在新 Turn 冻结进 `FrozenRunConfig`（缺省 false），只由受信宿主 `runtimeDefault.workPreview` 的存在性计算，override 不可开启；旧 Turn 继续时不开新能力。`workPreviewLoader` 在每个 Work Turn 开始前重新解析，宿主内部复查 Trust，失效即抛 `WorkspaceTrustError`。
- `preparePreview` 的身份四元组由 Runtime 绑定注入，宿主负责目标策略校验、Job 归属与本地就绪；Core 在审批前拒绝确定无效的 HTTP(S) 参数，并调用宿主可选纯 validatePreviewTarget；不发网络，完整目标策略仍由宿主复核。URL模式的Core不读取网页或执行进程。静态单文件模式见下文，经同一ToolExecutor进程边界和JobService准备。成功结果只表示"预览请求已准备"，实际显示由用户端处理。
- 模型可见输出仅为 `{ previewId, state: "prepared", openWhen }`（无法证明服务归属时附带 `autoOpen: false`）；`hostLabel` 与 `copyUrl`（等于实际页面地址）只通过受控展示明细 `ToolDisplayDetail.kind = "open_preview"` 进入展示层，任一字段非法时明细 fail-closed 省略。durable checkpoint 对 `open_preview` 输入使用与 Web 工具相同的 `{ redacted: true }` 占位，原始参数只在当前 Runtime 短期暂存用于审批恢复。
- 结果尾部展示明细可携带 `jobId`（宿主核验后的受管 Job 绑定）与 `autoOpen`（false 表示无法证明服务归属，只能由用户显式打开）；`jobId` 是宿主写入的机器字段，模型传入的 `request.jobId` 不参与绑定。

最小宿主示例（均在 Trust 后；仅 Web Work 宿主装配）：

```ts
import type { WorkPreviewCapability } from "@autopilot-agent/core";

const loader = {
  async loadWorkPreview(workspaceRoot: string): Promise<WorkPreviewCapability | undefined> {
    // 宿主在此执行目标策略校验、Job 归属与本地就绪探测；
    // 返回的 preparePreview 只准备导航交付，绝不返回网页内容。
    return createWebWorkPreviewService({ workspaceRoot });
  },
};
```

### 6.6 Desktop BrowserCapability

Core公开BrowserCapability、BrowserBinding与BrowserOperation宿主中立类型，以及严格单动作解析函数parseBrowserOperation；CapabilityLoader.loadBrowser在Trust后注入，RunConfig.browser/browserLoader仅从runtimeDefault装配。browserEnabled 记录冻结能力，旧回合缺失时不能在恢复阶段新增能力。Chat 恒不装配。受管 Work Session 从可信 hostToolsLoader 的精确绑定结果取得 browser capability，忽略 Runtime 的通用浏览器装配。Turn override 无法替换能力。

`BrowserBinding` 为 `{ sessionId: string; turnId: string }`。`BrowserCapability.request(binding, callId, operation, signal?, authorization?)` 返回宿主动作结果。`BrowserRequestAuthorization` 来自可信 Runtime 执行上下文，携带当前权限档。`approvedOnce` 仅在消费当前动作的单次批准后传入。声明 `managesApprovals: true` 的宿主处理网页动作和 document 的确认，前提是已有完整的实际目标与归属校验。`confirmsDocument: true` 继续兼容只接管完全访问 document 确认的原宿主。`endTurn(binding)` 撤销回合授权和占用。`parseBrowserOperation(value)` 只接受固定单动作。`isPublicBrowserUrl(url)` 与 `isPublicBrowserRead(operation, pageUrl?)` 通过地址文本识别公开目标候选，宿主用真实页面 URL 复核观察目标。仍由 Core 负责的网页审批显示同标签、同代次的站点和元素引用，隐藏路径、查询和片段。

```ts
import { parseBrowserOperation } from "@autopilot-agent/core";

const operation = parseBrowserOperation({ type: "open", url: "https://example.com" });
// capability、binding、callId 和 signal 均由受信宿主/工具上下文提供。
const result = await capability.request(binding, callId, operation, signal);
```

原生browser工具限定一次结构化动作并使用真实sessionId/turnId/toolCallId及取消信号，不接受模型自报身份、任意JS/CDP或批量脚本。宿主负责统一once/本回合always审批；Core仍保留工具目录与策略边界。endTurn在真实终态调用；awaiting_approval/awaiting_user_input暂停不撤销同回合授权。CLI在Trust后以Desktop原生凭据装配该能力，连接和会话身份不进入模型参数。截图复用会话图片Store，原始base64不进入transcript；Store不可用时返回图片缺失说明。

原生模型工具 `browser` 的本地文档入口为 `{type:"open",staticPath:"工作区相对.md/.markdown/.html路径"}`，与URL二选一；仅在受信Job绑定存在时，经原进程沙箱/审批复用既有单文件预览Job，再以Runtime真实身份调用浏览器open。该兼容字段不进入宿主线协议。共享 `BrowserOperation` 另支持 `{type:"document",path:"所选文件"}`：相对路径按受管工作区解析，允许明确指定的外部绝对Windows/macOS路径；Desktop先解析canonical单文件，再由既有BrowserAccess确认。当前turn对同一canonical文件的授权可复用，既有浏览器always不放开其他文件。HTTP(S)动作保持原契约。Markdown仅渲染基础标题、段落、列表、代码与强调，原始HTML转义，CSP禁止脚本和远程资源；仅提供所选文件，Markdown最多2MiB。

Node宿主可消费公开常量 `STATIC_PREVIEW_SCRIPT` 复用固定单文件服务；它不是模型脚本入口，调用者负责精确文件授权与服务生命周期。既有Job按原端口/文件名路由使用；Desktop页拥有Worker可申请随机端口和不透明单文件路由，关页/清空/初始化取消时回收。`parseBrowserOperation` 对file URL抛出 `BROWSER_FILE_URL_USE_DOCUMENT`（先document，再以返回的pageId/revision截图），document扩展名不是md/markdown/htm/html时抛出 `BROWSER_DOCUMENT_UNSUPPORTED`，其他非法动作抛出 `BROWSER_ACTION_INVALID`，不暴露Zod参数正文。

浏览器固定单动作补充支持 wait(pageId,revision,condition="load",timeout)，timeout 为 1–30000 毫秒，返回 loaded/timedOut。downloads(pageId,revision) 仅返回该页下载摘要，cancel-download(pageId,revision,id) 仅取消该页指定下载，均复用原生身份、单动作审批及占用校验。pageId为UUID，revision为非负整数，使用当前宿主结果中的身份及新鲜snapshot引用。Desktop宿主的list仅列调用者所属工作区页面，跨工作区pageId拒绝；后台操作保留当前选中页，显式open/select只在所属工作区切页/展开。工作区归属和审批由宿主负责，不由中立BrowserBinding新增字段。完整动作参数见 [CLI浏览器命令](CLI-Reference.md#13-desktop-浏览器browser)。同页在途动作的所属调用者和回合可经审批应答当前 JS 对话框，原执行位保持占用；人工应答先撤销授权并取消原动作，再直接应答以解除阻塞，停止结果仍需确认。弹窗打开/关闭使旧 revision 失效。

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

V2 `tool-result` 可选携带 `images`，每项为与普通图片相同的 `{ type: "image-ref", id, sha256, width, height }`，最多十项；`content` 仍只含文本。旧纯文本记录无需改写或提升 durable schema。Anthropic 在对应 `tool_result.content` 中生成图片块；Chat Completions 在同批所有 tool 结果闭合后追加带来源标注的图片 user 消息，避免打断多工具配对。压缩器计入工具图片估算，摘要仅保留图片占位，不凭引用编造视觉事实。

### 8.6 知识资源身份辅助 API

| API | 签名 | 说明 |
|---|---|---|
| `createKnowledgeResourceId` | `() => string` | 生成 `resource_` 加 32 位小写十六进制随机标识，不从文件名或内容派生。 |
| `isKnowledgeResourceId` | `(value: string) => boolean` | 校验资源标识形状；不接受路径或任意文件名。 |
| `deriveKnowledgeTableName` | `(resourceId: string, embeddingSpaceId: string) => string` | 按资源标识与完整 Embedding 空间派生稳定物理表名；资源标识非法或 Embedding 空间为空时抛 `RAG_STORAGE_INVALID`。 |

宿主应保存 `resourceId` 与 `embeddingSpaceId`，不要自行拼接 LanceDB 物理表名；资源表名属于 Core 存储实现细节。

### 8.7 `listWorkspaceFiles(input)`：工作区文件枚举

枚举工作区文件，返回稳定排序的工作区相对路径列表；供 CLI `@文件` 候选索引等宿主能力复用。它不是模型工具，不进入工具目录，也不经过审批链。

枚举使用固定 ripgrep 参数，保留工作区内的忽略规则并跳过目录链接。环境中的 ripgrep 配置不会更改候选范围。

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

### 8.8 `resolveWindowsPackageManagerCommand(program, args)`

签名：`(program: string, args: readonly string[]) => { executable: string; args: string[] } | null`。受信 Node 宿主在准备结构化进程调用时复用；例如 `const command = resolveWindowsPackageManagerCommand("npm", ["--version"]);`。非 Windows 或非 npm/npx/pnpm（可带 `.cmd`）返回 `null`；Windows 匹配时在当前 Node 安装及受限系统安装位置查找固定 CLI，核对 realpath 后返回当前 Node executable 与 CLI argv，不执行命令。

可信 CLI 不可用时通常抛 `SandboxPortError` / `SANDBOX_UNAVAILABLE`，部分非 ENOENT 文件系统错误仍可能原样拒绝；调用方不得回退 shell 拼接，也不得直接展示底层错误。解析成功不等于工具审批或沙箱准备成功。

## 9. 公开类型索引

以下类型均从默认入口导出。使用时优先 `import type`；字段很多的 DTO 以 TypeScript 声明为准，本手册在相关 API 小节说明其输入输出语义。

| 分类 | 公开类型 |
|---|---|
| 基础 RAG | `VectorInput`、`VectorOutput`、`ChatMessage`、`AgentToolCall`、`IngestOptions`、`IngestResult`、`IngestProgressEvent`、`ParseExcelOptions`、`ExcelIngestOptions`、`ExcelIngestResult`、`SheetInfo`、`AskStreamOptions`、`RAGAgent`、`RAGAgentOptions`、`RAGQuerier`、`RagErrorCode`、`RagStorageOptions`、`KnowledgeResource`、`DeleteKnowledgeResourceResult`、`KnowledgeResourceManifest`、`KnowledgeResourceStatus`、`PdfPageMetadata`、`RagEvidence`、`TableProfile` |
| Runtime facade | `AgentRuntime`、`AgentRuntimeFacade`、`CreateAgentRuntimeOptions`、`RuntimePorts`、`ThreadStore`、`ThreadHostContext`、`ThreadFacade`、`ThreadActor`、`ThreadControl`、`ThreadEvent`、`ThreadMessage`、`ThreadProgressEntry`、`ThreadProgressKind`、`ThreadProgressView`、`AgentThreadProgressPage`、`SessionStore`、`CheckpointStore`、`TranscriptStore`、`CredentialStore`、`ProjectStore`、`EventSink`、`Clock`、`WorkspaceAdapter`、`WorkspaceInfo`、`TurnStore`、`ApprovalStore`、`InputInbox`、`LeaseStore`、`JobStore`、`JobStoreWriteCondition`、`JobOwnerProbe`、`FileMutationStore`、`SessionResourceStore`、`UserQuestionStore`、`GetUserQuestionInput`、`SaveUserQuestionAnswerInput`、`SaveUserQuestionAnswerResult`、`ProjectService`、`SessionService`、`CreateSessionInput`、`TurnService`、`TurnState`、`ApprovalService`、`InputInboxService`、`UserQuestionService`、`UserQuestionSubmissionService`、`AgentUserQuestionCapability`、`CreateUserQuestionRequestInput`、`SubmitUserQuestionAnswerInput`、`JobService`、`SessionJobService`、`UndoService`、`UndoPreview`、`UndoResult` |
| Runtime domain | `ProductMode`、`ChatRetrievalMode`、`CapabilityCeiling`、`Session`、`SessionPersistenceMode`、`SessionStatus`、`Project`、`CreateProjectInput`、`Turn`、`TurnStatus`、`Job`、`JobStatus`、`JobOwner`、`JobOwnerLiveness`、`JobControlState`、`JobLastControl`、`JobView`、`JobListView`、`JobReadView`、`JobOutputSnapshot`、`JobSafeOutputSnapshot`、`JobSafeOutputStreamSnapshot`、`JobSafeOutputStreamView`、`JobOutputView`、`StartJobInput`、`PollJobInput`、`JobPollResult`、`FileMutation`、`FileMutationOperation`、`FileMutationStatus`、`PrepareFileMutationInput`、`UndoTransaction`、`UserQuestionOption`、`UserQuestionItem`、`UserQuestionAnswerItem`、`UserQuestionRequest`、`UserQuestionAnswer`、`StoredUserQuestion`、`TodoStatus`、`TodoItem`、`TodoCounts`、`TodoSnapshot`、`TodoWriteResult`、`ModelRef`、`ReasoningEffort`、`ReasoningProfile`、`SessionRunConfig`、`FrozenRunConfig`、`CredentialRef`、`ResolvedCredential` |
| Turn 协议 | `ChatCapabilityBinding`、`ChatCapability`、`ChatAttachmentGrant`、`ChatKnowledgeCapability`、`ChatRagEvidenceBatch`、`ChatRagEvidence`、`UiDocument`、`RunConfig`、`ResolveRunConfigInput`、`CompactPolicy`、`ProviderRuntimeSettings`、`LimitConfig`、`ResolvedAgentRuntimeLimits`、`AgentRuntimeSafetyLimits`、`StartTurnInput`、`ContinueTurnInput`、`CancelTurnInput`、`SteerTurnInput`、`CompactTurnInput`、`CompactTurnResult`、`AgentEvent`、`AgentEventEnvelope`、`CreateEventEnvelopeInput`、`AgentMessage`、`AgentMessageRole`、`AgentJsonObject`、`AgentContentBlock`、`AgentToolPairingScan`、`AgentCheckpoint`、`PublicCheckpointView`、`FrozenRunConfigView`、`AgentTerminationBudget`、`AgentTerminationReason`、`AgentTerminationView`、`RecoverableTurnStatus`、`RecoverableApprovalView`、`RecoverableTurnView`、`AgentMessageMigrationSuccess`、`AgentMessageMigrationFailure`、`AgentMessageMigrationResult`、`AgentErrorCode` |
| 审批与输入 | `ApprovalDecision`、`PersistentGrant`、`SubmitApprovalInput`、`FindPersistentGrantInput`、`InboxInput`、`InboxDelivery`、`InboxStatus`、`InboxBoundary`、`InboxAttachmentRef`、`InboxSkillRef`、`PostInboxInput`、`DrainInboxInput`、`ClaimNextInboxInput`、`ConsumeInboxInput`、`ListInboxInput` |
| 工具 | `ToolPermissionMode`、`ToolApprovalDecision`、`ApprovalDisplayFacts`、`ToolDisplayFacts`、`ToolDisplayDetail`、`ToolJobDisplayFacts`、`ToolApprovalRequest`、`ToolExecutionRequest`、`ToolExecutionOptions`、`ToolExecutionResult`、`ToolExecutionMeta`、`ToolInterruptionState`、`ToolError`、`ToolEvent`、`ToolModelDefinition`、`ToolActionFacts`、`ToolPolicyResult` |
| Context/Skill/MCP/Web | `AgentContextSnapshot`、`ContextBudgetSnapshot`、`ContextUsageView`、`ContextUsageBreakdownView`、`ContextUsageCategoryKind`、`ContextUsageCategoryView`、`TurnUsageSummaryView`、`FrozenInstruction`、`FrozenMemorySnippet`、`AgentSkillsCapability`、`SkillCatalogEntry`、`SkillDiscoveryCandidate`、`LoadedSkill`、`SkillResource`、`PreparedSkillCommand`、`McpCapability`、`McpServerConfig`、`WebCapability`、`WebSearchCapability`、`WebSearchCapabilityError`、`WebSearchCapabilityErrorCode`、`WebSearchResult`、`WebSearchSource`、`WebFetchCapability`、`WebFetchCapabilityError`、`WebFetchCapabilityErrorCode`、`WebFetchResult`、`WorkPreviewCapability`、`WorkPreviewPrepareRequest`、`WorkPreviewPrepareResult`、`WorkPreviewOpenWhen` |
| Provider/设置 | `ModelSampler`、`ModelSamplerFactory`、`CreateModelSamplerInput`、`ModelSamplerFactoryOptions`、`CreateFirstPartyModelSamplerInput`、`ModelSampleOptions`、`ModelCapability`、`PromptCacheMode`、`FirstPartyEffortSource`、`ResolvedFirstPartyModelSample`、`ModelBehaviorProfile`、`VisionAnalyzer`、`FrozenProviderConfig`、`ApiProtocol`、`ProtocolProfile`、`ProviderRouteProfile`、`ProviderProtocolAdapter`、`ProviderProtocolAdapterInput`、`CompletionDecision`、`CompletionIntentSignal`、`CompletionPolicy`、`CompletionPolicyState`、`AutopilotSettingsScope`、`AutopilotSettingsSource`、`ResolvedAutopilotSettings`、`ResolvedFirstPartySettings`、`ResolvedRagConnectionSettings`、`ResolvedRagSettings`、`RagConnectionRole`、`ResolvedWebSearchSettings`、`SettingsDiagnostic` |
| Trust/Bootstrap | `SafeBootstrapConfig`、`WorkspaceTrustEntry`、`WorkspaceTrustStatus`、`WorkspaceTrustPolicy`、`CapabilityLoader`、`CreateRuntimeBootstrapServiceOptions`、`RuntimeBootstrapService` |
| 快照、资源与 Rerank | `DatabaseError`、`DatabaseErrorCode`、`MySQLSourceConfig`、`DatabaseSnapshotConfig`、`DatabaseInspection`、`DatabaseSyncResult`、`DatabaseSnapshotReadCapability`、`SnapshotColumnDescription`、`SnapshotTableDescription`、`SnapshotQueryResult`、`DatabaseSearchCapability`、`CreateDatabaseSearchCapabilityOptions`、`DatabaseSearchPolicy`、`DatabaseSearchRequest`、`DatabaseSearchResult`、`DatabaseAggregationKeyword`、`DatabaseFilterOperatorKeyword`、`DatabaseQueryProfile`、`DatabaseQueryPlan`、`DatabaseQueryPlannerInput`、`RagSourcePolicy`、`KnowledgeResource`、`DeleteKnowledgeResourceResult`、`RerankPolicy`、`RerankRuntime`、`RerankOutcome`、`RerankResult`、`RerankVisionImage`、`RerankRole`、`RerankDocument`、`RerankProviderRequest`、`RerankProviderResult`、`RerankProviderAdapter` |
| 兼容 Agent | `AgentOptions`、`AgentInstance`、`PublicCompactInput`、`AgentCompactionResult`、`AgentInjectedInput`、`AgentInputInboxCapability`、`AgentLease`、`AgentRunInput`、`RagCapability` |
| 执行事实与协作 | `RuntimeFact`、`RuntimeFactSnapshot`、`RuntimeFacts`、`TurnExecutionView`、`ThreadEventActor`、`ThreadGroup`、`ThreadMember`、`ThreadReceipt`、`ThreadCreateIntent`、`ThreadDelivery`、`ThreadDeliveryReason`、`ThreadControlIntent`、`ThreadHandoffInput`、`ThreadHandoffRef`、`ThreadHandoffDocumentInput`、`ThreadHandoffDocument`、`ThreadHandoffWriter`、`WaitResult`、`WaitTargetResult`、`ThreadsCapability`、`AgentThreadsCapability`、`AgentThreadMemberView`、`AgentThreadMessageView`、`AgentThreadReadResult`、`ThreadDeliveryHostContext`、`ThreadDeliveryService`、`ThreadStartDelivery`、`ThreadReconcileResult` |
| 沙箱、外部权限与宿主保护 | `SandboxMode`、`SandboxEnforcement`、`SandboxPolicy`、`SandboxCapabilityReport`、`SandboxExecutionRequest`、`SandboxPreparedCommand`、`SandboxErrorCode`、`SandboxPort`、`ManagedExecutionControl`、`ManagedExecutionChannel`、`SandboxDegradeApproval`、`ExternalPermissionProjector`、`ExternalPermissionSnapshot`、`ExternalFileOperation`、`ParsedExternalPermissionRule`、`ExternalFileApproval`、`ExternalExecutionTarget`、`ExternalExecutionApproval`、`ExternalExecutionAuthorization`、`ExternalWriteCapability`、`HostMutationProtection`、`ProtectedMutationTarget`、`ResolvedExternalPermissionSettings`、`ResolvedSandboxSettings` |
| 图片、目录与浏览器 | `SessionImageStore`、`SessionImageRef`、`SessionDirectoryPage`、`SessionDirectoryQuery`、`SessionDirectoryEntry`、`BrowserCapability`、`BrowserBinding`、`BrowserOperation`、`BrowserRequestAuthorization`、`InboxOrigin`、`JobExecutionFacts`、`WebFetchBlockReason`、`AgentProviderFailureReason` |
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
  // Kernel 原始事件尚未脱敏；跨宿主展示前调用 sanitizeEventForExternal(event)。
  // 持久化及 lease 仍由调用方负责。
}
```

`RunContext` 是 Kernel 的依赖注入对象，主要字段如下；完整结构以实验性入口类型声明为准：

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
| `createReadFileTool()` | `read_file` | `{ path, offset?: number, limit?: 1..2000 }` | 默认从第 1 行读取最多 2000 行；已知目标位置时按 offset/limit 定位。只读；支持 UTF-8/UTF-16 文本，单次扫描最多 8 MiB、返回正文最多 256 KiB，按约25K token保守估算及字节预算返回连续完整行前缀与续读位置；同版本同范围且旧正文可见时返回短提示；二进制拒绝。 |
| `createEditFileTool()` | `edit_file` | `{ path, oldString, newString, replaceAll?: boolean }` | 写入；必须先由 `read_file` 建立可信观察范围，限制在已观察行内编辑并校验文件未变化。 |
| `createWriteFileTool()` | `write_file` | `{ path, content, expectedSha256? }` | 写入；新建可不传 hash，覆写已有文件必须回传 `read_file` 给出的 SHA-256。 |
| `createRunCommandTool()` | `run_command` | `{ program, args?: string[], cwd?: ".", timeoutMs?: 1..120000 }` | 默认超时 30 秒，最大 120 秒；以 `shell: false` 执行单个前台命令；不支持管道、多命令或交互输入，stdout/stderr 固定内存保留。任一路输出首次超过 30KB 时全文落盘到工作区相对路径 `.autopilot/tmp/<turnId>/<安全 callId>-<哈希>.<stdout\|stderr>.log`，结果追加 `spilledOutput`（按流给出相对路径）与 `spillHint`（提示用 `read_file` 分段回读）；未超限不生成临时文件；冻结 read-only 不落盘并提示截断内容无法回读；落盘失败照常返回内存结果，不把成功调用变成 `isError`。 |

工具构造函数不是浏览器 API。调用方必须只注入已 canonicalize 的 `workspaceRoot`，传递 `AbortSignal`，并将 `ToolExecutionContext` 中的授权回调和 mutation store 绑定到可信宿主状态。不得直接调用工具 `execute()` 绕过 `ToolExecutor`；写入和进程调用仍须经统一能力、Policy 与适用审批链。

### 10.4 `ToolRegistry`

```ts
class ToolRegistry {
  constructor(ceiling?: CapabilityCeiling);
  register<TInput, TOutput>(definition: AgentToolDefinition<TInput, TOutput>): void;
  unregister(toolName: string): void;
  get(toolName: string): AgentToolDefinition<unknown, unknown>;
  getModelDefinitions(): ToolModelDefinition[];
}
```

- `register()` 先按产品能力上限过滤（不在上限内时不注册），再拒绝非法/重复工具名、非法 metadata 或缺少本地 `createActionFacts` 的定义。
- `unregister()` 只供受控 capability 生命周期在 shutdown 后移除临时工具；不要在运行中替换工具实现。
- `get()` 未找到时抛稳定 `TOOL_NOT_FOUND` 错误。
- `getModelDefinitions()` 过滤 `isAvailable() === false` 的定义，仅投影名称、说明和 JSON Schema，不包含 handler、权限、路径或凭据。

`@autopilot-agent/core/internal/*` 不属于公共契约。不得为了获取私有 checkpoint、Provider 请求、工具 handler、数据库连接或文件路径而引用它；任何输出到浏览器的数据仍须经过 Runtime 的脱敏 DTO/事件边界。
