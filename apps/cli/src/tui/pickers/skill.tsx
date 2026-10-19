/** Skill 选择器：按展示名、canonical 名称和说明筛选，方向键/空格/搜索操作。 */

import { type ReactNode } from "react";
import { Box, Text } from "ink";
import type { CliSkillSummary } from "../../types.js";
import { TUI_ACCENT_COLOR, TUI_SKILL_OFF_COLOR, TUI_SKILL_ON_COLOR } from "../../design-tokens.js";

/** 以展示名、canonical 名称和说明筛选 TUI 内已脱敏的 Skill 摘要。 */
export function filterTuiSkills(skills: CliSkillSummary[], query: string): CliSkillSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return skills;
  return skills.filter(function matchesSkill(skill) {
    return `${skill.displayName}\n${skill.qualifiedName}\n${skill.description}`.toLocaleLowerCase().includes(normalizedQuery);
  });
}

/** 渲染可用方向键、空格开关和搜索操作的 Skill 选择器。 */
export function TuiSkillPicker(props: { skills: CliSkillSummary[]; query: string; selectedIndex: number; useColor: boolean; screenReader: boolean }): ReactNode {
  const filteredSkills = filterTuiSkills(props.skills, props.query);
  const selectedIndex = Math.max(0, Math.min(props.selectedIndex, Math.max(0, filteredSkills.length - 1)));
  const firstVisibleIndex = Math.max(0, Math.min(selectedIndex - 3, Math.max(0, filteredSkills.length - 8)));
  const visibleSkills = filteredSkills.slice(firstVisibleIndex, firstVisibleIndex + 8);
  const selectedSkill = filteredSkills[selectedIndex];
  return (
    <Box marginTop={1} borderStyle="single" borderColor={props.useColor ? TUI_ACCENT_COLOR : undefined} paddingX={1} flexDirection="column" aria-role="listbox">
      <Text bold color={props.useColor ? TUI_ACCENT_COLOR : undefined}>Skills</Text>
      <Text dimColor={props.useColor}>↑↓ select · Space on/off · Enter save · type or / to search · Esc cancel</Text>
      <Box borderStyle="single" marginTop={1} paddingX={1} aria-role="textbox">
        <Text>Search: {props.query}</Text><Text color={props.useColor ? TUI_ACCENT_COLOR : undefined}>▏</Text>
      </Box>
      {visibleSkills.length === 0 ? <Text dimColor={props.useColor}>no matching skills</Text> : visibleSkills.map(function renderSkill(skill, visibleIndex) {
        const index = firstVisibleIndex + visibleIndex;
        const selected = index === selectedIndex;
        return <Text key={skill.qualifiedName} bold={selected} color={selected && props.useColor ? TUI_ACCENT_COLOR : undefined}>{selected ? "› " : "  "}<Text color={props.useColor ? skill.selected ? TUI_SKILL_ON_COLOR : TUI_SKILL_OFF_COLOR : undefined}>[{skill.selected ? "on" : "off"}]</Text> {skill.displayName} · {skill.qualifiedName}</Text>;
      })}
      {selectedSkill?.description ? <Text dimColor={props.useColor}>  {selectedSkill.description}</Text> : null}
      <Text dimColor={props.useColor}>{filteredSkills.length === 0 ? "0 skills" : `${selectedIndex + 1}/${filteredSkills.length} skills`}{props.screenReader ? " · skill selector" : ""}</Text>
    </Box>
  );
}
