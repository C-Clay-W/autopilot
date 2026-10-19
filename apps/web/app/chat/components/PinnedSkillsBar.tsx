/**
 * 会话固定 Skill 提示条：让跨 Turn 生效的上下文在对话开始前保持可见且可撤销。
 */
"use client";

interface PinnedSkill {
  skillRef: string;
  name: string;
}

interface PinnedSkillsBarProps {
  skills: PinnedSkill[];
  onUnpin: (skillRef: string) => void;
}

/** 渲染当前会话持久化的 Skill 列表。 */
export default function PinnedSkillsBar({ skills, onUnpin }: PinnedSkillsBarProps) {
  if (!skills.length) return null;
  return (
    <div className="border-l-4 border-accent bg-accent/10 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">本会话固定 Skill</span>
        {skills.map((skill) => (
          <span key={skill.skillRef} className="inline-flex items-center gap-1 border border-ink bg-card px-2 py-1">
            📌 {skill.name}
            <button type="button" onClick={() => onUnpin(skill.skillRef)} className="border-l border-ink/40 pl-1 hover:text-accent" title="取消固定">×</button>
          </span>
        ))}
      </div>
    </div>
  );
}
