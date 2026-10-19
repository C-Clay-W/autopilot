# Autopilot Agent

本地 AI 编程助手：阅读与修改项目、执行开发命令、跟踪后台任务、管理会话，通过 Trust、权限和审批控制操作。CLI 和本地 Web 共享 TypeScript Agent Runtime。

## 安装 CLI

需要 Node.js `>=20.11.0 <22`，建议 Node 20.20.2 与 npm 10。

```bash
npm install -g autopilot-agent@0.1.0
ap --help
```

主包自动带入 Core、Adapters、Presentation 和 CLI。ap 与 autopilot 等价。完整安装、模型配置、使用和排错见 [主包使用手册](packages/autopilot-agent/README.md)。npm CLI 不包含 Web 应用。

## 从源码运行

```bash
git clone https://github.com/C-Clay-W/autopilot.git
cd autopilot
npm ci
npm run build -w packages/core
npm run build -w packages/adapters
npm run build -w packages/presentation
npm run build -w apps/cli
node apps/cli/dist/main.js --help
```

共享包构建后，Web 使用 `npm run dev -w apps/web -- --hostname 127.0.0.1`。用户配置、工作区和日常开发见 [源码使用指南](agent/doc/HowToUse.md)；构建与测试见 [BUILD.md](BUILD.md)。

## 项目组成

| 包 / 目录 | 职责 |
|---|---|
| [autopilot-agent](packages/autopilot-agent/README.md) | 用户安装入口，关联安装其余四包 |
| [@autopilot-agent/cli](apps/cli/README.md) | 命令解析、Controller、Ink TUI 与文本/JSONL 输出 |
| [@autopilot-agent/core](packages/core/README.md) | Runtime、审批、会话、工具、RAG 与宿主接口 |
| [@autopilot-agent/adapters](packages/adapters/README.md) | Node 存储、工作区、配置、沙箱及外部能力 |
| [@autopilot-agent/presentation](packages/presentation/README.md) | 共享安全事件投影、时间线、分组和展示文案 |
| [apps/web](apps/web/README.md) | Next.js 本地 Chat / Work 界面，源码运行，不作为 npm 应用分发 |

五个 npm 包的已发布版本为 0.1.0；当前源码与开发参考文档可以包含发布后的修复。相同 package.json 版本号不代表源码与 registry 归档逐字一致；固定发布行为以 npm 归档为准，源码以 Git commit 为准。

## 文档

- [CLI 命令参考](agent/doc/CLI-Reference.md)
- [Core API 参考](agent/doc/Core-API.md)
- [源码启动与使用](agent/doc/HowToUse.md)

必要测试、配置及合成 fixture 随源码提供。真实 env、凭据、会话/数据库和内部运行记录不公开。

## 安全与贡献

Trust、工具审批和 OS 沙箱各有职责，full_access 仍受路径、Schema 和破坏性命令门禁约束。保留重要项目备份，审查模型改动，不把本地 Web 直接暴露到公网。

欢迎 Issue 和 PR，描述复现、环境及相关验证，避免提交密钥和原始会话。公开分支由开发主线筛选同步，贡献经审查纳入开发主线后再同步。当前为早期版本，平台和沙箱限制见主包手册。

## 许可证

项目代码使用 [MIT](LICENSE)，第三方材料保留独立授权，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
