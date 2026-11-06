/** T1回归：预览页面侧取origin，Job声明仍执行真实严格origin规则；不启动服务。 */
import { expect, it, vi } from "vitest";
import { createWorkPreviewService } from "../../../../../apps/web/lib/workspace-host/work-preview-service";
import { normalizeJobServiceUrl } from "../../../src/runtime/domain/job-service-url";

/** 桥接真实Core源函数，不消费旧dist或替换比较语义。 */
vi.mock("@autopilot-agent/core", async function sourceBridge() { return await import("../../../src/runtime/domain/job-service-url"); });
const origin = "http://127.0.0.1:54321";

/** 固定ready探测和内存Job事实仅验证绑定/导航/停止边界。 */
function serviceWithDeclaration(serviceUrl: string) {
  const job = { jobId: "job-owned", status: "running", controlState: "owned", canStop: true, serviceUrl, startedAt: 1, updatedAt: 1, stdoutBytes: 0, stderrBytes: 0, outputTruncated: false };
  const stop = vi.fn(async function stop() { return { ...job, status: "stopped" }; });
  const verifyServiceOwnership = vi.fn(async function verify() { return "owned" as const; });
  const service = createWorkPreviewService({ workspaceRoot: "fixture-workspace", agentAuthorities: [], jobsOf: function scoped() { return { list: async function list() { return { jobs: [job] }; }, verifyServiceOwnership, stop } as never; }, probe: async function ready() { return { state: "ready" as const }; } });
  return { service, stop, verifyServiceOwnership };
}

it("非根HTML页面保留owned Job绑定，导航可停止并沿原引用停止入口", async function pageOrigin() {
  const { service, stop, verifyServiceOwnership } = serviceWithDeclaration(origin);
  const result = await service.preparePreview({ workspaceId: "fixture-workspace", sessionId: "owner", turnId: "turn", callId: "call", openWhen: "after_turn", url: origin + "/nested/selected%20page.html", jobId: "job-owned" });
  expect(result.jobId).toBe("job-owned"); expect(result.autoOpen).toBeUndefined();
  expect(verifyServiceOwnership).toHaveBeenCalledWith({ jobId: "job-owned", serviceUrl: origin });
  const navigation = await service.resolveNavigation({ previewId: result.previewId, sessionId: "owner" });
  expect(navigation).toMatchObject({ serviceState: "ready", canStop: true, navigationUrl: origin + "/nested/selected%20page.html" });
  await service.stopPreviewJob({ previewId: result.previewId, sessionId: "owner" });
  expect(stop).toHaveBeenCalledWith({ jobId: "job-owned", source: "host" });
});

it("只转换页面URL，不放宽Job非根路径/凭据/query声明，也不绑定其他origin", async function declarationBoundary() {
  for (const serviceUrl of [origin + "/bad.html", origin + "?q=1", "http://user:password@127.0.0.1:54321", "http://127.0.0.1:54322"]) {
    if (!serviceUrl.endsWith(":54322")) expect(normalizeJobServiceUrl(serviceUrl)).toBeUndefined();
    const { service, verifyServiceOwnership } = serviceWithDeclaration(serviceUrl);
    const result = await service.preparePreview({ workspaceId: "fixture-workspace", sessionId: "owner", turnId: "turn", callId: "call", openWhen: "after_turn", url: origin + "/page.html" });
    expect(result.jobId).toBeUndefined(); expect(result.autoOpen).toBe(false); expect(verifyServiceOwnership).not.toHaveBeenCalled();
  }
  const { service } = serviceWithDeclaration(origin);
  await expect(service.preparePreview({ workspaceId: "fixture-workspace", sessionId: "owner", turnId: "turn", callId: "bad-page", openWhen: "after_turn", url: "http://user:password@127.0.0.1:54321/page.html" })).rejects.toMatchObject({ code: "PREVIEW_INVALID_TARGET" });
});
