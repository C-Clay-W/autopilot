/** Work HTTP 边界：旧无作用域入口不可从 cwd 代选工作区，旧知识入口统一退休。 */
import { workSessionErrorResponse } from "./work-session-error";
import { getWorkspaceRequestContext } from "./web-workspace-session";

/** canonical Route 已校验的异步上下文是旧处理器唯一允许的调用来源。 */
export function rejectUnscopedWorkRequest(): Response | undefined {
  if (getWorkspaceRequestContext()) return undefined;
  return workSessionErrorResponse("WORKSPACE_REQUIRED");
}

/** 退休接口保留方法契约，但不初始化 Host、解析请求、访问知识文件或转发到 Chat。 */
export function workKnowledgeUnavailable(): Response {
  return workSessionErrorResponse("WORK_KNOWLEDGE_UNAVAILABLE");
}
