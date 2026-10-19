/** Work 会话 HTTP 错误映射：保留已知业务码，领域类与 Runtime 生命周期保持原有归属。 */
import { loadCore } from "../core-loader";
import { findHttpFailure, httpErrorResponse, readHttpErrorCode } from "../runtime-host/web-http-error";

const WORK_HTTP_FAILURES = {
  WORKSPACE_REQUIRED: { status: 400, message: "请先选择并信任工作区，再使用工作区任务入口" },
  WORKSPACE_NOT_TRUSTED: { status: 403, message: "工作区尚未获得信任" },
  WORK_KNOWLEDGE_UNAVAILABLE: { status: 410, message: "Work 不再提供私有知识库能力，请使用 Chat RAG" },
  WORK_HISTORY_READ_ONLY: { status: 409, message: "旧任务上下文来源未验证，仅可查看；请创建新的 Work 任务" },
  INVALID_SESSION_ID: { status: 400, message: "会话标识无效" },
  INVALID_SESSION_REQUEST: { status: 400, message: "会话请求无效" },
  INVALID_INPUT: { status: 400, message: "任务输入无效" },
  SESSION_NOT_FOUND: { status: 404, message: "会话不存在或不属于当前工作区" },
  WORKSPACE_SESSION_NOT_FOUND: { status: 404, message: "会话不存在或不属于当前工作区" },
  TURN_NOT_FOUND: { status: 404, message: "任务不存在或不属于当前会话" },
  TURN_NOT_CANCELLABLE: { status: 409, message: "当前任务没有可取消的活动执行" },
  PERMISSION_GRANT_NOT_FOUND: { status: 404, message: "授权不存在或已撤销" },
  TURN_NOT_RESUMABLE: { status: 409, message: "当前任务不可继续" },
  TURN_ALREADY_RUNNING: { status: 409, message: "当前任务仍在运行" },
  QUEUE_START_IN_PROGRESS: { status: 409, message: "排队任务正在启动" },
  active_turn_finished: { status: 409, message: "前一个任务已经结束，请重新发送当前输入" },
  APPROVAL_NOT_FOUND: { status: 404, message: "审批不存在" },
  APPROVAL_MISMATCH: { status: 409, message: "审批已失效或不属于当前任务" },
  APPROVAL_ALREADY_SUBMITTED: { status: 409, message: "审批决定已提交" },
  QUESTION_NOT_FOUND: { status: 404, message: "问题不存在" },
  QUESTION_ALREADY_ANSWERED: { status: 409, message: "问题已回答，不能重复提交不同答案" },
  QUESTION_ANSWER_INVALID: { status: 400, message: "问题答案无效" },
  QUESTION_TURN_STATE_INVALID: { status: 409, message: "当前任务状态不允许提交答案" },
  WORK_ATTACHMENT_INVALID: { status: 400, message: "图片附件无效，请检查标识、类型和大小" },
  WORK_ATTACHMENT_NOT_FOUND: { status: 404, message: "图片附件不存在或不属于当前会话" },
  WORK_REQUEST_ORIGIN_INVALID: { status: 403, message: "后台任务请求来源无效" },
  JOB_INPUT_INVALID: { status: 400, message: "后台任务请求参数无效" },
  JOB_CURSOR_INVALID: { status: 400, message: "后台任务游标无效或已过期" },
  JOB_NOT_FOUND: { status: 404, message: "后台任务不存在或不属于当前会话" },
  JOB_OWNER_UNAVAILABLE: { status: 409, message: "后台任务由其他运行实例持有，当前无法停止" },
  JOB_OWNER_UNKNOWN: { status: 409, message: "后台任务所有权无法确认，当前无法停止" },
  JOB_STATE_CONFLICT: { status: 409, message: "后台任务当前状态不允许此操作" },
  SESSION_HAS_ACTIVE_JOBS: { status: 409, message: "当前会话仍有活动后台任务" },
  JOB_STOP_TIMEOUT: { status: 504, message: "等待后台任务停止超时" },
  JOB_STOP_FAILED: { status: 500, message: "后台任务停止失败" },
  JOB_STORAGE_FAILED: { status: 500, message: "后台任务状态保存失败" },
  WORKSPACE_SESSION_CONFLICT: { status: 409, message: "会话当前状态不允许此操作" },
  WORKSPACE_SESSION_FAILED: { status: 500, message: "会话服务发生内部错误" },
};

/** 已知码使用明确的状态与安全文案，供入口提前返回，不强制抛错。 */
export function workSessionErrorResponse(code: keyof typeof WORK_HTTP_FAILURES): Response {
  return httpErrorResponse(code, WORK_HTTP_FAILURES[code]);
}

/** 严格白名单映射兼容不同模块实例的领域错误，不根据 message 猜测原因。 */
export function findWorkSessionErrorResponse(error: unknown): Response | undefined {
  const code = readHttpErrorCode(error);
  const failure = findHttpFailure(WORK_HTTP_FAILURES, code);
  return failure ? httpErrorResponse(code!, failure) : undefined;
}

/** Runtime 信任异常保留原类；其余未知异常统一为 500，不误报请求无效或资源缺失。 */
export function toWorkSessionErrorResponse(error: unknown): Response {
  const known = findWorkSessionErrorResponse(error);
  if (known) return known;
  if (error instanceof loadCore().WorkspaceTrustError) return workSessionErrorResponse("WORKSPACE_NOT_TRUSTED");
  return workSessionErrorResponse("WORKSPACE_SESSION_FAILED");
}
