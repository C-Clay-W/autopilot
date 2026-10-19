/** Work Session 单个后台 Job 摘要 Route。 */

import { readWebWorkspaceJob } from "@/lib/workspace-host/web-workspace-jobs";

/** 返回当前会话中指定 Job 的安全摘要。 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string; jobId: string }> }) {
  return readWebWorkspaceJob(request, params);
}
