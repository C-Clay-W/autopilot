/** 能力预览 API 回归：同源边界、受限查询与安全输出，不访问真实配置或 Provider。 */
import { describe, expect, it, vi } from "vitest";

const { getMainModelCapabilities } = vi.hoisted(function mocks() { return { getMainModelCapabilities: vi.fn(function capabilities() { return { supportedReasoningEfforts: ["none", "xhigh"], supportsToolCalls: true }; }) }; });
vi.mock("@/lib/settings/credential-settings", function service() { return { createCredentialSettingsService: function createService() { return { getMainModelCapabilities }; } }; });
import { GET } from "@/app/api/settings/capabilities/route";

describe("settings capabilities route", function suite() {
  it("仅向本机同源返回脱敏能力并禁用缓存", async function previewsCapabilities() {
    const response = await GET(new Request("http://localhost:3000/api/settings/capabilities?apiProtocol=openai-responses&baseUrl=https%3A%2F%2Fmain.fixture%2Fv1&model=custom"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ supportedReasoningEfforts: ["none", "xhigh"], supportsToolCalls: true });
    expect(getMainModelCapabilities).toHaveBeenCalledWith({ apiProtocol: "openai-responses", baseUrl: "https://main.fixture/v1", model: "custom" });
  });

  it("拒绝跨站、远程访问与多余查询字段", async function rejectsUnsafeQueries() {
    expect((await GET(new Request("http://localhost:3000/api/settings/capabilities", { headers: { origin: "https://other.example" } }))).status).toBe(403);
    expect((await GET(new Request("http://192.168.1.2:3000/api/settings/capabilities"))).status).toBe(403);
    expect((await GET(new Request("http://localhost:3000/api/settings/capabilities?apiKey=secret"))).status).toBe(400);
  });
});
