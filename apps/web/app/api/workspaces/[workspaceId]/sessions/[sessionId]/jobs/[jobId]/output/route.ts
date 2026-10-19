/** Work Session 后台 Job 安全输出 Route。 */

import { readWebWorkspaceJobOutput } from "@/lib/workspace-host/web-workspace-jobs";

/** 返回指定 Job 的有限增量 stdout/stderr，不允许 Web 长等待。 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string; sessionId: string; jobId: string }> }) {
  return readWebWorkspaceJobOutput(request, params);
}
