# 从源码构建 Autopilot

公开源码构建说明。全部命令从仓库根执行，不依赖作者的 launcher、全局 ap、私有 env 或历史产物。

## 环境

建议 Node.js 20.20.2 与 npm 10。CLI 声明 `>=20.11.0 <22`；整仓依赖可能要求较新的 Node 20 小版本。Windows PowerShell 可使用 npm.cmd/npx.cmd，避免 npm.ps1 执行策略问题。

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

安装包不代表 OS 沙箱可用。先运行 sandbox status / doctor；初始化系统能力属于单独显式操作。Adapters native 目录是 Windows 原生候选材料，不等于默认 npm runner 的实机保证。macOS/Linux 的验证范围及已知问题见主包手册。
