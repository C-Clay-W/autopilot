/** statusView 异步刷新 hook：从 Controller 拉取脱敏状态栏。 */

import { useState } from "react";
import type { CliController } from "../../controller.js";
import type { CliStatusView } from "../../types.js";

/** 管理脱敏状态栏并暴露异步刷新函数；测试 double 未提供 getStatusView 时保持旧值。 */
export function useStatusView(controller: CliController): {
  statusView: CliStatusView | undefined;
  refreshStatusView: () => Promise<void>;
} {
  const [statusView, setStatusView] = useState<CliStatusView | undefined>(undefined);

  /** 从 Controller 刷新脱敏状态栏，测试 double 未提供时保持旧状态行。 */
  async function refreshStatusView(): Promise<void> {
    const next = await controller.getStatusView?.();
    if (next) setStatusView(next);
  }

  return { statusView, refreshStatusView };
}
