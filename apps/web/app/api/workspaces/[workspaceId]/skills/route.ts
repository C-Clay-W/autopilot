/** 工作区 Skill catalog：验证 Registry/Trust 后复用既有受控发现与响应。 */
import { GET as getSkills } from "@/app/api/skills/route";
import { requireWorkspaceSession, runWithWorkspaceRequestContext } from "@/lib/workspace-host/web-workspace-session";
import { toWorkspaceErrorResponse } from "@/lib/workspace-host/web-workspace-server";

/** 只允许读取明确选择且受信任的工作区目录，不从 cwd 代选。 */
export async function GET(_request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const context = await requireWorkspaceSession((await params).workspaceId);
    return await runWithWorkspaceRequestContext(context, getSkills);
  } catch (error) { return toWorkspaceErrorResponse(error); }
}
