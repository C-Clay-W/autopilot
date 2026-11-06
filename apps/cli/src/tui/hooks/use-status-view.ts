/** statusView异步刷新hook：合并同批/在途刷新，切换和卸载失效旧订阅。 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CliController } from "../../controller.js";
import type { CliStatusView } from "../../types.js";

/** 每挂载持有独立取消身份；一次查询期间的新刷新最多合并成一次后续查询。 */
export function useStatusView(controller: CliController): {
  statusView: CliStatusView | undefined;
  refreshStatusView: () => Promise<void>;
} {
  const [state, setState] = useState<{ controller: CliController; value: CliStatusView }>();
  const lifecycle = useMemo(function createLifecycle() {
    return { active: true, abort: new AbortController(), requested: false, pending: undefined as Promise<void> | undefined };
  }, [controller]);

  useEffect(function bindStatusLifecycle() {
    lifecycle.active = true;
    if (lifecycle.abort.signal.aborted) lifecycle.abort = new AbortController();
    return function cancelStatusLifecycle(): void {
      lifecycle.active = false;
      lifecycle.requested = false;
      lifecycle.abort.abort();
    };
  }, [lifecycle]);

  const refreshStatusView = useCallback(async function refreshStatusView(): Promise<void> {
    if (!lifecycle.active || !controller.getStatusView) return;
    lifecycle.requested = true;
    if (!lifecycle.pending) {
      // 微任务合并同次提交触发的刷新，不额外叠加时间节流。
      lifecycle.pending = Promise.resolve().then(async function drainStatusRefreshes(): Promise<void> {
        while (lifecycle.active && lifecycle.requested) {
          lifecycle.requested = false;
          try {
            const next = await controller.getStatusView?.({ signal: lifecycle.abort.signal });
            if (next && lifecycle.active && !lifecycle.abort.signal.aborted) setState({ controller, value: next });
          } catch { /* 查询失败或失效不写入其他Session，也不产生未处理拒绝。 */ }
        }
      }).finally(function releaseStatusRefresh(): void { lifecycle.pending = undefined; });
    }
    await lifecycle.pending;
  }, [controller, lifecycle]);

  return { statusView: state?.controller === controller ? state.value : undefined, refreshStatusView };
}
