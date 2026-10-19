/** 覆盖真实 Next 回环规范化和来源拒绝边界。 */
import { expect, it } from "vitest";
import { isLocalSettingsRequest } from "../../lib/settings/settings-request-origin";
it("允许 Next localhost URL 与实际 127 Host，但 Origin 必须精确匹配实际 Host", function normalizedLoopback() {
 function request(host: string, origin: string, site="same-origin") { return new Request("http://localhost:3015/api/settings/credentials",{method:"POST",headers:{host,origin,"sec-fetch-site":site}}); }
 expect(isLocalSettingsRequest(request("127.0.0.1:3015","http://127.0.0.1:3015"))).toBe(true);
 expect(isLocalSettingsRequest(request("127.0.0.1:3015","http://localhost:3015"))).toBe(false);
 expect(isLocalSettingsRequest(request("127.0.0.1:9999","http://127.0.0.1:9999"))).toBe(false);
 expect(isLocalSettingsRequest(request("evil.example:3015","http://evil.example:3015"))).toBe(false);
 expect(isLocalSettingsRequest(request("127.0.0.1:3015","http://127.0.0.1:3015","cross-site"))).toBe(false);
 expect(isLocalSettingsRequest(request("localhost:3015@evil.example","http://evil.example"))).toBe(false);
});
