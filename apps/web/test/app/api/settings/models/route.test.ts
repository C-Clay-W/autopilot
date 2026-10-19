/** 模型目录 API 测试：验证本机同源边界与主动刷新委托。 */
import { describe, expect, it, vi } from "vitest";

const { refreshMainModelCatalog } = vi.hoisted(function mocks() { return { refreshMainModelCatalog: vi.fn(async function refresh() { return { models: ["deepseek-live"], source: "official" }; }) }; });
vi.mock("@/lib/settings/credential-settings", function service() { return { createCredentialSettingsService: function createService() { return { refreshMainModelCatalog }; } }; });
import { GET } from "@/app/api/settings/models/route";

describe("settings model catalog route", function suite() {
  it("DeepSeek 同源请求触发一次服务端刷新", async function refreshesCatalog() {
    const response = await GET(new Request("http://localhost:3000/api/settings/models?provider=deepseek", { headers: { origin: "http://localhost:3000" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: ["deepseek-live"], source: "official" });
    expect(refreshMainModelCatalog).toHaveBeenCalledTimes(1);
  });

  it("拒绝跨站与自定义服务目录猜测", async function rejectsUnsupportedRequests() {
    expect((await GET(new Request("http://localhost:3000/api/settings/models?provider=deepseek", { headers: { origin: "https://other.example" } }))).status).toBe(403);
    expect((await GET(new Request("http://localhost:3000/api/settings/models?provider=custom"))).status).toBe(400);
  });
});
