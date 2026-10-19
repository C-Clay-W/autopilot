/** canonical Chat Session API；封闭方法和路径统一交给 HTTP 适配层，Runtime 只由宿主装配。 */
import { runChatSessionRoute } from "@/lib/runtime-host/chat-session-route";

export const runtime = "nodejs";
export const maxDuration = 120;
type Context = { params: Promise<{ segments?: string[] }> };

/** 映射 App Router 参数，复用同一个身份校验和方法白名单。 */
async function handle(request: Request, context: Context): Promise<Response> {
  return runChatSessionRoute(request, (await context.params).segments);
}

export { handle as GET, handle as POST, handle as DELETE, handle as PATCH, handle as PUT, handle as HEAD, handle as OPTIONS };
