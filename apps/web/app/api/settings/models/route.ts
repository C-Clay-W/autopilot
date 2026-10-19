/** 主模型目录 API：仅接受本机同源 GET，并由服务端使用已保存凭据主动刷新。 */
import { NextResponse } from "next/server";
import { isLocalSettingsRequest } from "@/lib/settings/settings-request-origin";
import { createCredentialSettingsService } from "@/lib/settings/credential-settings";

export const runtime = "nodejs";


/** 返回官方目录或明确标记的维护目录，不回显 Key 与上游响应正文。 */
export async function GET(request: Request) {
  if (!isLocalSettingsRequest(request)) return NextResponse.json({ error: "请在本机打开网站刷新模型列表。" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const provider = new URL(request.url).searchParams.get("provider");
  if (provider !== "deepseek") return NextResponse.json({ error: "自定义服务请手动填写模型 ID。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  try {
    return NextResponse.json(await createCredentialSettingsService().refreshMainModelCatalog(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "模型列表刷新失败，仍可手动填写。" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
