<!-- 公开依赖审计：说明 Agent 自研边界、第三方库取舍与可复核的源码证据。 -->
# Agent 的依赖审计：哪些自己写，哪些交给成熟库

Autopilot 的工程取舍是：**自己实现 Agent 的执行与控制链路，用成熟库解决格式、存储、协议接入和界面等边界问题。** CLI 与本地 Web 共用这一套 Runtime，模型协议通过 Adapter 接入。

本文整理自 2026-10-22 的五包依赖审计，并于 2026-10-24 对源码 0.2.0 的公开文件核对关键结论。证据范围是源码与 `package.json` 的静态检查，不是漏洞扫描、性能评测或跨平台运行验收；不将历史安装目录体积或源码行数当作当前发布物指标。

## 先看自研边界

| 能力 | 项目负责什么 | 源码证据 |
|---|---|---|
| Agent 主循环 | 模型采样、工具调用与结果回填、停止条件和错误处理 | [agent-kernel.ts](../packages/core/src/internal/kernel/agent-kernel.ts) |
| 上下文管理 | 上下文预算、消息配对边界和历史压缩 | [context-budget.ts](../packages/core/src/internal/kernel/context-budget.ts)、[compact.ts](../packages/core/src/internal/kernel/compact.ts) |
| 工具调度 | 工具并发与串行、重试和超时调度 | [tool-scheduler.ts](../packages/core/src/internal/tool-scheduler.ts) |
| 会话与审批 | Turn 生命周期、会话状态、审批与恢复的应用层控制 | [turn-service.ts](../packages/core/src/runtime/application/turn-service.ts)、[session-service.ts](../packages/core/src/runtime/application/session-service.ts)、[approval-service.ts](../packages/core/src/runtime/application/approval-service.ts) |
| Provider 中立协议 | 内核消息与供应商 wire 格式分离，按冻结协议选择 Adapter | [provider-protocol-adapter.ts](../packages/core/src/runtime/provider/provider-protocol-adapter.ts) |
| Web 抓取控制 | DNS 与目标地址校验、重定向和响应上限等策略 | [safe-web-fetch.ts](../packages/adapters/src/node/capabilities/web/safe-web-fetch.ts) |

这些编排逻辑没有调用 LangChain 或 LlamaIndex。**编排不依赖 Agent 框架，不代表 Core 没有第三方依赖**：工具参数校验使用 Zod，Anthropic Messages 协议使用官方 SDK；文件解析和检索也使用专门的库。

## 五个包如何划分依赖

下表只计 `dependencies` 中非本项目包的直接声明，不计开发依赖和传递依赖。包数是发布与职责划分，不代表五层依次调用；本地 Web 是独立应用，不计入五包。

| 包 | 第三方直接依赖数 | 主要职责与依赖 |
|---|---:|---|
| [Core](../packages/core/package.json) | 14 | Agent Runtime、工具与数据能力；含 Zod、Anthropic SDK、ripgrep、LanceDB、SQL 与文档解析库，也含尚未清理的声明 |
| [Adapters](../packages/adapters/package.json) | 3 | Node 宿主能力；sandbox-runtime、js-yaml、linkedom |
| [Presentation](../packages/presentation/package.json) | 0 | 共享事件投影与展示协议，仅直接依赖本项目 Core |
| [CLI](../apps/cli/package.json) | 4 | 终端界面与输出；Ink、React、string-width、wrap-ansi |
| [安装入口](../packages/autopilot-agent/package.json) | 0 | 关联项目包并转发 CLI 启动 |

“0”仅表示没有直接声明第三方运行时依赖，不表示安装它时没有传递依赖。

## 为什么保留这些第三方库

自研的判断标准是：**能否在保持正确性与安全性的前提下，减少真实维护成本。** 能写出来，并不等于值得长期维护。

| 边界 | 当前选择 | 保留的理由 |
|---|---|---|
| 工具参数校验 | `zod` | 同时提供运行时校验和类型推导，自写替代会扩大工具链维护面 |
| 文件搜索 | `@vscode/ripgrep` | 复用高效搜索与忽略规则语义；简单目录遍历不能等价替代 |
| 文档解析与页图 | `xlsx`、`mammoth`、`pdf-parse`、`pdfjs-dist`、`@napi-rs/canvas` | 格式兼容、字体和渲染的维护成本高，不是 Agent 编排的核心差异 |
| 向量与数据库 | `@lancedb/lancedb`、`sql.js`、`mysql2` | 复用索引、SQLite 与数据库协议实现；自写检索或驱动难以保持等价能力 |
| 宿主解析 | `js-yaml`、`linkedom` | 将 YAML、HTML 语法处理交给专门实现，宿主继续负责权限和抓取策略 |
| 终端交互 | `ink`、`react`、`string-width`、`wrap-ansi` | 复用渲染、输入和字符宽度处理，避免维护整套终端渲染器 |
| 系统沙箱 | `@anthropic-ai/sandbox-runtime` | 复用平台隔离机制；依赖存在不代表当前平台已启用或通过实机验收 |
| Anthropic 协议 | `@anthropic-ai/sdk` | 仅用于 Messages Adapter；内核保持 Provider 中立，不自行承担 SDK 的全部协议维护 |

OpenAI Chat Completions 路径使用自有 `fetch` 与 SSE 处理，见 [OpenAI Adapter](../packages/core/src/runtime/provider/openai-chat-completions-adapter.ts)；Anthropic SDK 的接入边界见 [Anthropic Adapter](../packages/core/src/runtime/provider/anthropic-messages-adapter.ts)。两条路径说明协议可以独立实现，不表示本次已替换 SDK。

## 审计也应暴露待整理项

源码 0.2.0 仍保留以下声明问题，本文如实记录，未修改依赖或锁文件：

| 项目 | 静态检查结果 | 后续取舍 |
|---|---|---|
| `langchain`、`@langchain/core` | Core 仍在依赖清单中声明，Core 源码未发现引用 | 可在单独依赖清理中评估移除；目前不能宣称依赖树已无框架包 |
| `pdfjs-dist` | Core 源码未发现直接引用，`pdf-parse` 的依赖链使用它 | 评估是否需要直依赖与版本约束，验证解析和渲染后再调整 |
| `@types/sql.js` | 类型包列在运行时依赖中 | 评估移至开发依赖，并检查声明产物消费是否受影响 |
| Anthropic SDK | 有实际引用 | 自研协议接入是可讨论的选择，需权衡流事件、错误映射和长期协议兼容成本 |

这份审计体现的是可以追溯的依赖边界与工程判断，不把“全部自研”当作目标，也不将清理建议写成已完成工作。Windows 当前不启用 OS 进程沙箱，macOS 实机验证仍有边界；完整说明见 [README 的已知限制](../README.md#已知限制与平台边界)。
