/** canonical Chat 知识管理入口；只转发传输参数，不读取 Workspace 或复制 RAG 管线。 */
import { runChatKnowledgeRoute } from "@/lib/runtime-host/chat-knowledge-route";
export const runtime = "nodejs";
export const maxDuration = 300;
type Context = { params: Promise<{ segments?: string[] }> };
/** 所有方法共用封闭路由和安全错误边界。 */
async function handle(request: Request, context: Context): Promise<Response> { return runChatKnowledgeRoute(request, (await context.params).segments); }
export { handle as GET, handle as POST, handle as DELETE, handle as PATCH, handle as PUT, handle as HEAD, handle as OPTIONS };
