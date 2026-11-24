# 从源码构建 Autopilot

公开源码构建说明。全部命令从仓库根执行，不依赖作者的 launcher、全局 ap、私有 env 或历史产物。

## 环境

完整工程使用 Node.js 22.13+ 与 npm 10 安装和构建。独立 CLI 声明 `>=20.11.0 <22`，推荐以 Node 20.20.2 运行。Windows PowerShell 可使用 npm.cmd/npx.cmd，避免 npm.ps1 执行策略问题。

```bash
node --version
npm --version
npm ci
```

npm workspaces 自动链接 apps/packages。依赖含原生模块，在目标 OS 安装，保留正常安装脚本，不跨平台复制 node_modules。

## 构建顺序与输出

Core → Adapters / Presentation → CLI / Web。每步成功再继续：

```bash
npm run build -w packages/core
npm run build -w packages/adapters
npm run build -w packages/presentation
npm run build -w apps/cli
```

| 包 | 构建 | 输出 |
|---|---|---|
| Core | esbuild 多入口、TypeScript 声明、PDF Python 脚本 | packages/core/dist |
| Adapters | esbuild CJS/ESM 与类型声明 | packages/adapters/dist |
| Presentation | esbuild CJS/ESM 与类型声明 | packages/presentation/dist |
| CLI | TypeScript NodeNext / JSX | apps/cli/dist |
| Web | Next.js build | apps/web/.next |
| 主入口 | 无构建，转发到已安装的 CLI | bin 与 schema |

整仓构建可用根 `npm run build`，Turbo 按 dependsOn 排序，无需与分包命令重复执行。共享包源码变化后重建其 dist，避免旧产物掩盖问题。

## 启动

```bash
node apps/cli/dist/main.js --help
node apps/cli/dist/main.js --workspace-root /path/to/your/project
```

替换工作区路径，含空格时加引号。调试源码使用该入口，避免全局 ap 指向另一个 npm 版本。

Web 开发服务器：

```bash
npm run dev -w apps/web -- --hostname 127.0.0.1
```

打开终端显示的本地地址。共享包构建后，Web 生产模式使用：

```bash
npm run build -w apps/web
npm run start -w apps/web
```

start 默认绑定 127.0.0.1。本项目按本地服务设计，上述命令不包含公网部署鉴权方案。

## Desktop

桌面开发、Parallel 和 Orchestration 的首次操作见 [三端启动指南](agent/doc/HowToUse.md#desktop)。Forge 使用工程 Node 22.13+，桌面中的 AP 使用单独的 Node 20.20.2。Windows x64 可在源码根目录的 PowerShell 中准备运行时：

```powershell
$runtimeDir = '.local/node-windows-20.20.2'
New-Item -ItemType Directory -Force $runtimeDir | Out-Null
npm pack node-win-x64@20.20.2 --pack-destination $runtimeDir
tar -xzf "$runtimeDir/node-win-x64-20.20.2.tgz" -C $runtimeDir
```

Apple 芯片 Mac 的打包运行时按以下方式准备：

```bash
mkdir -p .local/node-darwin-arm64-20.20.2
npm pack node-bin-darwin-arm64@20.20.2 --pack-destination .local/node-darwin-arm64-20.20.2
tar -xzf .local/node-darwin-arm64-20.20.2/node-bin-darwin-arm64-20.20.2.tgz -C .local/node-darwin-arm64-20.20.2
```

macOS 源码启动时，桌面窗口会在 Electron resources 的 `node20/bin/node` 或 PATH 中查找兼容 Node。在 Node 22 工程终端准备完以上资源后，可运行 `export PATH="$PATH:$PWD/.local/node-darwin-arm64-20.20.2/package/bin"`。工程仍会先找到 Node 22，桌面终端会继续查找到兼容的 Node 20。

首次启动或打包前执行 `npm run prepare:browser -w apps/desktop` 准备浏览器驱动，再运行 `npm run desktop`。打包使用 `npm run desktop:package`。Windows x64 安装向导用 `npm run desktop:make -- --platform=win32 --arch=x64` 生成，位于 `apps/desktop/out/make/nsis/x64/`。在 Apple 芯片 Mac 上，`npm run desktop:make -- --platform=darwin --arch=arm64` 生成桌面 ZIP。Forge 的 make 脚本不生成 DMG。

## 模型和可选能力

CLI/Web 使用用户级 `.autopilot/settings.json`，Windows 在 USERPROFILE 下，macOS/Linux 在用户 home 下。参照 [主包手册](packages/autopilot-agent/README.md)，无需复制开发 env。

环境变量名称是公开配置接口；敏感的是实际值。兼容变量 LOOP_LLM_BASE_URL/API_KEY/MODEL 仅用于仍支持它们的宿主路径，CLI 不自动读取 Web env 文件。优先使用用户 settings，Key 不进入版本控制或浏览器日志。

Web 设置页可配置模型、搜索及 RAG。Embedding 模型与维度须匹配已入库向量空间。按需启用 PDF/OCR 时准备 Python/PyMuPDF 或 OCR 工具；缺少可选依赖只影响对应能力。

## 日常开发与测试

Core 使用 `npm run dev -w packages/core` watch，另一终端运行 Web；Adapters/Presentation 变化后重建对应包。保留各 workspace 的 Vitest 配置、单元/契约测试及合成 fixture，例如：

```bash
npm run test -w packages/presentation -- test/todo.test.ts
npm run test -w apps/cli -- test/parser.test.ts
npm run typecheck -w packages/core
```

根 test:unit 遍历 workspace；根 test:e2e 启动跨进程 lease 冒烟，消费共享包当前 dist 并创建临时状态。按改动选测；OS/进程测试受平台与权限限制。本文提供命令，不宣称这些检查已经全部通过。

## npm 清单检查

五包各自 prepack 会构建并校验允许发布的文件。完成相关构建后可在根运行 `npm run check:npm-pack` 检查清单、版本及声明引用；不发布 npm，不验证 Provider。

公开 Git 源码保留 src、测试和构建配置，npm 分发 dist、声明及入口等；npm files 不能替代 Git 忽略规则。

## 沙箱与平台

源码 0.4.0 在 Windows 不提供 OS 进程沙箱：命令和后台 Job 经权限策略判定后以当前用户权限运行，host MCP 按配置与审批执行。sandbox status / setup 返回停用报告，不安装 Windows 沙箱；审批不构成隔离。macOS 继续使用 Seatbelt，系统初始化属于显式操作。进程树回收与跨平台实机验证须单独确认。npm 0.4.0 的使用与限制见主包手册。
