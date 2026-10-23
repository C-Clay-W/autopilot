/**
 * WorkPreviewLayout.tsx — 预览面板与消息区的行内布局容器。
 *
 * 未打开时保持原 flex-1 单栏；双栏模式复用 DiffSidebarDivider 的指针捕获/rAF/键盘机制，
 * 以会话内存比例控制左栏宽度（右栏用剩余宽度，不累积误差），aria 按百分比上报，
 * 键盘步进为容器可分配宽度的 2%，Home/End 到最小/最大位置。
 * 三个槽位带稳定 key：消息区始终挂载（窄屏只隐藏可见性），面板槽位在宽窄切换时位置不变，
 * 因此切布局不重建 Composer、不迁移/重挂 iframe；只有真正关闭面板才卸载 iframe。
 */

"use client";

import type { ReactNode } from "react";
import DiffSidebarDivider from "./DiffSidebarDivider";
import { clampPreviewLeftWidth, isDualPaneCapable, PREVIEW_DIVIDER_WIDTH, PREVIEW_MIN_WIDTH, previewRatioToWidth, previewWidthToRatio } from "../work-preview-state";

interface WorkPreviewLayoutProps {
  /** 实测内容容器宽度（ResizeObserver 提供）；0 表示尚未测量。 */
  containerWidth: number;
  /** 左栏会话内存比例（0–100）；宽度由此派生，容器变化时比例不变。 */
  leftRatio: number;
  /** 左栏比例变更回调（拖动/键盘）；父布局写入会话内存。 */
  onLeftRatioChange(ratio: number): void;
  /** 预览面板是否打开；关闭时保持原 flex-1 单栏行为。 */
  active: boolean;
  /** 窄屏单栏：容器不足 648px 时隐藏消息区，保留其组件状态。 */
  narrow: boolean;
  /** 右栏面板节点（WorkPreviewPanel）；active 为 false 时忽略。 */
  panel: ReactNode;
  /** 左栏内容（消息列表与输入区）。 */
  children: ReactNode;
}

/** 渲染消息区与预览面板的行内布局；Diff 打开时本组件保持未打开形态，Diff 面板由外层渲染。 */
export default function WorkPreviewLayout({ containerWidth, leftRatio, onLeftRatioChange, active, narrow, panel, children }: WorkPreviewLayoutProps) {
  const dual = active && !narrow && isDualPaneCapable(containerWidth);
  const leftWidth = dual ? clampPreviewLeftWidth(previewRatioToWidth(leftRatio, containerWidth), containerWidth) : 0;
  const bounds = { minPx: PREVIEW_MIN_WIDTH, maxPx: containerWidth - PREVIEW_DIVIDER_WIDTH - PREVIEW_MIN_WIDTH };
  const percent = {
    now: previewWidthToRatio(leftWidth, containerWidth),
    min: previewWidthToRatio(bounds.minPx, containerWidth),
    max: previewWidthToRatio(bounds.maxPx, containerWidth),
  };
  return (
    <>
      {/* 消息区恒定挂载：窄屏用 hidden 属性隐藏可见性，Composer 草稿与消息阅读位置不因布局切换丢失。 */}
      <div key="messages" hidden={active && !dual} className={dual ? "flex min-h-0 min-w-0 flex-col shrink-0" : "flex min-h-0 min-w-0 flex-1 flex-col"} style={dual ? { width: leftWidth } : undefined}>
        {children}
      </div>
      {dual && (
        <DiffSidebarDivider
          key="divider"
          width={leftWidth}
          onChange={function changeLeftWidth(nextWidth) { onLeftRatioChange(previewWidthToRatio(nextWidth, containerWidth)); }}
          label="调整预览区域宽度"
          stepPx={Math.max(8, Math.round((containerWidth - PREVIEW_DIVIDER_WIDTH) * 0.02))}
          widenOn="right"
          bounds={bounds}
          ariaValue={percent}
          viewportGated={false}
        />
      )}
      {active && <div key="panel" className="flex min-h-0 min-w-0 flex-1 flex-col">{panel}</div>}
    </>
  );
}
