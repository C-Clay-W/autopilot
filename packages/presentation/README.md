# @autopilot-agent/presentation

CLI 与 Web 共用的纯 TypeScript 展示层：把 Runtime 安全事件和宿主事件转换为可重放的时间线状态。普通用户安装 `autopilot-agent@0.2.0`，CLI 会带入本包。

## 核心接口

| API / 类型 | 作用 |
|---|---|
| createPresentationState | 创建空展示状态 |
| PresentationInput | Runtime 信封与 Host 安全事件的统一输入 |
| reducePresentationInput | 不可变地归约单个输入 |
| replayPresentationInputs | 从输入序列重建视图状态 |
| selectTimeline | 时间线过滤与工具分组 |
| selectTurnTimeline / selectTurnTodoSnapshot | 按 Turn 读取时间线及 Todo |
| tool-profiles / copy / redaction | 工具展示协议、共享文案和安全文本处理 |

```typescript
import {
  createPresentationState,
  replayPresentationInputs,
  selectTimeline,
  type PresentationInput,
} from "@autopilot-agent/presentation";

/** 输入必须先经宿主安全投影，不传入原始 Provider 或工具响应。 */
export function buildTimeline(inputs: PresentationInput[]) {
  const state = replayPresentationInputs(inputs, createPresentationState());
  return selectTimeline(state);
}
```

本包不启动模型、不读写文件、不保存 Session，也不包含 React/Ink 组件。reducer 与 selector 负责视图事实和分组，不承担权限授权；文本脱敏函数不能替代上游事件安全投影。

## 构建与测试

```bash
npm ci
npm run build -w packages/core
npm run build -w packages/presentation
npm run test -w packages/presentation -- test/todo.test.ts
```

从 monorepo 根运行。产物为 CJS、ESM 和 TypeScript 声明，Core 保持 external；npm 0.2.0 精确依赖 Core 0.2.0。公开源码还保留 reducer、分组及展示行为测试和合成 fixture。

## 许可证

MIT，见本包 LICENSE。
