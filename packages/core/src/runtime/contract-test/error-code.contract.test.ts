/**
 * runtime/contract-test/error-code.contract.test.ts — Error Code 契约测试
 *
 * 验证 AgentRuntimeError 携带 code；新增 code 在抛出与捕获时保持稳定。
 */

import { describe, it, expect } from "vitest";
import { AgentRuntimeError } from "../protocol";
import type { AgentErrorCode } from "../protocol";

describe("AgentErrorCode contract test", function errorCodeContractSuite() {
  it("AgentRuntimeError 携带 code 与 message", function errorCarriesCode() {
    const error = new AgentRuntimeError("SESSION_NOT_FOUND", "Session 不存在");
    expect(error.code).toBe("SESSION_NOT_FOUND");
    expect(error.message).toBe("Session 不存在");
    expect(error.name).toBe("AgentRuntimeError");
    expect(error).toBeInstanceOf(Error);
  });

  it("AgentRuntimeError 携带 cause", function errorCarriesCause() {
    const cause = new Error("底层错误");
    const error = new AgentRuntimeError("RUNTIME_ERROR", "包装错误", cause);
    expect(error.cause).toBe(cause);
  });

  it("Phase 3 新增 code 在抛出与捕获时保持稳定", function newCodesStable() {
    const newCodes: AgentErrorCode[] = [
      "PROJECT_NOT_FOUND",
      "INVALID_RUN_CONFIG",
      "PROVIDER_UNAUTHORIZED",
      "MODEL_NOT_FOUND",
      "TURN_FROZEN_MISMATCH",
      "CREDENTIAL_REF_INVALID",
    ];

    for (const code of newCodes) {
      const error = new AgentRuntimeError(code, `测试 ${code}`);
      expect(error.code).toBe(code);
    }
  });

  it("Phase 2 既有 code 保持稳定", function legacyCodesStable() {
    const legacyCodes: AgentErrorCode[] = [
      "SESSION_NOT_FOUND",
      "TURN_NOT_FOUND",
      "TURN_ALREADY_RUNNING",
      "CHECKPOINT_NOT_FOUND",
      "NOT_IMPLEMENTED",
      "RUNTIME_ERROR",
    ];

    for (const code of legacyCodes) {
      const error = new AgentRuntimeError(code, `测试 ${code}`);
      expect(error.code).toBe(code);
    }
  });
});
