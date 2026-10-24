# @autopilot-agent/adapters

Autopilot 的共享 Node.js 宿主适配层，为 Core 的 RuntimePorts 提供实际文件存储、工作区、凭据和系统能力。普通用户安装 `autopilot-agent@0.2.0` 即自动获得本包。

## 提供什么

- createNodeRuntimePorts 统一装配 Session、Turn、checkpoint、transcript、审批、Job、inbox 等 durable Store。
- createNodeWorkspaceAdapter、Trust store/policy、workspace registry 与 canonical 工作区身份。
- settings loader/writer/user service、CredentialStore 和受信的延迟凭据解析。
- createNodeCapabilityLoader：指令、Skills、MCP、上下文和 Web 搜索/抓取；createNodeRagRuntime 提供 RAG 连接装配。
- createNodeChatStorage、附件存储和 Chat capability loader，为无工作区 Chat 与 Work 隔离状态。
- createNodeSandboxPort（macOS Seatbelt）与 Windows 宿主执行 port（`createNodeHostExecutionSandboxPort`）等平台适配。

本包不提供 Web HTTP/SSE/React UI，也不负责 CLI 的终端生命周期；这些由具体宿主承担。

## 组合入口示例

```typescript
import { createAgentRuntime } from "@autopilot-agent/core";
import { createNodeRuntimePorts } from "@autopilot-agent/adapters";

/** stateRoot 和 workspaceRoot 必须由受信宿主验证，不从模型参数取值。 */
export function createHostRuntime(stateRoot: string, workspaceRoot: string) {
  const ports = createNodeRuntimePorts({ stateRoot, workspaceRoot });
  return createAgentRuntime({ ports });
}
```

这是装配示例，不是开箱即用的模型任务：宿主仍需初始化状态布局、配置和授权，并在退出时清理 Runtime。stateRoot 是显式参数，不从模型或浏览器请求推导。Chat 使用专门的存储/loader 绑定，无工作区时不提供 Work 文件与命令能力。

用户 settings 的凭据只在受信 Node 层读取，项目 Trust 不等于批准运行 MCP server。默认 host MCP 在本机运行；OS 沙箱是单独能力，状态与初始化需显式检查。

## 构建与平台

```bash
npm ci
npm run build -w packages/core
npm run build -w packages/adapters
npm run test -w packages/adapters -- test/node-credential-store.test.ts
```

从 monorepo 根运行。输出 CJS/ESM 和声明；Core、Node 内置模块及 Anthropic sandbox-runtime 保持 external。0.2.0 精确依赖 sandbox-runtime 0.0.78；不要因安装成功就声称系统隔离、原生 Job 全树回收或跨平台实机验证完成。

Windows 不加载 sandbox-runtime：进程工具经逐次审批后以当前用户权限直接执行，没有 OS 沙箱，`sandbox status` / `sandbox setup` 返回宿主执行停用报告；不要把它描述为隔离执行。参考 [Core API](https://github.com/C-Clay-W/autopilot/blob/main/agent/doc/Core-API.md)、[构建说明](https://github.com/C-Clay-W/autopilot/blob/main/BUILD.md) 和主包的平台限制。

## 源码 0.2.0 与 npm 版本

源码与五个 npm 包当前版本均为 0.2.0。Windows 不提供 OS 进程沙箱，命令、后台 Job 与 host MCP 逐次审批后以当前用户权限直接执行；审批不提供 OS 隔离。macOS 继续使用 Seatbelt。实机与进程树生命周期仍需按实际验证确认。

## 许可证

项目代码为 MIT。macOS 沙箱所依赖的 Anthropic sandbox-runtime 0.0.78 仍为 Apache-2.0 授权，许可证副本见 native/srt-win/LICENSE-APACHE-2.0 与仓库 THIRD_PARTY_NOTICES.md；本项目不再包含针对该上游的 Windows 派生补丁。
