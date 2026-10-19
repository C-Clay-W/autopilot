/** Web HTTP 错误工具：只校验传输字段和输出固定摘要，不替代 Core、Node 或 Host 领域错误。 */
export interface HttpFailure {
  status: number;
  message: string;
}

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
