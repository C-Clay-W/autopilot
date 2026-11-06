/** 独立验收：用任务自有HTML、内存Store与真实受管loopback服务验证组件边界，不启动产品宿主。 */
import { expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";
import { createSessionService } from "../../../src/runtime/application/session-service";
import { createJobService, type JobService } from "../../../src/runtime/application/job-service";
import { prepareStaticPreview, STATIC_PREVIEW_SCRIPT } from "../../../src/internal/tools/builtins/static-preview";
import { probeLocalService } from "../../../../../apps/web/lib/workspace-host/work-preview-readiness";
import { createOpenPreviewTool } from "../../../src/internal/tools/builtins/open-preview-tool";
import { createWorkPreviewService } from "../../../../../apps/web/lib/workspace-host/work-preview-service";

/** 仅桥接包名到同一真实源码函数，避免Web组件加载未更新的Core dist；不替换行为。 */
vi.mock("@autopilot-agent/core", async function sourceBridge() {
  return await import("../../../src/runtime/domain/job-service-url");
});

/** 在本任务产物根建立独立fixture，不接触真实工作区状态。 */
async function fixture() {
  const base = path.resolve(process.cwd(), "../../.agent-tests/work-test/manual-followup-01a19eed/fixtures");
  await mkdir(base, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(base, "tester-static-")));
  await writeFile(path.join(root, "selected page.html"), "<!doctype html><title>isolated selected file</title>");
  await writeFile(path.join(root, "neighbor.html"), "private neighbor fixture");
  return root;
}

it("真实Job单文件服务就绪、只公开所选HTML、重复复用并可停止", async function managedSingleFile() {
  const root = await fixture();
  const ports = createMemoryPorts(root);
  await createSessionService(ports).create({ id: "tester-owner" });
  const jobs = createJobService({ store: ports.jobStore, sessionStore: ports.sessionStore, projectStore: ports.projectStore, ownerProbe: ports.jobOwnerProbe });
  const input = { jobs, workspaceId: root, workspaceRoot: root, sessionId: "tester-owner", turnId: "tester-turn", staticPath: "selected page.html" };
  const context = { permissionMode: "ask" as const, toolCallId: "tester-call", sandboxPolicy: { execution: "host" as const, policy: { mode: "workspace-write" as const, workspaceRoot: root, allowedDomains: [], deniedRead: [], deniedWrite: [] } } };
  try {
    const first = await prepareStaticPreview(input, context);
    expect(await probeLocalService(first.url, { totalMs: 3000, perTryMs: 400, maxAttempts: 10, delayMs: 30 })).toEqual({ state: "ready" });
    const response = await fetch(first.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("isolated selected file");
    expect((await fetch(first.url, { method: "HEAD" })).status).toBe(200);
    for (const target of ["/", "/neighbor.html", "/selected%20page.html?anything=1", "/%2e%2e/neighbor.html"]) {
      expect((await fetch(new URL(target, first.url))).status).toBe(404);
    }
    expect((await fetch(first.url, { method: "POST" })).status).toBe(404);
    expect(await prepareStaticPreview(input, context)).toEqual(first);
    expect(await jobs.list(root)).toHaveLength(1);
    expect(await jobs.forSession(input).verifyServiceOwnership({ jobId: first.jobId, serviceUrl: new URL(first.url).origin })).toBe("owned");
    const preview = createWorkPreviewService({ workspaceRoot: root, agentAuthorities: [], jobsOf: function scoped(sessionId) { return jobs.forSession({ workspaceId: root, sessionId }); } });
    const tool = createOpenPreviewTool({ ...input, capability: preview });
    const request = tool.inputSchema.parse({ staticPath: input.staticPath });
    await tool.validateInput?.(request, context);
    const prepared = await tool.execute(request, context);
    expect(prepared).toMatchObject({ state: "prepared", copyUrl: first.url, jobId: first.jobId });
    expect(prepared.autoOpen).not.toBe(false);
    expect(await preview.resolveNavigation({ previewId: prepared.previewId, sessionId: input.sessionId })).toMatchObject({ serviceState: "ready", canStop: true, navigationUrl: first.url });
    await preview.stopPreviewJob({ previewId: prepared.previewId, sessionId: input.sessionId });
    expect((await jobs.get(first.jobId))?.status).toBe("stopped");
    expect(await probeLocalService(first.url, { totalMs: 500, perTryMs: 200, maxAttempts: 1, delayMs: 0 })).toMatchObject({ state: "unavailable" });
  } finally { await jobs.shutdown(); }
}, 20000);

it("归属不明、服务失属、分页不完整与启动失败不会新建或盲重试", async function rejectedPreparation() {
  const root = await fixture();
  const file = await realpath(path.join(root, "selected page.html"));
  const record = { id: "existing", sessionId: "owner", workspaceId: root, program: process.execPath, args: ["-e", STATIC_PREVIEW_SCRIPT, file, "12345"], serviceUrl: "http://127.0.0.1:12345", status: "running" };
  for (const kind of ["owner_unknown", "unowned", "paged", "failed"] as const) {
    const start = vi.fn(async function failedStart() { return { status: "failed" }; });
    const jobs = { get: async function get() { return record; }, start, forSession: function scoped() { return { list: async function list() { return kind === "paged" ? { jobs: [], nextPageCursor: "more" } : kind === "failed" ? { jobs: [] } : { jobs: [{ jobId: "existing", status: "running", controlState: kind === "owner_unknown" ? "owner_unknown" : "owned" }] }; }, verifyServiceOwnership: async function ownership() { return "unowned"; } }; } } as unknown as JobService;
    await expect(prepareStaticPreview({ jobs, workspaceId: root, workspaceRoot: root, sessionId: "owner", turnId: "turn", staticPath: "selected page.html" }, { permissionMode: "ask", sandboxPolicy: { execution: "host", policy: { mode: "workspace-write", workspaceRoot: root, allowedDomains: [], deniedRead: [], deniedWrite: [] } } })).rejects.toBeDefined();
    expect(start).toHaveBeenCalledTimes(kind === "failed" ? 1 : 0);
  }
});
