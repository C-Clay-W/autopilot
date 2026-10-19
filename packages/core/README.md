# @autopilot-agent/core

Autopilot 的共享 Agent Runtime、工具执行、审批、会话和 RAG 核心。普通 CLI 用户只需安装 `autopilot-agent@0.1.0`；本包主要面向自行编写宿主或集成知识检索能力的开发者。

## 入口与能力

| 入口 / API | 用途 |
|---|---|
| createAgentRuntime | 装配 Runtime Facade；由宿主注入 RuntimePorts |
| runtime.turns / sessions / projects | Turn 执行、恢复、取消及会话/项目管理 |
| runtime.approvals / inbox / questions | 审批、持续输入及宿主结构化回答 |
| runtime.jobs / undo | 非 PTY 后台 Job 和受控文件撤销 |
| createRAGAgent / createAgent | 文档入库、检索与问答的兼容公开入口 |
| createDatabaseSnapshot / getDefaultDatabaseSource | 受控数据库快照和已注册源 |
| listWorkspaceFiles | 工作区文件索引与候选枚举 |
| @autopilot-agent/core/experimental | Kernel、采样器和工具工厂等不稳定接口 |

完整签名、参数、错误和示例见 [Core API 参考](https://github.com/C-Clay-W/autopilot/blob/main/agent/doc/Core-API.md)。默认入口是稳定公开边界，禁止把 core/internal/* 深层路径当作正式集成接口。开发文档以源码为准，可能先于 npm 0.1.0。

## 装配原则

```typescript
import { createAgentRuntime, type RuntimePorts } from "@autopilot-agent/core";

/** 用受信宿主提供的存储、工作区、采样和系统能力创建 Runtime。 */
export function createHostRuntime(ports: RuntimePorts) {
  return createAgentRuntime({ ports });
}
```

Node 文件存储和工作区等实现由配套的 Adapters 提供。宿主负责受信路径、凭据解析、Trust、事件消费及退出时调用 runtime.shutdown；不要直接在浏览器客户端创建可访问本机文件的 Runtime，也不要把上述工厂当成无需配置即可执行模型任务的完整程序。

## RAG 与数据

Core 包含文档、Excel/PDF 解析，Embedding、向量空间校验、Rerank 和数据库快照能力。连接应由受信宿主提供，凭据延迟解析，不进入事件或浏览器。Embedding 模型和维度变化需要匹配或重建索引；PDF/OCR 的外部工具按需准备。

Core 支持这些能力不表示每个宿主都启用全部工具：npm CLI 不提供私有知识库 RAG，Web Chat / 知识服务按自身边界装配。数据库能力不接受浏览器任意传入 DSN 或 SQL 作为授权。

## 构建与验证

```bash
npm ci
npm run build -w packages/core
npm run typecheck -w packages/core
npm run test -w packages/core -- src/internal/tools/builtins/todo-write-tool.test.ts
```

从 monorepo 根运行。构建脚本使用 esbuild 生成 CJS/ESM 多入口，TypeScript 生成声明，并带上必需的 PDF Python 脚本。消费方读取 dist，修改后需重建。原生依赖在目标 OS 安装，不跨平台复制。

Trust、工具授权和沙箱各有职责。拒绝不支持的路径/协议不等于证明 OS 隔离成功；平台实机限制见主入口包手册。

## 许可证

MIT，见 LICENSE。第三方依赖采用各自授权。
