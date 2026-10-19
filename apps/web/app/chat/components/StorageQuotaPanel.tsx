/**
 * Agent 存储配额面板：展示本机服务端全局用量，并允许用户修改经过服务端边界校验的上限。
 */
"use client";

import { useState } from "react";

export interface AgentStorageQuotaView {
  usedBytes: number;
  status: "healthy" | "warning" | "degraded";
  hardLimit: number;
  softLimit: number;
  targetLimit: number;
  minHardLimit: number;
  maxHardLimit: number;
}

interface StorageQuotaPanelProps {
  open: boolean;
  quota: AgentStorageQuotaView;
  onClose: () => void;
  onUpdated: (quota: AgentStorageQuotaView) => void;
}

/** 将字节数格式化为 UI 易读单位，避免用户根据原始整数判断存储水位。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 以 GiB 编辑硬上限，提交时再转换为整数字节，避免浏览器浮点误差写入服务端。 */
function toGiB(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(2);
}

/** 存储状态对应的用户提示；warning 表示即将触发归档回收，degraded 表示非必要 Memory 写入会被拒绝。 */
function getStatusMessage(status: AgentStorageQuotaView["status"]): string {
  if (status === "warning") return "存储接近上限；后续写入可能回收最早的已归档会话。";
  if (status === "degraded") return "存储已达到上限；非必要长期记忆写入已被拒绝。";
  return "存储空间充足。";
}

/** 展示并更新全局配额设置；关闭时不保留未保存输入，避免把浏览器草稿误当成服务端配置。 */
export default function StorageQuotaPanel({ open, quota, onClose, onUpdated }: StorageQuotaPanelProps) {
  const [hardLimitGiB, setHardLimitGiB] = useState(function initializeHardLimit() { return toGiB(quota.hardLimit); });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  /** 将输入上限提交到受控 API；服务端仍负责范围校验和最终状态计算。 */
  async function saveHardLimit(): Promise<void> {
    const hardLimit = Math.round(Number(hardLimitGiB) * 1024 * 1024 * 1024);
    if (!Number.isSafeInteger(hardLimit)) {
      setError("请输入有效的 GiB 数值");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/agent-storage", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hardLimit }) });
      console.log(response);
      const data = await response.json() as AgentStorageQuotaView & { error?: string };
      if (!response.ok) throw new Error(data.error || "保存存储上限失败");
      onUpdated(data);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存存储上限失败");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-6" role="dialog" aria-modal="true" aria-label="Agent 存储设置" onMouseDown={onClose}>
      <div className="w-full max-w-md border-[3px] border-ink bg-card p-4" onMouseDown={function stopPanelClose(event) { event.stopPropagation(); }}>
        <div className="flex items-center justify-between gap-4 border-b-2 border-ink pb-2 text-sm font-semibold">
          <span>Agent 存储</span>
          <button type="button" onClick={onClose} className="border-2 border-ink px-2 py-1 text-xs hover:bg-ink hover:text-ink-on-dark">关闭</button>
        </div>
        <p className={`mt-3 border-l-4 px-3 py-2 text-xs ${quota.status === "healthy" ? "border-ink bg-ink/5" : "border-accent bg-accent/10"}`}>{getStatusMessage(quota.status)}</p>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <dt className="text-muted">已用</dt><dd className="text-right">{formatBytes(quota.usedBytes)}</dd>
          <dt className="text-muted">当前上限</dt><dd className="text-right">{formatBytes(quota.hardLimit)}</dd>
          <dt className="text-muted">预警水位</dt><dd className="text-right">{formatBytes(quota.softLimit)}</dd>
        </dl>
        <label className="mt-4 block text-xs font-semibold" htmlFor="agent-storage-limit">全局上限（GiB）</label>
        <input id="agent-storage-limit" type="number" min={quota.minHardLimit / 1024 / 1024 / 1024} max={quota.maxHardLimit / 1024 / 1024 / 1024} step="0.01" value={hardLimitGiB} onChange={function changeHardLimit(event) { setHardLimitGiB(event.target.value); }} className="mt-1 w-full border-2 border-ink bg-card px-3 py-2 text-sm outline-none" />
        <p className="mt-1 text-xs text-muted">允许范围：{formatBytes(quota.minHardLimit)}–{formatBytes(quota.maxHardLimit)}。设置低于当前用量后，后续写入会按现有规则回收归档会话。</p>
        {error && <p className="mt-3 text-xs text-accent">{error}</p>}
        <button type="button" onClick={function submitHardLimit() { void saveHardLimit(); }} disabled={saving} className="mt-4 w-full border-2 border-ink bg-ink px-3 py-2 text-sm font-semibold text-ink-on-dark hover:bg-accent disabled:bg-muted">{saving ? "保存中…" : "保存上限"}</button>
      </div>
    </div>
  );
}
