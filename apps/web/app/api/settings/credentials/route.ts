/** 本机凭据表单 API：限制同源请求、请求大小和字段，只返回安全配置状态。 */
import { NextResponse } from "next/server";
import { isLocalSettingsRequest } from "@/lib/settings/settings-request-origin";
import { createCredentialSettingsService } from "@/lib/settings/credential-settings";

export const runtime = "nodejs";


/** 所有响应禁用缓存；异常只按白名单输出，不回显请求或底层错误。 */
function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** 读取允许公开的配置错误码，兼容开发态模块热更新。 */
function failure(error: unknown) {
  const messages: Record<string, string> = {
    INVALID_SETTINGS_INPUT: "配置内容无效，请检查供应商、模型、服务地址、维度和 Key。",
    SETTINGS_INPUT_INVALID: "配置内容无效，请检查供应商、模型、服务地址、维度和 Key。",
    SETTINGS_INVALID: "现有配置存在无法读取的字段，请先修复该字段后重试。",
    SETTINGS_KEY_REQUIRED: "请填写当前连接的 API Key；更换供应商或地址后不能沿用旧 Key。",
    SETTINGS_MIGRATION_CONFLICT: "检测到多份不同的旧主模型 Key，请填写新的主 Key 后再保存。",
    SETTINGS_CHANGED: "配置已在其他位置更新，请刷新后重试。",
  };
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  // 只透出错误码与字段路径，绝不回显配置值；权限段诊断不进入该错误（设置页单独展示）。
  const detail = error && typeof error === "object" && "diagnostic" in error ? error.diagnostic as { code?: unknown; field?: unknown } | undefined : undefined;
  const field = typeof detail?.field === "string" ? `（${String(detail.code)}：${detail.field}）` : typeof detail?.code === "string" ? `（${detail.code}）` : "";
  return response({
    code: Object.hasOwn(messages, code) ? code : "SETTINGS_SAVE_FAILED",
    error: `${messages[code] ?? "配置暂时无法保存，请稍后重试。"}${field}`,
    ...(field ? { diagnostic: { code: detail?.code, field: detail?.field } } : {}),
  }, code === "SETTINGS_CHANGED" ? 409 : Object.hasOwn(messages, code) ? 400 : 500);
}

/** 返回已配置状态，绝不返回已保存 Key。 */
export async function GET(request: Request) {
  if (!isLocalSettingsRequest(request)) return response({ error: "请在本机打开网站配置 API Key。" }, 403);
  try { return response(await createCredentialSettingsService().getStatus()); } catch (error) { return failure(error); }
}

/** 有界读取本机模型表单后保存；允许显式连接字段，拒绝存储路径和凭据引用。 */
export async function POST(request: Request) {
  if (!isLocalSettingsRequest(request)) return response({ error: "配置请求来源无效，请在本机刷新页面后重试。" }, 403);
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return response({ error: "配置请求格式无效。" }, 415);
  const reader = request.body?.getReader();
  if (!reader) return response({ error: "请填写配置。" }, 400);
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32_768) { await reader.cancel(); return response({ error: "配置内容过长。" }, 413); }
      chunks.push(value);
    }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return response({ error: "配置请求格式无效。" }, 400); }
    return response(await createCredentialSettingsService().save(input));
  } catch (error) { return failure(error); }
}
