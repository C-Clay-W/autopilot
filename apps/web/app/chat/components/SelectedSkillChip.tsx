/**
 * 已选 Skill 标签：在输入区明确显示本轮注入项，并允许取消或切换跨 Turn 固定状态。
 */
"use client";

interface SelectedSkillChipProps {
  name: string;
  pinned?: boolean;
  onRemove: () => void;
  onTogglePin: () => void;
}

/** 渲染一枚可移除、可固定的直角 Skill Chip。 */
export default function SelectedSkillChip({ name, pinned = false, onRemove, onTogglePin }: SelectedSkillChipProps) {
  return (
    <span className={`inline-flex items-center gap-1 border-2 border-ink px-2 py-1 text-xs ${pinned ? "bg-accent text-ink-on-dark" : "bg-card"}`}>
      <span>{pinned ? "📌 " : ""}{name}</span>
      <button type="button" onClick={onTogglePin} className="border-l border-ink/40 pl-1" title={pinned ? "取消固定" : "固定 Skill"}>{pinned ? "取消固定" : "固定"}</button>
      <button type="button" onClick={onRemove} className="border-l border-ink/40 pl-1" title="移除 Skill">×</button>
    </span>
  );
}
