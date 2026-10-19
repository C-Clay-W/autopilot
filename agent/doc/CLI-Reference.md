# CLI 命令参考（@autopilot-agent/cli）

> 面向终端用户的 CLI argv 命令与交互 slash 命令手册。命令解析的源码真相位于 `apps/cli/src/parser.ts`，命令编排位于 `apps/cli/src/main.ts`，交互 slash 行为位于 `apps/cli/src/controller.ts`。本文档只描述当前可用命令，不记录 Phase、Stage 或开发过程。

## 文档维护规则

每次变更 CLI 命令时必须遵守：

1. **以源码为准**：先核对 `apps/cli/src/parser.ts`、`main.ts`、`controller.ts` 的命令解析、编排与 slash 行为；不得以旧 Plan、旧 dist 或历史记录为依据。
2. **按命令就地更新**：已有命令的参数、语义、安全边界或退出码变化时，更新它原有小节；只有新增命令或 slash 命令时才新增小节，禁止在文末追加“本次新增”“Stage xx”一类内容。
3. **每个命令完整说明**：写明用法、参数、语义、安全边界、退出码和最小示例；涉及 Trust、确认、allowlist 或 fail-closed 时必须单独写出。
4. **示例用占位值**：不写真实密钥、绝对个人路径、内部状态或 Provider 响应。
5. **稳定边界清楚**：本文档覆盖 `@autopilot-agent/cli` 的 argv 命令与 slash 命令；Core 编程 API 见 `Core-API.md`，不在本文档范围。

---

## 目录

1. [入口与全局约定](#1-入口与全局约定)
2. [会话与聊天](#2-会话与聊天)
3. [项目管理](#3-项目管理)
4. [Session 管理](#4-session-管理)
5. [信任管理](#5-信任管理)
6. [配置管理](#6-配置管理)
7. [诊断](#7-诊断)
8. [MCP 管理](#8-mcp-管理)
9. [后台 Job 管理](#9-后台-job-管理)
10. [撤销（Undo）](#10-撤销undo)
11. [交互 slash 命令](#11-交互-slash-命令)

---

## 1. 入口与全局约定

### 1.1 命令形态

CLI 提供两个等价的 bin 名：`autopilot`（主命令）与 `ap`（等价别名），均指向同一入口。裸命令（不带任何子命令）等价于 `autopilot chat` 并进入交互聊天。

### 1.2 全局选项

| 选项 | 作用 |
|---|---|
| `-h, --help` | 显示帮助文本 |
| `--workspace-root <path>` | 指定 canonical 工作区根 |
| `--state-root <path>` | 指定 durable Runtime 状态根（默认用稳定 workspace identity 解析） |
| `--trust-root <path>` | 指定 Trust 记录根 |
| `--session <id>` / `-s <id>` | 指定 Session |
| `--output <interactive\|text\|jsonl>` | 输出格式 |
| `--jsonl` | `--output jsonl` 的等价简写 |
| `--scope <user\|project\|local>` | `config` 命令的 scope，必须显式提供 |
| `--yes` | 确认类命令（session delete / mcp approve / undo）跳过交互确认 |
| `--connectivity` | `doctor` 的 Provider 连通探测开关 |

### 1.3 无色启动

TUI 是否输出 ANSI 颜色由 `NO_COLOR` 环境变量控制。变量只要是非空值就会关闭颜色；`NO_COLOR` 不是 `ap` 的 argv 子命令，不能写成 `ap NO_COLOR`。

Windows CMD：

```bat
set "NO_COLOR=1" && ap
```

该设置会保留在当前 CMD 会话中；恢复彩色时执行：

```bat
set "NO_COLOR="
```

macOS/Linux：

```bash
NO_COLOR=1 ap
```

这种写法只对本次 `ap` 进程生效。以上命令中的裸 `ap` 会进入交互聊天；需要执行其他 argv 命令时，将 `ap` 替换为对应命令即可。

### 1.4 输出格式

- `interactive`（默认）：有 TTY 时使用 Ink TUI，无 TTY 时回落到纯文本。
- `text`：纯文本渲染。
- `jsonl`：逐事件输出 JSONL，**永不输出 ANSI 或交互提示**，适合脚本管道。

Todo 任务链在三种输出中的一致行为：模型通过 `todo_write` 工具更新任务链时产生 `todo_updated` 安全事件（字段仅含 `todos` 与 `counts`，不携带 raw Tool args）。`text` 每次更新输出一行稳定摘要 `todo: <completed>/<total> completed[ · in progress: <activeForm>]`；`jsonl` 输出完整安全事件对象；`interactive` 动态区以单卡显示，详见 2.2。

终态状态事件可带有 `termination: { reason?, recoverable, budget? }`：原因仅来自 Core 固定白名单，`recoverable` 是 Core 的布尔判定；可选预算只含 `used/limit/unit`，其中执行时长单位为 `ms`、Token 单位为 `tokens`。`text`、`jsonl`、交互时间线与备用 viewport 显示同一安全摘要。旧事件缺少投影时不补造原因或数值；Provider 原始错误、凭据和路径不会透传。

### 1.5 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 成功或正常退出 |
| `1` | 运行时错误 |
| `2` | 用法错误（未知命令、缺参数、缺 `--yes`、非法值等） |
| `130` | 收到 SIGINT |
| `143` | 收到 SIGTERM |

### 1.6 Trust 门禁

以下命令**不要求**工作区已 Trust，可离线只读执行：

```
autopilot project list | current | remove
autopilot doctor
autopilot sandbox status
autopilot trust status | revoke
autopilot config ... --scope user
```

以下命令**要求**工作区已 Trust，未 Trust 时向 stderr 输出 `WORKSPACE_TRUST_REQUIRED: <status>` 并以退出码 1 结束：

```
autopilot chat | resume
autopilot session list | rename | delete
autopilot project open
autopilot mcp list | approve | revoke
autopilot job list | show | kill
autopilot undo --session <id> --yes
autopilot sandbox setup --yes
autopilot config ... --scope project|local
```

例外：`autopilot project open` 与交互式 `autopilot chat` 在 TTY 下会触发 Trust 确认对话框，用户确认后继续；非 TTY 下同样拒绝。

---

## 2. 会话与聊天

### 2.1 `autopilot`（裸命令）

进入交互聊天，工作区为当前目录。

```text
autopilot
```

### 2.2 `autopilot chat [prompt]`

```text
autopilot chat [prompt] [--session <id>] [--output interactive|text|jsonl]
```

`ap` 是 `autopilot` 的等价别名；提交首轮 prompt 时可直接写成：

```text
ap chat "some of your prompt"
```

这是一次性调用：首轮 prompt 完成并进入 `idle` 后，Autopilot 自动退出，不继续等待下一条交互输入。

- `prompt`：作为初始消息提交给 Agent；带 prompt 时以一次性任务方式运行，完成（idle）后自动退出。
- `--session`：指定已有 Session，否则创建当前 Project 下的新 Session。
- `--output`：见 1.3。

CLI 不注册结构化 `ask_user_question` Tool，也不显示问题卡或选项 picker。若方向性信息确实不足，模型会在普通助手正文中汇总最少必要的澄清问题并正常结束当前 Turn；用户下一条 prompt 会作为同一 Session 的新 Turn，并依靠 canonical history 继续。该正文不是审批，不能通过 `/approve`、`resume` 或任意输入绕过 Tool 的 Policy、Trust 与审批链。

**Todo 任务链展示（interactive）**：每个 Turn 只显示该轮最后一次安全 `todo_updated` 的单卡，位于回答及过程之后、该轮终态摘要与冻结耗时之前；中间版本不重复写入历史。普通新轮没有自身更新时不显示旧卡，后续更新或清空不覆盖前轮最终快照。默认紧凑态显示 `Todo <completed>/<total> · <activeForm>`（无进行中任务时只显示计数），活动卡底部持续显示 `Ctrl+O 展开`，展开后切换为 `Ctrl+O 收起`；该按键在 picker 与审批等待之外随时切换完整清单，并同时切换工具调用分组行的展开明细（默认收起，展开后缩进显示组内各调用；screen reader 恒展开）。展开区最多占 10 行，矮终端会继续按可用高度收缩；in_progress 与最近完成优先，超出部分以一行隐藏计数收口。彩色模式以 `✓/■/□` glyph 加删除线/加粗/唯一橙色表达；screen reader 与 `NO_COLOR` 模式均输出中文状态文字。终态只固化一次最终清单，不再显示不可操作的快捷提示，并继续保留 screen reader 中文状态。当前进行中任务的 `activeForm` 也会作为动态区活动行的稳定文案，替代宿主猜测的工具动词短语。

**活动耗时与引导原文（interactive）**：本轮累计耗时在输入框上方的既有活动状态旁显示，复用活动时钟；读屏、降低动态偏好仍按秒更新，终态停止并在历史保留冻结总耗时。已确认的 steer 原文按提交位置留在所属 Turn 内，消费后原位更新状态且仅显示一次；queue 原文在等待区可见，领取后成为新轮首条输入。回调晚到、消费先到或切轮均按 inputId 关联原轮，不读取私有 checkpoint 或附件展开内容。

**Todo 任务链续接规则**：任务链快照只在连续路径继承。运行中的普通输入（steer 引导）在当前 Turn 安全边界交给模型，模型随后以 `todo_write` 提交追加或调整后的完整列表；`/queue <prompt>` 领取后的下一 Turn 继承上一任务链的安全 Todo 快照（见 11.2）；`autopilot resume` 恢复同一 durable Turn 时沿用原 Todo 进度并保留继续更新能力。普通新 Turn 的任务链初始为空，不继承旧 Todo；用户输入正文不能直接改写任务链。

**长调用链与恢复**：未显式配置 `maxSteps` 或 settings.json 的 `maxTurns` 时，正常交互不设循环轮数闸门；未显式配置 `maxDurationMs` / `AGENT_MAX_DURATION_MS` 时也不设累计执行段时长闸门。`maxTurns` 映射到内部 `maxSteps`，每轮为一次模型采样及其工具批次，可含多个工具，不按消息数或单个工具调用数计数；有效正整数无固定 100 轮封顶。显式轮数触顶产生 `limit_reached`，可用 `autopilot resume` 继续；Continue 复用冻结轮数值并开启新的执行段，不重置已完成工具事实。Runtime 在每个完整工具批次后保存最新 durable checkpoint，进程重启/恢复不会重放已完成工具；无法确认的未闭合副作用会先以 `TOOL_OUTCOME_UNKNOWN` 闭合，要求验证后再继续。显式 `runtime_budget` 与重复无进展护栏会以 `interrupted_recoverable` 暂停；执行段时长预算可在同一 Turn 上继续，保留已完成调用事实。耗尽的显式 `token_budget` 是 `failed` 终态，Core 拒绝继续执行。旧模式/旧默认值不在当前契约范围，本轮不提供迁移保证。

**交互继续词**：当前 Session 存在 `awaiting_approval`、`awaiting_user_input`、`interrupted_recoverable` 或 `limit_reached` 的可恢复 Turn 时，在交互输入框提交精确的 `继续`、`继续执行` 或 `继续任务` 会直接复用该 Turn 的 `resume -> turns.continue()` 路径，不创建新 Turn；其中 `awaiting_user_input` 仍只显示“请在支持结构化回答的 Web 中处理”。没有可恢复 Turn 时，这些词保持普通 prompt 语义。

**@ 文件提及（interactive）**：交互输入框中在行首或空白后输入 `@` 弹出工作区文件候选菜单（最多显示 5 行，↑/↓ 滚动选择，输入越完整候选越少，`@` 空查询列出工作区一层目录与文件）；Tab/Enter 插入选中项（文件尾随空格，目录尾随 `/` 可继续下钻），Esc 仅关闭菜单且已输入内容保留（再次 Esc 恢复既有取消语义；与 slash 菜单 Esc 清空输入不同）。提交时（新 Turn、运行中引导、`/queue` 与首轮 initial prompt 行为一致），@ 引用的工作区相对路径内容以 `<system-reminder>` 附加块追加到发送给模型的内容；时间线与 Esc 恢复始终只显示/恢复原文。引用限制：仅接受工作区内相对路径（绝对路径与 `..` 逃逸拒绝）；单文件超过 8MiB 拒绝读取；内容截断为前 2000 行 / 256KiB；目录只列一层，上限 100 项；路径未找到、越界或读取失败以 notice 提示且不阻断提交。非交互 `autopilot chat "<prompt>"` 中 `@` 按普通文本处理，不注入文件内容。

**受控联网**：Trust 后 CLI 通过共享 Node loader 装配 Web capability，但继续删除任何外部 loader 的 `loadRag`，不会因 Web 配置恢复 CLI RAG。需要最新公开事实时模型先使用 `web_search`；用户给出明确 URL 时可直接 `web_fetch`。Fetch 在 `ask` 模式按域名审批，跨域跳转需要目标域名的新审批；当前调用的新审批替代旧审批，刷新回放也只保留最新可操作项。拒绝后当前 Turn 立即停止后续工具，不能改用 `run_command` / curl 绕过。TUI 的专用“网络搜索/网页读取”行只显示来源数量、最终域名、内容类型和截断事实，不显示 query、来源 URL、URL 路径或网页正文。Search 没有结构化引用时显示“搜索服务未返回结构化引用”，不等同于没有搜索结果；最终回答中的普通链接不算结构化引用。

**退出码**：0 正常完成；1 运行时错误；2 用法错误（prompt 为空等）。

### 2.3 `autopilot resume [--session <id>]`

```text
autopilot resume [--session <id>] [--output interactive|text|jsonl]
```

恢复最近由 Core 确认可恢复的 Turn。Turn 状态全集为 `running | awaiting_approval | awaiting_user_input | interrupted_recoverable | limit_reached | completed | failed`，其中**只有 `awaiting_approval`、`interrupted_recoverable`、`limit_reached` 三种可执行恢复**；`awaiting_user_input` 仅会出现在同一 durable stateRoot 的 Web Session，CLI 固定显示“请在支持结构化回答的 Web 中处理”，不展示题目、选项或补充正文，也不伪造答案或调用 `continue`。`completed`、`failed` 与不可恢复终态（包括耗尽的 `token_budget`）不显示 Resume 指引。没有可恢复 Turn 时返回 `INVALID_INPUT`。从安全批次 checkpoint 恢复时，Core 私有存储沿用已完成调用与 canonical history，宿主不读取完整 checkpoint；仍未闭合的调用按未知结果安全闭合。

来源未验证的旧 Work 历史不再参与恢复：Core `getRecoverableState()` 返回 null，因此 CLI 将其视为无可恢复 Turn；直接 start/continue/compact 也受 `WORK_HISTORY_READ_ONLY` 限制。请新建任务，旧知识、会话与 transcript 保留。Node Context 暂停旧 Memory 召回，有 query 时返回 `LEGACY_MEMORY_REVIEW_REQUIRED`；不自动迁移或删除旧记忆，新的 Work AutoMemory 尚未接入。

---

## 3. 项目管理

```text
autopilot project open [path]
autopilot project list
autopilot project current
autopilot project remove <workspaceId>
```

| 子命令 | 语义 | 安全边界 |
|---|---|---|
| `open [path]` | 打开/首次 Trust 指定目录，创建或取得 Project | 新目录必须显式确认 Trust |
| `list` | 列出宿主级 workspace registry，按 `lastOpenedAt` 降序 | 不需要 Trust |
| `current` | 输出当前工作区的 `workspaceId` 与 Trust 状态 | 不需要 Trust |
| `remove <workspaceId>` | 从 registry 注销条目 | 仅注销索引，**不删除**源码、Trust 或 durable state |

- `open` 成功输出 `project ready: <projectId>`；`current` 输出 `{ workspaceId, trust }`。
- `list` 每项含 `workspaceId`、`displayName`、`lastOpenedAt`、`available`（路径是否存在）。
- `remove` 成功输出 `project registry removed: <workspaceId>; source files, sessions, and trust were not deleted`；条目不存在时 stderr 输出 `WORKSPACE_REGISTRY_ENTRY_NOT_FOUND`，退出码 1。

---

## 4. Session 管理

```text
autopilot session list
autopilot session rename <id> <title>
autopilot session delete <id> --yes
```

- `list`：按 `updatedAt` 降序输出当前 Project 下 Session 的脱敏摘要（`id`、`title`、`status`、`updatedAt`）。`status` 取值：`idle`（无活动 Turn）、`running`（有活动 Turn）、`waiting_approval`（有 Turn 等待审批）、`interrupted`（Turn 被中断）、`failed`（Turn 失败）、`completed`（最近 Turn 完成）。
- `rename <id> <title>`：通过 `SessionService.rename()` 校验空标题与长度，输出 `{ id, title, updatedAt }`。
- `delete <id> --yes`：调用 `SessionService.delete()`，成功输出 `{ id, deleted }`；保留活动 Turn 的 `TURN_ALREADY_RUNNING` 门禁。交互模式删除前二次确认；**非交互模式无 `--yes` 不删除**，stderr 输出 `SESSION_DELETE_CONFIRMATION_REQUIRED` 并以退出码 2 结束。

**安全边界**：只管理当前 canonical workspace 下的 Session；Session 不存在或不属于当前 Project 时返回 `SESSION_NOT_FOUND`。删除级联清理 Turn/Checkpoint/Transcript/Approval/Inbox/lease/mutation 及 Session 图片等外围资源。

---

## 5. 信任管理

```text
autopilot trust status
autopilot trust revoke
```

- `status`：输出当前工作区 Trust 状态 `{ status: "trusted" | "denied" | "pending" | "expired" }`。
- `revoke`：调用 `WorkspaceTrustPolicy.revokeTrust()`，把信任恢复为 `pending`（未信任），输出 `{ status: "pending" }`。

Trust 状态全集与产生方式：

| 状态 | 产生方式 |
|---|---|
| `trusted` | `grantTrust`：首次确认信任后持久化 |
| `denied` | `denyTrust`：首次拒绝信任后持久化 |
| `pending` | 无信任记录，或 `revoke` 后恢复为未信任 |
| `expired` | 曾为 `trusted` 但 `expiresAt` 已过（读取时实时计算，不落盘） |

**安全边界**：`revoke` 只撤销 Trust，**不删除** Session 或 durable state；当前工作区被撤销后，本进程不得继续创建 Runtime、读取 workspace settings 或调用 Provider。

---

## 6. 配置管理

```text
autopilot config show --scope <user|project|local>
autopilot config get <key> --scope <user|project|local>
autopilot config set <key> <value> --scope <user|project|local>
```

- `--scope` **必须显式提供**，无隐式默认。
- `user` 指向 `~/.autopilot/settings.json`；Windows 为 `%USERPROFILE%\.autopilot\settings.json`，macOS 为 `~/.autopilot/settings.json`。`project` 为 `<workspace>/.autopilot/settings.json`，`local` 为 `<workspace>/.autopilot/settings.local.json`，**必须在 Trust 后**读写。
- 读取经 Node Adapter settings writer 复用 loader 的路径解析与 schema，CLI 不直接编辑 JSON 文件。
- `show`：输出脱敏后的 scope 配置对象（safe view，敏感字段已移除）。
- `get <key>`：输出 `{ key, value }`，读取所选 scope 的文件值，不是所有 scope 合并后的最终有效配置。
- `set <key> <value>`：成功输出写入后的脱敏 safe view 对象。

默认主连接可手写 User settings 的 `env.ANTHROPIC_AUTH_TOKEN` 或 `env.ANTHROPIC_API_KEY`、`env.ANTHROPIC_BASE_URL`，按 Anthropic Messages 装配；推荐用顶层 `model` 选择模型。`env.ANTHROPIC_MODEL` 也接受，但优先于顶层/Project/Local 的 model。显式第三方连接通过 User `providerRoutes` 和 `model: "routeId/modelId"` 选择，不通过改写默认连接的 URL 猜测协议。Work 视觉默认继承所选主模型；保留受信 `visionModel` route/false 覆盖。Web 与 CLI 共用 User settings；CLI 不读取 Web 的 `.env.local`，也不因 settings 含有 RAG 四角色配置而获得私有 RAG 工具。

### 6.1 允许写入的 key（allowlist）

| key | 值域 |
|---|---|
| `model` | 非空、无首尾空白的模型 ID；CC alias 需 User env 中对应默认模型映射；`routeId/modelId` 需已声明的 route 和模型。Project/Local 不能引入 User 未授权的模型 |
| `effortLevel` | `low` \| `medium` \| `high`；`max` 必须写入 `env.CLAUDE_CODE_EFFORT_LEVEL` |
| `availableModels` | argv 用逗号分隔、非空且不重复；JSON 文件用字符串数组。仅 User scope 生效，限制 firstParty 主/子模型选择，不声明模型能力；route 模型使用各 route 的 models 清单；缺省候选合并主模型、已映射 alias、子模型及 route 模型 |

### 6.2 安全边界

- 不在 allowlist 内的 key 拒绝；命令值按标量/逗号列表解析，不把传入文字作为 JSON 对象注入。writer 拒绝空白 model、非法 effort、空/重复 availableModels，CLI 将错误收窄为 `CLI_RUNTIME_ERROR`。model 是否可用和 scope 是否允许由运行时 resolver 另行判定，不能把 config set 成功当作最终有效；例如 Project/Local 的 availableModels 可以写入但不生效。
- 凭据与 endpoint 必须由用户手工编辑 User settings 的 `env`：只接受 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY` 之一，以及可选的 `ANTHROPIC_BASE_URL`。它们不通过普通 `config get/set/show` 写入或回显；Project/Local 的 `env` 不生效。
- Search 由 User settings 启用，可手工添加严格的 `webSearch: { provider, baseUrl, model, credentialRef: { provider, key } }`；当前 provider 支持 `deepseek`、`openai-compatible` 与 `xiaomi-mimo`，Base URL 不含协议路径（`/v1/messages`、`/responses`、`/chat/completions` 由适配器追加）。普通 `config get/set/show` 不写入或回显凭据引用与 Base URL。本机 Web 设置中心的“主模型”分类可保存同一完整连接和独立 Key，不改变普通 CLI config 的写入边界。Search 使用独立用途引用；仅官方 `https://api.deepseek.com/anthropic` 主连接可复用主 Key，复用时固定使用 DeepSeek 官方 Anthropic 地址与 deepseek-flash 模型。其他连接使用自身 provider/Base URL/model/Key，并统一以 `reasoning: { effort: "none" }` 关闭思考；主问答模型与思考设置独立。显式设置 `webSearch:false` 后下一次 start/continue 隐藏 Search；省略时官方 DeepSeek 主连接仍可默认继承，已运行请求使用当前快照。
- 配置启用即授权查询外发：query 发给所选搜索供应商，搜索答案与来源随后作为工具结果发给当前主模型供应商，可能形成双 Provider 数据流。Plain/JSONL 模式启动聊天前向 stderr 显示提示；TUI 的启动品牌区保留同一提示。网页读取继续按域名审批，跨域重新绑定目标并审批。
- Work 的 `vision_analyze` 是受控工具而非命令入口：`auto_approve` 与 `full_access` 下按只读风险自动执行，不重复弹审批卡；`ask` 下仍可逐次审批，并按 `vision-analyze:workspace` 复用会话/工作区授权。图片路径、Schema、冻结视觉能力和 Provider 安全门不因权限模式放宽。
- Web 待审批参数不落盘；当前 Runtime 可短期恢复原参数，重启/失效后以 `WEB_INPUT_UNAVAILABLE` 闭合原批次并重新规划，不外发占位字符串。
- CLI 与 Web 共享执行预算：Search 默认及最大 300 秒；Fetch 每次执行段默认及最大 60 秒，跨域审批等待不计入执行段，批准后重新计时。Fetch URL 最长 2,000 字符，跨域与同域共用最多 10 次跳转，原始响应与解压结果各限 10 MiB，提取文本最多 100,000 字符；超限、超时或取消不会自动重试。
- 写入前调用 Core resolver，但 writer 当前不依据 resolver diagnostics 拒绝落盘；只有 writer 自身抛出的校验错误会阻断写入。成功写入使用原子替换，配置生效和诊断仍需后续 loader/doctor 核对。
- writer 还检查文件内既有敏感字段；User 顶层 env 和合法 webSearch 引用是例外，但当前 providerRoutes 内的 credentialRef、顶层 maxOutputTokens 等会触发该检查，使普通 config set 被拒绝。含这些字段的完整配置请手工编辑用户文件，不把这三项命令当作完整 settings 编辑器。

**退出码**：0 成功；1 运行时错误（含 Trust 缺失，stderr `WORKSPACE_TRUST_REQUIRED`）。

**示例**：

```text
autopilot config set model provider-model-id --scope user
autopilot config set availableModels provider-model-id,provider-fast-id --scope user
autopilot config get model --scope user
```

### 6.3 手写 settings.json 的参数与写法

文件必须是 JSON 对象，不支持 JSON 注释或尾随逗号。**不要添加 `schemaVersion`**：当前 resolver 对任何显式 schemaVersion 都产生 `SETTINGS_SCHEMA_VERSION_UNSUPPORTED`，忽略整份来源。未知顶层字段不会因此获得执行能力；env 字符串也不会自动导出到进程环境。

最小默认协议配置（占位模型必须替换为供应商可用的完整 ID）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_API_KEY": "YOUR_API_KEY"
  },
  "model": "YOUR_MODEL_ID"
}
```

`ANTHROPIC_API_KEY` 和 `ANTHROPIC_AUTH_TOKEN` **只能设置一个**；两者同时有效时产生 `SETTINGS_AUTH_CONFLICT` 并清空该主连接的凭据引用。User 文件 env 的值必须是字符串；模型/凭据字符串不能含首尾空白或控制字符。Base URL 接受 HTTP(S)，不得含 URL 用户名/密码、query、fragment；默认协议缺省地址为 `https://api.anthropic.com`，不手工追加 `/v1/messages`。

| 字段 | 文件值/限制 | scope 与优先级 |
|---|---|---|
| `model` | 完整模型 ID、已映射 alias 或 `routeId/modelId` | User < Project < Local；User env.ANTHROPIC_MODEL 优先，后两层只能选择已授权模型 |
| `env.ANTHROPIC_MODEL` | 非空模型 ID 或已映射 alias | User-only；不写此项可用 config set model 改顶层模型 |
| `env.ANTHROPIC_DEFAULT_OPUS_MODEL` / `...SONNET_MODEL` / `...HAIKU_MODEL` | 各 alias 的完整模型 ID | User-only；未配置映射的 alias 不解析为默认模型 |
| `availableModels` | 非空、无重复的字符串数组 | User-only；firstParty 主/子模型最终选择必须在该数组中 |
| `modelOverrides` | 非空字符串到非空字符串的对象 | User-only；单跳替换，禁止自映射、链和循环；替换结果仍校验授权清单 |
| `effortLevel` | `"low"` / `"medium"` / `"high"` | 三层可声明；User env effort 优先 |
| `env.CLAUDE_CODE_EFFORT_LEVEL` | `"low"` / `"medium"` / `"high"` / `"max"` / `"auto"` / `"unset"` | User-only；auto/unset 清除显式 effort，不等于关闭思考 |
| `alwaysThinkingEnabled` | JSON 布尔值 | 三层可声明；实际请求受模型/协议能力控制 |
| `maxOutputTokens` | JSON 整数，1–1,000,000 | User-only；是输出预算，不是上下文窗口 |
| `maxTurns` | JSON 正整数，最大安全整数；省略表示无限制 | User < Project < Local；在新 Turn 冻结为内部 `maxSteps`，限制每个执行段的采样/工具循环轮数，一轮可含多个工具；Continue 复用冻结值 |
| `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 十进制整数字符串，1–10,000,000 | User-only；受信 compact 窗口声明 |
| `env.API_TIMEOUT_MS` | 十进制整数字符串，1,000–600,000 | User-only；默认主连接超时，单位毫秒 |
| `env.CLAUDE_CODE_SUBAGENT_MODEL` | 模型 ID 或已映射 alias | User-only；子模型候选配置，不代表独立子任务功能已提供 |
| `env.CLAUDE_CODE_DISABLE_AUTO_UPDATE` | 字符串 | 兼容字段被接受，当前不驱动 CLI 自动更新流程 |
| `providerRoutes` | route 字典，见 6.4 | User-only；显式声明协议和模型目录 |
| `visionModel` | `false` 或已声明 OpenAI Chat Completions route 的 `routeId/modelId` | User-only；省略时保留主模型继承，非法选择诊断并关闭覆盖 |
| `webSearch` | `false` 或严格连接对象 | User-only；支持字段与数据流见 6.2；env 的三种 USER_SETTINGS_WEB_SEARCH_* 字符串可提供对应凭据 |
| `sandbox` | `{ mode?, allowedDomains?, deniedRead?, deniedWrite? }` | mode 只允许 read-only/workspace-write；mode/allowedDomains User-only；deny 列表各 scope 取并集，只收窄 |
| `rag` | 固定四角色对象 | User-only；CLI 不开放私有 RAG，普通 CLI 配置不需要此段 |

sandbox 的三个列表必须是无重复的非空字符串数组，禁止元素 `"*"`，允许空数组；settings 不允许 `danger-full-access`。RAG 解析器接受 textRerank、visionRerank、textEmbedding、multimodalEmbedding 四角色连接及其固定用途 env 密钥，不能把它当作 CLI 工具启用开关。

首次配置后进入目标目录运行 `ap`，按提示建立 Trust，再执行 `ap doctor` 核对 settings/model/credential；未 Trust 时这些检查会 SKIP。只有显式执行 `ap doctor --connectivity` 才探测 Provider；不能用 `ap config show` 是否打印密钥判断凭据是否有效，它会删除敏感字段。

### 6.4 显式第三方协议连接

源码仅支持 `anthropic-messages` 和 `openai-chat-completions` 两种主模型协议，不把 endpoint 外观当作协议判断，也不承诺所有同名兼容服务可用。

```json
{
  "env": { "USER_SETTINGS_CUSTOM_API_KEY": "YOUR_API_KEY" },
  "providerRoutes": {
    "custom": {
      "id": "custom",
      "apiProtocol": "openai-chat-completions",
      "baseUrl": "https://api.example.com/v1",
      "credentialRef": { "provider": "custom", "key": "USER_SETTINGS_CUSTOM_API_KEY" },
      "models": [{ "id": "YOUR_MODEL_ID" }]
    }
  },
  "model": "custom/YOUR_MODEL_ID"
}
```

`id` 必须等于字典 key，credentialRef.provider 必须等于 id，key 绑定 User env 的实际凭据字段；`USER_SETTINGS_*` 引用缺失时不退回进程环境。models 必须非空且 id 不重复；可选 displayName 必须非空，单模型可选 contextWindowTokens 为 1–10,000,000 的 JSON 整数。Base URL 不追加协议资源路径。不要同时设置 env.ANTHROPIC_MODEL，否则它会优先选回默认主连接。

route 和单模型可分别提供 protocolProfile。Anthropic profile 必须恰为 `{ "apiProtocol": "anthropic-messages" }`；Chat Completions profile 必须恰含 apiProtocol、assistantToolCallContent（empty-string/null）、supportsReasoningContent（布尔）、supportsUsageInStreaming（布尔）四字段，且协议一致。profile 是受信兼容声明，不能通过配置虚构供应商能力；选择经过验证的服务和模型。

---

## 7. 诊断

```text
autopilot doctor [--connectivity]
```

逐行输出 `PASS` / `WARN` / `FAIL` / `SKIP` 检查结果。默认**只读、离线、无 Provider 调用、不创建状态根**。

检查顺序：node 版本 → workspace identity → 沙箱能力（脱敏）→ Trust 状态 → 已存在 stateRoot 的可读写性 / schemaVersion / migration 诊断 → durable JSONL 损坏诊断 → settings / model / credential / Web Search → Trust 后检查 Skills 与 MCP → `--connectivity` 明确提供时才做受限 Provider 与 Web Search 连通探测。

检查项全集与状态判定：

| 检查项 | 状态判定 | detail |
|---|---|---|
| `node` | 恒 `PASS` | Node 版本 |
| `workspace` | 恒 `PASS` | `id=<workspaceId>` |
| `sandbox` | enforcement=full→`PASS`，否则→`WARN` | `<backend> enforcement=<full|partial|unavailable>`（脱敏，不含路径/命令明细） |
| `trust` | `trusted`→`PASS`，其他→`WARN` | 状态值 |
| `state_root` | read/write→`PASS`，未初始化→`WARN`，不可访问→`FAIL` | `read/write` / `not initialized` / `not accessible` |
| `state_schema` | 兼容或已迁移→`PASS`，非法→`FAIL`，无 state root→`SKIP` | `compatible` 或迁移码 / `schema invalid` |
| `durable_jsonl` | clean→`PASS`，有损坏→`WARN`，无 state root→`SKIP` | `clean` / `N corrupted record(s)` |
| `settings` | valid→`PASS`，有诊断→`WARN`，未 Trust→`SKIP` | `valid` / `N diagnostic(s)` |
| `model` | 配置→`PASS`，未配置→`WARN` | `configured` / `not configured` |
| `credential` | 配置→`PASS`，未配置→`WARN` | `configured` / `not configured` |
| `web_search` | 配置且凭据可解析→`PASS`，未配置→`WARN`，凭据不可解析→`FAIL`，未 Trust→`SKIP` | `configured` / `not configured` / `credential unavailable`，Trust 后附带查询发往 DeepSeek、结果发往主模型的告知 |
| `skills` | 发现→`PASS`，配置不可用→`WARN`，未 Trust→`SKIP` | `N discovered` / `configuration unavailable` |
| `mcp` | 配置→`PASS`，配置不可用→`WARN`，未 Trust→`SKIP` | `N configured` / `configuration unavailable` |
| `provider_connectivity` | 仅在 `--connectivity` 下探测→`PASS`/`WARN`/`FAIL`，未开启→`SKIP` | `use --connectivity` / `endpoint reachable` / 脱敏失败类别 |
| `web_search_connectivity` | 仅在 Search 已配置且 `--connectivity` 下探测→`PASS`/`WARN`/`FAIL`；未配置、凭据不可用、未开启或未 Trust→`SKIP` | `endpoint reachable` / `not configured` / `credential unavailable` / `use --connectivity` / 脱敏失败类别 |

**安全边界**：Trust 未建立时，settings、Web Search、Skills、MCP、Memory 与 Provider 检查均为 `SKIP`；不为了 Doctor 绕过 bootstrap 边界。Provider 与固定 DeepSeek Search endpoint 的连通性探测都是无凭据、无模型、无请求体的短超时 HEAD 请求，不记录 endpoint、认证或响应正文，也不执行真实搜索。

`doctor` 的 `sandbox` 项只报告当前 OS 沙箱后端状态；`mcp` 项只报告配置数量，不会启动 MCP server，也不判定各 server 的 `executionMode` 或 `isolation`。查看单个 server 的 `sandbox` / `host` 模式与 `sandboxed` / `unisolated` 标记，请使用 `mcp list` 或 `mcp approve`。

**示例输出**（未 Trust）：

```text
PASS node: v20.14.0
PASS workspace: id=v1-...
WARN trust: pending
WARN state_root: not initialized
SKIP state_schema: state root unavailable
SKIP durable_jsonl: state root unavailable
SKIP settings: workspace not trusted
SKIP skills: workspace not trusted
SKIP mcp: workspace not trusted
SKIP provider_connectivity: workspace not trusted
```

---

### 7.2 CLI 性能诊断（显式开发开关）

性能诊断不是 `ap` 的交互菜单或 argv 子命令，默认关闭。仅在需要分析流式输出和输入回显时显式设置环境变量：

Windows PowerShell：

```powershell
$env:AUTOPILOT_PERF_DIAGNOSTICS = "1"
$env:AUTOPILOT_PERF_DIAGNOSTICS_FILE = "<diagnostics-file>.jsonl"
ap chat "<prompt>"
```

Windows CMD：

```bat
set "AUTOPILOT_PERF_DIAGNOSTICS=1"
set "AUTOPILOT_PERF_DIAGNOSTICS_FILE=<diagnostics-file>.jsonl"
ap chat "<prompt>"
```

`AUTOPILOT_PERF_DIAGNOSTICS=1` 启用 Core、Provider、Runtime、TUI Store 和输入区的分段记录；`AUTOPILOT_PERF_DIAGNOSTICS_FILE` 指定退出时写入的 JSONL 文件。诊断记录只包含 `version`、`point`、`eventType`、`monotonicMs` 和可选 `durationMs`，不包含回答正文、输入文本、凭据或路径正文。文件在 CLI 进程退出时一次性写入，运行期间不会逐事件落盘。

CLI/TUI 当前没有查看诊断过程或结果的交互界面；需要用文本编辑器、脚本或测试宿主读取该 JSONL 文件。未设置输出文件时仍会在进程内收集，但退出后不会保留；只设置输出文件而不把开关设为 `1` 不会记录任何数据。

启用该开关后，TUI 的 Controller dispatch 异常会额外记录一条 `point: "tui_runtime_error"`：`eventType` 为 `dispatch`，`monotonicMs` 为单调时钟毫秒，`errorCategory` 与 `errorCode` 来自 Core/Adapter 稳定错误码白名单。分类包括 `config_directory`、`workspace_trust`、`agent_runtime`、`node_state`、`node_chat` 与 `unknown`；未知或非法错误码分别收敛到固定通用码（如 `CLI_RUNTIME_ERROR`），不会记录任意对象的 `code`。TUI 屏幕继续显示 `CLI_RUNTIME_ERROR`。记录不含异常消息、`cause`、stack、路径、prompt、Provider 内容或凭据。

---

## 8. MCP 管理

```text
autopilot mcp list
autopilot mcp approve <server> [--yes]
autopilot mcp revoke <server>
```

- `list`：列出 Trust 后读取到的 MCP server 摘要，每项含 `serverName`、`approved`、`executionMode`（`sandbox` / `host`）与 `isolation`（`sandboxed` / `unisolated`）；不回显 command、args、cwd 或环境变量。未配置 `execution` 时显示 `host` / `unisolated`。
- `approve <server> [--yes]`：为 server 当前配置与有效执行模式保存 workspace grant，不会由此命令启动 server；成功输出 `{ serverName, approved, executionMode, isolation }`。默认 `host` 与显式 `host` 都会在授权前 stderr 明确警告其直接运行在宿主且没有 OS 沙箱隔离；非交互必须 `--yes`，否则 stderr 输出 `MCP_APPROVAL_CONFIRMATION_REQUIRED` 并以退出码 1 结束。
- `revoke <server>`：撤销该 server 的授权，输出 `{ serverName, revoked }`。

**安全边界**：Workspace Trust 只允许读取 `mcp.json`，不等于允许执行任意 server command；授权前把 `program + args + cwd + configHash` 作为 `mcp_server_start` ActionFacts 交给 PolicyEngine，不能把 CLI 确认当成绕过 hard deny。每个 server 默认使用 `execution: "host"`；只有配置显式选择 `"sandbox"` 才经 `SandboxPort`。host 以宿主用户权限运行且没有 OS 沙箱，必须显示 `unisolated` 并在授权前警告。两种模式都要求 Workspace Trust 与绑定 `serverName + configHash`（包含有效执行模式）的 workspace grant；缺省模式变更及旧 hash 标准化会使旧 grant 失配，需重新授权。sandbox 初始化失败保持 fail-closed，不回退 host。server 启动后的每次 MCP 工具调用仍需要工具审批，审批卡显示其隔离事实；`run_command` 和 Job 仍始终要求 OS 沙箱。server 不存在返回 `MCP_SERVER_NOT_FOUND`。

---

## 8.5 沙箱管理

```text
autopilot sandbox status
autopilot sandbox setup --yes
```

- `status`：输出当前平台沙箱能力报告（脱敏 JSON）：`platform`、`backend`、`enforcement`（`full` / `partial` / `unavailable`）、`installed`、`provisioned`、`version` 与脱敏 `diagnostics`。macOS 首次 status 会惰性初始化 Seatbelt 沙箱；Windows 报告 provision 事实，但命令执行路径在实机门禁通过前保持不可用。不需要 Trust。
- `setup --yes`：显式触发沙箱安装（仅 Windows 有实际效果：专用账户/WFP/ACL 的 UAC 提权安装；macOS 无 provision 步骤，返回当前能力报告）。必须显式 `--yes`，否则 parser 报错 `sandbox 支持 status | setup --yes`；用户取消 UAC 不是错误，报告诊断含 `install_cancelled`。要求工作区已 Trust。

**安全边界**：报告不含 SID、用户名、真实路径列表、凭据或命令正文；底层错误统一映射为稳定 `SANDBOX_*` 错误码，不透传 SRT 原始文案；setup 不会在模型工具调用或普通命令中自动触发。

---

## 9. 后台 Job 管理

TUI Job 请求带视图代次，Esc 返回后迟到详情不会重新打开弹层；详情与停止结果按 revision 同步缓存列表，因此停止后 Esc 返回仍显示 stopped。2026-09-09 Windows 真实 TTY 已验证 busy 中 `/jobs`、日志、停止、Esc，以及 `NO_COLOR`/screen reader 文字可读；Windows 全屏请求按既有规则降级 inline。macOS 实机仍暂缓。

Agent 启动后台 Job 后，活动工具卡持续显示 `/jobs 查看后台任务`。启动成功时可显示 Core 安全 DTO 提供的 executable basename（例如 `POWERSHELL`）：CLI 仅将该标签转为大写，并使用界面统一的橙色强调 token；目录、参数、PID 与输出不得进入该标签或启动卡。Job 离开 `starting/running` 后不再显示操作提示。

```text
autopilot job list
autopilot job show <id>
autopilot job output <id>
autopilot job kill <id>
```

- `list`：输出当前 workspace 下的安全摘要数组。字段包括 `id`、`sessionId`、`turnId`、`jobId`、`status`、`controlState`、`canStop`、时间／退出码、输出字节数、`outputTruncated` 与 `snapshotKind`；不输出 program、args、cwd、PID、owner 或日志正文。
- `show <id>`：输出单个安全 Job 摘要；不存在或不属于当前 workspace 时返回 `JOB_NOT_FOUND`。
- `output <id>`：输出 Core 已限量、去控制符和脱敏的 stdout/stderr 双流窗口及 opaque cursor；两路不承诺原始交错顺序。
- `kill <id>`：按该 Job 的 Session 绑定执行停止。只有本次命令创建的 Runtime 实际拥有进程句柄时才能成功；其他存活宿主或 owner 不明返回 `JOB_OWNER_UNAVAILABLE`／`JOB_OWNER_UNKNOWN` 并以退出码 1 结束，不伪造 stopped。

**安全边界**：独立命令先逐字段限量和脱敏，再序列化为完整单行 JSON；长列表不会通过截断 JSON 字符串限长。Job 绑定当前 workspace 与 Session，不支持 detach 或跨 Runtime IPC 接管；运行时正常退出会终止本进程拥有的活动 Job；Session 删除遇到活动 Job 返回稳定冲突，须回到原 owner 宿主停止。

---

## 10. 撤销（Undo）

```text
autopilot undo --session <id> --yes
```

撤销指定 Session 最近一个 Turn 的文件副作用。

- `--session <id>`：必填。
- `--yes`：必填，**非交互入口必须显式提供**；无 `--yes` 时 stderr 输出 `UNDO_CONFIRMATION_REQUIRED` 并以退出码 2 结束。

**语义与安全边界**：

- preview 状态为 `available`（有可撤销内容）或 `unavailable`（无可撤销内容，`reason` 说明原因）；执行结果状态为 `completed`（撤销完成）或 `failed`（撤销失败，`conflicts` 列出冲突路径）。
- 只回滚 `write_file` / `edit_file` 产生且成功记录的 create/edit/overwrite。
- 撤销前校验 Trust、PolicyEngine、canonical path、所有 current SHA 与 blob hash；任一不匹配 fail closed，不提供 `--force`。
- 目标文件被后续人工修改（current SHA 不再等于 after SHA）时 fail closed：非交互 `autopilot undo` 输出 `UNDO_NOT_AVAILABLE: <reason>`，交互 `/undo confirm` 输出 `UNDO_CONFLICT`，均不覆盖。
- 不撤销 command、后台 Job、MCP、网络或数据库副作用。
- 文件正文只存于 stateRoot 的私有 content-addressed blob，不进入输出或 transcript。

**退出码**：0 撤销完成；1 `UNDO_NOT_AVAILABLE` / `UNDO_FAILED` / `SESSION_NOT_FOUND`；2 缺 `--yes` 或 `--session`。

交互式等价物见 11 的 `/undo`。

---

## 11. 交互 slash 命令

以下命令在交互聊天输入框内以 `/` 开头输入，由 `parseSlashAction` 解析，不发送给模型。

| 命令 | 用法 | 说明 |
|---|---|---|
| `/exit` | `/exit` | 退出当前 CLI 会话；有活动 Turn 时先取消 |
| `/cancel` | `/cancel` | 取消正在运行的 Turn |
| `/queue` | `/queue <prompt>` | 把下一条 prompt 投递到 durable queue |
| `/compact` | `/compact` | 压缩当前 Turn 上下文 |
| `/context` | `/context [all]` | 查看当前上下文用量（`all` 展开完整安全诊断字段） |
| `/jobs` | `/jobs [show\|output\|stop <id>]` | 管理当前 Session 的后台任务 |
| `/model` | `/model [modelId]` | 打开模型 picker，或设置下一 Turn 默认模型 |
| `/effort` | `/effort [effort]` | 查看或设置下一 Turn 推理强度（别名 `/reasoning`） |
| `/skill` | `/skill [name]` | 打开 Skill picker，或选择/切换一个 canonical Skill |
| `/permissions` | `/permissions [mode \| grants \| revoke <constraint>]` | 查看/设置 Session 权限模式（`ask`\|`auto_approve`\|`full_access`）；`grants` 列出当前会话可见的持久授权；`revoke <constraint>` 按 toolName+constraint 精确撤销一条授权 |
| `/approve` | `/approve <decision>` | 提交工具审批决定（`allow_once`\|`allow_session`\|`allow_workspace`\|`deny`） |
| `/undo` | `/undo [confirm]` | 预览（或 `confirm` 提交）撤销当前会话最近一轮文件修改 |

### 11.1 `/undo` 与 `/undo confirm`

- `/undo`：输出脱敏 preview（`undo preview: turn <turnId>` + 每个文件的 `operation` / `path`）并提示输入 `/undo confirm` 执行；没有可撤销内容时返回 `UNDO_NOT_AVAILABLE`。
- `/undo confirm`：由 Core 重新校验全部 SHA 后执行；preview 过期、外部修改或无 preview 时返回 `UNDO_CONFLICT`，fail closed。

### 11.2 `/context` 与 `/context all`

```text
/context
/context all
```

查看当前 Session 的安全上下文用量。两种形式均为只读：不调用 Provider、不触发 compact、不更新 checkpoint；数据来自 `runtime.turns.getContextUsage()` 的同一脱敏快照。

- `/context`：默认摘要。交互 TUI 中以覆盖层显示且**不进入滚动历史**：左侧窗口容量网格（按终端宽度与窗口大小选择 5×5 / 5×10 / 10×10 / 20×10），右侧 `model: <modelRef>`、总量 `<projected>/<window> tokens (<window %>)`、固定分类行（tokens + 窗口占比）、`Free space` 与 `Autocompact buffer`；下方 Memory/Skills 只显示聚合 `itemCount + tokens`，不含路径、文件名或 Skill 名；末行提示 `/context all to expand`。按 Esc 只关闭覆盖层回到聊天，不取消运行中的 Turn，已输入内容保持。
- `/context all`：在默认摘要后追加安全诊断字段：总体与 breakdown 的 `measurement`、`providerMeasuredTokens`（仅数值）、`estimatedAddedTokens`、`currentContextTokens`、`outputReserveTokens`、`compactTriggerTokens`、`compactNeeded`、free/compact buffer/over-limit 的 tokens 与占比。
- 参数校验：其他参数返回用法错误 `/context 只接受可选 all 参数`，不查询 Runtime、不调用 Provider。
- 精度三态：`measured`（当前上下文无本地增量）、`projected`（Provider 锚点 + 新增内容估算）、`estimated`（无可信 usage）；总体为 `measured` 时分类明细仍是本地估算。无 Session、无冻结窗口或查询失败时固定输出 `Context: unknown`（exit 0）——它表示当前没有可展示事实，不是命令失败，不显示 0% 或猜测窗口。
- 非交互输出：`text` 跳过装饰网格，输出固定字段顺序的稳定文本报告；`jsonl` 只输出结构化安全 DTO 行，无网格字符、ANSI 或 TUI 文案。`NO_COLOR` 与 screen reader 模式跳过网格但保留全部事实字段。
- 安全边界：报告不含 Memory 路径、Skill/工具名、schema、消息正文、message count、tool/request 签名或凭据；仅 Memory/Skills 携带聚合 `itemCount`。比例可超过 100%，文本显示真实超限值，视觉网格封顶。

状态栏在 model/effort/permission 行附近显示紧凑 Context 行：有快照时为 `context: 16.1% · measured` 或 `context: ≈16.1% · estimated`；无数据固定 `context: unknown`。`measured` 只表示当前上下文没有本地增量，下一次输出仍是预留而非实测。

`/compact` 的反馈使用 Core 显式 outcome：changed 输出 `context compacted: estimated 120000 -> 52000`；skipped 输出 `context compact skipped: no compactable history; projection unchanged (estimated 120000 tokens)`；活动 Turn 中显示 `TURN_ALREADY_RUNNING: 当前 Turn 仍在运行，请等待结束或中断后再压缩`（退出码 1），不声称已排队或将在安全边界执行。`preTokens`/`postTokens` 一律标注 `estimated`（本地估算）。

### 11.3 其他 slash 命令要点

- `/jobs`：打开当前 Session 的任务列表；`show` 查看安全详情，`output` 查看有限安全日志，`stop` 明确停止当前 Runtime 拥有的目标。TUI 中可用方向键、Enter、`o`、`s`、`r` 操作；Agent 执行中仍可调度。详情 Esc 返回列表，列表 Esc 返回原输入视图，不取消 Turn、不退出 CLI，输入状态保持。
- 活动 Turn 为 `running` 时，状态栏持续显示 `Esc interrupt`、`Enter 引导` 与 `/queue <prompt> 排队`；Turn 离开运行态后隐藏这些运行期操作提示。
- Trust 成功后，CLI 确保当前 canonical 项目根存在 `.autopilot/tmp`，仅作为 Agent 临时脚本、截图裁剪和中间产物目录；不因此创建项目级 `settings.json` 或 `settings.local.json`。临时目录不应写入 `node_modules`。
- `/queue <prompt>`：仅在已有活动 Turn 时生效，投递到 durable inbox 队列；领取后的下一 Turn 标记为 claimed queue，因此仅继承上一任务链的安全 Todo 快照，不会从普通无关新 Turn 前复活旧 Todo；缺 prompt 返回用法错误。
- `/permissions <mode>`：只接受三态工具权限模式；缺 mode 时打开 picker。
- `/permissions grants`：列出当前 Session/工作区可见的持久授权（scope、toolName、constraint 及记住状态）；canonical 私有身份由 Core list 投影剔除。允许活动 Turn 中使用与 `/permissions revoke` 不同：撤销是持久状态变更，活动 Turn 中不可用。
- `/permissions revoke <constraint>`：按列表原样复制的 constraint 精确撤销；Core 先删 grant 权威再删工作区 local 投影规则，删除失败或不存在时返回稳定错误，不模糊匹配、不撤销其他授权。
- `/approve <decision>`：只接受固定宿主决定，不携带冻结调用字段；缺决定或非法值返回用法错误。
- `/model <modelId>`：值必须属于当前 settings 允许的模型目录；`/effort <effort>` 只接受当前 firstParty 的 CC 请求值。端点不支持显式 effort 时返回明确错误，不静默降档。

### 待验证 Continue 与后台执行阶段（2026-10-12）

写后读回验证未完成时显示“等待修改文件读回验证 · 可继续”，既有精确继续词恢复同一 Turn。继续只补 read_file 验证和总结，不重放已完成写入或任意恢复 failed。停止当前 Session/Runtime 的精确 Job 不再弹额外操作审批，外部/不确定 owner 拒绝；全树停止失败仍为 stopping/JOB_STOP_FAILED，不能用 broker close 伪造 stopped。

Job 的 running 指包装进程运行，缺少原生 ready 协议时目标状态未知；安全 read/list 的 execution 可带包装阶段、关闭信号及 reported Win32 错误码。新源码/包通过不等于现役 ap 已全部更新或 Windows 沙箱恢复。
