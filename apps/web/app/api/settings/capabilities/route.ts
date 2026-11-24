/** 主模型能力预览 API：只接受本机同源短连接字段，返回 Core 可请求强度与工具能力。 */
import { NextResponse } from "next/server";
import { isLocalSettingsRequest } from "@/lib/settings/settings-request-origin";
import { createCredentialSettingsService } from "@/lib/settings/credential-settings";

export const runtime = "nodejs";

/** 在服务端用现有受信 route 覆盖解析草稿，不返回 Key、credentialRef 或配置正文。 */
export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!isLocalSettingsRequest(request)) return NextResponse.json({ error: "请在本机打开网站配置模型。" }, { status: 403, headers });
  const params = new URL(request.url).searchParams;
  if (params.size > 4 || [...params.keys()].some(function unknown(key) { return !["apiProtocol", "compatibilityPreset", "baseUrl", "model"].includes(key); })) return NextResponse.json({ error: "模型连接字段无效。" }, { status: 400, headers });
  try {
    return NextResponse.json(createCredentialSettingsService().getMainModelCapabilities(Object.fromEntries(params)), { headers });
  } catch {
    return NextResponse.json({ error: "无法解析模型能力，请检查协议、兼容预设与模型。" }, { status: 400, headers });
  }
}
