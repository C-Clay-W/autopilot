# Autopilot Web

Next.js 16 / React 19 的本地 Web 宿主。Chat 使用临时附件与知识检索，Work 面向已选择并信任的项目进行文件、命令、审批、任务和会话操作。两种模式共享 Core / Adapters / Presentation，能力与状态边界分别装配。

本应用不包含在 npm autopilot-agent 的安装中，从源码运行。

## 启动

从仓库根执行，建议 Node 20.20.2 / npm 10：

```bash
npm ci
npm run build -w packages/core
npm run build -w packages/adapters
npm run build -w packages/presentation
npm run dev -w apps/web -- --hostname 127.0.0.1
```

打开终端显示的本地地址，默认 http://127.0.0.1:3000。构建后运行：

```bash
npm run build -w apps/web
npm run start -w apps/web
```

start 绑定 127.0.0.1。服务能够操作所在机器的项目文件，不应直接用作未经鉴权的公网服务。

## 配置与使用

使用用户 home 下 `.autopilot/settings.json`，与 CLI 共享用户配置；默认 Anthropic 与显式 Chat Completions 示例见 [主包手册](../../packages/autopilot-agent/README.md)。也可在设置页配置主模型、搜索与 RAG 连接，不需要作者的 env 或 launcher。

先选择模式：Chat 处理会话临时附件；Work 选择目标项目、完成 Trust，再审批具体操作。模型、搜索、视觉和 RAG 需要各自可用的服务；未配置对应连接时该能力不可用。RAG 向量空间必须与入库模型/维度一致；PDF/OCR 还需按能力准备外部工具。

## Work 预览与 Windows 执行

源码 0.2.0 的 Work 支持内置预览面板、结果入口和 `open_preview` 工具，只准备导航，不读取、验证或操作页面；Chat 不注册该工具。宿主校验预览目标与 Job 归属，服务归属无法证明时不自动展开。完整浏览器与 Provider 验收仍需确认。

Windows 进程沙箱已移除；命令、后台 Job 与 host MCP 逐次审批后以当前用户权限直接执行，界面显示未隔离。macOS 继续使用 Seatbelt 沙箱，平台实机保证以实际验证为准。

## 源码与检查

- app/chat 提供会话、审批、Todo、Job 和时间线组件。
- app/api 与 lib/runtime-host 处理本地请求、运行编排及安全 DTO，Node 实现尽量复用 Adapters。
- lib/settings 和设置页仅通过受控边界处理连接配置，密钥不回显到普通状态视图。
- test 与 vitest.config.ts 保留定向单元和契约测试；例如根运行 `npm run test -w apps/web -- test/lib/settings/credential-settings.test.ts`。

详细启动见 [使用指南](../../agent/doc/HowToUse.md)，构建和运行限制见 [BUILD.md](../../BUILD.md)。本地字体由 JetBrains Mono 提供，保留 OFL 授权；项目代码 MIT。
