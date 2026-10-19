# Provider Settings Stage 0 Fixture

本目录只冻结 `Talk-Plan0829-provider-settings.md` Stage 0 的基线和目标契约，供后续 Stage 的单元测试、实现审查和 macOS 最终验收复用。它不是可被运行时加载的用户配置，也不代表 Provider、目录创建、Schema 发布或双平台验收已经完成。

## 当前基线（2026-08-29）

| 区域 | 当前事实 | 源码定位 |
|---|---|---|
| Core settings | 只解析 v1/v2 的 DeepSeek/Ali 专用结构、内置模型和独立视觉模型 | `packages/core/src/runtime/config/autopilot-settings.ts` |
| Node settings | 已按 User/Project/Local 路径读取和热重载，但没有首次业务命令创建用户配置根、lstat 链接拒绝或 CC `env` 白名单 | `packages/adapters/src/node/settings/node-settings-loader.ts` |
| Node writer | 只写旧 schema 的非敏感键，尚不保留 CC 顶层 passthrough | `packages/adapters/src/node/settings/node-settings-writer.ts` |
| CLI 装配 | 固定 `createDeepSeekModelSamplerFactory()`，并保留 `LOOP_LLM_*` 启动回退 | `apps/cli/src/composition-root.ts` |
| Web 装配 | 固定默认 Factory，并有 Ali/DashScope 独立视觉回退 | `apps/web/lib/composition-root.ts` |
| 主链 transport | 固定 OpenAI Chat Completions 与 `reasoning_effort` | `packages/core/src/internal/lib/provider-transport.ts` |
| Turn 冻结 | 已有 `FrozenProviderConfig` 入口，但仍以 DeepSeek/Ali 和独立视觉分支解析 | `packages/core/src/runtime/application/turn/turn-runtime-config-resolver.ts` |

## Fixture 清单

| 文件 | 固定内容 |
|---|---|
| `legacy-v1-settings.json` | 既有 v1 DeepSeek settings 解析输入 |
| `legacy-v2-settings.json` | 既有 v2 primary/vision settings 解析输入 |
| `legacy-loop-llm-env.json` | `LOOP_LLM_*` 兼容回退的变量名和完整性条件；不保存值 |
| `current-openai-transport-request.json` | 当前主链 `/chat/completions` 与 `reasoning_effort` 请求形态 |
| `cc-compatible-settings.schema.json` | 目标 CC Provider/模型子集的 Draft 2020-12 fixture；未知顶层字段保留 |
| `stage0-contract.json` | Scope、优先级、effort、稳定诊断、路径安全和 win32/darwin 验收矩阵 |

所有 URL 都是 `.invalid` 测试地址；本目录没有 API Key、Token、真实 Home 路径、真实 Provider 响应或可执行的用户 settings。

## 版本与执行边界

- 发布 CLI 的已声明 Node 支持范围为 `>=20 <22`；本 Stage 的 CI 基线固定为 Node 20.x。
- 根 `package.json` 固定 package manager 为 `npm@10.8.2`；Stage 0 的 CI 基线固定为 npm 10.8.2。
- 当前工作主机的 Node 版本为 `v22.23.2`，不属于上述 CLI 支持范围，因此本 Stage 不用它宣称任何 CLI 兼容测试通过。
- `win32` 自动项目可在对应实现 Stage 执行；`darwin` fixture、runner 和人工清单在本 Stage 冻结，原生执行统一延后到 Stage 7。
