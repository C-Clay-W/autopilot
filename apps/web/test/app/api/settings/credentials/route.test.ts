/** 凭据 API 来源回归：拒绝跨站、本机外访问、未知字段和过大请求，不触及真实用户文件。 */
import { describe, expect, it, vi } from "vitest";
const { save, getStatus } = vi.hoisted(function mocks() { return { save: vi.fn(async function save(): Promise<Record<string, unknown>> { return { main: { configured: true } }; }), getStatus: vi.fn(async function getStatus(): Promise<Record<string, unknown>> { return { main: { configured: false } }; }) }; });
vi.mock("@/lib/settings/credential-settings", function service() { return { createCredentialSettingsService: function createService() { return { save, getStatus }; } }; });
import { GET, POST } from "@/app/api/settings/credentials/route";

/** 构造浏览器同源请求，允许每项测试明确改变来源和正文。 */
function request(origin = "http://localhost:3000", body = "{}", url = "http://localhost:3000/api/settings/credentials") {
  return new Request(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
}

describe("credentials route", function suite() {
  it("只允许本机同源提交，拒绝缺失或伪造 Origin", async function checksOrigins() {
    expect((await POST(request("https://other.example"))).status).toBe(403);
    expect((await POST(request("null"))).status).toBe(403);
    expect((await POST(request("http://192.168.1.2:3000", "{}", "http://192.168.1.2:3000/api/settings/credentials"))).status).toBe(403);
    expect(save).not.toHaveBeenCalled();
    const accepted = await POST(request());
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
  });
  it("拒绝跨源状态读取和大正文", async function boundsReadAndWrite() {
    expect((await GET(new Request("http://localhost:3000/api/settings/credentials", { headers: { origin: "https://other.example" } }))).status).toBe(403);
    expect((await POST(request("http://localhost:3000", "x".repeat(40_000)))).status).toBe(413);
    expect((await GET(new Request("http://localhost:3000/api/settings/credentials"))).status).toBe(200);
  });

  it("H3：权限段诊断随状态返回，整页错误只透出错误码与字段", async function isolatesPermissionDiagnostics() {
    getStatus.mockResolvedValueOnce({ diagnostics: [{ code: "SETTINGS_PERMISSIONS_UNSUPPORTED", field: "permissions.defaultMode", scope: "user" }] });
    const ok = await GET(new Request("http://localhost:3000/api/settings/credentials"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ diagnostics: [{ code: "SETTINGS_PERMISSIONS_UNSUPPORTED", field: "permissions.defaultMode", scope: "user" }] });

    getStatus.mockRejectedValueOnce({ code: "SETTINGS_INVALID", diagnostic: { code: "SETTINGS_MODEL_INVALID", field: "availableModels", scope: "user" } });
    const blocked = await GET(new Request("http://localhost:3000/api/settings/credentials"));
    expect(blocked.status).toBe(400);
    const body = await blocked.json() as { error: string; diagnostic?: unknown };
    expect(body.error).toContain("SETTINGS_MODEL_INVALID");
    expect(body.error).toContain("availableModels");
    expect(body.error).not.toContain("模型配置无法读取");
    expect(body.diagnostic).toEqual({ code: "SETTINGS_MODEL_INVALID", field: "availableModels" });
  });

  it("H3：保存失败返回稳定码与字段，不回显配置值", async function reportsSaveDiagnostic() {
    save.mockRejectedValueOnce({ code: "SETTINGS_INPUT_INVALID", diagnostic: { code: "SETTINGS_SANDBOX_MODE_FORBIDDEN", field: "sandbox.mode", scope: "user" } });
    const failed = await POST(request());
    expect(failed.status).toBe(400);
    const body = await failed.json() as { code: string; error: string };
    expect(body.code).toBe("SETTINGS_INPUT_INVALID");
    expect(body.error).toContain("SETTINGS_SANDBOX_MODE_FORBIDDEN");
    expect(body.error).toContain("sandbox.mode");
  });
});
