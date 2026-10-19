/** Work Session 后台 Job 列表 Route。 */

import { listWebWorkspaceJobs } from "@/lib/workspace-host/web-workspace-jobs";

/** 返回当前可写 Work Session 的有限安全 Job 摘要。 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string }> }) {
  return listWebWorkspaceJobs(request, params);
}
