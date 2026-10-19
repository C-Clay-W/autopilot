/**
 * discover_skills 工具：按任务描述返回应用层已发现 Skill 的规范调用名，不加载正文也不访问文件系统。
 */
import { z } from "zod";
import type { AgentToolDefinition } from "../types";

export interface SkillDiscoveryCandidate {
  skill: string;
  description: string;
}

export interface SkillDiscoveryCapability {
  discoverSkills(request: { query: string; limit: number }): Promise<SkillDiscoveryCandidate[]>;
}

const discoverSkillsSchema = z.object({
  query: z.string().trim().min(1).max(4_000).describe("当前要完成的任务描述，用于发现可能相关的 Skill"),
  limit: z.number().int().min(1).max(5).default(3).describe("最多返回的候选数量"),
}).strict();

/** 创建 Claude Code 风格的按需 Skill 候选发现工具；返回的 skill 可直接传给 skill 工具。 */
export function createDiscoverSkillsTool(capability: SkillDiscoveryCapability): AgentToolDefinition<z.infer<typeof discoverSkillsSchema>, SkillDiscoveryCandidate[]> {
  return {
    name: "discover_skills",
    description: "按当前任务发现相关 Skills，返回可直接传给 skill 工具的规范名称；用于任务转向或当前可用 Skill 不明确时。",
    inputSchema: discoverSkillsSchema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 1, resourceKey: "skills:catalog" }, retry: { safe: false } },
    createActionFacts: () => ({ toolName: "discover_skills", effect: "none", destructive: false, operation: "discover", risk: "read_only" }),
    async execute(input) { return capability.discoverSkills(input); },
    serializeOutput(output) { return output; },
  };
}
