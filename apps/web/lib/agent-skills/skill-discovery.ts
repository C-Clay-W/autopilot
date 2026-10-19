/**
 * Web Skill capability 兼容入口；canonical Skill 扫描和加载实现统一位于 @autopilot-agent/adapters。
 */

export { createSkillsCapability } from "@autopilot-agent/adapters";
export type {
  AgentSkillsCapability,
  LoadedSkill,
  PreparedSkillCommand,
  SkillCatalogEntry,
  SkillDiscoveryCandidate,
  SkillResource,
} from "@autopilot-agent/core";
