# @autopilot-agent/cli

Autopilot 的终端宿主包。普通用户安装主包 `autopilot-agent@0.4.0`，无需分别安装各个 scoped 包：

```bash
npm install -g autopilot-agent@0.4.0
ap --help
```

完整安装、使用和限制见 [主包手册](https://github.com/C-Clay-W/autopilot/blob/main/packages/autopilot-agent/README.md)，当前源码的 Anthropic、Chat Completions、Responses 配置与完整 argv / slash 语法见 [CLI 参考](../../agent/doc/CLI-Reference.md#6-配置管理)。Chat Completions 与 Responses 各有独立配置示例，包含 User settings 路径、凭据引用、兼容预设和模型能力限制。开发参考随源码更新，可能先于已发布版本的行为。

## 结构与职责

- parser.ts 解析 argv 与交互命令，main.ts 编排入口、输出及退出。
- composition-root.ts 注入共享 Core Runtime 与 Node Adapters，controller.ts 管理任务、审批与恢复。
- thread-commands.ts / thread-host.ts 承载同机会话协作：`ap thread ...` 薄命令复用 Core 协作协议，交互会话持有驱动 Runner；两者共用同一状态根与 Project。
- tui/ 使用 React / Ink；renderer.ts 与 event-projector.ts 支持纯文本和 JSONL。
- 内部依赖为 Core、Adapters、Presentation，0.4.0 使用匹配的精确版本。

本包的 bin 提供 ap/autopilot，主入口包再转发至本包的 dist/main.js，不复制 Runtime。TTY 使用交互界面；显式 --output text/jsonl 用于脚本，JSONL 不输出 ANSI 或交互提示。

## 编程入口

包根导出 parseArgv、parseSlashAction、renderHelp、createCliCompositionRoot、createCliController、main、事件投影和 TUI 相关类型。优先把它作为终端应用使用；自行嵌入时需要处理输入输出、Trust、审批和退出清理，不在模块导入时自动启动任务。

```typescript
import { parseArgv, renderHelp } from "@autopilot-agent/cli";

const parsed = parseArgv(["chat", "解释项目结构", "--output", "text"]);
console.log(parsed);
console.log(renderHelp());
```

## 源码开发

从 monorepo 根安装依赖，依次构建 Core、Adapters、Presentation，再执行：

```bash
npm run build -w apps/cli
node apps/cli/dist/main.js --help
npm run test -w apps/cli -- test/parser.test.ts
```

build 使用 TypeScript，输出 dist/*.js 与声明，不在 npm 包中发布源码映射和测试。当前 Node 声明为 >=20.11.0 <22；建议整仓构建使用 Node 20.20.2。

CLI 使用用户级 settings.json，默认工作区为当前目录，可显式指定 --workspace-root。CLI 不读取开发仓库 Web env，也不因配置中含 RAG 字段而自动启用私有知识库工具。重要项目保留版本控制，OS 沙箱、MCP 和平台限制见主包手册。

## 0.4.0 版本

可用 `/effort` 查看当前模型支持的推理强度，用 Ctrl+G 重看保留的通知。启动帮助见 `ap --help`。

## 0.3.0 版本

新增单窗口多会话、任务分派与进展汇报、主子会话双入口审批和图片输入。`Ctrl+T` 切换会话，`Ctrl+A` 处理真实待办请求；历史结构化问题可在原目标会话回答并继续。历史按需加载，输出使用终端原生滚动，并改进启动、缩放和流式完成时的布局。

用户模型配置继续使用用户级 settings.json。图片处理取决于模型及工具能力，首次使用前按主包手册配置。已知旧版状态在受信初始化时自动备份升级，保留升级前数据。

本包随 npm 0.4.0 发布，内部依赖使用匹配的精确版本。Windows 命令和后台 Job 按权限模式与风险审批后以当前用户权限执行，host MCP 另按授权执行，审批不提供 OS 隔离；macOS 继续使用 Seatbelt。实机与进程树生命周期仍需按实际验证确认。

## 许可证

公开源码采用 [MIT 许可证](https://github.com/C-Clay-W/autopilot/blob/main/LICENSE)。第三方依赖保留各自许可证。
