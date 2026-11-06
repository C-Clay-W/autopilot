/** 协作组事件的只读持续观察；与普通 Turn stream 分离。 */
import { optionalThreadId, optionalThreadInt, runWorkspaceThreadRoute, THREAD_PROTOCOL_VERSION } from "@/lib/workspace-host/thread-route";

export const runtime = "nodejs";
export const maxDuration = 1800;

/** 校验首批并持续按 Core 游标读取；取消只释放本观察流。 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string; groupId: string }> }) {
  return runWorkspaceThreadRoute(params, async function observe({ threads }) {
    const { groupId } = await params;
    const url = new URL(request.url);
    const cursor = optionalThreadId(url.searchParams.get("cursor") ?? request.headers.get("last-event-id"), "cursor", 2_048);
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 20 : optionalThreadInt(Number(rawLimit), "limit", 1, 100)!;
    const read = async function readPage(current?: string) {
      return threads.events({ protocolVersion: THREAD_PROTOCOL_VERSION, groupId, ...(current ? { cursor: current } : {}), limit });
    };
    let page = await read(cursor);
    let nextCursor = page.cursor;
    let closed = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const encoder = new TextEncoder();
    /** 终止等待并解绑请求信号，不影响宿主或 Turn。 */
    function cleanup() {
      closed = true;
      if (timer) clearTimeout(timer);
      wake?.();
      request.signal.removeEventListener("abort", cleanup);
    }
    request.signal.addEventListener("abort", cleanup, { once: true });
    if (request.signal.aborted) cleanup();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (closed) { if (!cancelled) controller.close(); return; }
        try {
          if (page.items.length) {
            controller.enqueue(encoder.encode(`id: ${page.cursor}\nevent: page\ndata: ${JSON.stringify(page)}\n\n`));
            nextCursor = page.cursor;
            page = { ...page, items: [] };
            return;
          }
          await new Promise<void>(function wait(resolve) { wake = resolve; timer = setTimeout(resolve, 1000); });
          wake = undefined;
          timer = undefined;
          if (closed) { if (!cancelled) controller.close(); return; }
          page = await read(nextCursor);
          if (closed) { if (!cancelled) controller.close(); return; }
          if (page.items.length) {
            controller.enqueue(encoder.encode(`id: ${page.cursor}\nevent: page\ndata: ${JSON.stringify(page)}\n\n`));
            nextCursor = page.cursor;
            page = { ...page, items: [] };
          } else controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          if (!closed) controller.enqueue(encoder.encode('event: error\ndata: {"code":"THREADS_UNAVAILABLE"}\n\n'));
          cleanup();
          if (!cancelled) controller.close();
        }
      },
      cancel() { cancelled = true; cleanup(); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
  }, { observeOnly: true });
}
