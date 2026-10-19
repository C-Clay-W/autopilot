/** 浏览器端 Workspace 知识入库客户端协议回归测试。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceKnowledgeIngestUrl, uploadWorkspaceKnowledge, uploadChatKnowledge } from "@/lib/knowledge-ingest-client";

/** 用多个 chunk 构造可验证跨边界解析的 SSE 响应。 */
function createSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** 构造只用于 FormData 的浏览器 File 测试对象。 */
function createTextFile(): File {
  return new File(["hello"], "hello.txt", { type: "text/plain" });
}

afterEach(function restoreGlobals() {
  vi.unstubAllGlobals();
});

describe("knowledge ingest client", function knowledgeIngestClientSuite() {
  it("Chat 两个用户入口共用终态解析且只提交 file 和取消信号", async function uploadsChatKnowledge() {
    const controller = new AbortController();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async function upload(url: string, init: RequestInit) {
      calls.push(url);
      expect([...((init.body as FormData).keys())]).toEqual(["file"]);
      expect(init.signal).toBe(controller.signal);
      return createSseResponse(['event: progress\ndata: {"step":"embed"}\n\n', 'event: completed\ndata: {"resourceId":"resource_fixture","type":"text"}\n\n']);
    }));
    const progress = vi.fn();
    for (const session of [undefined, "rag_session"]) expect((await uploadChatKnowledge(createTextFile(), progress, session, controller.signal)).status).toBe("completed");
    expect(calls).toEqual(["/api/chat/knowledge", "/api/chat/sessions/rag_session/knowledge"]);
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it("只生成绑定 opaque Workspace 的 canonical 入库地址", function buildsCanonicalUrl() {
    expect(getWorkspaceKnowledgeIngestUrl("workspace/a b")).toBe("/api/workspaces/workspace%2Fa%20b/knowledge/ingest");
    expect(function emptyWorkspace() { return getWorkspaceKnowledgeIngestUrl("  "); }).toThrow("请先选择工作区");
  });

  it("消费 progress 与 completed 新协议并返回 resourceId", async function consumesCompletedProtocol() {
    const fetchMock = vi.fn(async function fetchKnowledge(url: string | URL | Request, init?: RequestInit) {
      expect(url).toBe("/api/workspaces/workspace-1/knowledge/ingest");
      const body = init?.body as FormData;
      expect(body.get("sessionId")).toBe("session-1");
      expect(body.get("clientRecordId")).toBe("knowledge-1");
      return createSseResponse([
        "event: progress\ndata: {\"step\":\"parse\",\"current\":1,",
        "\"total\":2}\n\nevent: completed\ndata: {\"resourceId\":\"resource-1\",\"type\":\"text\",\"status\":\"completed\",\"totalChunks\":3,\"failedPages\":[]}\n\nevent: [DONE]\ndata: {}\n\n",
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const progress: unknown[] = [];

    const terminal = await uploadWorkspaceKnowledge(
      "workspace-1",
      createTextFile(),
      function recordProgress(event) { progress.push(event); },
      { sessionId: "session-1", clientRecordId: "knowledge-1" },
    );

    expect(progress).toEqual([{ step: "parse", current: 1, total: 2 }]);
    expect(terminal).toEqual({
      status: "completed",
      result: { resourceId: "resource-1", type: "text", status: "completed", totalRows: undefined, totalChunks: 3, failedPages: [] },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("保留 partial 和 failed 的安全终态而不误报完成", async function preservesNonSuccessTerminals() {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createSseResponse([
        "event: partial\ndata: {\"resourceId\":\"resource-2\",\"type\":\"pdf\",\"status\":\"partial\",\"totalChunks\":8,\"failedPages\":[2,4]}\n\nevent: [DONE]\ndata: {}\n\n",
      ]))
      .mockResolvedValueOnce(createSseResponse([
        "event: failed\ndata: {\"code\":\"RAG_INGEST_FAILED\",\"message\":\"知识库入库失败\"}\n\nevent: [DONE]\ndata: {}\n\n",
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const partial = await uploadWorkspaceKnowledge("workspace-1", createTextFile(), function ignoreProgress() {});
    const failed = await uploadWorkspaceKnowledge("workspace-1", createTextFile(), function ignoreProgress() {});

    expect(partial).toMatchObject({ status: "partial", result: { resourceId: "resource-2", failedPages: [2, 4] } });
    expect(failed).toEqual({ status: "failed", code: "RAG_INGEST_FAILED", message: "知识库入库失败" });
  });

  it("读取非 SSE HTTP 错误中的安全文案", async function readsHttpFailure() {
    vi.stubGlobal("fetch", vi.fn(async function rejectUpload() {
      return Response.json({ code: "WORKSPACE_REQUIRED", error: "请使用 Workspace 知识资源入口" }, { status: 400 });
    }));

    const terminal = await uploadWorkspaceKnowledge("workspace-1", createTextFile(), function ignoreProgress() {});

    expect(terminal).toEqual({ status: "failed", code: "WORKSPACE_REQUIRED", message: "请使用 Workspace 知识资源入口" });
  });
});
