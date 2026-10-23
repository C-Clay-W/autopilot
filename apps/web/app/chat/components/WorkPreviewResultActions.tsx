/**
 * WorkPreviewResultActions.tsx — 本轮结果尾部的预览入口与复制链接。
 *
 * 仅在 Work 且存在已成功交付预览事实时渲染一次，位于最终正文之后、Turn Summary 之前；
 * 只消费安全交付 DTO（previewId/hostLabel/copyUrl），不读 raw tool output。
 */

"use client";

import { useEffect, useState } from "react";
import type { TurnPreviewDelivery } from "../work-preview-state";

interface WorkPreviewResultActionsProps {
  /** 本轮最后一条已成功交付的预览安全事实。 */
  delivery: TurnPreviewDelivery;
  /** 面板当前是否正显示本结果的 previewId。 */
  open: boolean;
  /** 本结果的导航请求仍在进行中，按钮进入 busy。 */
  busy: boolean;
  /** 切换侧栏到本结果或关闭本结果面板。 */
  onToggle(): void;
}

/** 渲染切换按钮、完整 copyUrl 与复制按钮；复制内容严格等于实际页面地址。 */
export default function WorkPreviewResultActions({ delivery, open, busy, onToggle }: WorkPreviewResultActionsProps) {
  const [copied, setCopied] = useState(false);
  /** 复制反馈 1.6 秒后复位，卸载时清理计时器。 */
  useEffect(function resetCopiedFeedback() {
    if (!copied) return;
    const timer = window.setTimeout(function reset() { setCopied(false); }, 1600);
    return function cleanup() { window.clearTimeout(timer); };
  }, [copied]);

  /** 仅在用户点击时写入剪贴板；失败保留可选择文本与手动复制提示。 */
  async function copyLink(): Promise<void> {
    try {
      if (!navigator.clipboard) throw new Error("CLIPBOARD_UNAVAILABLE");
      await navigator.clipboard.writeText(delivery.copyUrl);
      setCopied(true);
    } catch {
      setCopied(false);
      window.alert("复制失败，请选中链接手动复制");
    }
  }

  return (
    <section className="mt-3 border-t-2 border-ink pt-2 text-xs" data-preview-delivery={delivery.previewId}>
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        aria-expanded={open}
        aria-controls="work-preview-panel"
        className="border-2 border-ink bg-card px-3 py-1.5 font-semibold text-ink hover:bg-ink hover:text-ink-on-dark disabled:cursor-not-allowed disabled:opacity-50"
      >
        {open ? "关闭预览" : "打开预览"}
      </button>
      <p className="mt-2 break-all text-muted" data-testid="preview-copy-url">{delivery.copyUrl}</p>
      <button type="button" onClick={function copyPreview() { void copyLink(); }} className="mt-1 border-2 border-ink px-2 py-0.5 font-semibold hover:bg-ink hover:text-ink-on-dark">
        {copied ? "已复制" : "复制链接"}
      </button>
      {copied && <span className="ml-2 text-muted">已复制</span>}
    </section>
  );
}
