/**
 * Skill 工具：让 Agent 按需取得应用层已经校验过的 Skill 正文或资源，不直接访问用户文件系统。
 */
import { z } from "zod";
import type { AgentToolDefinition } from "../types";
import type { SkillDiscoveryCapability } from "./discover-skills-tool";
export type { SkillDiscoveryCandidate } from "./discover-skills-tool";

export interface SkillCatalogEntry {
  skillId: string;
  qualifiedName: string;
  name: string;
  description: string;
  source: string;
  allowedTools?: string[];
  displayName?: string;
  modelInvocable?: boolean;
  userInvocable?: boolean;
  argumentHint?: string;
  whenToUse?: string;
}

export interface LoadedSkill {
  skillId: string;
  contentHash: string;
  content: string;
  allowedTools?: string[];
}

export interface SkillResource {
  skillId: string;
  relativePath: string;
  content: string;
}

export interface PreparedSkillCommand {
  skillId: string;
  program: string;
  args: string[];
  cwd: string;
}

export interface AgentSkillsCapability extends SkillDiscoveryCapability {
  catalog: SkillCatalogEntry[];
  loadSkill(request: { skill: string }): Promise<LoadedSkill>;
  readResource(request: { skill: string; relativePath: string }): Promise<SkillResource>;
  prepareScript(request: { skill: string; relativePath: string; args: string[] }): Promise<PreparedSkillCommand>;
}

const skillInputSchema = z.object({
  action: z.enum(["load", "read_resource", "prepare_script"]),
  skill: z.string().min(1).max(256).describe("Skill 名称，即系统提示中列出的名称；唯一名称可直接传入，例如 test-math-task。同名 Skill 才传入 repo:skill-name 或 user:skill-name"),
  relativePath: z.string().min(1).max(512).optional(),
  args: z.array(z.string().max(4_000)).max(50).optional(),
}).strict();

/** 创建按需加载 Skill 的只读工具；准备脚本不会执行，仍需后续 run_command 审批。 */
export function createSkillTool(capability: AgentSkillsCapability): AgentToolDefinition<z.infer<typeof skillInputSchema>, LoadedSkill | SkillResource | PreparedSkillCommand> {
  return {
    name: "skill",
    description: "按需加载已发现 Skill 的正文或资源，或准备脚本命令；脚本仍必须通过 run_command 执行并接受原有审批。",
    inputSchema: skillInputSchema,
    metadata: { effect: "dynamic", destructive: false, concurrency: { max: 1, resourceKey: "skills:resource" }, retry: { safe: false } },
    createActionFacts: () => ({ toolName: "skill", effect: "none", destructive: false, operation: "read_capability", risk: "read_only" }),
    async execute(input) {
      const catalogSkill = capability.catalog.find((item) => item.qualifiedName === input.skill || item.skillId === input.skill || item.name === input.skill);
      if (input.action === "load" && !catalogSkill?.modelInvocable) throw new Error("该 Skill 仅允许用户显式选择后加载");
      if (input.action === "load") return capability.loadSkill({ skill: input.skill });
      if (!input.relativePath) throw new Error("读取资源或准备脚本必须提供 relativePath");
      if (input.action === "read_resource") return capability.readResource({ skill: input.skill, relativePath: input.relativePath });
      return capability.prepareScript({ skill: input.skill, relativePath: input.relativePath, args: input.args ?? [] });
    },
    serializeOutput(output) { return output; },
  };
}
