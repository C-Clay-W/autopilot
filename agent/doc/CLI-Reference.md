# CLI 命令参考（@autopilot-agent/cli）

> 面向终端用户的 CLI argv 命令与交互 slash 命令手册。命令解析位于 `apps/cli/src/parser.ts`，入口与编排位于 `apps/cli/src/main.ts`，普通交互行为位于 `apps/cli/src/controller.ts`；协作命令另核对 `thread-commands.ts`，Desktop 受管入口另核对 `managed-controller.ts` 与 `apps/desktop/src/orchestration-desktop.ts` 的实际分支。本文档只描述当前可用命令，不记录 Phase、Stage 或开发过程。

## 文档维护规则

每次变更 CLI 命令时必须遵守：

1. **以源码为准**：先核对 `apps/cli/src/parser.ts`、`main.ts`、`controller.ts` 的命令解析、编排与 slash 行为，并沿协作、配置、TUI 或 Desktop 受管入口核对实际调用；帮助字符串不能代替执行分支，不得以旧 Plan、旧 dist 或历史记录为依据。
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
12. [会话协作（thread）](#12-会话协作thread)
13. [Desktop 浏览器（browser）](#13-desktop-浏览器browser)

---

## 1. 入口与全局约定

### 1.1 命令形态

CLI 提供两个等价的 bin 名：`autopilot`（主命令）与 `ap`（等价别名），均指向同一入口。裸命令（不带任何子命令）等价于 `autopilot chat` 并进入交互聊天。

直接入口判断统一真实文件路径，npm workspace 的目录联接或符号链接入口同样执行命令；通过模块导入 CLI 入口时不自动启动会话。

### Desktop 受管状态出口

受管 Desktop Shell 中的 chat/resume 会自动连接只读本机状态通道，启动前可显示未绑定状态，Trust 和配置仍按 CLI 原入口处理。工作区绑定后投影当前选择、打开会话与本进程驱动过的后台会话，独立于 TUI/plain/JSONL 显示。恢复通知和活动身份只用于发现，再由 Core 查询判定事实。

内部受管环境使用 `AUTOPILOT_DESKTOP_STATUS_` 前缀的 ENDPOINT、TOKEN、INSTANCE_ID、PANE_ID、GENERATION，由 Desktop 每个 Shell 代次重新覆盖。普通外部 CLI 没有完整环境时不创建该出口、连接或 timer。help、doctor 和短管理命令不注册 AP 实例。连接失败、拒绝或断开不会改变业务退出码，也不写 stdout/JSONL；重连只补事实快照。正常退出有限刷新当前会话，身份、同 Turn 序号与读取代次通过检查后才提交。读取失败、落后或期间发生选择/执行变化保持待确认，最终快照未完整送达时按连接中断降级；可确认时发送退出通知。异常退出由 Host 保守标为连接中断。旧 Host/CLI 缺协议时退为状态不可用。

### 1.2 全局选项

| 选项 | 作用 |
|---|---|
| `-h, --help` | 显示帮助文本 |
| `--workspace-root <path>` | 指定 canonical 工作区根 |
| `--state-root <path>` | 指定 durable Runtime 状态根（默认用稳定 workspace identity 解析） |
| `--trust-root <path>` | 指定 Trust 记录根 |
| `--session <id>` / `-s <id>` | `chat` / `resume` 指定 Session，`undo` 必填 |
| `--output <interactive\|text\|jsonl>` | `chat` / `resume` 输出格式，默认 `interactive` |
| `--jsonl` | `--output jsonl` 的等价简写 |
| `--scope <user\|project\|local>` | `config` 命令的 scope，必须显式提供 |
| `--yes` | `session delete` / `mcp approve` 跳过交互确认；`undo` / `sandbox setup` 必填 |
| `--connectivity` | `doctor` 的 Provider 连通探测开关 |

上表是选项目录，不表示每个命令都接受所有选项。未知选项拒绝；普通入口只接受独立的选项和值，不支持 `--key=value` 或 `--` 分隔符。工作区选择优先级为 `--workspace-root`（`project open` 未提供时用其 path）→ `AGENT_WORKSPACE_ROOT` → 启动目录，不向上探测仓库根。默认状态位于 `%LOCALAPPDATA%/autopilot-agent/workspaces/<workspaceId>`，没有 `LOCALAPPDATA` 时使用 `~/.autopilot-agent/workspaces/<workspaceId>`；默认 Trust 目录为状态根的同级 `agent`。显式状态根和 Trust 根不改变工作区 Trust 要求。`browser` 只接受自己的动作/JSON/内部许可参数，见第 13 节。

正常使用入口在完成 Trust 后自动备份并升级已知旧状态格式（含6/7→8）；更新 npm 包后仍使用原工作区和历史，不需要更换状态根或手改版本号。当前版重复打开不重复备份，普通查询 Store 不承担迁移。真正无法升级时，CLI 输出稳定 `STATE_SCHEMA_*` 原因及恢复提示，不再掩盖成 `CLI_RUNTIME_ERROR`；未知新版不会被降级。`doctor` 不触发状态升级，初始化边界见第 7 节。

### Windows 终端缩放

Windows Desktop 宿主通过 `TERM_PROGRAM=autopilot-desktop` 启用 ConPTY 动态区域兼容。缩窄窗口或窗格时，旧帧按当前物理占行清理，输入草稿、已提交历史和 inline 原生滚动继续保留。当前prompt在活动、审批及问答等待期间由动态区持有，按列宽重排；Turn 完成、失败、中断或达到上限并固化时，prompt 按原顺序一同交给唯一Static所有者归档，位于该轮终态及耗时之前，恢复同轮不重放。Esc 回填后编辑重发创建独立的新prompt，会话切换保留各自正文。Desktop 在字体和首个网格就绪后启动一次 ap，后续布局变化调整同一进程。

Windows 上的外部交互 TTY 在存在 `WT_SESSION` 或未声明 `TERM_PROGRAM` 时启用旧帧擦除补偿，覆盖从资源管理器启动 cmd 后运行 ap 的入口。Desktop 优先使用自己的宿主标记。交互主屏的列宽发生过变化时，等列宽稳定 200 毫秒且布局采用最终列宽后，清理一次当前视口和终端滚动缓冲，由 Ink 重放本次 AP 已输出的内容和当前输入。拖回原宽也会清理。启动 AP 之前的 Shell 输出会从该窗格的滚动缓冲移除。外部终端仍由 Windows Terminal 控制网格，Desktop 继续使用自己的尺寸预协商。物理行补偿读取 Node TTY 内部 `_handle.getWindowSize`，以覆盖原生网格先变化、`stdout.columns` 缓存后更新的时序。内部接口缺失或失败时回用尺寸字段。

### Desktop 启动权限

Desktop 在创建 Shell 时通过受管环境 `AUTOPILOT_DESKTOP_AP_PERMISSION=ask|auto_approve|full_access` 固定新 Session 的默认权限；CLI 仅在 `ensureChatSession` 创建 Session 时消费该值。变量缺失时沿现有 CLI 默认配置；非法值拒绝新建。`chat --session`、`resume` 及 TUI 选择历史 Session 不写入权限。Shell 内再次运行 `ap` 采用该 Shell 创建时的权限；已有会话仍通过 `/permissions` 调整。该环境入口不改变 Trust、沙箱或 Core 权限策略，第三方 CLI 不受此设置控制。

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

交互 `chat`/`resume` 在完成必要的 Trust 确认后，与本地初始化并行显示 Desktop 新 Logo 的细密 Unicode 点阵及灰白扫光。首个可见帧至少展示两秒，本地 Runtime、配置、Session、Controller 和会话管理器就绪后撤下加载区并进入输入界面，模型首答和历史分页不参与等待。初始化失败立即撤下加载区并报告错误。正常顶部品牌为左侧静态小 Logo 与右侧 AUTOPILOT 像素字标，下方显示版本号。窄终端按尺寸缩小或回落为加载文字，reducedMotion/NO_COLOR 使用静态画面，读屏使用文字品牌。临时区仅清理本次动态帧，保留 inline 原生滚动与终端历史。CI 环境沿用 Ink 的静态输出并跳过启动动画门槛。

Windows Desktop 内的静态品牌头使用小 Logo 与 Autopilot 文字标题，使内置浏览器展开缩窄终端时，原生历史中的图形保持可读。

Todo 任务链在三种输出中的一致行为：模型通过 `todo_write` 工具更新任务链时产生 `todo_updated` 安全事件（字段仅含 `todos` 与 `counts`，不携带 raw Tool args）。`text` 每次更新输出一行稳定摘要 `todo: <completed>/<total> completed[ · in progress: <activeForm>]`；`jsonl` 输出完整安全事件对象；`interactive` 动态区以单卡显示，详见 2.2。

终态状态事件可带有 `termination: { reason?, recoverable, budget? }`：原因仅来自 Core 固定白名单，`recoverable` 是 Core 的布尔判定；可选预算只含 `used/limit/unit`，其中执行时长单位为 `ms`、Token 单位为 `tokens`。`text`、`jsonl`、交互时间线与备用 viewport 显示同一安全摘要。旧事件缺少投影时不补造原因或数值；Provider 原始错误、凭据和路径不会透传。

失败 `status` 事件可带白名单 `code`、安全 `reason`、Recorder 生成的 UUID `feedbackId`、有限 `providerHttpStatus` 和受限 `providerFailureDetail`。Plain 与 TUI 显示原因、可用的 HTTP 状态、上游标识和反馈 ID，JSONL 保留结构化字段。Web 与 CLI 使用 Core 共享的中立原因提示，不在 CLI 按厂商或 HTTP 数字解释业务语义。Adapter 将可靠事实归一为有限原因，未知网关保持通用提示。旧持久 `deepseek_official` 仅经归一化入口迁移，ID 和合法 HTTP 状态保留；协议 code/type 标识经共享字符、长度和常见凭据形式校验后展示，不用于恢复；自由 message 不显示。短标识仍可能含敏感信息，用户已明确接受此残余风险。未知 429 保守拒绝，已确认余额/额度不重试，可靠限流/过载沿用有界恢复。

### 1.5 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 成功或正常退出 |
| `1` | 运行时错误 |
| `2` | 用法错误（未知命令、缺参数、缺 `--yes`、非法值等） |
| `130` | 收到 SIGINT |
| `143` | 收到 SIGTERM |

### 1.6 Trust 门禁

以下命令**不要求**工作区已 Trust，不启动 Agent 执行：

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
autopilot job output <id>
autopilot thread ...
autopilot undo --session <id> --yes
autopilot sandbox setup --yes
autopilot config ... --scope project|local
```

例外：`autopilot project open` 以及输出为 `interactive` 的 `chat` / `resume` 在 stdin、stdout 均为 TTY 时会触发 Trust 确认对话框，用户确认后继续；拒绝或退出对话框正常退出 0，未执行任务。非 TTY 或显式 `text` / `jsonl` 不弹确认。Desktop 私有 `managed-attach` 与 `browser` 使用各自受管通道，不走上述普通 argv 的初始化路径。

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
- `--output`：见 1.4。

普通 CLI 新任务不注册结构化 `ask_user_question` Tool，也不创建新的问题卡或选项 picker。若方向性信息确实不足，模型会在普通助手正文中汇总最少必要的澄清问题并正常结束当前 Turn；用户下一条 prompt 会作为同一 Session 的新 Turn，并依靠 canonical history 继续。该正文不是审批，不能通过 `/approve`、`resume` 或任意输入绕过 Tool 的 Policy、Trust 与审批链。已有结构化问题仍可按历史恢复入口逐题回答，见 2.3 和第 12 节。

**Todo 任务链展示（interactive）**：每个 Turn 只显示该轮最后一次安全 `todo_updated` 的单卡，位于回答及过程之后、该轮终态摘要与冻结耗时之前；中间版本不重复写入历史。普通新轮没有自身更新时不显示旧卡，后续更新或清空不覆盖前轮最终快照。默认紧凑态显示 `Todo <completed>/<total> · <activeForm>`（无进行中任务时只显示计数），活动卡底部持续显示 `Ctrl+O 展开`，展开后切换为 `Ctrl+O 收起`；该按键在 picker 与审批等待之外随时切换完整清单，并同时切换工具调用分组行的展开明细（默认收起，展开后缩进显示组内各调用；screen reader 恒展开）。展开区最多占 10 行，矮终端会继续按可用高度收缩；in_progress 与最近完成优先，超出部分以一行隐藏计数收口。彩色模式以 `✓/■/□` glyph 加删除线/加粗/唯一橙色表达；screen reader 与 `NO_COLOR` 模式均输出中文状态文字。终态只固化一次最终清单，不再显示不可操作的快捷提示，并继续保留 screen reader 中文状态。当前进行中任务的 `activeForm` 也会作为动态区活动行的稳定文案，替代宿主猜测的工具动词短语。

**总耗时与引导原文（interactive）**：每轮结束后仅在时间线保留一条冻结总耗时，累计同一 Turn 的实际执行段，不计审批/暂停等待；活动行和首答省略重复耗时，静默状态只显示 Still working。失败终态同时保留安全失败原因和 HTTP 状态，不被通用恢复性文案遮住。审批提交/恢复准备期间保持控制器执行权，后台观察不能撤销进行中的精确请求；决定已保存但旧宿主未继续时，`/resume` 复用该条决定继续，不重复提交。已确认的 steer 原文按提交位置留在所属 Turn 内，消费后原位更新状态且仅显示一次；queue 原文在等待区可见，领取后成为新轮首条输入。回调晚到、消费先到或切轮均按 inputId 关联原轮，不读取私有 checkpoint 或附件展开内容。

**Todo 任务链续接规则**：任务链快照只在连续路径继承。运行中的普通输入（steer 引导）在当前 Turn 安全边界交给模型，模型随后以 `todo_write` 提交追加或调整后的完整列表；`/queue <prompt>` 领取后的下一 Turn 继承上一任务链的安全 Todo 快照（见 11.3）；`autopilot resume` 恢复同一 durable Turn 时沿用原 Todo 进度并保留继续更新能力。普通新 Turn 的任务链初始为空，不继承旧 Todo；用户输入正文不能直接改写任务链。

**长调用链与恢复**：未显式配置 `maxSteps` 或 settings.json 的 `maxTurns` 时，正常交互不设循环轮数闸门；未显式配置 `maxDurationMs` / `AGENT_MAX_DURATION_MS` 时也不设累计执行段时长闸门。`maxTurns` 映射到内部 `maxSteps`，每轮为一次模型采样及其工具批次，可含多个工具，不按消息数或单个工具调用数计数；有效正整数无固定 100 轮封顶。显式轮数触顶产生 `limit_reached`，可用 `autopilot resume` 继续；Continue 复用冻结轮数值并开启新的执行段，不重置已完成工具事实。Runtime 在每个完整工具批次后保存最新 durable checkpoint，进程重启/恢复不会重放已完成工具；无法确认的未闭合副作用会先以 `TOOL_OUTCOME_UNKNOWN` 闭合，要求验证后再继续。显式 `runtime_budget` 与重复无进展护栏会以 `interrupted_recoverable` 暂停；执行段时长预算可在同一 Turn 上继续，保留已完成调用事实。耗尽的显式 `token_budget` 是 `failed` 终态，Core 拒绝继续执行。旧模式/旧默认值不在当前契约范围，本轮不提供迁移保证。

CLI 没有 `--maxSteps` / `--maxDurationMs` 选项；进程环境可设置 `AGENT_MAX_STEPS`、`AGENT_MAX_DURATION_MS` 和 `AGENT_MAX_TOTAL_TOKENS`，三者缺省均不启用对应预算。`AGENT_MAX_TOOL_RETRIES` 默认 5、最高 10；显式 Token 预算最高 10,000,000。环境值只接受正整数字符串且须为安全整数，非法值回退缺省。settings 的 `maxTurns` 提供已选运行配置中的 `maxSteps`，覆盖环境默认；这些环境默认在模块加载时读取，修改后需重新启动 CLI。

**交互继续词**：当前 Session 存在可恢复 Turn 时，在输入框提交精确的 `继续`、`继续执行` 或 `继续任务` 可走原 Turn 的恢复路径，不创建新 Turn；尚未决定的审批仍等待审批。已进入历史结构化问题输入时，普通正文优先作为当前题的答案收集，不能把“继续”当作跳过问题；应使用 `/resume` 核查问题或复用已保存答案。没有可恢复 Turn 时，这些词保持普通 prompt 语义。

**滚动与复制**：当前入口统一使用 inline 主屏，正文回看、鼠标划选与复制由终端原生处理；旧 fullscreen 环境变量不启用备用屏。CLI 的备用屏内部选区、释放自动复制及选区优先 Ctrl+C 路径不属于当前启动行为。Ctrl+C 的宿主取消/退出语义见第 12 节，系统复制快捷键是否被终端拦截取决于实际终端。

**图片粘贴（Windows/macOS interactive）**：终端把 Ctrl+V 交给程序或发送空 bracketed paste 时可读取剪贴板截图与图片文件；若终端拦截 Ctrl+V，可尝试 Alt+V。Windows 使用 PowerShell STA，macOS 使用系统 osascript/AppKit；macOS 受控代码测试通过，系统桥接和真实终端尚待实机验证。输入显示 `[Image N]`，方向键跨越占位符，删除时按整张移除；文字可混合输入，单条最多 10 张。原图单张最多 20 MiB、4000 万像素，规范化副本总计最多 20 MiB，GIF 只发送静态首帧。纯文本 bracketed paste 保持原有输入语义；不支持文件会显示提示。终端快捷键是否到达程序取决于实际终端，真实 TTY 行为须由用户实测。

**@ 文件提及（interactive）**：交互输入框中在行首或空白后输入 `@` 弹出工作区文件候选菜单（最多显示 5 行，↑/↓ 滚动选择，输入越完整候选越少，`@` 空查询列出工作区一层目录与文件）；Tab/Enter 插入选中项（文件尾随空格，目录尾随 `/` 可继续下钻），Esc 仅关闭菜单且已输入内容保留（再次 Esc 恢复既有取消语义；与 slash 菜单 Esc 清空输入不同）。提交时（新 Turn、运行中引导、`/queue` 与首轮 initial prompt 行为一致），@ 引用的工作区相对路径内容以 `<system-reminder>` 附加块追加到发送给模型的内容；时间线与 Esc 恢复始终只显示/恢复原文。引用限制：仅接受真实目标位于受信工作区内的相对路径（绝对路径、`..` 逃逸、指向根外的链接与无法核实的路径均拒绝）；单文件超过 8MiB 拒绝读取；内容截断为前 2000 行 / 256KiB；目录只列一层，上限 100 项；路径未找到、越界或读取失败以 notice 提示且不阻断提交。非交互 `autopilot chat "<prompt>"` 中 `@` 按普通文本处理，不注入文件内容。

普通 CLI 和编排主控都对原文、路径与附加块使用 32 KiB 的 UTF-8 软预算。先保留原文，再为已核验路径预留空间，剩余空间用于摘录。只附路径或部分内容时，模型可按路径补读或预览。原文本身超出软预算时直接保留原文。

**受控联网**：Trust 后 CLI 通过共享 Node loader 装配 Web capability，但继续删除任何外部 loader 的 `loadRag`，不会因 Web 配置恢复 CLI RAG。需要最新公开事实时模型先使用 `web_search`；用户给出明确 URL 时可直接 `web_fetch`。Fetch 在 `ask` 模式按域名审批。在 `auto_approve` 和 `full_access` 下，初始公开 Fetch、同域跳转及已启用的 Search 免普通审批。跨域跳转需要目标域名的新审批；当前调用的新审批替代旧审批，刷新回放也只保留最新可操作项。拒绝后当前 Turn 立即停止后续工具，不能改用 `run_command` / curl 绕过。TUI 的专用“网络搜索/网页读取”行只显示来源数量、最终域名、内容类型和截断事实，不显示 query、来源 URL、URL 路径或网页正文。`WEB_URL_BLOCKED` 在实时与历史工具结果中带固定安全提示，可区分地址或协议不允许、DNS 解析失败、非公网网段和重定向被拒绝。Search 没有结构化引用时显示“搜索服务未返回结构化引用”，不等同于没有搜索结果；最终回答中的普通链接不算结构化引用。

**退出码**：0 正常完成；1 运行时错误；2 用法错误（prompt 为空等）。

### 2.3 `autopilot resume [--session <id>]`

```text
autopilot resume [--session <id>] [--output interactive|text|jsonl]
```

恢复由 Core 确认可恢复的原 Turn。恢复视图状态为 `running | awaiting_approval | awaiting_user_input | interrupted_recoverable | limit_reached | completed | failed`。不带 `--session` 时，CLI 按 Session 更新时间降序，自动选择 `awaiting_approval`、`interrupted_recoverable`、`limit_reached` 中可恢复的目标；没有这类目标时返回 `INVALID_INPUT`。自动选择不包含历史 `awaiting_user_input`，处理它需显式 `resume --session <id>`，或在交互 TUI 切入目标后执行 `/resume`。

`awaiting_approval` 有持久决定时复用决定请求原 Turn 续接；尚未决定时显示当前审批，不能用 resume 代批。历史 `awaiting_user_input` 会读取安全题目并逐题显示选项，输入编号或自定义文本完成回答后提交原 requestId 并请求续接；纯数字自定义写作 `其他 <内容>`。已有答案复用原答案，不补造新答案。协作目标由兼容在线宿主驱动，离线时保留等待提示；非交互 argv resume 输出题目后会返回，需使用交互目标继续回答。`completed`、`failed` 与不可恢复终态（包括耗尽的 `token_budget`）拒绝恢复；指定目标但无恢复状态时输出 `CLI_RECOVERABLE_TURN_NOT_FOUND`，不可恢复状态输出 `CLI_TURN_NOT_RESUMABLE`。从安全批次 checkpoint 恢复时，Core 私有存储沿用已完成调用与 canonical history，宿主不读取完整 checkpoint；仍未闭合的调用按未知结果安全闭合。

恢复或新 Turn 的对话基线取最近一个“可安全重建”的终态轮（`completed`/`failed`/`interrupted`，checkpoint 身份一致且消息可迁移。中断轮尾部未闭合的工具调用按未知结果配对）：最新失败或中断任务仍留在上下文中，继续执行不回退到更早历史，也不重放失败轮的工具调用。沙箱可用性等环境阻塞失败以结构化 `errorCode`（如 `SANDBOX_UNAVAILABLE`）区分，提示对应原因与处理说明，不再统一引导模型配置。

来源未验证的旧 Work 历史不再参与恢复：Core `getRecoverableState()` 返回 null，因此 CLI 将其视为无可恢复 Turn；直接 start/continue/compact 也受 `WORK_HISTORY_READ_ONLY` 限制。请新建任务，旧知识、会话与 transcript 保留。Node Context 暂停旧 Memory 召回，有 query 时返回 `LEGACY_MEMORY_REVIEW_REQUIRED`；不自动迁移或删除旧记忆，新的 Work AutoMemory 尚未接入。

---

### Desktop 受管主控终端（私有附着入口）

Desktop 在真实 PTY 中调用 `ap managed-attach`，自动提供只绑定当前编排工作区的本机连接能力。普通终端没有该能力或 stdin/stdout 不是 TTY 时退出 1；此入口只接受精确的 `managed-attach` 单参数，不接受 Session、目录、Provider 或 Runtime 参数，不创建自由会话。`/exit` 或 EOF 正常退出 0，Ctrl+C 退出 130，已进入 TUI 后受管连接断开按 SIGTERM 退出 143；连接初始化失败退出 1。退出客户端不停止 Run。

终端复用 Trust 对话框信任所属工作区；信任后先创建无目标、无模型执行的固定主控，首条正文才作为目标进入同一个 Run。原生 Controller 处理审批权限与逐题问答，支持原审批卡允许的持久授权，确认保存后请求原 Host 继续。手动 `/allow <approvalId>` / `/deny <approvalId>` 保存一次性允许／拒绝后，也会交给宿主审批续接流程，驱动原 Turn；拒绝后的续接用于让 Core 处理拒绝，不表示执行被拒工具。手动 `/answer {"questionId":"<requestId>","answers":[{"id":"<questionId>","selected":["<选项>"]}]}` 则只保存答案，之后需用 `/resume` 独立继续原 Turn。图形问答提交与主控原生逐题回答会在保存后请求原 Host 继续，不能把手动 `/answer` 的语义套到图形入口。Esc 或 `/cancel` 发送终端当前所见 Turn 的精确停止请求。受管客户端不等待较早的输入或状态轮询；界面仍根据原 Turn 的实际事件确认中断。`/pause` 暂停新派工但允许追加；`/dispatch` 恢复派工。`/resume` 继续原 Turn。`/status`、`/batch approve|deny`、`/agent <委派ID> status` 提供状态、完整扩员批次确认和执行者交互入口。执行者status复用安全审批display展示操作、影响范围、完整actionPreview及宿主无沙箱提示，包含声明的目标文件清单。原 Turn 确认结束后，普通追问在同一个 Run 和主控 Session 开启新 Turn，沿用可安全重建的对话和工具结果。仍等待真实交互、存在活动 Job 或执行未知时，先保留适用的普通输入，等待原会话可接收。结构化回答绑定终端所见的原问题。旧执行的恢复使用 `/recover` 核查，按结果用 `/reconnect` 或 `/reconnect accept` 确认，再显式 `/resume`。停止后的普通追问无需恢复旧执行，派工恢复由 `/dispatch` 控制。用 Desktop「开始新任务」创建新 Run。切换历史 Session 后重置正文游标。Esc 仅请求取消并保留当前会话；Ctrl+C、/exit 或 EOF 退出客户端，重新连接可打开所选 Run。同目录占用时，终端显示宿主发出的持有者工作区、Run、完整 Session 和 Turn 标识、核查状态与处理入口。回收失败委派和让出等待中的租约也显示宿主提示。不能通过此入口启用 Thread、改目标 Session 或解除受管约束。

主控终端还支持 `/agent <委派ID> approve <approvalId>` / `deny <approvalId>`（保存决定并请求续接该执行者原 Turn）、`answer <回答JSON>`（只保存，随后用同一委派的 `resume`）、`resume` 与 `cancel`。审批 ID 从 `/status` 或该委派的 `status` 读取，不用委派 ID 代替审批 ID。`/allow`、`/deny`、`/answer` 可手动输入但不在 slash 补全目录中；执行者终端补全仅显示 `/resume`、`/exit`、`/finish`、`/approval`，不提供主控的 `/agent` 等管理入口，等待问题时应使用本会话图形问答控件。决定保存、恢复请求接受、真实启动与任务完成是不同事实；需按 `/approval status` 和后续事件核查。

受管 TUI 使用目标主控的受信工作区根生成 `@` 候选，提交原文后由受管 Worker 使用共用规则核验文件并生成摘录。主控投递还会按封装后的 IPC 请求预算缩减摘录。原文所在 IPC 请求仍超限时，终端提示从输入历史取回并缩短。公共 slash 目录保留普通 AP 的 12 项，编排终端额外显示它实际支持的命令，复用方向键和 Tab/Enter。活动或等待审批的原 Turn 支持 `/queue <prompt>`，在同一主控 Session 等已确认成功终态后逐条启动新 Turn，继承队列连续路径的 Todo 和 Skill 引用。空闲时提示需要活动 Turn。排队正文归原 Run，等待期间既有主控和委派仍使用当前轮输入。受管主控的浏览器由 Desktop 按精确会话和执行段注入，统一审批仍在 Desktop。

输出复用完整 Ink TUI、CLI 安全事件投影和 Store，按持久事件游标读取，展示模型回复、工具过程和状态。输入支持原编辑及历史，慢请求期间可编辑下一条草稿；Host 确认的追加原文显示在时间线。多行宿主回执复用原生时间线展示，单行状态仍在输入框上方。连接令牌仅在客户端环境与本地认证通道使用。主控的模型、权限、Skills、Context、Jobs、Undo 与图片复用正常 CLI Controller 和同一 Composition Root；执行者终端使用所绑定委派的普通输入、恢复和精确停止入口，审批与回答由本会话图形控件承接。

主控可粘贴设置中复制的 `/ap-orchestration <流程>` 完整首行，追加正文后发送。模板识别仅使用首行，正文、附件及 `@` 文件按原投递合同进入主控。主控用 `/finish run [原因]` 或 `/finish step <步骤ID> [原因]` 有序收尾；执行者输入 `/finish [原因]` 收尾本步骤，或输入 `/finish run [原因]` 收尾整个 Run。回执在发起会话和 Run 详情可查。需要立即中断时使用原精确停止入口。

受管主控和执行者的审批菜单直接使用原请求的 `allowedDecisions`，兼容读取其安全 display 中的集合；均缺失时只提供 `allow_once` 与 `deny`。允许时显示会话与工作区授权，原值交给 Core 校验并保存原 grant；菜单注明本主控／本执行者会话、工作区及原约束。普通 CLI 与 Parallel 沿用各自原审批行为。

审批确认保存即可反馈「已批准／已拒绝，正在恢复原任务」，恢复结果独立持久保存，通过快照在两个入口一致显示。`/approval status` 核查本会话原审批及恢复回执，并显示安全阶段、错误码和白名单存储诊断；`/approval resume` 只请求续接原任务，不重新提交决定。先核查原请求，再核对原 Turn/checkpoint、无活动执行/Job 与目录准入；已开始、换 Turn 或仍未知不会再次执行。旧记录只有在 Core 原已决暂停点可核对时提供恢复，不从旧回执补造缺失的 OS 原因。

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

- `list`：按 `updatedAt` 降序输出当前 Project 下 Session 的脱敏摘要（`id`、`title`、`status`、`updatedAt`）。`status` 取值：`idle`（无活动 Turn）、`running`（有活动 Turn）、`waiting_approval`（有 Turn 等待审批）、`waiting_user_input`（历史结构化问题等待回答）、`interrupted`（Turn 被中断）、`failed`（Turn 失败）、`completed`（最近 Turn 完成）。
- `rename <id> <title>`：通过 `SessionService.rename()` 校验空标题与长度，输出 `{ id, title, updatedAt }`。
- `delete <id> [--yes]`：调用 `SessionService.delete()`，成功输出 `{ id, deleted }`。不带 `--yes` 时在 TTY 确认，带 `--yes` 跳过确认；**非交互模式无 `--yes` 不删除**，stderr 输出 `SESSION_DELETE_CONFIRMATION_REQUIRED` 并以退出码 2 结束。Core 仍拒绝被协作组引用的会话（`THREAD_HAS_PENDING_WORK`）、含运行／审批／问答等待 Turn 的会话（`TURN_ALREADY_RUNNING`）或含活动 Job 的会话（`SESSION_HAS_ACTIVE_JOBS`），这些失败退出 1。

**安全边界**：只管理当前 canonical workspace 下的 Session；Session 不存在或不属于当前 Project 时返回 `SESSION_NOT_FOUND`。删除级联清理 Turn/Checkpoint/Transcript/Approval/Inbox/lease/mutation 及 Session 图片等外围资源。

---

## 5. 信任管理

```text
autopilot trust status
autopilot trust revoke
```

- `status`：输出当前工作区 Trust 状态 `{ status: "trusted" | "denied" | "pending" | "expired" }`。
- `revoke`：调用 `WorkspaceTrustPolicy.revokeTrust()`，把信任恢复为 `pending`（未信任），输出文字 `trust revoked: pending; future capability, Runtime, and Provider initialization is blocked`。

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
| `effortLevel` | 此命令的 writer 仅接受 `low` \| `medium` \| `high`；手写 settings 的六档与模型限制见 6.3、6.4 |
| `availableModels` | argv 用逗号分隔，条目去首尾空白并忽略空项，最终列表须非空且不重复；JSON 文件用字符串数组。仅 User scope 生效，限制 firstParty 主/子模型选择，不声明模型能力；route 模型使用各 route 的 models 清单；缺省候选合并主模型、已映射 alias、子模型及 route 模型 |

### 6.2 安全边界

- 不在 allowlist 内的 key 拒绝；命令值按标量/逗号列表解析，不把传入文字作为 JSON 对象注入。writer 拒绝空白 model、非法 effort、空/重复 availableModels，CLI 将错误收窄为 `CLI_RUNTIME_ERROR`。model 是否可用和 scope 是否允许由运行时 resolver 另行判定，不能把 config set 成功当作最终有效；例如 Project/Local 的 availableModels 可以写入但不生效。
- 凭据与 endpoint 由用户手工编辑 User settings。默认连接使用 `env` 中的 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY` 之一，以及可选的 `ANTHROPIC_BASE_URL`；显式 route 使用 `providerRoutes` 和对应 env 凭据，见 6.4。它们不通过普通 `config get/set/show` 写入或回显；Project/Local 的 `env` 不生效。
- Search 由 User settings 启用，可手工添加严格的 `webSearch: { provider, baseUrl, model, credentialRef: { provider, key } }`；当前 provider 支持 `deepseek`、`openai-compatible` 与 `xiaomi-mimo`，Base URL 不含协议路径（`/v1/messages`、`/responses`、`/chat/completions` 由适配器追加）。普通 `config get/set/show` 不写入或回显凭据引用与 Base URL。本机 Web 设置中心的“主模型”分类可保存同一完整连接和独立 Key，不改变普通 CLI config 的写入边界。Search 使用独立用途引用；仅官方 `https://api.deepseek.com/anthropic` 主连接可复用主 Key，复用时固定使用 DeepSeek 官方 Anthropic 地址与 deepseek-flash 模型。其他连接使用自身 provider/Base URL/model/Key，并统一以 `reasoning: { effort: "none" }` 关闭思考；主问答模型与思考设置独立。显式设置 `webSearch:false` 后下一次 start/continue 隐藏 Search；省略时官方 DeepSeek 主连接仍可默认继承，已运行请求使用当前快照。
- 配置启用即授权查询外发：query 发给所选搜索供应商，搜索答案与来源随后作为工具结果发给当前主模型供应商，可能形成双 Provider 数据流。Plain/JSONL 模式启动聊天前向 stderr 显示提示；TUI 的启动品牌区保留同一提示。网页读取按当前权限档处理初始域，跨域重新绑定目标并审批。
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

`permissions` 段只接受 `allow`/`deny`/`ask`：`allow` 仅 Local 文件（workspace 的 `settings.local.json` 投影）生效，User/Project 的 `allow` 产生 `SETTINGS_PERMISSIONS_SCOPE_FORBIDDEN`；未知字段（如 Claude Code 的 `defaultMode`、`Bash(...)` 类工具规则）产生 `SETTINGS_PERMISSIONS_UNSUPPORTED`——该字段不生效、不迁移、不写回，也不会产生任何授权，同段合法的 `deny`/`ask` 收窄继续保留。`deny`/`ask` 出现无法解释的条目或 `permissions` 不是对象时产生 `SETTINGS_PERMISSIONS_UNSAFE` / `SETTINGS_PERMISSIONS_INVALID`：外部文件操作的自动放行与持久授权一律按拒绝处理（fail-closed），修正该字段前不会恢复。设置中心读取时权限段问题单独展示，不阻断模型字段读写；保存模型配置不会删除、迁移或改写该段。

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
| `effortLevel` | `"none"` / `"low"` / `"medium"` / `"high"` / `"xhigh"` / `"max"` | 手写文件三层可声明；User env effort 优先；实际合法子集见 6.4 |
| `env.CLAUDE_CODE_EFFORT_LEVEL` | 同一六档，另接受 `"auto"` / `"unset"` | User-only；auto/unset 清除显式 effort，随后采用模型缺省或供应商默认 |
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

主模型支持 `anthropic-messages`、`openai-chat-completions`、`openai-responses`。协议必须由 `apiProtocol` 显式声明。`compatibilityPreset` 可为 `openai`、`deepseek`、`generic`，仅用于后两种协议；route 名、模型名和 URL 均不触发预设识别。官方 OpenAI 连接必须显式设置 `"compatibilityPreset": "openai"` 才采用对应参数和能力合同。

Anthropic route 的可选 `protocolProfile` 必须恰为 `{ "apiProtocol": "anthropic-messages" }`。各协议 profile 均须与 route 的 `apiProtocol` 一致。

连接放在 User 文件 `~/.autopilot/settings.json`，Windows 对应 `%USERPROFILE%\.autopilot\settings.json`。`providerRoutes` 在 Project/Local scope 不生效。route 字典 key 可以自定，`id` 与 `credentialRef.provider` 必须同为该 key。`model` 用 `routeId/modelId` 选中已声明的单个模型。`models` 是非空对象数组，每个模型使用独立对象，每个对象只写一个 `id`，各模型的 `id` 不重复。同一对象重复写 `id` 键会被 JSON 解析覆盖。route 可选 `displayName` 必须非空。

`credentialRef.key` 精确引用 User 文件的 `env` 字段。下例使用 `USER_SETTINGS_CHAT_API_KEY` 与 `USER_SETTINGS_RESPONSES_API_KEY`，应保持引用与 env key 一致。`USER_SETTINGS_*` 引用先查同名字段，再兼容去掉 `USER_SETTINGS_` 前缀的字段；缺失时失败，不回退进程环境。普通 key 在 User env 缺失时才按 `<规范化大写 provider>_<大写 key>` 查进程环境。settings 的 env 不自动导出为进程环境。

`baseUrl` 填供应商 API 根路径，如 `https://api.example.com/v1`；Chat 适配器追加 `/chat/completions`，Responses 适配器追加 `/responses`。不要把完整资源路径填入 `baseUrl`。URL 限制同 6.3。

#### 6.4.1 Chat Completions 配置

1. 在 User 文件中合并下面的完整连接，替换占位 Key、示例域名和虚构模型 ID。该示例声明通用 Chat 合同，实际服务需支持流式函数调用。
2. 按供应商合同选择 `compatibilityPreset` 和 `protocolProfile`。如接官方 OpenAI，显式改为 `openai`，并按下方模型表选择可用模型与 effort。
3. 将顶层 `model` 设为 `chat-example/example-chat-model`，清理会覆盖它的 `env.ANTHROPIC_MODEL`。进入目标目录运行 `ap`、完成 Trust，再运行 `ap doctor` 核对离线诊断。

```json
{
  "env": {
    "USER_SETTINGS_CHAT_API_KEY": "YOUR_API_KEY"
  },
  "providerRoutes": {
    "chat-example": {
      "id": "chat-example",
      "apiProtocol": "openai-chat-completions",
      "compatibilityPreset": "generic",
      "baseUrl": "https://api.example.com/v1",
      "credentialRef": {
        "provider": "chat-example",
        "key": "USER_SETTINGS_CHAT_API_KEY"
      },
      "protocolProfile": {
        "apiProtocol": "openai-chat-completions",
        "assistantToolCallContent": "null",
        "supportsReasoningContent": false,
        "supportsUsageInStreaming": true
      },
      "models": [
        {
          "id": "example-chat-model",
          "capabilities": {
            "supportedReasoningEfforts": ["none"],
            "defaultReasoningEffort": "none",
            "inputModalities": ["text"],
            "supportsToolCalls": true
          }
        }
      ]
    }
  },
  "model": "chat-example/example-chat-model",
  "effortLevel": "none"
}
```

Chat profile 必须恰含上例四个字段，`assistantToolCallContent` 允许 `"empty-string"` 或 `"null"`，其余两项为布尔值。模型级 profile 优先于 route profile，整对象替换；省略时采用内置 Chat 缺省 profile。`supportsReasoningContent` 只声明私有推理字段格式，effort 仍由模型能力校验。

OpenAI Chat 使用 `max_completion_tokens` 并省略旧式 `thinking`；DeepSeek Chat 使用 `max_tokens`；generic Chat 使用 `max_tokens` 并省略采样参数。旧配置缺省 `compatibilityPreset` 时保留原 Chat 兼容路径，包括旧采样/`thinking` 行为，不自动迁移为 OpenAI 预设。添加预设前须核对目标服务合同。

#### 6.4.2 Responses 配置

1. 在 User 文件中合并下面的独立配置，替换占位 Key、示例域名和虚构模型 ID。此例声明 OpenAI Responses 的 encrypted replay 合同。
2. API 根地址由供应商提供，适配器自动追加 `/responses`。核对服务支持该协议、模型的函数调用和所声明 effort；按需要改用下表的 DeepSeek 或 generic 策略。
3. 将顶层 `model` 设为 `responses-example/example-responses-model`，清理覆盖用的 `env.ANTHROPIC_MODEL`；完成 Trust 后用 `ap doctor` 核对离线诊断。

```json
{
  "env": {
    "USER_SETTINGS_RESPONSES_API_KEY": "YOUR_API_KEY"
  },
  "providerRoutes": {
    "responses-example": {
      "id": "responses-example",
      "apiProtocol": "openai-responses",
      "compatibilityPreset": "openai",
      "baseUrl": "https://api.example.com/v1",
      "credentialRef": {
        "provider": "responses-example",
        "key": "USER_SETTINGS_RESPONSES_API_KEY"
      },
      "models": [
        {
          "id": "example-responses-model",
          "capabilities": {
            "supportedReasoningEfforts": ["low", "medium", "high"],
            "defaultReasoningEffort": "medium",
            "inputModalities": ["text"],
            "supportsToolCalls": true
          }
        }
      ]
    }
  },
  "model": "responses-example/example-responses-model",
  "effortLevel": "medium"
}
```

| Responses 预设 | 缺省 protocolProfile | 限制 |
|---|---|---|
| `openai` | `{ "apiProtocol": "openai-responses", "reasoningReplay": "encrypted" }` | 发送 `store:false` 与 `include:["reasoning.encrypted_content"]`；显式 profile 必须保持 encrypted |
| `deepseek` | `{ "apiProtocol": "openai-responses", "reasoningReplay": "content" }` | 显式 profile 必须保持 content；effort 限 `none/low/high/max` |
| `generic` 或省略 | `{ "apiProtocol": "openai-responses", "reasoningReplay": "none" }` | 公共协议保守缺省；受信声明可改为 encrypted/content，需服务支持 |

Responses profile 只能包含表中两个字段。模型级对象优先于 route 对象，随后才是预设缺省。私有 replay 绑定协议、route、Base URL 与模型；切换连接不会把旧供应商的私有推理原样重放给新连接。

#### 6.4.3 模型能力、effort 与生效顺序

配置接受中立六档 `none/low/medium/high/xhigh/max`，实际请求采用模型与协议的合法子集。非法组合会产生诊断或 `REASONING_EFFORT_NOT_SUPPORTED`，不静默降档。当前内置精确模型与预设组合如下。

| 显式预设与模型 ID | Responses effort | Chat Agent 工具与 effort | 原生图片输入 |
|---|---|---|---|
| `openai`，`gpt-6-astra`、`gpt-6.1-sol` | `low/medium/high/xhigh/max`，缺省 medium | 不支持 Agent 工具，需 Responses | 支持 |
| `openai`，`gpt-6.1-terra` | 六档，缺省 medium | 不支持 Agent 工具，需 Responses | 支持 |
| `openai`，`gpt-6-sol`、`gpt-6-luna` | 六档，缺省 medium | 支持工具，仅 `none`，缺省 none | 支持 |
| `deepseek`，`deepseek-flash`、`deepseek-v4-flash` | `none/low/high/max`，缺省 high | 支持工具，同一四档 | 支持 |
| `deepseek`，`deepseek-v4-pro` | `none/low/high/max`，缺省 high | 支持工具，同一四档 | 仅文本 |

Anthropic Messages 保留原映射，支持 `none/low/medium/high/max`，拒绝 `xhigh`；旧 firstParty 与无预设 Chat 的历史目录行为继续保留。协议支持图片字段不等于模型支持图片，原生图片输入还需所选模型的 `inputModalities` 含 `image`。已知 OpenAI 工具/effort 限制、输出硬上限和 DeepSeek Pro 文本输入限制不能通过能力声明放宽。

未收录的新模型可直接在当前 route 的 `models` 中增加独立对象，并声明 `capabilities` 与必要的 `protocolProfile`，无需等待内置目录更新。能力字段包括 `supportedReasoningEfforts`（无重复六档子集，空数组表示不支持调整）、`defaultReasoningEffort`（必须属于该数组）、`inputModalities`（无重复、必须含 text，可再含 image）、`supportsToolCalls`（布尔）、`maxOutputTokens`（正整数）。模型对象另可声明 `contextWindowTokens`（1–10,000,000 的 JSON 整数）；它表示上下文窗口，输出预算独立。

能力优先级为每模型显式字段覆盖内置精确目录，省略字段沿用目录或保守缺省，再应用协议/预设硬限制；数组整体替换，单模型声明不传播到同 route 的其他模型。未知 Responses 模型缺省仅文字与函数调用，effort 能力未知时采用供应商默认；要显式指定 effort 或发送图片，先按实际服务补齐对应声明。上面两个虚构模型示例仅展示用户声明写法，声明本身不代表已在线验证。当前目录随源码版本提供。

模型与 effort 的有效来源按以下顺序确定。

- settings 普通字段按 User < Project < Local 合并，后两层只能选择 User 已授权模型。User `env.ANTHROPIC_MODEL` 高于这三层 `model`；User `env.CLAUDE_CODE_EFFORT_LEVEL` 高于这三层 `effortLevel`，包括 auto/unset 的清除语义。
- 当前 Session 的 `/model`、`/effort` 默认值覆盖 settings 默认值；未指定 effort 时采用模型能力中的缺省值，无缺省则使用供应商默认。`/effort` 菜单和直接参数只接受当前模型/协议合法子集。
- settings 热更新与模型/推理 slash 修改作用于下一 Turn（nextTurn）。权限的人类选择在下次安全恢复或新 Turn 采用，状态栏以 Core 当前执行段视图展示，模型/Provider 的 Continue 仍沿用原冻结配置。

独立 `visionModel` 仍只接受已声明 Chat Completions route 的模型或 `false`，省略时继承主模型；主模型新增 Responses 不扩大独立视觉覆盖的可选协议。Search 继续使用 6.2 的独立 `webSearch` 合同及凭据用途，不能直接把任意 `providerRoutes` 当作搜索连接。

---

## 7. 诊断

```text
autopilot doctor [--connectivity]
```

逐行输出 `PASS` / `WARN` / `FAIL` / `SKIP` 检查结果。默认**不升级状态、不调用 Provider、不创建状态根**。普通入口会先确保用户配置目录存在，故不承诺完全没有文件系统写入。检查成功完成时退出 0，即使某项为 `FAIL`；调用本身抛出异常才退出 1。

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
| `web_search` | 配置且凭据可解析→`PASS`，未配置→`WARN`，凭据不可解析→`FAIL`，未 Trust→`SKIP` | `configured` / `not configured` / `credential unavailable`，Trust 后附带查询发往所选搜索供应商、结果发往主模型的告知 |
| `skills` | 发现→`PASS`，配置不可用→`WARN`，未 Trust→`SKIP` | `N discovered` / `configuration unavailable` |
| `mcp` | 配置→`PASS`，配置不可用→`WARN`，未 Trust→`SKIP` | `N configured` / `configuration unavailable` |
| `provider_connectivity` | 仅在 `--connectivity` 下探测→`PASS`/`WARN`/`FAIL`，未开启→`SKIP` | `use --connectivity` / `endpoint reachable` / 脱敏失败类别 |
| `web_search_connectivity` | 仅在 Search 已配置且 `--connectivity` 下探测→`PASS`/`WARN`/`FAIL`；未配置、凭据不可用、未开启或未 Trust→`SKIP` | `endpoint reachable` / `not configured` / `credential unavailable` / `use --connectivity` / 脱敏失败类别 |

**安全边界**：Trust 未建立时，settings、Web Search、Skills、MCP 与 Provider 连通检查均为 `SKIP`；不输出独立的 model、credential 或 Memory 检查行，不为了 Doctor 绕过 bootstrap 边界。Provider 探测使用所选连接的 Base URL，Search 探测使用所选搜索供应商的协议 endpoint，均为无凭据、无模型、无请求体、5 秒超时且不自动跟随重定向的 HEAD 请求，不记录 endpoint、认证或响应正文，也不执行真实搜索。HTTP 状态低于 500 即记为可达（含 401/404 等），因此 PASS 不表示密钥有效或模型可调用；主连接 `credential` 也仅检查引用已配置，Search 的 credential 另做本机解析。

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

`AUTOPILOT_PERF_DIAGNOSTICS=1` 启用 Core、Provider、Runtime、TUI Store 和输入区的分段记录；`AUTOPILOT_PERF_DIAGNOSTICS_FILE` 指定退出时写入的 JSONL 文件。诊断记录包含 `version`、`point`、`eventType`、`monotonicMs` 和可选 `durationMs`；错误记录额外包含封闭 `errorCategory/errorCode`，Session 保存失败可包含内部 `storage`（固定 operation/target/phase、白名单 OS code、锁等待毫秒和清理失败标记），不包含回答正文、输入文本、凭据或路径正文。文件在 CLI 进程退出时一次性写入，运行期间不会逐事件落盘。

CLI/TUI 当前没有查看诊断过程或结果的交互界面；需要用文本编辑器、脚本或测试宿主读取该 JSONL 文件。未设置输出文件时仍会在进程内收集，但退出后不会保留；只设置输出文件而不把开关设为 `1` 不会记录任何数据。

启用该开关后，TUI 的 Controller dispatch 异常会额外记录一条 `point: "tui_runtime_error"`：`eventType` 为 `dispatch`，`monotonicMs` 为单调时钟毫秒，`errorCategory` 与 `errorCode` 来自 Core/Adapter 稳定错误码白名单。分类包括 `config_directory`、`workspace_trust`、`agent_runtime`、`node_state`、`node_chat` 与 `unknown`；未知或非法错误码分别收敛到固定通用码（如 `CLI_RUNTIME_ERROR`），不会记录任意对象的 `code`。TUI 对 `node_state` 显示稳定码与“会话保存未完成”提示，对 `THREAD_RECOVERY_REQUIRED` 显示发现／绑定指引，其余 dispatch 异常显示 `CLI_RUNTIME_ERROR`。记录不含异常消息、`cause`、stack、路径、prompt、Provider 内容或凭据。

---

## 8. MCP 管理

```text
autopilot mcp list
autopilot mcp approve <server> [--yes]
autopilot mcp revoke <server>
```

- `list`：列出 Trust 后读取到的 MCP server 摘要，每项含 `serverName`、`approved`、`executionMode`（`sandbox` / `host`）与 `isolation`（`sandboxed` / `unisolated`）；不回显 command、args、cwd 或环境变量。未配置 `execution` 时显示 `host` / `unisolated`。
- `approve <server> [--yes]`：为 server 当前配置与有效执行模式保存 workspace grant，不会由此命令启动 server；成功输出 `{ serverName, approved, executionMode, isolation }`。默认 `host` 与显式 `host` 都会在授权前 stderr 明确警告其直接运行在宿主且没有 OS 沙箱隔离；非交互必须 `--yes`，否则 stderr 输出 `MCP_APPROVAL_CONFIRMATION_REQUIRED` 并以退出码 1 结束。
- `revoke <server>`：撤销该 server 的授权，输出 `{ serverName, approved: false, revoked }`。

**安全边界**：Workspace Trust 只允许读取 `mcp.json`，不等于允许执行任意 server command；授权前把 `program + args + cwd + configHash` 作为 `mcp_server_start` ActionFacts 交给 PolicyEngine，不能把 CLI 确认当成绕过 hard deny。每个 server 默认使用 `execution: "host"`；只有配置显式选择 `"sandbox"` 才经 `SandboxPort`。host 以宿主用户权限运行且没有 OS 沙箱，必须显示 `unisolated` 并在授权前警告。两种模式都要求 Workspace Trust 与绑定 `serverName + configHash`（包含有效执行模式）的 workspace grant；缺省模式变更及旧 hash 标准化会使旧 grant 失配，需重新授权。sandbox 初始化失败保持 fail-closed，不回退 host。server 启动后的每次 MCP 工具调用仍需要工具审批，审批卡显示其隔离事实；macOS 上 `run_command` 与 Job 仍要求 OS 沙箱；Windows 不加载 SRT，进程工具按权限模式与风险分流，在宿主直接执行且没有 OS 隔离（见 8.5 停用报告与第 9 节宿主 Job 说明）。server 不存在返回 `MCP_SERVER_NOT_FOUND`。

---

## 8.5 沙箱管理

```text
autopilot sandbox status
autopilot sandbox setup --yes
```

- `status`：输出当前平台沙箱能力报告（脱敏 JSON）：`platform`、`backend`、`enforcement`（`full` / `partial` / `unavailable`）、`installed`、`provisioned`、`version` 与脱敏 `diagnostics`。macOS 首次 status 会惰性初始化 Seatbelt 沙箱；Windows 返回宿主执行停用报告（`backend: "host-execution"`，diagnostics 说明进程调用按权限模式与风险分流，在宿主直接执行且没有 OS 隔离），不加载 SRT、不报告 provision。不需要 Trust。
- `setup --yes`：显式触发沙箱安装（macOS 无 provision 步骤，返回当前能力报告；Windows 返回同一份宿主执行停用报告，不触发 UAC、不做系统变更）。必须显式 `--yes`，否则 parser 报错 `sandbox 支持 status | setup --yes`。要求工作区已 Trust。

**安全边界**：报告不含 SID、用户名、真实路径列表、凭据或命令正文；底层错误统一映射为稳定 `SANDBOX_*` 错误码，不透传 SRT 原始文案；setup 不会在模型工具调用或普通命令中自动触发。

---

## 9. 后台 Job 管理

TUI Job 请求带视图代次，Esc 返回后迟到详情不会重新打开弹层；详情与停止结果按 revision 同步缓存列表，因此停止后 Esc 返回仍显示 stopped。交互TUI统一使用inline主屏与终端原生滚动，不启用备用屏或正文内置滚动条；历史fullscreen环境变量不再启用备用屏，`NO_COLOR`只关闭颜色。按Ctrl+T呼出有界历史目录面板，按Ctrl+A进入关联任务/审批面板。
待关联任务审批时显示“Ctrl+A原地处理”；待审批Session无需保留执行中的activeTurnId，宿主校验最新Turn归属与状态后展示当前审批。子会话自身同样保留当前有效审批卡；旧Turn/终态不恢复、不代批。

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

输入 `/` 或命令前缀可打开候选。菜单按终端剩余行数展示候选，缩放时保持当前选中项。↑/↓ 可在首末回绕，计数以全部匹配项为准。窄屏会截短过长的说明。Tab 补全，Enter 选择或执行，Esc 关闭。

| 命令 | 用法 | 说明 |
|---|---|---|
| `/exit` | `/exit` | 退出整个 CLI 宿主，按本进程 owner 收尾并报告未决事实 |
| `/resume` | `/resume` | 显式恢复当前选中会话的可恢复 Turn；查看/切换不执行此动作 |
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

交互 TUI 的长命令结果（含受管主控 `/help`、`/agent <委派ID> status` 安全预览）打开完整报告覆盖视图：↑↓ / PgUp / PgDn 滚动，Esc 仅返回聊天，保留原草稿且不取消 Turn。Ctrl+G 可重新打开全部已保留通知，最近四条 info 不再是完整信息的唯一入口；短结果仍在原 info 区显示。Jobs、Context、模型/权限/Skills/effort 等已有专用视图与当前审批优先，普通文本不得另开报告覆盖它们。非交互 text/jsonl 输出保持原路径。受管命令的审批 ID、保存与续接约定见上文受管入口及 [Desktop 使用指南](HowToUse.md#desktop)。

编排主控的 `/help` 和裸 `/agent` 打开同一份中文帮助，按任务与派工、主控操作、执行者操作和历史恢复分组。帮助正文只出现在滚动覆盖层。普通 CLI 不支持 `/help`，请使用 argv `ap --help`；普通 slash 补全目录为 12 项，额外支持手动 `/resume` 和 `/reasoning`（`/effort` 别名），它们不在普通补全目录中。

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
- 非交互输出：`text` 输出固定字段顺序的文字报告；`jsonl` 输出结构化安全 DTO。交互 TUI 在 `NO_COLOR` 下仍以字符绘制网格，读屏模式使用完整文字报告。
- 安全边界：报告不含 Memory 路径、Skill/工具名、schema、消息正文、message count、tool/request 签名或凭据；仅 Memory/Skills 携带聚合 `itemCount`。比例可超过 100%，文本显示真实超限值，视觉网格封顶。

状态栏在模型、推理强度和权限值之后显示 `workspace: <路径> · context: <状态>`。窄终端先缩短路径，读屏模式可换行并保留完整文字。Context 有快照时为 `context: 16.1% · measured` 或 `context: ≈16.1% · estimated`；无数据固定 `context: unknown`。`measured` 只表示当前上下文没有本地增量，下一次输出仍是预留而非实测。

底栏以 ` · ` 分隔模型、推理强度和权限值，并省略累计用量行。用量数据和 Context 仍由 `runtime.turns.getUsageSnapshot()` 的安全快照提供。分项不完整时保留已知总量，执行段耗时沿用快照口径。

`/compact` 的反馈使用 Core 显式 outcome：changed 输出 `context compacted: estimated 120000 -> 52000`；skipped 输出 `context compact skipped: no compactable history; projection unchanged (estimated 120000 tokens)`；活动 Turn 中显示 `TURN_ALREADY_RUNNING: 当前 Turn 仍在运行，请等待结束或中断后再压缩`（退出码 1），不声称已排队或将在安全边界执行。`preTokens`/`postTokens` 一律标注 `estimated`（本地估算）。

交互 TUI 在手动压缩请求等待期间显示 `Compacting context…`，复用现有活动动效；读屏或减少动态效果模式保留静态文案。等待态归属当前 Session，切换会话再返回仍可显示，成功、跳过或失败后清除，再显示结果并刷新用量。

注意，当前 DeepSeek 与 OpenAI/GPT 均使用应用侧管理的摘要压缩，由当前 Turn 冻结的 Provider 采样器生成摘要并替换后续执行上下文。使用远程 Provider 时摘要仍需远程模型调用。当前尚未适配 OpenAI 原生云压缩（`/responses/compact` 或 `context_management`），选择 Responses 协议也沿用上述摘要流程。

### 11.3 其他 slash 命令要点

- `/jobs`：打开当前 Session 的任务列表；`show` 查看安全详情，`output` 查看有限安全日志，`stop` 明确停止当前 Runtime 拥有的目标。TUI 中可用方向键、Enter、`o`、`s`、`r` 操作；Agent 执行中仍可调度。详情 Esc 返回列表，列表 Esc 返回原输入视图，不取消 Turn、不退出 CLI，输入状态保持。
- 可见会话侧栏优先消费Esc关闭（包括未聚焦侧栏），关闭/切换不取消Turn；状态栏同步提示Esc关闭侧栏。侧栏关闭且 Turn 正常运行时显示 `Working · Esc interrupt`。运行中 Enter 提交普通正文为 steer 引导，`/queue` 显式排下一轮；受管主控可用 `/help` 查看本模式帮助。取消提交时绑定精确Session/Turn并过滤终态/重复请求，不对Completed显示取消请求成功。
- Trust 成功后，CLI 确保当前 canonical 项目根存在 `.autopilot/tmp`，仅作为 Agent 临时脚本、截图裁剪和中间产物目录；不因此创建项目级 `settings.json` 或 `settings.local.json`。临时目录不应写入 `node_modules`。
- `/queue <prompt>`：仅在已有活动 Turn 时生效，投递到 durable inbox 队列；领取后的下一 Turn 标记为 claimed queue，因此仅继承上一任务链的安全 Todo 快照，不会从普通无关新 Turn 前复活旧 Todo；缺 prompt 返回用法错误。
- `/permissions <mode>`：只接受三态工具权限模式，缺 mode 时打开 picker。人类选择在下次安全恢复或新 Turn 生效，状态栏分别显示当前模式和“恢复 / 新回合权限”。`auto_approve` 自动执行已核实的只读操作与受信工作区常规新建和编辑。`full_access` 跳过一般审批。删除、丢弃已有修改、`git push`、无法判断效果的进程和其他精确授权边界仍保留单次确认。显式询问或拒绝、沙箱、工作区外修改授权、Trust、Skill 与路径校验保持生效。普通 CLI 与编排主控共用此规则。
- `/permissions grants`：列出当前 Session/工作区可见的持久授权（scope、toolName、constraint 及记住状态）；canonical 私有身份由 Core list 投影剔除。允许活动 Turn 中使用与 `/permissions revoke` 不同：撤销是持久状态变更，活动 Turn 中不可用。
- `/permissions revoke <constraint>`：按列表原样复制的 constraint 精确撤销；Core 先删 grant 权威再删工作区 local 投影规则，删除失败或不存在时返回稳定错误，不模糊匹配、不撤销其他授权。
- `/approve <decision>`：只接受固定宿主决定，不携带冻结调用字段；缺决定或非法值返回用法错误。
- `/model <modelId>`：值必须属于当前 settings 允许的模型目录，并支持 Agent 工具；`/effort <effort>` 从中立六档 `none/low/medium/high/xhigh/max` 中按当前模型/协议合法子集选择，菜单与直接参数共用该子集。模型切换也校验已选 effort；不兼容时返回 `REASONING_EFFORT_NOT_SUPPORTED`。两者保存为 Session 下一 Turn 默认值，优先于 settings，活动 Turn 与 Continue 使用原冻结值。

### Continue 与后台执行

写后读回验证未完成时显示“等待修改文件读回验证 · 可继续”，既有精确继续词恢复同一 Turn。继续只补 read_file 验证和总结，不重放已完成写入或任意恢复 failed。停止当前 Session/Runtime 的精确 Job 不再弹额外操作审批，外部/不确定 owner 拒绝；全树停止失败仍为 stopping/JOB_STOP_FAILED，不能用包装进程 close 伪造 stopped。

---

## 12. 会话协作（thread）

交互 TUI 在一个inline窗口管理当前Project的平级会话，正文回看使用终端原生滚动。Ctrl+T才按需读取历史目录，每页最多扫描20条元数据记录；目录只显示标题，UUID仅作内部精确路由，重名标题仍选择原UUID。PgDn到已载目录末尾时加载下一页，过滤后空页仍保留继续入口；目录不读transcript/checkpoint、不解析或保留presentation消息，不给未打开普通会话创建Controller/Store/React子树。Node可流式扫描旧Session JSON的结构字节跳过正文，不承诺零正文磁盘字节。Enter仅为精确目标创建视图并读首100条事件；Ctrl+L显式加载下一历史页，到尾后只按末尾游标增量跟进。选择、翻页和切换不执行start/continue/resume，恢复仍用/resume。只挂载当前会话正文；已打开会话保留Store、草稿/附件/光标，隐藏会话不做渲染派生或状态栏查询。

正文仍每页100事件；生产宿主的当前交互直接采用Core安全执行投影，不等待摘要或正文追到尾。旧分页适配器路径仅供未提供统一投影的宿主兼容，不能覆盖已验证当前请求。同Turn恢复立即清旧审批，迟到旧正文只补历史；审批过期或失效给出刷新提示，提交不以放开running代替Core校验。

父任务只有收到Core结构化thread_wait事实才显示等待关联任务/待审批数量；待审批提示Ctrl+A处理，新事实交回父任务时显示正在处理关联结果。关联目标存在本身不改变父执行标签，父等待文案不参与子审批输入许可。

当前会话直接创建/显式关联的有效子审批自动显示带目标标题的真实卡片，同Project普通独立会话不混入。未打开关联目标只增量投影审批、阻塞、Todo及终态等安全状态，不保留回答或工具正文。自动到达的卡不抢输入焦点，主正文、草稿和光标保留。Ctrl+A聚焦首张卡，再按Ctrl+A按到达顺序轮转；Enter提交该卡冻结允许决定，d展开安全详情，PgUp/PgDn翻详情，Esc返回主输入。主会话保持选中，正文在聚焦期间仍可见。快照不足只显示待确认及刷新提示，关联审批交互不会自动切换子会话，Ctrl+T仍用于会话选择。输入通过根唯一订阅路由并在layout提交时绑定当前输入handler，避免切换后被动订阅空窗。

父入口与子自身入口复用同一个Controller/Store和原Session/Turn/approvalId。批准/拒绝沿原Controller提交，Core校验冻结调用、范围、TTL与唯一决定，批准后自动continue原Turn。父入口仅锁定具体审批请求，子consume保留原owner/取消登记，长执行不占父输入。非分组本机继续的dispatch Promise等待该段消费结束。分组已存交互在Core持久接受交接后返回，兼容Runner独立消费原Turn。已有决定撤下可操作旧卡，恢复失败如实展示“审批决定已保存，尚未恢复执行”；Ctrl+A聚焦后Enter重试，按精确原审批身份读取和复用持久决定，不再次提交批准。`controller.resume(expectedApproval?)`可选期望只用于该精确重试，普通/resume沿原恢复规则。Core在领取租约后复核当前执行段，迟到旧恢复不能重放已完成或后续暂停段。

审批继续异常保留`CLI_APPROVAL_CONTINUE_FAILED/<白名单错误码>`阶段标记，即使后续状态校准失败也保留原安全分类。Runner的stderr诊断同时给出`THREAD_HOST_ERROR <封闭类别>/<白名单错误码>`，未知异常回退固定标记，异常正文、cause、路径和凭据不进入这些诊断。

轻量元数据一旦确认关联目标的当前Turn改变、身份未知或已终态，立即在等待历史页前失效旧审批/问答及原地菜单；同Turn仍有效的审批保留，不等分页追赶。Controller/Projector的`invalidateObservedTurn?({turnId?,status})`只清除旧交互/执行身份，不合成事件、不恢复执行；旧提交/事件流/恢复查询的迟到响应不得复活旧状态或继续旧Turn。页返回再次核对原Controller与当前权威身份，结果同步只取原目标Controller当前投影。已打开正文保留为最后观察到的历史，草稿/附件/光标不清除。


CLI关联与普通目标的生产状态来自Core统一执行投影；父Ctrl+A和进入子会话引用同一原Session/Turn/approvalId请求，不等待正文101页或交互摘要游标追到尾。当前请求可见性独立于Session/Turn滞后running摘要；已有决定、过期、状态待确认、执行失联与摘要尚未同步均提供明确提示。提交仍走Core当前执行段/冻结输入/范围/TTL/重复校验，切换不授权、也不自动continue。Runner错误在stderr显示THREAD_HOST_ERROR，并在已挂载TUI增加关联任务状态提交失败提示。

首个有效交互即时保存20字输入短标题，首个成功回答沿Web范式取20字更新由本Controller建立的自动标题；手工标题不覆盖，无新模型采样。历史空标题显示“新对话”；交互顶栏、目录、底栏、提示及普通详情均不展示会话UUID，UUID仅在内部寻址及resume/非交互管理场景保留。新建委派目标由共享Core继承创建时当前有效permissionMode偏好，既有/显式ask目标仍可切入审批；不继承具体批准、Trust、凭据或Job，已冻结Turn不追改。

选择只读取既有安全 transcript 与已持久展示消息，不调用 start/continue/resume、不领取 lease。后台输入处理器和鼠标绑定显式关闭，显示隐藏不作为权限门；后台事件按 Session/Turn/seq 去重，仅更新原目标提醒，不抢焦点。审批、steer/queue、取消及恢复提交时固定目标身份，迟到结果写回原会话。新 Thread 只增加目录项，不另开窗口。

Ctrl+C、/exit、EOF 退出整个宿主：先停止观察与自动 queue，再仅取消本 controller/Runner 持有的 running Turn，等待审批/输入保留；仅释放本 owner 未启动的 claimed。stderr 分别陈述确认中断、等待、未交付、可恢复、未确认，不能把前台 Completed 当全部完成或宣称外部副作用已停止。无隐藏 daemon；重开后显式 /resume 或 ap resume 恢复。


同机的多个 `ap` 会话可以在同一个 canonical workspace / stateRoot / Project 内协作：用户通过 prompt 表达分工需求，Agent 首次创建子会话时按需建立根组，再投递任务并读取结果；人类启用/停用命令保留为管理接口。**真正的执行只由在线 `ap` 常驻会话持有的 Runner 驱动**；短命令只提交意图或观察事实，不启动隐藏服务、不接管其他窗口的 TTY。

### 12.1 通用约定

- `/resume`遇awaiting_approval且Core不再交付有效approval身份时，只委托原Core重签当前冻结调用审批；不发新任务、不批准或执行工具。已有有效审批保持待处理。若人类保存了与当前执行段不同的权限，resume 委托 Core 在安全边界重新评估，不提交或重放旧批准，仍只恢复原 Turn。

- 模型工具 `resume_thread({ threadId, expectedTurnId, groupId? })` 需本次单次确认，所有权限模式都不能跳过；仅恢复精确原 Turn，重复请求不会排入额外run。原审批/问答仍留在目标；旧恢复批准不能跨到同Turn后来一次暂停。accepted 不表示执行开始，`recoveryAction=open_target_continue` 时切入目标使用已有 `/resume`，无需更改状态文件。短命令未新增 `thread resume` 子命令。
- 中断立即撤下旧审批；失败提交校准 Core 当前状态，过期身份通过原恢复入口重新签发。执行耗时累计共享启动事件到审批/提问/暂停/终态的真实执行段，等待冻结，恢复真实启动后续加；活动、结果与相关状态栏使用一致口径，不修改安全runtimeBudget。
- CLI 不装配 `open_preview` 或 Intelligent UI。共享 `start_background_job` 在审批前复用纯 serviceUrl 校验，只接受loopback HTTP(S) origin；页面路径属于Web的open_preview.url。前台命令不适合常驻服务，超时先检查执行/端口事实，不能盲重试。

- 组用 `--group <groupId>`、会话用 `--thread <threadId>` 指定；`threadId` 就是 Session ID。
- 除采用版本 CAS 的 `bind-host` 外，写命令必须显式提供 `--request-id <id>`（调用方生成并保存的 UUID）。相同 requestId 与相同内容重试返回原回执；同键不同内容返回 `THREAD_REQUEST_CONFLICT`，不覆盖原记录。
- 正文、交接摘要和共享板值从文件或 stdin 读取，避免 shell 引号与转义二次解释。
- 输出是单行 JSON（`watch` 为每行一条事件 JSON）；错误只写 stderr 的稳定错误码或固定提示，不含宿主路径或底层异常正文。
- 退出码：`0` 成功；`1` 运行期失败（`THREAD_SCOPE_DENIED`、`THREAD_STATE_CONFLICT`、`THREAD_HANDOFF_WRITE_FAILED` 等）；`2` 参数错误（含 Core `INVALID_INPUT`）；`130`/`143` 表示观察被 SIGINT/SIGTERM 结束。
- 全局选项 `--state-root`、`--trust-root`、`--workspace-root` 可写在 `thread` 之前或之后；其余选项必须匹配所在子命令。
- 短命令不启动 Runner，也不探测其他进程是否在线：回执只表示消息已接受，不写“已启动/已完成”。只有宿主能确定离线时才返回 `hostOffline`。
- 未建立 Project 或协作能力未装配时返回 `THREADS_UNAVAILABLE`；所有协作命令仍需工作区 Trust。
- 受信普通 Work 新 `start` 在根会话无组时可由首次 `create_thread` 按需建立根组；`continue`、Chat 与协作子会话不会获得该自举权限。组创建来源仍记录真实 thread actor，人类 owner 单独记录；`create_thread` 创建子会话本身不启动 Turn。
- Web 与 CLI 共用本机人类身份，因此同一 workspace / stateRoot / Project 下 Web 建的组可由 CLI 读取和投递；不同主体、工作区或 Project 仍被拒绝。该固定身份是首版本机单用户约定，不是认证凭据。

### 12.2 `autopilot thread group enable|disable`

```bash
ap thread group enable --thread <rootThreadId> --request-id <id>
ap thread group disable --group <groupId> --request-id <id>
```

- `enable`：为一个空闲 Work 会话建立协作组，并把它作为根成员。会话必须存在、属于当前 Project 且处于 `idle`；重复启用同一根会话返回同组。
- `disable`：拒绝后续 create/send/state.update/interrupt，保留成员、历史、回执与未交付消息；**不停止正在执行的 Turn**。需要停止时先 `interrupt` 并观察 owner 确认。
- 输出：`enable` 返回 `group`（含 `groupId`、`rootThreadId`、`enabled`、`allowedTools`、`members`）；`disable` 返回 `{ groupId, enabled: false }`。

### 12.3 `autopilot thread create|associate|list|read|bind-host`

`ap thread associate --group <groupId> --thread <threadId> --request-id <id>` 由已完成 Trust 的本机人类 owner 显式关联已有普通 Work 会话。Core 逐次验证同 workspace/Project、当前状态根 Store、真实 Session 和 owner，幂等重试不重复成员；模型无此关联工具，目标 ID 或创建血缘不产生授权。关联不启动模型。


```bash
ap thread create --group <groupId> --thread <parentThreadId> --request-id <id> [--title <t>] [--role <label>] [--model <provider/modelId>] [--effort <none|low|medium|high|xhigh|max>]
ap thread list --group <groupId> [--cursor <c>] [--limit <n>]
ap thread read --group <groupId> --thread <threadId> [--cursor <c>] [--limit <n>]
```

- `create`：在组内创建正常 Work Session 并绑定成员；创建**不启动推理**。`--thread` 是父会话，必须是组成员。`--model`/`--effort` 只能从宿主当前目录选择，非法值返回 `MODEL_NOT_FOUND` 或参数错误。输出含 `threadId`、`groupId`、`parentThreadId` 与 Web 相对链接。
- `list`：分页返回本组成员及当前组 `revision`（默认 20，最大 100），成员保留可选 `executionHost`。
- `read`：只读安全投影，返回会话摘要、最近 Turn、最近助手消息与有界历史；**不 resume、不启动、不确认已读**。
- `--cursor` 由上一次输出原样带回；跨视图、跨组或过期游标返回 `THREAD_CURSOR_INVALID`。

`ap thread bind-host --group <groupId> --thread <threadId> --expected-revision <revision> --execution-host <cli-work-v1|web-work-v1>` 用于人类确认尚无执行事实，或原执行权威completed且没有活动owner/claim的歧义旧目标。可先用 `ap session list` 取得会话id，再用 `ap thread group of --thread <id>` 只读取得groupId/revision，随后执行 `ap thread list --group <groupId>`，从同次结果取得目标和 `revision`，再明确选择执行档位。成功返回目标、档位和协议版本。此命令以 `expectedRevision` 做 CAS，版本变化后重新读取并确认。参数错误沿用 usage 退出码，权限/状态错误沿用协作错误映射。活动 owner、已知档位和无法证明兼容的旧执行事实受 Core 保护。模型没有绑定入口，命令自身不启动 Runner。

CLI capability、交互与短命令的人类 Facade、模型协作和 Runner 共用 `cli-work-v1`，Web 使用 `web-work-v1`。已有有效归属和原 Turn 冻结能力保持，跨端查看与投递保留目标档位。缺档位旧记录经执行证据和组 CAS 补齐，无法消歧时具名宿主保持等待。直接启动和恢复也遵守相同兼容门禁。

### 12.4 `autopilot thread send`

```bash
ap thread send --group <groupId> --thread <threadId> --mode <notify|run|steer> --request-id <id> \
  (--message-file <path> | --message-stdin) [--reply-to <messageId>] [--expected-turn-id <turnId>] \
  [--handoff-title <title> --handoff-file <path>]
```

- `--mode` 必填，语义固定：`notify` 只投递通知，不启动空闲目标；`run` 由在线 Runner 启动下一 Turn（目标忙时排到后续 Turn）；`steer` 只进入发送时匹配的活动 Turn。
- 正文二选一：`--message-file <path>` 或 `--message-stdin`（配合管道）。空正文在投递前拒绝。
- `steer` 必须给 `--expected-turn-id`；其他模式禁止该字段。Turn 已变化返回 `THREAD_TURN_MISMATCH`，目标空闲返回 `THREAD_NOT_RUNNING`，不降级成新 Turn。
- 交接（可选，仅 `--mode run`）：`--handoff-title` 与 `--handoff-file` 必须成对提供。宿主先原子写入 `<workspace>/.autopilot/thread-passdown-<handoffId>.md`，再接受消息；文件失败或内容冲突时不投递、不启动目标，返回 `THREAD_HANDOFF_WRITE_FAILED` / `THREAD_HANDOFF_CONFLICT`。交接只用于用户明确要求“换会话继续当前任务”。
- 输出：`messageId`、`deliverySeq`、`deliveryStatus`（接受即 `pending`），交接成功时另有 `handoffRef`。接受不等于目标已执行或任务完成。

### 12.5 `autopilot thread wait|watch`

```bash
ap thread wait --group <groupId> --thread <id> [--thread <id> ...] [--cursor <threadId>=<cursor> ...] [--task <threadId>=<messageId> ...] [--timeout-ms <n>]
ap thread watch --group <groupId> [--cursor <c>] [--limit <n>]
```

- `wait`：只观察 1–8 个不同目标的进展、完成、失败或需关注状态，**不启动、不恢复、不取消**任何目标；`--timeout-ms` 取 0–30000（默认 30000）。没有游标时立即返回当前快照；带上游标后等待变化。Ctrl+C 只结束本次等待。
- `watch`：按组事件序列持续输出 JSON 行（`member_created`、`message_accepted/delivered/blocked`、`shared_state_changed`、`turn_attention/terminal` 等）。Ctrl+C 只断开观察，不停止任何目标。

指定 `--task <threadId>=<messageId>` 时只等待该次 run 任务，taskId 等于 send 回执的 messageId；每个 --thread 最多指定一个 task。任务等待只取对应 delivery/真实消费 Turn，目标后续用户新 Turn 不混入；游标绑定 task，不能跨任务复用。省略 --task 仍为显式会话级观察，不能据其 latest 状态推断原委派完成。会话累计 pendingProgress 保持包含已淘汰摘要的语义，任务视图只计该任务（同样包含已淘汰条目）。

### 12.6 `autopilot thread state read|set|remove`

```bash
ap thread state read --group <groupId>
ap thread state set --group <groupId> --request-id <id> --expected-revision <n> --key <k> (--value <json> | --value-file <path>)
ap thread state remove --group <groupId> --request-id <id> --expected-revision <n> --key <k>
```

- 共享板只承载用户显式放入的 JSON（目标、约束、结论、引用等），不承载凭据、审批、checkpoint 或宿主绝对路径。
- 写入必须给 `--expected-revision`；版本不匹配返回 `THREAD_STATE_CONFLICT` 并附当前 revision，调用方需重新读取后重试，不自动合并。
- `--value` 必须是合法 JSON；复杂内容用 `--value-file` 读取，避免命令行转义问题。

### 12.7 `autopilot thread interrupt`

```bash
ap thread interrupt --group <groupId> --thread <threadId> --expected-turn-id <turnId> --request-id <id>
```

向当前 owner 提交中断意图并返回 `{ accepted, controlId, hostOffline }`；**接受不等于已停止**，实际终态需用 `read` 或 `wait` 查询。Turn 不匹配返回 `THREAD_TURN_MISMATCH`，目标没有运行中 Turn 返回 `THREAD_NOT_RUNNING`。

### 12.8 常驻宿主与退出

- 交互 `ap` 会话（含 `chat`/`resume`）会在启动时发现当前状态根下已启用的协作组，并接管本进程的 Runner；没有组时保持轻量复查，不产生执行轮询。
- 关闭或退出该 `ap` 会话会停止本进程持有的驱动：已取消与未确认的 Turn 数量写到 stderr（`thread runner stopped: cancelled=<n> unconfirmed=<n>`），不会把未完成任务写成成功。
- 另一个窗口的短命令与 `watch` 只读取同一份持久事实；执行仍取决于是否有在线且已授权的 `ap` 宿主。

示例（正文从文件读取，避免 shell 重新解释）：

```bash
ap thread send --group <groupId> --thread <threadId> --mode run --request-id <uuid> --message-file ./task.md
ap thread send --group <groupId> --thread <threadId> --mode run --request-id <uuid> --message-file ./continue.md --handoff-title "交接当前任务" --handoff-file ./handoff.md
printf '%s' "$PROMPT" | ap thread send --group <groupId> --thread <threadId> --mode notify --request-id <uuid> --message-stdin
```

Job 的 running 指包装进程运行，缺少原生 ready 协议时目标状态未知；安全 read/list 的 execution 可带执行阶段、关闭信号及 reported Win32 错误码。Windows 宿主执行 Job（`sandbox.execution: "host"`）没有包装进程，spawn 的子进程即目标本身，`phase` 为 `host_running` / `host_spawn_failed`，停止以进程树终止加 close 观察为实际证据。

终端尺寸由最外层界面统一采集和提交给Ink，当前正文只消费分配宽高，不能把正文列宽上限当作物理宽度回写。resize主动重排，输出代理只通知Ink失效缓存，不旁路清屏或定时整屏刷新。交互采用inline原生滚动，输入框不参与弹性压缩；视觉行派生按词和完整grapheme顺序处理，ANSI为零宽原子，避免长文本每行重扫/重包剩余全文。

普通会话切入后的审批卡与关联原地卡共用有界安全详情区域和底部固定允许决定；长原因/命令不会把允许/拒绝移出屏幕，PgUp/PgDn只滚动审批详情，Esc只收起当前审批详情而不取消Turn。关闭会话侧栏后下一次独立按键按实时面板/Session身份接收，不依赖Ink旧订阅闭包及时刷新；同事件消费标记继续防止切换Enter/关闭Esc穿透。

### 历史结构化问答与持久恢复

新 CLI 任务继续使用纯文本澄清。目标会话存在历史结构化问题时，按 Core 安全题目逐题输入选项编号或自定义文本，纯数字自定义使用 `其他 <内容>`。问题输入期间 `@` 按原样保存，不打开文件候选或扩展文件内容，也不登记为新任务 Prompt。提交绑定原 Session/Turn/requestId，异步查询遇到请求换代时拒绝旧输入。Core 校验失败后重新显示权威当前问题。

`/resume` 对未答问题显示逐题入口，已答问题复用原 requestId 和持久答案。审批决定与答案分别显示保存事实。已启用协作组通过 Core requestInteractionContinuation 交给兼容宿主，离线时显示等待并提示保持或启动对应 Web/CLI 宿主，`/resume` 可重试原请求。后续真实执行与终态单独观察。旧分页兼容入口消费真实 `question_required` 事件。

### 根输入与轻量观察

Ctrl+A优先聚焦关联待审批或可重试的已存决定卡，无审批但存在等待问题时打开关联列表并定位问题目标，Enter进入该会话回答。BOUNDARY_CHANGED表示执行结果未确认，提供核对提示并关闭自动恢复卡。Ctrl+T独立管理会话查看。新卡到达保留父正文、草稿、附件和光标，焦点只随显式输入改变。

根handleSessionList固定当前模式和目标，通过同步ref及layout输入桥处理按键。目录加载期间只缓存同一模式代次的列表按键，反复打开复用Manager同一个在途目录读取，过期回调失效。关闭根面板后的输入桥补齐当前目标的提交间隙，其他覆盖视图已消费的输入不排入prompt。裸Esc先由现有Ink解码，同chunk的Meta组合沿原解码语义。

周期刷新只给当前选中正文读取一页，普通隐藏历史保留Controller/Store/草稿和游标，重选后从原游标补齐。关联活动读取安全交互投影。选择或停止会话会取消原状态查询，Core安全投影的分页与main关联摘要循环响应同一signal，迟到结果不提交到新目标。目录仍按需分页，查看保持只读语义。


`ap thread group of --thread <id>` 是既有Core人类Facade.groupOf的只读CLI薄映射，返回协议版本、可选group与安全revision。旧归属错误在交互与普通命令输出中提示这条发现路径及bind-host完整参数。通过list的同次revision确认目标，选择cli-work-v1或web-work-v1后，使用兼容宿主正常开始该Session的新任务。等待审批/问答、中断、未知副作用及活动owner继续沿原恢复规则，completed绑定不会继续原Turn。

### 实机修复后的 inline 输出与命名失败

稳定 prompt 和终态内容由单窗口唯一 Static 追加，切会话及缩窗不重挂历史所有者。同一 Turn 恢复后的终态仅追加新事件段。活动内容显示最新尾部，完整终态写入终端原生历史；输入行有界但草稿与光标保留，审批决定区独立显示，长详情用 PgUp/PgDn 查看。关联审批默认提示，Ctrl+A 聚焦一张卡，循环切换目标；新卡不抢输入。等待审批不播放动画，运行态共享时钟为 120ms。

自动标题是附属步骤：只有 STATE_STORAGE_UNAVAILABLE 且重新读取后的完整会话事实（除 title/updatedAt）相同、Work 身份有效、无活动 Turn 且可开始新任务，才保留原记录继续，并提示标题未保存。schema、安全路径、身份变化、读取失败或消失均拒绝降级；不新增存储重试。TUI 存储失败显示稳定码和固定提示，内部诊断不会投影给模型或 Web。


## 13. Desktop 浏览器（browser）

`ap browser <action> '<JSON参数>'` 在 Desktop 受管第三方 CLI 原生 shell 工具中执行一个前台动作，不创建 Provider、Runtime 会话或外部浏览器。动作名与 JSON 对象分别传入，JSON 不含 type、调用身份或回合。禁止复合 shell、重定向、后台执行与原始 CDP/JS。原生适配器追加内部 `--permit <64位十六进制许可>`；用户/模型不得自行生成许可。缺少受管连接或有效单次许可时拒绝，不回退全局 agent-browser。

```sh
ap browser open '{"url":"https://example.com"}'
ap browser list '{}'
ap browser snapshot '{"pageId":"12345678-1234-4234-8234-123456789012","revision":0}'
ap browser click '{"pageId":"12345678-1234-4234-8234-123456789012","revision":0,"ref":"@e1"}'
```

支持 list、document(path)、open(url)、navigate(pageId,revision,url)、select/close/release/back/forward/reload/snapshot/screenshot(pageId,revision)，以及 click(ref)、fill(ref,value)、press(key)、scroll(direction,amount)、select-option(ref,value)、check(ref,checked)、dialog(accept,text)、wait(condition="load",timeout=1..30000ms)、downloads、cancel-download(id)。最后一组同样需要 pageId/revision。页面身份与代次取自返回结果，元素引用取自新鲜 snapshot；导航后重新获取，不能猜测或复用旧引用。JSON 内单引号写成 `\u0027`。

成功输出 JSON，退出0；参数错误退出2，连接/拒绝/取消/执行失败退出1。浏览器失败只输出显式固定码白名单中的完整BROWSER_*码（如BROWSER_PERMIT_INVALID、BROWSER_CALL_REPLAY、BROWSER_CANCELLED），不再被通用CLI_RUNTIME_ERROR遮蔽；附带正文、路径或未知扩展码统一收窄为BROWSER_REQUEST_FAILED，非法响应为BROWSER_RESPONSE_INVALID，其他普通CLI异常保留既有脱敏。同页占用冲突在CLI映射为BROWSER_BUSY。截图结果为 PNG image 内容块。失联或超时可能已产生效果，不自动重试；Codex shell 若返回持续执行标识，应等待原执行完成。

浏览器授权在 Desktop 通知位置组的审批卡完成（默认右下角），once 为一个动作，always 为当前用户回合；第三方在该回合尚无always授权时，首个动作仍需确认，设置always只改变卡片默认选项。关闭卡片即拒绝。原生工具自身权限/插件信任仍由第三方 CLI 处理。list仅返回调用者所属Desktop工作区的页面，其他工作区pageId不可操作；导航或JS对话框变化后需刷新revision。独立终端不提供此能力。AP 自身使用 Trust 后注入的 Core browser 工具，无需通过该 shell 命令自报原生身份。

AP与受管Claude/Codex/OpenCode/CodeBuddy共用document(path)单动作预览Markdown/HTML，例如 `ap browser document '{"path":"C:/Users/Example/中文 Vault/plan.md"}'` 或 `ap browser document '{"path":"/Users/example/中文 Vault/plan.md"}'`；也接受按Desktop工作区解析的相对路径。明确外部文件无需复制进工作区，须确认精确canonical文件；本turn可仅复用已授权文件，浏览器always不扩大文件范围。file URL拒绝码为 `BROWSER_FILE_URL_USE_DOCUMENT`，先document再用返回pageId/revision执行screenshot。AP旧open/staticPath→Job入口继续兼容。

四条原生Shell适配把原始ap browser命令改写到Desktop冻结的绝对Node+CLI，通过固定参数恢复前导跨Win32/Bash/PowerShell5传递JSON，不依赖父Shell函数或全局ap。Claude/CodeBuddy局部plugin、Codex用户回合hook与OpenCode局部instructions/plugin提供路由；受管使用契约禁止直接agent-browser/CDP，适配器不提供所有Shell命令的拦截保证。普通shell沿原生权限检查，Codex updatedInput不签发permissionDecision=allow。缺endpoint、鉴权、回合/调用ID、许可、取消和模块异常保留不同稳定错误，不回退外部浏览器；不声称OS范围的别名/解释器绕过防护。桌面启动和浏览器资源准备见 [Desktop 使用指南](HowToUse.md#desktop)。


### 受限 PowerShell 单文件删除

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

Desktop受管CLI路由补充（2026-11-11）：四种第三方CLI的ap-browser契约在Desktop userData局部生成/更新，Skill描述及原生会话上下文明确内置浏览器使用ap browser，不要误选Codex IAB / Computer Use。Claude/CodeBuddy通过局部plugin与--append-system-prompt接入；Codex通过原生SessionStart/UserPromptSubmit模型可见目录接入，能力确认后才加--no-daemon及局部hooks，保留/hooks信任；OpenCode通过进程局部OPENCODE_CONFIG_CONTENT instructions/plugin接入。四条原生Shell命令均重写到当前Desktop绝对Node+CLI，普通外部终端不受影响。Codex cmd/command支持单动作，code输入仅给路由提示，不能在JavaScript单元执行ap browser。明确指定外部浏览器不被全局拦截；不改变第三方CLI权限、配置、状态根或全局PATH。

受管编排终端以当前 Session、Turn、审批 ID 的宿主回执更新审批状态。宿主持久记录核查次数及一次自动补发预算。恢复停止后由主控协调。用户可直接以自然语言要求整次停止、改派或追加；主控依各目标回执反馈进度。新审批独立展示。
