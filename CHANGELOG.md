# Autopilot 更新日志（CHANGELOG）

本文件记录 Autopilot 产品的所有显著变更：功能新增、调整与 Bugfix。

Autopilot 是一个包含 core（无头 Agent Kernel）、cli（终端交互）、web（网页工作台）的 AI Agent 产品，其前身是 2026 年 7 月初起步的 "rag-next" RAG 检索系统，同年 7 月底正式更名 Autopilot Agent。

格式参考 [Keep a Changelog](https://keepachangelog.com/)，条目按版本与日期倒序排列。来源：Git 提交历史与 `agent/` 目录下的 Runbook 开发记录。

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
