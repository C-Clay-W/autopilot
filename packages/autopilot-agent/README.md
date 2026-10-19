<!-- 本文件用于 npm 用户了解 CLI 安装、配置和使用方式。 -->
# Autopilot Agent — 用户手册

本地工作区中的 AI 编程助手，可以读写文件、执行命令、调用已授权 MCP 工具并保存会话。敏感操作受工作区 Trust、权限与审批控制。

本 npm 包分发 CLI，不包含 Web 或 Desktop 应用，也不提供私有知识库 RAG、AutoMemory 或内置浏览器预览。

本手册以已发布 npm 0.1.0 的安装和配置为基础；GitHub 源码可能包含后续修复。推荐 Node 20.20.2 与 npm 10。

## 安装

需要 **Node.js >=20.11.0 且 <22** 和 npm。首次安装需要网络连接；部分依赖包含平台二进制或安装脚本。

```bash
npm install -g autopilot-agent@0.1.0
ap --help
```

只需安装这个包，npm 会自动安装匹配版本的 Core、Adapters、Presentation 和 CLI。`ap` 与 `autopilot` 是等价命令。

## 配置 settings.json

CLI 不读取开发仓库的 Web `.env.local`，用户无需复制该文件。用户配置位于 Windows 的 `%USERPROFILE%\.autopilot\settings.json`，macOS 的 `~/.autopilot/settings.json`。目录不存在时自行创建；只创建一个 JSON 对象文件，不写注释、尾随逗号或 `schemaVersion`。显式 schemaVersion 会导致整份来源被忽略。

### 默认 Anthropic Messages 连接

替换以下占位密钥和模型 ID：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_API_KEY": "YOUR_API_KEY"
  },
  "model": "YOUR_MODEL_ID"
}
```

认证也可以使用 `ANTHROPIC_AUTH_TOKEN`，但它与 `ANTHROPIC_API_KEY` 只能配置一个；同时配置会产生认证冲突。默认连接按 Anthropic Messages 协议发送请求，不能只改 URL 就接入任意 Chat Completions 服务。Base URL 不手工追加 `/v1/messages`，不得包含 URL 用户名/密码、query 或 fragment。

### 显式 Chat Completions 连接

需要使用经过验证的 OpenAI Chat Completions 兼容服务时，声明协议、模型目录和凭据引用：

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

示例域名和模型必须替换。route 的 id 必须等于字典 key，credentialRef.provider 必须等于该 id，key 对应用户文件 env 中的凭据名，models 非空且 id 不重复；Base URL 不追加 `/chat/completions`。不要同时设置 `env.ANTHROPIC_MODEL`，它会优先选择默认主连接。

route 的 apiProtocol 只接受 `anthropic-messages` 或 `openai-chat-completions`。可选 displayName 是非空字符串，models 项可声明 1–10,000,000 的整数 contextWindowTokens。兼容 profile 需与实际服务匹配：Anthropic profile 只含 apiProtocol；Chat Completions profile 恰含 apiProtocol、assistantToolCallContent（empty-string/null）、supportsReasoningContent（布尔）、supportsUsageInStreaming（布尔）。profile 可放在 route 或 models 项上，不声明未经验证的能力。

### 常用可选参数

| 字段 | settings.json 中的写法与限制 |
|---|---|
| `model` | 模型 ID 或已声明的 routeId/modelId；opus/sonnet/haiku alias 必须先通过 User env 的 ANTHROPIC_DEFAULT_OPUS_MODEL/SONNET_MODEL/HAIKU_MODEL 映射 |
| `env.ANTHROPIC_MODEL` | 可接受模型 ID/alias，但优先于顶层 model；推荐省略，避免覆盖后续 config set model |
| `availableModels` | User-only，非空且无重复的字符串数组；限制默认连接的主/子模型选择，不声明能力；route 模型仍使用其 models 清单 |
| `modelOverrides` | User-only，字符串映射对象；只允许单跳替换，禁止自映射、链和循环；结果仍需属于合法模型目录 |
| `effortLevel` | 顶层字符串 low/medium/high；最终效果受模型与协议能力限制 |
| `env.CLAUDE_CODE_EFFORT_LEVEL` | 字符串 low/medium/high/max/auto/unset，优先于顶层；auto/unset 清除显式 effort，不等于关闭思考 |
| `alwaysThinkingEnabled` | JSON 布尔值，不写成字符串；实际请求仍取决于模型能力 |
| `maxOutputTokens` | User-only，JSON 整数 1–1,000,000；输出预算，不是上下文大小 |
| `env.API_TIMEOUT_MS` | User-only，默认主连接超时的整数字符串，1,000–600,000 毫秒，例如 `"60000"` |
| `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` | User-only，十进制整数字符串 1–10,000,000，声明 compact 窗口 |
| `visionModel` | User-only，false 关闭，或已声明 Chat Completions route 的 routeId/modelId；省略时继承主模型 |
| `webSearch` | User-only，false 关闭；完整对象需 provider/baseUrl/model/credentialRef 四字段，provider 为 deepseek/openai-compatible/xiaomi-mimo 且引用 provider 一致 |
| `sandbox` | mode 为 read-only/workspace-write；allowedDomains、deniedRead、deniedWrite 为无重复字符串数组，不能含裸星号；mode/allowedDomains 仅 User，deny 可由各层收窄 |

env 的值必须是字符串；模型和默认连接凭据不含首尾空白或控制字符，其他凭据也应避免空白。未知 env 项不会自动成为进程环境变量，显式 route 的凭据通过引用从原始用户文件读取。不要在 settings 中声明 danger-full-access。

工作区可另有 `.autopilot/settings.json` 和 `.autopilot/settings.local.json`，仅 Trust 后读取；通常按 User → Project → Local 覆盖允许字段。模型连接、凭据、providerRoutes、availableModels、modelOverrides 等来自 User，项目不能自行引入未授权模型或凭据。不要把密钥放进项目文件或版本控制。

`ap config set` 只允许 model、effortLevel、availableModels 三个 key，并需显式 `--scope`；文件中的 availableModels 是数组，命令参数则是逗号列表。config set 成功不代表所有 resolver 诊断都通过，Project/Local 的 availableModels 不生效。凭据和 endpoint 用手工编辑用户文件配置，config show 不回显它们。

当前 writer 会拒绝含 providerRoutes.credentialRef 或 maxOutputTokens 等字段的文件上的普通 config set；这类完整配置请直接编辑用户文件。config get/show 读取所选 scope 的脱敏文件值，不是多层合并后的最终有效配置。

```bash
ap config set model YOUR_MODEL_ID --scope user
ap config set effortLevel high --scope user
ap config set availableModels MODEL_A,MODEL_B --scope user
```

不要同时使用 env.ANTHROPIC_MODEL 和 config set model；声明 availableModels 后，当前默认主模型也必须在列表中。CLI 不因用户 settings 含有 RAG 配置而获得私有知识库工具。

## 开始使用

进入要处理的项目目录后运行：

```bash
ap
```

首次使用按提示确认工作区 Trust，再运行 `ap doctor` 核对 settings、model 和 credential；未 Trust 时这些检查会 SKIP。`ap doctor` 默认离线，只有显式 `ap doctor --connectivity` 才探测 Provider。`ap` 进入交互模式；也可以提交单次任务：

```bash
ap chat "分析当前项目结构，不修改文件"
```

常用管理命令：

```bash
ap session list
ap trust status
ap sandbox status
```

查看各命令的具体参数与限制：`ap --help`。更新和卸载：

```bash
npm install -g autopilot-agent@latest
npm uninstall -g autopilot-agent
```

卸载 npm 包不表示删除用户配置、凭据或会话数据。

## npm 0.1.0 的已知限制

- Windows 和 macOS 的沙箱需要相应平台条件；安装成功不表示已完成沙箱初始化或隔离验收。通过 `ap doctor` 和 `ap sandbox status` 检查实际状态。
- Windows 后台 Job 全进程树停止、显式 sandbox MCP 的 stdin 转发目前存在已知问题；默认 host MCP 未提供 OS 隔离。不要依赖这些路径处理不可信任务或需要可靠回收的长任务。
- macOS 全链路验收尚未完成，Linux 未纳入本次支持验收。Provider 可用性、限额和调用费用由所配置的服务决定。
- 当前为早期版本，重要工作区请保留版本控制或备份；不承诺任意平台、协议端点和外部工具的兼容性。

## 功能与工作流

- 阅读和搜索项目文件，解释结构、排查错误，使用 @文件提及补充上下文。
- 按需求编辑文件、执行开发命令，并把需要确认的操作交给审批。
- 用 Todo 跟踪任务，通过后台 Job 查看输出和请求停止。
- 保存会话、恢复可继续的任务，按模型能力管理上下文和压缩。
- 加载本机 Skills；配置并显式授权 MCP 服务后扩展工具。
- 按需配置网页搜索和视觉服务；这些服务与主问答连接的能力、费用和限制分别处理。

第一次可以输入“分析项目结构，先不要修改文件”，确认工作区、模型和权限设置符合预期，再进行实际修改。

## 交互命令速查

| 命令 | 用途 |
|---|---|
| /model、/effort | 模型与思考强度，受可用模型清单和服务能力限制 |
| /skill | 查看并选择 Skill |
| /permissions | 查看或调整后续任务的权限模式 |
| /context、/context all | 上下文用量和分项信息 |
| /compact | 压缩当前会话上下文 |
| /queue 需求 | 将下一条需求排队 |
| /jobs | 查看后台任务，按提示读取输出或停止 |
| /undo | 先查看最近一轮可撤销文件改动，再确认撤销 |
| /cancel、/exit | 取消任务或退出 |

完整命令语法见 [CLI 参考](https://github.com/C-Clay-W/autopilot/blob/main/agent/doc/CLI-Reference.md)。该参考随源码更新，可能包含 npm 0.1.0 之后的能力；安装版先用 ap --help 确认可用命令。

## 脚本调用与会话管理

```bash
ap chat "解释这个项目的启动流程" --output text
ap chat "列出关键模块" --output jsonl
ap session list
ap resume --session SESSION_ID
ap project list
ap trust status
ap mcp list
ap job list
```

将 SESSION_ID 替换为自己的会话 ID。交互模式有 TTY 时使用 Ink；text 输出纯文本；jsonl 输出逐事件 JSON，不输出 ANSI 或交互提示。非交互命令不能替你完成未授权操作的人工确认；检查实际终态和退出码，不只判断进程是否启动。

全局选项 --workspace-root、--state-root、--trust-root 可显式控制项目与状态位置。默认项目是启动时当前目录；更换目录前确认是否仍在预期工作区。

## Trust、权限、沙箱与 MCP

Trust 表示你允许该项目作为工作区参与运行，不等于自动批准全部操作。ask、auto_approve、full_access 是工具授权策略；auto_approve 的安全写入和工作区命令仍依赖 Trust，full_access 仍保留路径、Schema 和破坏性命令检查。

OS 沙箱是独立能力，依赖本机平台和系统配置。使用 ap sandbox status / ap doctor 检查，不把 npm 安装成功或拒绝执行当成隔离验收。MCP server 的 command 需要显式授权；项目 Trust 不代替 MCP 审批，默认 host MCP 也不提供 OS 隔离。

提交重要任务前保留 Git 提交或备份。Undo 只覆盖可撤销的文件修改，不是数据库、网络副作用、外部进程或任意命令的通用回滚。

## 配置和数据存放

用户配置位于 home 下 .autopilot；各工作区的持久状态按 canonical 工作区身份分离。配置、会话、checkpoint、日志及工具输出可能含项目内容，应按本地用户数据管理，不上传到公共 Issue。

--state-root / --trust-root 会改变状态或 Trust 的读取位置，调试时记录自己的参数，避免把新目录误认为会话丢失。npm uninstall 只卸载程序，不自动删除这些数据。不要为排查问题直接清空未知的状态目录。

## 常见问题

| 问题 | 处理方向 |
|---|---|
| npm 报 engines 不匹配 | 确认实际运行命令使用受支持的 Node 20；不要只检查另一个终端的版本 |
| Windows 拦截 npm.ps1 | 改用 npm.cmd，不必修改系统执行策略 |
| ap 找不到或仍是旧版本 | 检查 npm 全局 bin 与命令解析路径，例如 PowerShell 的 Get-Command ap |
| doctor 的配置检查 SKIP | 先在交互终端确认当前工作区 Trust |
| 401/403 或模型不可用 | 检查密钥、endpoint、协议、完整模型 ID 和服务商权限；不要把真实 Key 发到 Issue |
| Chat Completions 接不上 | 使用 providerRoutes 声明协议，baseUrl 不追加 /chat/completions |
| config set 拒绝已有文件 | 完整自定义连接配置可直接编辑用户 settings；不要为绕过校验删掉密钥引用 |
| 没有私有知识库工具 | npm CLI 当前不开放该能力；Core/Web 的 RAG 是另行装配的宿主能力 |
| 沙箱或后台任务停止异常 | 查看状态与已知限制，在一次性项目复现，勿盲目重试系统初始化 |

模型服务和网络连通性由你选择的 Provider 决定。协议兼容不代表所有模型的工具调用、流式 usage、reasoning 和上下文能力都一致。

## 五包组成与源码

```text
autopilot-agent@0.1.0
├── @autopilot-agent/cli@0.1.0
│   └── @autopilot-agent/presentation@0.1.0
├── @autopilot-agent/core@0.1.0
└── @autopilot-agent/adapters@0.1.0
```

CLI 也直接依赖 Core 和 Adapters，Adapters/Presentation 依赖 Core。主包的 bin 解析已安装的 CLI 并转发参数、标准流及退出结果；不重复实现 Agent Runtime。schema/cc-compatible-settings.schema.json 提供配置结构参考，实际允许字段仍受 Runtime 校验。

源码仓库：https://github.com/C-Clay-W/autopilot 。源码还包含 Web；它不随 npm 主包安装。开发者可阅读各包 README、Core API 和 BUILD.md，从源码修改并验证。当前源码可以先于 registry 中的 0.1.0，不能仅凭版本字段判断二者完全相同。

## 许可证

本公开源码采用 MIT，见 LICENSE；第三方依赖和字体保留各自许可证。已发布的 npm 0.1.0 不会因本次源码整理而被替换或重新发布。
