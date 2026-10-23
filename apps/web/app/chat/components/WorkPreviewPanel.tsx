/**
 * WorkPreviewPanel.tsx — 右侧内置预览面板：iframe、工具栏、窄屏回退与状态提示。
 *
 * iframe 只加载 Stage2 受限 API 校验过的 navigationUrl，沙箱档与 referrer 按冻结契约固定；
 * load 只结束等待动画，超时保留 iframe 与手动入口，不凭超时断言被 CSP 阻止。
 */

"use client";

import { useEffect, type RefObject } from "react";
import type { WorkPreviewPanelState } from "../work-preview-state";

/** 界面等待页面 load 的上限；超过后进入 embedding_unknown 并提示新标签页。 */
const EMBEDDING_WAIT_MS = 15_000;

/** serviceState 的固定中文说明；unchecked 不显示为服务就绪或验收通过。 */
function describeServiceState(state: WorkPreviewPanelState): string {
  const serviceState = state.target?.serviceState;
  if (state.phase === "resolving") return "正在解析预览目标…";
  if (state.phase === "opening") return "页面已交给浏览器加载，效果请查看";
  if (state.phase === "embedding_unknown") return "若页面空白或无法显示，可在新标签页打开";
  if (serviceState === "ready") return "服务就绪";
  if (serviceState === "redirect_pending") return "目标会跳转，请确认地址";
  if (serviceState === "unavailable") return "服务当前不可用";
  return "未做服务端探测，实际效果以页面为准";
}

interface WorkPreviewPanelProps {
  /** 面板状态（阶段 + 当前导航目标）。 */
  state: WorkPreviewPanelState;
  /** 窄屏单栏模式：工具栏以"返回任务"作为主关闭动作。 */
  narrow: boolean;
  /** 工具栏容器 ref，手动打开成功后由装配层聚焦。 */
  toolbarRef?: RefObject<HTMLDivElement | null>;
  /** 页面 load 事件：只结束等待动画。 */
  onLoad(): void;
  /** 界面等待超时：进入 embedding_unknown。 */
  onEmbeddingTimeout(): void;
  /** 重新解析当前目标（工具交付重新 GET；手动链接重新 POST）。 */
  onRefresh(): void;
  /** 关闭面板；自动弹回抑制由装配层记录。 */
  onClose(): void;
  /** 停止该引用拥有的受管 Job（仅工具交付且 canStop 时显示）。 */
  onStop(): void;
}

/** 渲染预览面板：工具栏 + 状态行 + iframe/错误卡；整个页面只挂载这一个 iframe。 */
export default function WorkPreviewPanel({ state, narrow, toolbarRef, onLoad, onEmbeddingTimeout, onRefresh, onClose, onStop }: WorkPreviewPanelProps) {
  const { phase, target, errorMessage } = state;

  /** opening 阶段武装 load 等待上限；目标变化或阶段离开时重置。 */
  useEffect(function armEmbeddingTimeout() {
    if (phase !== "opening") return;
    const timer = window.setTimeout(onEmbeddingTimeout, EMBEDDING_WAIT_MS);
    return function disarm() { window.clearTimeout(timer); };
  }, [phase, onEmbeddingTimeout, target?.navigationUrl]);

  const showIframe = (phase === "opening" || phase === "displayed" || phase === "embedding_unknown") && target !== null;

  return (
    <aside id="work-preview-panel" aria-label="内置预览" className="flex h-full min-h-0 min-w-0 flex-1 flex-col border-2 border-ink bg-card">
      <div ref={toolbarRef} className="flex flex-wrap items-center gap-2 border-b-2 border-ink px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-semibold text-ink" title={target?.hostLabel ?? ""}>{target?.hostLabel ?? "内置预览"}</span>
        <button type="button" onClick={onRefresh} disabled={phase === "resolving"} className="border-2 border-ink px-2 py-1 font-semibold hover:bg-ink hover:text-ink-on-dark disabled:cursor-not-allowed disabled:opacity-50">刷新</button>
        {target?.canStop && <button type="button" onClick={onStop} className="border-2 border-ink px-2 py-1 font-semibold hover:bg-ink hover:text-ink-on-dark">停止服务</button>}
        {target && <a href={target.navigationUrl} target="_blank" rel="noopener noreferrer" className="border-2 border-ink px-2 py-1 font-semibold hover:bg-ink hover:text-ink-on-dark">新标签页 <span aria-hidden="true">↗</span></a>}
        <button type="button" onClick={onClose} className="border-2 border-ink px-2 py-1 font-semibold hover:bg-ink hover:text-ink-on-dark">{narrow ? "返回任务" : "关闭"}</button>
      </div>
      <p role="status" aria-live="polite" className="border-b border-ink/20 px-3 py-1 text-[10px] text-muted">{describeServiceState(state)}</p>
      {phase === "unavailable" ? (
        <div className="flex flex-1 flex-col items-start gap-3 p-4 text-xs" role="alert">
          <p className="font-semibold text-error">{errorMessage || "预览目标当前无法在宿主内打开"}</p>
          {target && <a href={target.navigationUrl} target="_blank" rel="noopener noreferrer" className="border-2 border-ink px-3 py-1.5 font-semibold text-accent hover:bg-ink hover:text-ink-on-dark">在新标签页打开 <span aria-hidden="true">↗</span></a>}
        </div>
      ) : showIframe && target ? (
        <iframe
          src={target.navigationUrl}
          title={`预览：${target.hostLabel}`}
          sandbox={target.sandboxProfile === "trusted_local" ? "allow-scripts allow-same-origin" : "allow-scripts"}
          referrerPolicy="no-referrer"
          onLoad={onLoad}
          className="h-full w-full flex-1 border-0"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-4 text-xs text-muted">正在准备预览…</div>
      )}
    </aside>
  );
}
