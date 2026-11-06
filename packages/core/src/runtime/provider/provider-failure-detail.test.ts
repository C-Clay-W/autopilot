/** Provider 通用失败标识的诊断与恢复边界回归。 */
import { describe, expect, it } from "vitest";
import { normalizeProviderHttpFailure } from "./provider-failure-normalization";
import { sanitizeAgentProviderFailureDetail } from "./provider-failure-guidance";

describe("通用上游失败标识", function testProviderFailureDetail() {
  it("未知网关标识可展示但不会把 429 猜成可重试限流", function preservesSafeIdentifierWithoutRetry() {
    expect(normalizeProviderHttpFailure("https://gateway.example", 429, JSON.stringify({ error: { code: "capacity_exhausted", message: "ignored" } }))).toEqual({ code: "PROVIDER_REQUEST_REJECTED", detail: "code:capacity_exhausted" });
    expect(normalizeProviderHttpFailure("https://other.example", 429, { error: { type: "quota_error" } })).toEqual({ code: "PROVIDER_REQUEST_REJECTED", detail: "type:quota_error" });
    expect(normalizeProviderHttpFailure("https://gateway.example", 503, { error: { code: "capacity_exhausted" } })).toEqual({ code: "PROVIDER_SERVER_ERROR", detail: "code:capacity_exhausted" });
  });
  it("拒绝自由文本、路径、凭据、堆栈和过长标识", function rejectsUnsafeIdentifiers() {
    for (const value of ["code:sk-secret", "type:password", "code:/private/path", "code:stack trace", "code:hello\nworld", "code:" + "x".repeat(33)]) expect(sanitizeAgentProviderFailureDetail(value)).toBeUndefined();
    expect(normalizeProviderHttpFailure("https://gateway.example", 400, { error: { message: "user content", code: "sk-secret" } })).toEqual({ code: "PROVIDER_REQUEST_REJECTED" });
  });
});
