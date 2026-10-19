/**
 * Skill 选择器：在浏览器端搜索轻量 catalog，仅将用户选中的限定名交给会话消息接口。
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import SkillOption, { type SkillOptionEntry } from "./SkillOption";

interface SkillPickerProps {
  open: boolean;
  skills: SkillOptionEntry[];
  selectedSkillRefs: string[];
  pinnedSkillRefs: string[];
  onSelect: (skillRef: string) => void;
  onTogglePin: (skillRef: string) => void;
  onClose: () => void;
}

/** 根据显示名、调用名、描述和来源过滤轻量 catalog。 */
function filterSkills(skills: SkillOptionEntry[], query: string): SkillOptionEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return skills;
  return skills.filter((skill) => [skill.displayName, skill.name, skill.qualifiedName, skill.description, skill.source].filter(Boolean).some((value) => value!.toLocaleLowerCase().includes(normalized)));
}

/** 渲染支持搜索和键盘导航的 Skill 选择弹窗。 */
export default function SkillPicker({ open, skills, selectedSkillRefs, pinnedSkillRefs, onSelect, onTogglePin, onClose }: SkillPickerProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const filteredSkills = useMemo(() => filterSkills(skills, query), [skills, query]);

  useEffect(function focusSkillSearch() {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗开启时重置其局部交互状态。
    setQuery("");
    setActiveIndex(0);
    window.requestAnimationFrame(function focusInput() { inputRef.current?.focus(); });
  }, [open]);

  /** 处理 Escape、方向键与 Enter，保证鼠标不可用时也能完成选择。 */
  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
    if (!filteredSkills.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(function nextIndex(index) { return (index + 1) % filteredSkills.length; });
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(function previousIndex(index) { return (index - 1 + filteredSkills.length) % filteredSkills.length; });
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onSelect(filteredSkills[activeIndex].qualifiedName);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/80 p-6 pt-24" role="dialog" aria-modal="true" aria-label="选择 Skill" onMouseDown={onClose}>
      <section className="w-full max-w-2xl border-[3px] border-ink bg-card p-4" onMouseDown={function stopClose(event) { event.stopPropagation(); }}>
        <div className="flex items-center justify-between gap-3 border-b-2 border-ink pb-3">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-accent">Agent Skills</p>
            <h2 className="mt-1 text-lg font-bold">选择 Skill</h2>
          </div>
          <button type="button" onClick={onClose} className="border-2 border-ink px-2 py-1 text-xs hover:bg-ink hover:text-ink-on-dark">关闭</button>
        </div>
        <input ref={inputRef} value={query} onChange={function updateQuery(event) { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={handleKeyDown} placeholder="搜索名称、描述或来源…" className="mt-4 w-full border-2 border-ink bg-bg px-3 py-2 text-sm outline-none" />
        <div className="mt-3 max-h-[55vh] overflow-y-auto border-2 border-ink">
          {filteredSkills.length ? filteredSkills.map((skill, index) => <SkillOption key={skill.qualifiedName} skill={skill} active={index === activeIndex} selected={selectedSkillRefs.includes(skill.qualifiedName)} pinned={pinnedSkillRefs.includes(skill.qualifiedName)} onSelect={function selectSkill() { onSelect(skill.qualifiedName); }} onTogglePin={function togglePin() { onTogglePin(skill.qualifiedName); }} />) : <p className="px-3 py-6 text-center text-xs text-muted">没有匹配的 Skill。</p>}
        </div>
      </section>
    </div>
  );
}
