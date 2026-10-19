/** web-workspace-server.test.ts — Workspace Route 的稳定错误状态与脱敏回归。 */

import { describe, expect, it } from "vitest";
import { WebWorkspaceHostError } from "@/lib/workspace-host/web-workspace-host";
import { toWorkspaceErrorResponse } from "@/lib/workspace-host/web-workspace-server";

/** 读取错误响应 JSON，确认 HTTP 语义与安全 DTO。 */
async function readError(error: unknown): Promise<{ status: number; body: { error: string; code: string } }> {
  const response = toWorkspaceErrorResponse(error);
  return { status: response.status, body: await response.json() as { error: string; code: string } };
}

describe("Workspace Route 错误映射", function workspaceRouteErrorSuite() {
  it("覆盖 400、403、404、409、500 且不回显底层路径", async function mapsStableSafeErrors() {
    const temporaryPath = "C:/temporary-secret-workspace";
    await expect(readError(new WebWorkspaceHostError("DIRECTORY_INVALID", "所选目录不可用"))).resolves.toMatchObject({ status: 400, body: { code: "DIRECTORY_INVALID" } });
    await expect(readError(new WebWorkspaceHostError("WORKSPACE_NOT_TRUSTED", "工作区尚未获得信任"))).resolves.toMatchObject({ status: 403, body: { code: "WORKSPACE_NOT_TRUSTED" } });
    await expect(readError(new WebWorkspaceHostError("WORKSPACE_NOT_FOUND", "工作区不存在"))).resolves.toMatchObject({ status: 404, body: { code: "WORKSPACE_NOT_FOUND" } });
    await expect(readError(new WebWorkspaceHostError("DIRECTORY_PICKER_BUSY", "目录选择正在进行"))).resolves.toMatchObject({ status: 409, body: { code: "DIRECTORY_PICKER_BUSY" } });
    const internal = await readError(new Error(temporaryPath));
    expect(internal).toMatchObject({ status: 500, body: { code: "WORKSPACE_INTERNAL_ERROR" } });
    expect(JSON.stringify(internal.body)).not.toContain(temporaryPath);
  });

  it("兼容开发态热更新前实例抛出的白名单 Host 错误", async function mapsStaleHostErrorByCode() {
    const staleHostError = { name: "WebWorkspaceHostError", code: "DIRECTORY_INVALID", message: "old module instance" };
    await expect(readError(staleHostError)).resolves.toEqual({ status: 400, body: { error: "所选目录不可用", code: "DIRECTORY_INVALID" } });
  });
});
