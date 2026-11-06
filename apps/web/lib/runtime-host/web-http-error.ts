/** Web HTTP 错误工具：只校验传输字段和输出固定摘要，不替代 Core、Node 或 Host 领域错误。 */
export interface HttpFailure {
  status: number;
  message: string;
}

/** Work/Chat 共用状态升级错误文案；异常路径、备份和底层正文只留在宿主侧。 */
export const STATE_HTTP_FAILURES: Readonly<Record<string, HttpFailure>> = {
  STATE_SCHEMA_VERSION_UNSUPPORTED: { status: 409, message: "状态数据格式不受当前版本支持，请更新程序后重试；现有数据已保留" },
  STATE_SCHEMA_BUSY: { status: 409, message: "状态数据正在使用或升级，请停止其他运行实例后重试" },
  STATE_SCHEMA_MIGRATION_FAILED: { status: 409, message: "状态数据升级未完成，原数据和恢复备份已保留，请停止其他运行实例后重试；仍失败请联系支持" },
  STATE_SCHEMA_MIGRATION_MISSING: { status: 409, message: "当前程序缺少此状态版本的升级步骤，请更新程序后重试；现有数据已保留" },
  STATE_SCHEMA_RECOVERY_REQUIRED: { status: 409, message: "状态数据需要恢复，原数据已保留，请停止其他运行实例后重试；仍失败请联系支持" },
  STATE_SCHEMA_MANIFEST_CORRUPTED: { status: 409, message: "状态版本信息已损坏，现有数据已保留，请联系支持恢复" },
  STATE_SCHEMA_VERSION_INVALID: { status: 409, message: "状态版本信息无效，现有数据已保留，请联系支持恢复" },
};

/** Web 自有请求/入口错误；领域失败继续由其原有错误类表达。 */
export class WebRouteError extends Error {
  /** 保存封闭的入口错误码和标准堆栈，不承载底层异常正文。 */
  constructor(public readonly code: "INVALID_CHAT_REQUEST" | "INVALID_SESSION_REQUEST" | "CHAT_MESSAGE_ALREADY_SUBMITTED" | "CHAT_SESSION_BUSY" | "CHAT_SERVICE_UNAVAILABLE") {
    super(code);
    this.name = "WebRouteError";
  }
}

/** 只读取字符串错误码，不隐式执行对象的 toString。 */
export function readHttpErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** 只接受映射自身的白名单键，拒绝 constructor、__proto__ 等继承属性。 */
export function findHttpFailure(failures: Readonly<Record<string, HttpFailure>>, code: string | undefined): HttpFailure | undefined {
  return code !== undefined && Object.hasOwn(failures, code) ? failures[code] : undefined;
}

/** 用固定定义生成 HTTP DTO，绝不传递原始异常 message/cause。 */
export function httpErrorResponse(code: string, failure: HttpFailure): Response {
  return Response.json({ code, error: failure.message }, { status: failure.status });
}

/** 仅将请求 JSON 解码失败与非对象请求判为 400，不吞掉后续业务 SyntaxError。 */
export async function readRequestObject(request: Request, code: "INVALID_CHAT_REQUEST" | "INVALID_SESSION_REQUEST"): Promise<Record<string, unknown>> {
  let body: unknown;
  try { body = await request.json(); } catch { throw new WebRouteError(code); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new WebRouteError(code);
  return body as Record<string, unknown>;
}

/** multipart 解码失败属于请求错误，存储/解析失败留给各自领域处理。 */
export async function readRequestForm(request: Request, code: "INVALID_CHAT_REQUEST" | "INVALID_SESSION_REQUEST"): Promise<FormData> {
  try { return await request.formData(); } catch { throw new WebRouteError(code); }
}
