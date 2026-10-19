/**
 * Skill 选择器单项：展示轻量 catalog 信息，并提供选择与固定两个独立操作。
 */
"use client";

export interface SkillOptionEntry {
  qualifiedName: string;
  name: string;
  description: string;
  source: string;
  displayName?: string;
  argumentHint?: string;
  allowedTools?: string[];
}

interface SkillOptionProps {
  skill: SkillOptionEntry;
  selected: boolean;
  pinned: boolean;
  active: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
}

/** 渲染一个可键盘聚焦的 Skill 目录项。 */
export default function SkillOption({ skill, selected, pinned, active, onSelect, onTogglePin }: SkillOptionProps) {
  return (
    <div className={`flex items-start gap-2 border-b border-ink/20 px-3 py-3 ${active ? "bg-ink/10" : ""}`}>
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">{skill.displayName || skill.name}</span>
          <span className="text-[10px] text-muted">{skill.source}</span>
          {selected && <span className="border border-accent px-1 text-[10px] text-accent">已选</span>}
        </div>
        <p className="mt-1 text-xs text-muted">{skill.description}</p>
        <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
          {skill.argumentHint && <span className="border border-ink px-1 text-muted">{skill.argumentHint}</span>}
          {skill.allowedTools?.map((tool) => <span key={tool} className="border border-ink/20 px-1 text-muted">{tool}</span>)}
        </div>
      </button>
      <button type="button" onClick={onTogglePin} className={`shrink-0 border-2 border-ink px-2 py-1 text-[10px] ${pinned ? "bg-accent text-ink-on-dark" : "hover:bg-ink hover:text-ink-on-dark"}`} aria-label={`${pinned ? "取消固定" : "固定"}${skill.displayName || skill.name}`}>
        {pinned ? "固定中" : "固定"}
      </button>
    </div>
  );
}
