# Autopilot 0.4.0 启动指南

| 想做什么 | 从哪里开始 | 启动后看到什么 |
|---|---|---|
| 在终端里让 AP 处理项目 | 用 npm 安装 CLI，进入项目运行 `ap` | 终端对话界面 |
| 开发或调试 CLI | 构建源码，用 Node 运行 CLI 入口 | 同一个终端界面，也支持纯文本和 JSONL |
| 在浏览器里使用 Chat 或 Work | 从源码启动 Web 开发服务器，或构建后运行 | 浏览器中的本地工作台 |
| 并排操作终端或交给主控派工 | 打开已安装的 Desktop，或从源码运行 `npm run desktop` | 桌面窗口里的 Parallel 和 Orchestration |

## CLI

**安装版**使用 Node.js 20.20.2 和 npm 10。CLI 声明的范围是 `>=20.11.0 <22`。先安装，再在希望 AP 处理的项目目录打开终端运行：

```bash
npm install -g autopilot-agent@0.4.0
ap --help
ap
```

`autopilot` 和 `ap` 是同一入口。首次进入项目按提示确认工作区信任，再输入需求。要继续与已有会话对话，用 `ap chat --session <会话ID>`；要恢复可继续的原任务，用 `ap resume --session <会话ID>`。脚本可用 `ap chat "概括这个项目的目录结构" --output text`，逐事件读取则用 `--output jsonl`。首次信任请在交互终端完成。

**源码版**先完成下面的源码准备和共享包构建，然后从仓库根运行：

```bash
npm run build -w apps/cli
node apps/cli/dist/main.js --help
node apps/cli/dist/main.js --workspace-root "/path/to/your/project"
```

最后一行换成自己的项目路径。源码更新后重新构建受影响的包；使用这个入口可以直接运行刚编译的 CLI。

## 源码准备

仅安装 npm CLI 或已有 Desktop 安装包时可以跳过本节。源码工程使用 npm workspaces。完整工程包含 Electron Forge，请用 Node.js 22.13 或更高的兼容 22.x 版本、npm 10，在目标系统安装依赖。独立启动 CLI 时切换到 Node 20.20.2。

```bash
git clone https://github.com/C-Clay-W/autopilot.git
cd autopilot
node --version
npm --version
npm ci
```

以下源码命令均从仓库根执行。Windows PowerShell 遇到 npm.ps1 执行策略限制时可直接使用 `npm.cmd`。CLI 和 Web 首次启动前依次构建共享包：

```bash
npm run build -w packages/core
npm run build -w packages/adapters
npm run build -w packages/presentation
```

## Web

Web 随 Git 源码提供。完成共享包构建后，开发时运行：

```bash
npm run dev -w apps/web -- --hostname 127.0.0.1
```

保留运行命令的终端，打开它打印的地址，通常是 `http://127.0.0.1:3000`。在设置页配置主模型。Chat 可对话和处理临时附件，Work 需先选择并信任本机项目，再进行文件和命令操作。停止本地服务可在原终端按 Ctrl+C。

要运行生产构建，先停止占用同一端口的开发服务，再运行：

```bash
npm run build -w apps/web
npm run start -w apps/web
```

生产启动脚本默认监听本机回环地址。两个入口都可以在命令末尾传入端口，例如 `npm run start -w apps/web -- --port 3100`。

## Desktop

**已有安装包。** Windows x64 双击 `AutopilotDesktopSetup-0.4.0-x64.exe`，选好目录并安装，然后从开始菜单打开 Autopilot Desktop。Apple 芯片 Mac 如取得对应 DMG，打开后将应用拖入「应用程序」，再从那里启动。使用安装包时无需自行安装 Node。GitHub 的 Source code ZIP 是源码压缩包，使用它请走下面的源码步骤。

**从源码启动。** 工程命令在 Node 22.13+ 上运行，终端里的 AP 单独使用 Node 20。准备好这两个运行时，再执行下面两行。Windows 固定运行时的准备命令和 macOS 路径见[桌面构建说明](https://github.com/C-Clay-W/autopilot/blob/main/BUILD.md#desktop)。

```bash
npm run prepare:browser -w apps/desktop
npm run desktop
```

第一行首次下载并校验浏览器驱动，已有匹配资源时可跳过。第二行会先构建共享包与 CLI，再启动 Electron Forge。保留该终端，等桌面窗口打开。Forge 开发服务使用 3177 端口。已有最新共享包和 CLI、只改了桌面界面时，也可用 `npm run start -w apps/desktop`。共享包或 CLI 更新后，退出窗口并重新运行根目录的 `npm run desktop`。

- **Parallel** 适合自己操作多个终端。选择智能体、双终端或四终端布局，再选择项目目录进入。Freedom 会打开空白 Shell，可自行输入 `ap`。要使用 Claude Code、Codex、OpenCode 或 CodeBuddy，请先在本机安装相应 CLI，再点「重新检测」。
- **Orchestration** 适合把目标交给 AP 主控。选择项目、输入任务，主控可以拆分工作并派给执行者。审批请求会显示在该工作区，下次可从任务历史接回主控会话。
- **内置浏览器** 从 Desktop 的浏览器面板打开，可查看网页、localhost 和本地 HTML/Markdown。需要让 AP 操作页面时，按桌面审批提示授权。

## 模型配置与首次检查

CLI、Web 和 Desktop 中的 AP 使用用户级配置。Windows 位于 `%USERPROFILE%\.autopilot\settings.json`，macOS/Linux 位于 `~/.autopilot/settings.json`。可以在 Web 设置页保存，也可以创建标准 JSON 文件。使用 Anthropic Messages 默认连接时，替换下例中的占位值：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_API_KEY": "YOUR_API_KEY"
  },
  "model": "YOUR_MODEL_ID"
}
```

OpenAI Responses、Chat Completions 连接需要显式指定协议、模型和凭据引用。具体字段和示例见 [CLI 参考](CLI-Reference.md)。搜索、Embedding、Rerank、PDF/OCR 可按需配置。模型服务费用由所选服务商收取。

| 现象 | 检查方法 |
|---|---|
| CLI 打不开或找不到共享包 | 用 `node --version` 核对 CLI 运行时，源码版按顺序重建共享包和 CLI |
| 模型连接失败 | 在已信任的项目中运行 `ap doctor`；`ap doctor --connectivity` 会实际请求模型服务，检查协议、Key 与模型 ID |
| Web 打不开 | 看终端打印的地址和端口；生产模式先构建 Web，再运行 start |
| Desktop 窗口打开，但 AP 终端启动失败 | 核对独立 Node 20 和 CLI 构建产物，再从仓库根运行 `npm run desktop` |
| Desktop 缺少浏览器资源 | 重新运行 `npm run prepare:browser -w apps/desktop`，成功后重启 |
| 项目写入或命令等待确认 | 核对项目目录、首次信任和当前审批。Windows 命令按当前用户权限运行；macOS 使用 Seatbelt |

公开仓库根目录的 BUILD.md 提供桌面打包和各包构建明细。命令与配置详见 [CLI 参考](CLI-Reference.md)，开发宿主时可查 [Core API](Core-API.md)。
