/** Web Agent 活动提示：复用 CLI 的离散帧语义，为等待下一事件提供稳定可见反馈。 */
"use client";

import { useEffect, useState } from "react";
import type { ActiveOperation } from "@autopilot-agent/presentation";
import { resolveWebActivityView, type WebActivityState } from "../../../lib/runtime-host/web-activity";

const ACTIVITY_FRAMES = ["·", "✢", "*", "✶", "✻", "✽", "✽", "✻", "✶", "*", "✢", "·"] as const;
const ACTIVITY_FRAME_MS = 120;
const TOOL_TRANSITION_MS = 2_000;

interface ActivityIndicatorProps {
  variant?: "status" | "scan";
  activeOperation?: ActiveOperation;
  toolStartedAt?: string;
  activity?: WebActivityState;
  running: boolean;
  startedAt?: number;
  elapsedMs?: number;
  runningSince?: number;
  resuming?: boolean;
}

/** 依据共享活动状态选择稳定文案；组件不读取模型原始文本。 */
function getActivityLabel(activeOperation: ActiveOperation | undefined, toolStartedAt?: string): string {
  if (activeOperation?.kind === "approval") return "等待授权";
  if (activeOperation?.kind === "context") return "正在整理上下文";
  if (activeOperation?.kind === "tool") {
    const startedAt = toolStartedAt ? Date.parse(toolStartedAt) : Number.NaN;
    return Number.isFinite(startedAt) && Date.now() - startedAt < TOOL_TRANSITION_MS ? "正在启动工具" : "正在等待工具结果";
  }
  if (activeOperation?.kind === "thinking") return "正在分析下一步";
  return "正在等待下一步事件";
}

/** 渲染与 CLI 相同的固定宽度离散活动帧；降低动态偏好时保留静态提示。 */
export default function ActivityIndicator({ variant = "status", activeOperation, toolStartedAt, activity, running, startedAt, elapsedMs, runningSince, resuming }: ActivityIndicatorProps) {
  const [now, setNow] = useState(function getInitialTime() { return Date.now(); });
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(function observeMotionPreference() {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    function updatePreference(): void {
      setReducedMotion(media.matches);
    }
    updatePreference();
    media.addEventListener("change", updatePreference);
    return function stopObservingMotionPreference(): void {
      media.removeEventListener("change", updatePreference);
    };
  }, []);

  useEffect(function advanceActivityFrame() {
    if (!running) return;
    const timer = window.setInterval(function updateActivityTime() { setNow(Date.now()); }, reducedMotion ? 1000 : ACTIVITY_FRAME_MS);
    return function stopActivityFrame() {
      window.clearInterval(timer);
    };
  }, [reducedMotion, running]);

  if (!running) return null;
  if (variant === "scan") return <span className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true"><span className="knowledge-ingest-sweep block h-full w-1/4 bg-accent/10" /></span>;
  const view = activity ? resolveWebActivityView({ activity, running, now }) : undefined;
  if (activity && !view) return null;
  const frame = reducedMotion ? "·" : ACTIVITY_FRAMES[Math.floor(now / ACTIVITY_FRAME_MS) % ACTIVITY_FRAMES.length];
  const label = resuming ? "正在恢复" : activeOperation?.kind === "approval" ? "等待授权" : activeOperation?.kind === "question" ? "等待回答" : view?.label ?? getActivityLabel(activeOperation, toolStartedAt);
  const progressTail = activity?.progressTail;
  const duration = elapsedMs === undefined ? undefined : elapsedMs + (runningSince === undefined || resuming ? 0 : Math.max(0, now - runningSince));
  const seconds = duration === undefined ? undefined : Math.floor(duration / 1000);
  const elapsed = seconds === undefined ? undefined : seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return <p className="mt-2 flex items-center gap-2 text-xs text-muted" role="status" aria-live="polite"><span className="inline-block w-3 text-center text-accent" aria-hidden="true">{frame}</span><span>{label}{elapsed ? ` · ${elapsed}` : ""}{progressTail ? ` · ${progressTail}` : ""}</span></p>;
}
