/** 凭据 API 来源回归：拒绝跨站、本机外访问、未知字段和过大请求，不触及真实用户文件。 */
import { describe, expect, it, vi } from "vitest";
const { save, getStatus } = vi.hoisted(function mocks() { return { save: vi.fn(async function save() { return { main: { configured: true } }; }), getStatus: vi.fn(async function getStatus() { return { main: { configured: false } }; }) }; });
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
});
