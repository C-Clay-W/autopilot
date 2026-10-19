<!-- 本文说明从公开源码安装、构建和使用 Autopilot，不依赖作者本机目录或配置。 -->
# 从源码启动与使用 Autopilot

源码包含 CLI、Web 应用及五个 npm 包。普通终端用户可直接安装 `autopilot-agent@0.1.0`；需要修改代码或使用 Web 时，按本文启动。

## 1. 环境准备

- 建议 Node.js 20.20.2 与 npm 10。CLI 声明范围为 `>=20.11.0 <22`，整仓依赖可能要求较新的 Node 20 小版本；Node 22 不在 CLI 声明范围内。
- Git 和安装依赖所需的网络。依赖含原生组件，请在目标机器安装，不跨 Windows/macOS 复制 node_modules。
- 可用的模型服务、模型 ID 和自己的 API Key，调用费用由服务商收取。
- 按需启用 PDF/OCR 时，才准备 Python、PyMuPDF 或 OCR 工具；仅启动 CLI 不要求这些工具。

Windows PowerShell 如果阻止 npm.ps1，使用 npm.cmd/npx.cmd，无需修改执行策略。以下命令均从仓库根运行。

## 2. 获取源码和安装

```bash
git clone https://github.com/C-Clay-W/autopilot.git
cd autopilot
node --version
npm --version
npm ci
```

npm workspaces 自动链接各包；保留根 package-lock.json。主要目录为 apps/cli、apps/web、packages/core、packages/adapters、packages/presentation、packages/autopilot-agent。

## 3. 构建 CLI

依次运行，每一步成功后再继续：

```bash
npm run build -w packages/core
npm run build -w packages/adapters
npm run build -w packages/presentation
npm run build -w apps/cli
node apps/cli/dist/main.js --help
```

共享包通过 dist 被其他包消费，修改源码后重建对应包；不要使用其他分支遗留的 dist 验证当前代码。

## 4. 配置模型

CLI 和 Web 使用用户级 settings.json，不需要作者的 Web env 文件。

| 系统 | 用户配置位置 |
|---|---|
| Windows | `%USERPROFILE%\.autopilot\settings.json` |
| macOS/Linux | `~/.autopilot/settings.json` |

目录不存在时自行创建。文件是标准 JSON，不写注释、尾随逗号或 schemaVersion。替换以下占位值：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_API_KEY": "YOUR_API_KEY"
  },
  "model": "YOUR_MODEL_ID"
}
```

默认连接使用 Anthropic Messages 协议；需要 Chat Completions 时，按主包 README 的 providerRoutes 示例声明协议，不能只改 URL。真实 settings、密钥及日志不要提交 Git。

公开仓库完整配置说明在 `packages/autopilot-agent/README.md`；CLI/Core 参考文档和本文同置于 `agent/doc/`。

## 5. 使用 CLI

从源码启动，显式指定希望处理的项目：

```bash
node apps/cli/dist/main.js --workspace-root /path/to/your/project
```

替换示例路径，Windows 路径含空格时加引号。首次在交互终端中按提示确认 Trust。然后检查配置：

```bash
node apps/cli/dist/main.js doctor --workspace-root /path/to/your/project
node apps/cli/dist/main.js doctor --connectivity --workspace-root /path/to/your/project
```

doctor 默认离线；connectivity 会请求模型服务。未 Trust 时部分检查会跳过。开始后输入自然语言需求，或使用 /model、/permissions、/context、/jobs、/undo 等命令。

脚本调用：

```bash
node apps/cli/dist/main.js chat "分析项目结构，不修改文件" --workspace-root /path/to/your/project --output text
```

使用已发布版本时只需 `npm install -g autopilot-agent@0.1.0`，进入目标项目运行 ap。全局 ap 可能与源码版本不同；调试源码优先使用 node apps/cli/dist/main.js。

## 6. 使用 Web

完成共享包构建后启动：

```bash
npm run dev -w apps/web -- --hostname 127.0.0.1
```

打开终端输出的本地地址，默认 http://127.0.0.1:3000。服务可以访问运行它的机器的文件，不要直接作为未经鉴权的公网服务部署。

设置页配置主模型及按需启用的搜索、Embedding、Rerank。Chat 临时附件检索与 Work 项目操作是不同能力；CLI 不提供私有知识库工具，不代表 Core/Web 不含 RAG。

构建后启动：

```bash
npm run build -w apps/web
npm run start -w apps/web
```

安装、打开页面或 --help 成功，不等于真实 Provider、文件写入及 OS 沙箱均已验收。

## 7. 开发与检查

- Core 使用 `npm run dev -w packages/core` 开启 watch，另一终端运行 Web；Adapters/Presentation 改动后重建对应包。
- 使用现有测试配置定向验证，例如 `npm run test -w packages/presentation -- test/todo.test.ts`。
- 依赖顺序为 Core → Adapters/Presentation → CLI/Web。整仓构建可用根 npm run build，不与分包命令重复执行。
- 用 Git 保存重要工作区。Trust、审批、权限模式和 OS 沙箱各有职责；full_access 不代表已获得系统隔离或任意权限。

## 8. 常见问题

| 现象 | 检查 |
|---|---|
| 共享包入口或类型不存在 | 根 npm ci 后按依赖顺序构建 |
| 源码变化未生效 | 确认源码入口，并更新对应 dist |
| 模型认证失败 | 检查用户配置、协议、模型；不要同时填写默认 API Key 和 Auth Token |
| 无法操作项目 | 检查 workspace-root、Trust 和操作审批 |
| RAG 向量空间不匹配 | 使用入库时的模型与维度，必要时重新入库，不通过改名绕过检查 |
| 沙箱不可用 | 查看 sandbox status / doctor；OS 沙箱初始化为单独操作 |

公开仓库根 BUILD.md 提供构建明细，主包 README 提供配置和平台限制。当前为早期项目，以对应版本源码和实际运行结果为准。
