/** route.test.ts — Workspace/Trust Route 的严格请求与安全响应回归。 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as listWorkspaces } from "@/app/api/workspaces/route";
import { DELETE as removeWorkspace } from "@/app/api/workspaces/[workspaceId]/route";
import { POST as openWorkspace } from "@/app/api/workspaces/open/route";
import { POST as pickWorkspace } from "@/app/api/workspaces/picker/route";
import { setWebWorkspaceHostForTest } from "@/lib/workspace-host/web-workspace-server";
import type { WebWorkspaceHost } from "@/lib/workspace-host/web-workspace-host";

/** 每次恢复真实 Host 单例，防止路由 mock 影响其他测试。 */
afterEach(function resetWorkspaceHost() {
  setWebWorkspaceHostForTest(undefined);
});

describe("Workspace API", function workspaceApiSuite() {
  it("只公开 chooser 是否可用的布尔能力，不返回宿主路径", async function exposesSafeChooserCapability() {
    setWebWorkspaceHostForTest({
      listWorkspaces: vi.fn(async function list() { return [{ workspaceId: "v1-1234567890abcdef", displayName: "项目", lastOpenedAt: 1, available: true, trustStatus: "trusted" as const }]; }),
      isDirectorySelectionAvailable: vi.fn(function isAvailable() { return true; }),
    } as unknown as WebWorkspaceHost);
    const response = await listWorkspaces();
    await expect(response.json()).resolves.toEqual({ workspaces: [{ workspaceId: "v1-1234567890abcdef", displayName: "项目", lastOpenedAt: 1, available: true, trustStatus: "trusted" }], directoryPickerAvailable: true });
  });

  it("拒绝路径 body 与非本机 picker 请求", async function rejectsUnsafePickerRequests() {
    const withPath = await pickWorkspace(new Request("http://localhost/api/workspaces/picker", { method: "POST", body: "C:/secret" }));
    expect(withPath.status).toBe(400);
    const remote = await pickWorkspace(new Request("https://example.test/api/workspaces/picker", { method: "POST" }));
    expect(remote.status).toBe(409);
  });

  it("严格校验 selection token，未知 workspace 返回稳定 404", async function validatesTokenAndWorkspaceId() {
    const invalidToken = await openWorkspace(new Request("http://localhost/api/workspaces/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selectionToken: "C:/secret" }) }));
    expect(invalidToken.status).toBe(400);
    setWebWorkspaceHostForTest({ removeWorkspace: vi.fn(async function remove() { return false; }) } as unknown as WebWorkspaceHost);
    const response = await removeWorkspace(new Request("http://localhost/api/workspaces/v1-1234567890abcdef", { method: "DELETE" }), { params: Promise.resolve({ workspaceId: "v1-1234567890abcdef" }) });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  });
});
