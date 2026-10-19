/** Work Session 后台 Job 显式停止 Route。 */

import { stopWebWorkspaceJob } from "@/lib/workspace-host/web-workspace-jobs";

/** 接受严格空对象并停止当前 Runtime 持有的指定 Job。 */
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string; jobId: string }> }) {
  return stopWebWorkspaceJob(request, params);
}
