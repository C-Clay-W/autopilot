/** Work Route 边界：无作用域请求、退休知识接口和只读旧任务在业务处理前稳定拒绝。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as legacyList, POST as legacyCreate } from "@/app/api/sessions/route";
import { POST as legacyMessages } from "@/app/api/sessions/[id]/messages/route";
import { GET as legacySkills } from "@/app/api/skills/route";
import { GET as workspaceSkills } from "@/app/api/workspaces/[workspaceId]/skills/route";
import * as ask from "@/app/api/ask/route";
import * as resources from "@/app/api/resources/route";
import * as image from "@/app/api/rag-image/route";
import * as pdf from "@/app/api/pdf-ingest/route";
import * as text from "@/app/api/text-ingest/route";
import * as excel from "@/app/api/excel-ingest/route";
import * as ingest from "@/app/api/workspaces/[workspaceId]/knowledge/ingest/route";
import * as list from "@/app/api/workspaces/[workspaceId]/knowledge/resources/route";
import * as remove from "@/app/api/workspaces/[workspaceId]/knowledge/resources/[resourceId]/route";
import * as page from "@/app/api/workspaces/[workspaceId]/knowledge/resources/[resourceId]/pages/[pageNumber]/image/route";
import { runWorkspaceSessionRoute } from "@/lib/workspace-host/workspace-session-route";
import { setWebWorkspaceHostForTest } from "@/lib/workspace-host/web-workspace-server";
import type { WebWorkspaceHost } from "@/lib/workspace-host/web-workspace-host";
import { loadCore } from "@/lib/core-loader";
import { resolveSessionImages, storeSessionImage } from "@/lib/session-attachment-store";
import { toWorkSessionErrorResponse } from "@/lib/workspace-host/work-session-error";

/** 每项用例恢复进程 Host 注入，不读取真实 Registry。 */
afterEach(function reset() { setWebWorkspaceHostForTest(undefined); });

describe("Work Route boundary", function suite() {
  it("canonical 保留业务码并丢弃原始文本，内部异常不猜成请求或资源错误", async function preservesSafeCodes() {
    const context = { projectId: "project", runtime: { sessions: { get: vi.fn(async function get() { return { projectId: "project", productMode: "work" }; }) } } };
    setWebWorkspaceHostForTest({ getContext: vi.fn(async function getContext() { return context; }) } as unknown as WebWorkspaceHost);
    const params = Promise.resolve({ workspaceId: "workspace", sessionId: "session" });
    for (const [code, status] of [["WORK_HISTORY_READ_ONLY", 409], ["TURN_NOT_FOUND", 404], ["QUESTION_ANSWER_INVALID", 400]] as const) {
      const response = await runWorkspaceSessionRoute(params, async function legacyError() { return Response.json({ code, error: "/private/secret" }, { status: 500 }); });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      const thrown = await runWorkspaceSessionRoute(params, async function domainError() { throw new (loadCore().AgentRuntimeError)(code, "/private/secret"); });
      expect(thrown.status).toBe(status);
      expect(await thrown.text()).not.toContain("/private/secret");
    }
    for (const code of ["constructor", "__proto__"]) {
      const response = await runWorkspaceSessionRoute(params, async function unknownError() { return Response.json({ code, error: "/private/secret" }, { status: 500 }); });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ code: "WORKSPACE_SESSION_FAILED", error: "会话服务发生内部错误" });
    }
    expect(toWorkSessionErrorResponse(new Error("Skill 参数 /private/secret 不存在")).status).toBe(500);
    expect(toWorkSessionErrorResponse(new SyntaxError("损坏的持久化 JSON")).status).toBe(500);
  });

  it("附件校验抛出领域错误，磁盘故障保持内部错误而非 400", async function attachmentErrors() {
    let failure: unknown;
    try { resolveSessionImages("session", "forged"); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(toWorkSessionErrorResponse(failure).status).toBe(400);
    await expect(storeSessionImage("session", new File(["x"], "file.exe"))).rejects.toMatchObject({ code: "WORK_ATTACHMENT_INVALID" });
    const diskFailure = Object.assign(new Error("EACCES /private/secret"), { code: "EACCES" });
    const response = toWorkSessionErrorResponse(diskFailure);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("/private/secret");
  });

  it("旧无作用域列表/创建不选择 cwd 或初始化 Host", async function noImplicitWorkspace() {
    const getContext = vi.fn();
    setWebWorkspaceHostForTest({ getContext } as unknown as WebWorkspaceHost);
    for (const response of [await legacyList(), await legacyCreate(), await legacySkills()]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "WORKSPACE_REQUIRED" });
    }
    const messagesResponse = await legacyMessages(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ id: "session" }) });
    expect(messagesResponse.status).toBe(400);
    expect(await messagesResponse.json()).toMatchObject({ code: "WORKSPACE_REQUIRED" });
    expect(getContext).not.toHaveBeenCalled();
  });

  it("全部旧知识方法返回 410，不触发 Host、Core 或自动转发", async function retiredKnowledgeRoutes() {
    const getContext = vi.fn();
    setWebWorkspaceHostForTest({ getContext } as unknown as WebWorkspaceHost);
    for (const route of [ask, resources, image, pdf, text, excel, ingest, list, remove, page]) {
      for (const handler of Object.values(route)) {
        const response = handler();
        expect(response.status).toBe(410);
        expect(await response.json()).toEqual({ code: "WORK_KNOWLEDGE_UNAVAILABLE", error: "Work 不再提供私有知识库能力，请使用 Chat RAG" });
      }
    }
    expect(getContext).not.toHaveBeenCalled();
  });

  it("伪造、未信任、跨产品和旧知识任务都在 action 前拒绝", async function rejectsBeforeAction() {
    const getContext = vi.fn();
    const action = vi.fn();
    setWebWorkspaceHostForTest({ getContext } as unknown as WebWorkspaceHost);
    const params = Promise.resolve({ workspaceId: "workspace", sessionId: "session" });
    for (const [code, status] of [["WORKSPACE_NOT_FOUND", 404], ["WORKSPACE_NOT_TRUSTED", 403]] as const) {
      getContext.mockRejectedValueOnce({ code });
      expect((await runWorkspaceSessionRoute(params, action)).status).toBe(status);
      getContext.mockRejectedValueOnce({ code });
      expect((await workspaceSkills(new Request("http://localhost"), { params })).status).toBe(status);
    }
    const session = { projectId: "project", productMode: "chat" };
    const context = { projectId: "project", runtime: { sessions: { get: vi.fn(async function get() { return session; }) }, turns: { getState: vi.fn(async function state() { return { readOnlyReason: "WORK_HISTORY_READ_ONLY" }; }) } } };
    getContext.mockResolvedValue(context);
    expect((await runWorkspaceSessionRoute(params, action)).status).toBe(404);
    session.productMode = "work";
    const response = await runWorkspaceSessionRoute(params, action, { requireWritable: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "WORK_HISTORY_READ_ONLY" });
    expect(action).not.toHaveBeenCalled();
  });
});
