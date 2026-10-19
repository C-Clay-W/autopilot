/**
 * 可折叠的思维链面板：默认折叠，展示回答过程中的步骤列表。
 * 参照 Claude Code 的 tool result 展示模式——默认收起，点击展开查看详情。
 */
"use client";

import { useState } from "react";
import type { ProcessStep } from "./process-step";

interface ChainOfThoughtProps {
  steps: ProcessStep[];
}

/** 隐藏历史会话中重复持久化的相同文案，兼容旧版本仅相邻去重的记录。 */
function getUniqueVisibleSteps(steps: ProcessStep[]): ProcessStep[] {
  const messages = new Set<string>();
  return steps.filter((step) => {
    if (step.diffContent || messages.has(step.message)) return false;
    messages.add(step.message);
    return true;
  });
}

/** 渲染可折叠的 Agent 执行过程。 */
export default function ChainOfThought({ steps }: ChainOfThoughtProps) {
  const [open, setOpen] = useState(false);
  const visibleSteps = getUniqueVisibleSteps(steps);

  if (visibleSteps.length === 0) return null;

  return (
    <div className="mt-3 border-2 border-ink bg-card mb-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold hover:bg-ink/10"
      >
        <span className="text-accent text-[1.3em]">{open ? "▾" : "▸"}</span>
        <span className="text-ink font-semibold">
          思考过程 (共 {visibleSteps.length} 步){!open && " · 展开"}
        </span>
      </button>
      {open && (
        <div className="border-t border-ink/20 px-3 py-2 space-y-1 text-[10px] text-muted">
          {visibleSteps.map((step, index) => (
            <p key={step.stage}>
              <span className="mr-2 text-accent">{String(index + 1).padStart(2, "0")}</span>
              {step.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
