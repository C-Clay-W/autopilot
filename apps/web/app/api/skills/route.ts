/**
 * Skill catalog 接口：只返回受控发现结果的轻量元数据，不泄露 Skill 正文或真实路径。
 */
import { NextResponse } from "next/server";
import { createSkillsCapability } from "@/lib/agent-skills/skill-discovery";
import { getAgentWorkspaceRoot } from "@/lib/agent-workspace";
import { rejectUnscopedWorkRequest } from "@/lib/workspace-host/work-route-boundary";

/** 获取当前工作区可供用户显式选择的 Skill catalog。 */
export async function GET() {
  const rejected = rejectUnscopedWorkRequest();
  if (rejected) return rejected;
  const capability = createSkillsCapability(getAgentWorkspaceRoot());
  return NextResponse.json({ skills: capability?.catalog ?? [] });
}
