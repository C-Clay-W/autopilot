# Autopilot 更新日志（CHANGELOG）

本文件记录 Autopilot 产品的所有显著变更：功能新增、调整与 Bugfix。

Autopilot 是一个包含 Core（无头 Agent Kernel）、CLI（终端交互）、Web（网页工作台）和 Desktop（桌面工作台）的 AI Agent 产品，其前身是 2026 年 7 月初起步的 "rag-next" RAG 检索系统，同年 7 月底正式更名 Autopilot Agent。

---

## [0.4.0] - 2026-11-24

### 新增

**Desktop 与双模式**

- **Autopilot Desktop** 新增独立桌面工作台，支持 Windows x64 安装向导和 macOS Apple 芯片 DMG。首次进入可选择 Parallel 或 Orchestration。两种模式各自保留工作区，切换后可回到原来的终端或任务，后台执行继续。
- **Parallel（并行模式）** 可在一个窗口里直接操作 Autopilot 和本机已安装的 Claude Code、Codex、OpenCode、CodeBuddy。可以从双终端、四终端布局开始，也可以用 Freedom 打开一个空白 Shell。每个工作区可建多个标签页，智能体总台可查看运行、等待和完成状态，并定位到对应终端。
- **Orchestration（编排模式）** 可把目标交给一个 AP 主控。主控能直接回答简单问题，也能把复杂任务拆成有依赖关系的步骤，派给多个 AP 执行者，再根据交付结果安排复核和验收。内置移交任务、分阶段执行、并行处理和独立检查四种模板。
- 编排主控和执行者都有可交互的终端。可在主控追加整体需求，也可到执行者终端补充当前委派。从任务历史可回到原主控会话继续追问。
- **Desktop 内置浏览器** 支持 Browser Use，可在终端旁打开网页、localhost 和本地 HTML、Markdown。用户可以手动浏览，也可以让智能体点击、填写、滚动和截图。切换工作区时恢复各自的网页标签和面板宽度。

**工作区与终端**

- 欢迎页会检测本机安装的第三方 CLI。安装后可点「重新检测」，为当前标签页手动选定的智能体优先于默认设置。Freedom 可直接进入空白终端，再手动运行 `ap`。
- Parallel 支持向右或向下添加终端、拖动分隔线、临时放大单个窗格。重开 Desktop 时会恢复工作区、标签顺序、分屏比例和焦点，并按保存的类型重新启动终端。
- 同一目录可以建立多个独立工作区。侧栏支持就地重命名，点击智能体可跨工作区定位并高亮对应窗格。总台可查看 AP 在等审批、等回答还是等子任务，第三方 CLI 则显示其上报的活动状态。
- 终端右键可复制所选文字。Windows 下有选区时按 Ctrl+C 复制，无选区时仍交给 CLI 处理中断。OpenCode 可用 Ctrl+Shift+C 复制内部选区，第三方 CLI 占用鼠标时可按住 Shift 划选。

**编排、审批与交接**

- 执行者终端会在首条工具输出前显示 `TASK` 和派单正文。顶部标签显示所含终端数，并标出待审批或待回答的标签。底栏默认收起，展开后按依赖顺序排列步骤，点击「定位终端」可直接查看该步的执行过程。
- 主控支持用 `@` 引用工作区文件，也可在执行期间用 `/queue` 排好后续要求。当前轮成功结束后，排队内容会在同一任务里依次执行。点「开始新任务」才另开一条任务记录。
- 审批卡标明请求来自哪个主控或执行者，并按操作提供单次、当前会话或工作区授权。批准后自动接回原来的执行。若拒绝了增派执行者的清单，可以对主控说「重新弹出派工审核」，查看并确认原清单。
- 执行者完成交接后，终端会提示把新需求交回主控。需要独立复核时，复核者可打开交付时记录的同一版本 HTML 或 Markdown，检查页面内容及交互，再向主控报告结果。
- 编排终端关闭后，可从原任务重新打开主控或执行者的会话。关闭最后一个终端前会检查是否还有执行、审批或待回答事项，空闲时保存接续记录。

**浏览器与通知**

- 用户可手动接管智能体正在操作的网页。同一页已有智能体操作时，其他智能体会收到占用提示。浏览器权限另可设为「每次操作确认」或「允许本回合操作」。
- 设置中可关闭浏览历史，或保留 7、30、90 天。下载可指定目录或每次询问位置，遇到同名文件会自动换名。
- 任务完成、下载和审批可在工作台内集中提醒。当前任务可设免打扰，后台任务仍可提醒。普通通知支持悬停暂停计时，审批卡会保留到用户处理。

**CLI 与模型接入**

- **模型接入** 新增 OpenAI Responses API 支持。Web 设置可在 Responses、Chat Completions 和 Anthropic Messages 三种协议间选择，支持从列表选模型或手动填写，并按模型能力显示可用的推理强度。
- CLI 的 `/effort` 也会按当前模型和协议列出可选档位，支持的模型可选 `none` 或 `xhigh`。状态栏并列显示模型、推理强度和权限模式。
- 编排主控的 `/help` 和 CLI 的长命令结果支持用方向键或翻页键阅读，按 Esc 回到原草稿。普通 CLI 可用 `ap --help` 查看帮助。Ctrl+G 可重看已保留的通知。手动运行 `/compact` 时会显示正在压缩的提示，结束时给出结果。

### 调整

- Desktop 支持浅色、深色及跟随系统主题，可设置默认智能体、新终端类型、AP 初始权限和通知位置。
- Desktop 浏览器默认跟随 AP 权限。「为我审批」可直接打开和查看公开网页，「完全访问」还可执行普通网页交互。本地文档首次打开时确认具体文件，下载写入前单独确认。
- AP「完全访问」减少常规操作的重复确认。对于已识别的删除、丢弃已有修改和 `git push` 等操作，仍需逐次批准。
- Work 在执行中收到补充要求时会结合原任务继续处理。用户明确叫停或更换目标时，按最新要求执行。

### 修复

- 修复编排首次进入偶发连接失败、审批提交后长时间停在等待状态，以及执行者交付并释放工作目录后主控未继续派发后续步骤的问题。
- 修复 Desktop 终端缩放、切换分屏或展开浏览器时的残影与布局错位，改善终端选区复制和中文输入法组字时的回车处理。
- 修复旧编排记录导致工作区无法从侧栏删除的问题。现在仅在该组有任务正在执行时询问一次，移除工作区会保留磁盘上的项目文件。
- 修复 Web 设置保存主模型时可能改写连接协议的问题。已有 Responses 或 Chat Completions 连接可保留原协议和模型配置。
- 修复 `git clean -nd` 等仅预览待清理文件的命令被当作实际删除而拒绝的问题。
- 修复 Web Chat 刷新或断线导致回答中断、重复提交的问题，支持重新接收原回答。Web Work 撤回排队输入时会先确认服务端结果，避免误改草稿或丢失其他待发消息。

---

## [0.3.0] - 2026-11-06

### 新增
- CLI 单窗口多会话与主子 Thread 会话，支持任务分派、消息沟通、进展汇报和任务交接。
- CLI 主会话集中处理子会话审批，也可切换到子会话处理同一请求。
- CLI 图片输入与历史图片关联，支持按模型能力进行图片分析。
- Web支持Thread协议，支持创建平行会话，多线程并发处理任务，保证主控纯净上下文。
- Web Chat 支持 Intelligent UI，根据内容动态生成可交互内容，支持图表、表格、选项、时间线、步骤和调整参数后继续讨论。
- 会话 Token 用量与耗时展示，以及可供排查任务失败的反馈编号。
- 命令大段输出保存并回读，减少因输出截断而重复执行命令。

### 修复
- 更新后部分历史工作区、会话和聊天无法打开或继续使用的问题，增加自动备份升级与失败保护。
- 主子会话审批、回答和继续执行衔接不完整，以及等待、完成和失联状态显示不准确的问题。
- 没有待审批请求时仍提示审批，以及重复观察和进展消息干扰对话的问题。
- CLI 首次启动留白、窗口缩放重复内容、流式完成跳位和多会话切换时的输入焦点问题。
- Web 用户输入与协作消息对齐、逐轮复制、停止确认，以及刷新后任务状态恢复的问题。
- 部分模型错误原因显示不清，以及取消和超时被错误归类的问题。
- 增强主循环稳定性。

### 调整
- CLI 与 Web 按各自执行环境承接任务，减少同一工作区中任务被错误接管的问题。
- 优化历史记录按需加载、状态查询和长会话读取，减少重复读取与界面刷新负担。
- 优化上下文缓存、压缩与文件读取，减少重复内容和修改后的机械回读。
- 模型请求失败采用有次数和等待上限的重试，并支持在等待期间取消。

---

## [0.2.0] - 2026-10-23

### 新增
- Web Work 内置网页预览面板，支持手动打开和 Agent 发起预览。
- 工具执行过程信息展示。

### 修复
- Windows 下 npm、npx、pnpm 命令及 MCP 启动异常。
- 预览会话切换、窄屏布局、拖拽调整、取消导航与结果入口异常。
- 权限配置错误被误判为模型配置错误的问题。

### 调整
- README 前置项目优势与架构说明，新增公开依赖审计和更新日志入口。
- 更新 Web 工作区截图与 npm 0.2.0 安装说明。
- Windows 移除进程沙箱，改为逐次审批后以当前用户权限直接执行，并明确显示未隔离状态。
- macOS 继续使用 Seatbelt 沙箱。

---

## [0.1.0] - 2026-10-10（npm 五包首次公开发布）

发布包：`autopilot-agent`、`@autopilot-agent/core`、`@autopilot-agent/adapters`、`@autopilot-agent/presentation`、`@autopilot-agent/cli`，入口命令 `ap` / `autopilot`。

### 新增 — 沙箱与安全
- 沙箱体系：macOS Spike 验证、Core 沙箱契约、Node Adapter 与双平台初始化入口、前台 `run_command` 隔离执行与审批自动放行、后台 Job 全生命周期隔离、文件 mutation policy 与删除边界、本地 MCP server 隔离。
- Windows 适配：Windows Adapter 接入、原生门禁、host MCP 环境白名单与 libuv 环境隔离修复、Windows 私有 Job 句柄控制与跨平台停止源码。
- 沙箱不可用时 fail-closed（workspace-write 降级为审批模式并明确拒绝终态）。
- Core 目标权限模型与文件工具改造、外部工作区权限拓宽、Runtime 权限投影与审批存储、CLI/Web 双端接入。
- Web「记住此命令」：相同外部命令免重复审批。
- 任务文件集合支持一次性批量审批（含外部文件集合一次审批）。
- 沙箱启动失败自动降级为审批模式并明确拒绝终态。

### 修复
- 并发场景下结果增量入账缺陷；`read_file`、CLI steer 展示与可选长任务限额问题；工具摘要与失败徽标展示；停止时绑定失败（保留活跃 wrapper）。
- 授权状态保护缺口、D1 撤权恢复缺失、锁内授权绑定、Undo 重验（CR R2/R3/R5/R6）；跨 workspace/stateRoot 同目标锁竞争（R4）；workspace-write 沙箱不可用 fail-closed（CR R2）；Windows 包管理器直接执行受信解析（R3）；沙箱 prepare 重试与耗尽后 deny（R4）；活跃出口修复 + deny 诊断结构化（R5）；精确命令授权不再合并 macOS 上不同的实际程序（R6）；CLI 初始化错误根因修复；Web 中文工作区 `DIRECTORY_INVALID` 编码问题；运行时无法持续滚动到底部。

### 变更
- 新增全仓构建打包手册 `BUILD.md`；`engines.node` 冻结为 `>=20.11.0 <22`。
- Web Diff 侧边栏支持拖动调宽。

---

## [0.1.0-beta] - 2026-09-02（内部版本冻结）

### 新增
- Provider Adapter V2 架构：canonical 消息与迁移、`apiProtocol`/`credentialRef`/封闭 compat profile，Anthropic Messages 与 OpenAI Chat Completions 各自收口为唯一 Adapter，移除 Core 对第三方厂商名硬编码。
- Web Search 方案定版：DeepSeek Responses 原生 Search capability + 本地安全 `web_fetch`。
- RAG 管线重建：独立 `database_search` Tool、PDF 批处理核心、Workspace 级 RAG Root/资源 manifest、关键词索引与向量空间复用、统一错误码。

### 修复
- Anthropic Messages 同批多工具结果未聚合导致的 HTTP 400；Anthropic 空 `thinking` replay 错误；会话无法立即新建/切换、目录选择器 `DIRECTORY_PICKER_BUSY`、SSE `[DONE]` 后状态残留等系列 Web 问题。

---

## [0.0.1-beta] - 2026-08-27（内部版本冻结）

### 新增
- AskUserQuestion 全栈落地：Core Tool + durable Question state、同 Turn 恢复、Web 结构化问题卡、CLI 纯文本回退。
- TodoList 全栈落地：Core `todo_write` 工具、`todo_updated` 事件、Web Todo 卡、CLI 动态 Todo UI；触发策略改为模型对复杂任务自主创建维护。
- Provider Settings：`~/.autopilot` 配置目录、Claude Code settings.json 子集解析、Anthropic Messages SDK 接入、Doctor 连通性检测。
- Web 多会话并行、Web 工作区选择（安全 Workspace/Trust API、Workspace Chip/Trust UI、macOS 目录 chooser）。

### 修复
- 任务取消后继续执行失败、取消后迟到 SSE、问题卡 requestId 绑定与键盘焦点缺陷。

---

## 内部演进阶段（2026-07-03 ~ 2026-08-27）

### RAG 基建期（07-03 ~ 07-14）
- **新增**：Monorepo 工程化改造；Qwen3-Embedding 本地部署验证；LanceDB 向量库接入，打通 Embedding→入库→语义检索端到端链路；`/lancedb` Web 可视化页面；excel-parser 与混合检索；`agent.search()` 搜索全链路与 `agent.ask()` 流式问答；文字型 PDF 入库；PDF 页级图文融合向量入库（多模态视觉模型）；入库进度 SSE 流式推送。
- **修复**：检索评分从错误的 `1-L2` 改为标准余弦相似度；MarkdownRenderer 不支持 `###` 标题；chat 页面大面积 UTF-8 中文乱码。

### 产品化与 Agent 首版期（07-15 ~ 07-22）
- **新增**：全站「复古纸本百科」设计风格并沉淀 `Design.md` 强制规范；聊天历史持久化；Embedding 切换全云端 API（1024 维定版）；Rerank 体系（多表混合召回、RRF、内容类型路由、LLM Rerank、HyDE 重试）；Qwen-VL 独立视觉定位与多模态分流策略；Agent Loop 首版（`createAgent()`/`createRAGAgent()` 双实例、Session Runtime、聊天 UI）；工具层与权限边界、审批基础能力；会话图片附件视觉分析。
- **修复**：PDF.js API/Worker 版本冲突；审批后审批卡消失、会话被 `awaiting_approval` 锁死；最终回答延迟显示、表格/代码块渲染、图片上下文丢失等系列问题。

### Agent 能力补全期（07-22 ~ 07-29）
- **新增**：MySQL 数据源双通道（离线快照 + 数据库 RAG）与资源配置页；持久上下文、跨会话 Memory、Skills capability 与配额 UI；Skill 主动选择（跨 Turn 固定、服务端精确注入）；工具调用过程实时展示、可折叠 EditHistory diff 面板、diff/思维链持久化；大文件增量编辑；可恢复 turn、durable inbox、任务排队与上下文 compact。
- **修复**：sql.js wasm 运行时异常；Skill 名称发现/调用一致性；`write_file` 输出截断；Windows Agent 因目录/命令探测耗尽步数上限（环境事实前置给模型）；steer 续跑、排队任务、审批恢复等竞态。

### Autopilot 定名与架构重构期（07-29 ~ 08-04）
- **变更**：产品定位正式更名 "Autopilot Agent"，RAG 降级为 Agent 的一个工具；Agent 执行闭环从 `agent-runtime.ts` 提取为无头 Agent Kernel（headless runner）；建立 Shared Runtime、Public API 与 Ports；Project/Provider/Session 平台无关领域模型统一；CLI 宿主（`apps/cli`）与 Ink TUI 启动。
- **修复**：否定只读 mutation gate P0；stale running 租约无法恢复；真实 auto compact 成功路径与 Reactive Overflow Compact 熔断器；审批续跑时间线成倍显示等系列问题。

### CLI 交付与 TUI 重构期（08-04 ~ 08-19）
- **新增**：`/skill`、`/model`、`/effort`、`/reasoning` 命令面；DeepSeek capability 与 raw reasoning 边界闭合；CLI 工作区能力（启动位置即工作区、自定义工作区、首次 Trust 引导）；TUI 改版（CC 风格 Spinner、滚动 follow）；TUI 模块化拆分（36 个模块）；macOS 首次可用化（`ap` 全局命令、ripgrep 依赖补齐）。
- **变更**：TUI 方向修正——默认翻转为主屏 inline、备用屏降级为显式实验模式；发布链 RC 化并通过真实 Provider smoke；统一全仓 npm 命名空间、版本重置。
- **修复**：Windows Terminal 多行 prompt 粘贴错位；CLI 总是触达步数限制（根因修复）；真实 TTY `stdin.ref is not a function` 崩溃；流式 Markdown 表格先以竖线文本输出；窗口 resize 后历史 UI 重复追加；Trust 对话框键盘不可选等系列问题。

### 产品化收口期（08-20 ~ 08-27）
- **新增**：文件变更 Undo（durable WAL/blob/journal，`/undo` 命令）；`read_file` 受限流式分页；`agent` 管理命令入口（`doctor`/`session list`），主命令定名 `autopilot`（别名 `ap`）；共享 `@autopilot-agent/presentation` 包，CLI 与 Web 统一展示契约；Web Agent 五项（执行停止、文件 Diff、等待授权、图片视觉理解、`vision_analyze`）；全局 Notice 通知系统。
- **变更**：TurnService 拆分（运行配置/上下文压缩/恢复视图/执行状态机）；对标 DeepSeek Harness 重构工具过程行展示。
- **修复**：Undo 事务收敛与 UTF-16LE 流式读取安全缺陷；`ap <prompt>` 参数透传丢失；Live SSE 完成后回答被 History 刷新吞掉；Web dev 动态 require 导致 API 500；`answer_discard` 语义导致回答拼接双份等系列问题。

---

## 0.1.0-beta 冻结后至 0.1.0 发布前的演进（2026-09-03 ~ 2026-10-09）

### 新增
- Web Search First 收口：安全 Web Fetch、Search First 行为、本机 Key 配置页。
- Chat/Work 分域与 RAG 归属纠偏：Chat 只读工具、RAG 证据门、错误协议统一；Web 区分 chat/work。
- 真实 Rerank 供应商 Adapter（百炼）与 Web 可视化模型配置。
- 后台任务操作闭环：CLI `/jobs` 管理、持续运行动画。
- 通用 Search 服务 + 厂商注册表，MiMo Search 适配器，Search 连接 settings.json 只读回显。
- 长调用链五点整改（限步护栏、env 控制步数、可恢复性）；单次模型输出 Token 配置；AutoMemory v0.5 项目级 Taste 投影。
- Web Chat 页面模块拆分（4 组件 + 4 组 Hook）；流式性能专项（delta 短窗口合并、CLI prompt 渲染隔离、Web 帧提交合并/memo 边界）。
- Token 预算连续性：Continue 开启新 runtime_budget 执行段且等待时长不消耗新段。
- Context Usage Presentation 全链路（Core DTO/纯投影、Runtime 事件、Web GET/SSE 顶栏、CLI 状态栏与 `/context [all]`、overlay 视图）。
- CLI `@文件` 提及全量落地（候选菜单、四档评分、提交注入上下文）。
- 第三方模型 `contextWindowTokens` 通用适配。
- Web 侧栏工作区分组折叠（持久徽标 + Ctrl+O）、模型回复复制按钮。

### 变更
- Chat RAG 资源入口统一到侧栏「资源目录」，退役旧 `/lancedb` 页面与 API。
- Core 配置规范化与主连接整改（主 Anthropic/视觉、DS Search、RAG 四角色）、两分类 Web 设置中心。
- CLI 中断后输入「继续」改为同 Turn Continue（对齐 Web 语义）。

### 修复
- Windows 下 LanceDB 原生包缺失与用户级 settings.json 解析冲突；RAG 引用串码/表格格式（换用标准 Markdown 库）；TUI 跨显示器 resize 残帧、Logo 响应式列宽、scrollback 旧物理回流帧；CLI 命令审批与 full_access 核对；Turn 运行中手动 compact 未被拒绝的守卫缺口；mutation gate 自然语言误判；Web stalled 阈值对齐 CLI 20s；RAG 过程文案重复显示等系列问题。
