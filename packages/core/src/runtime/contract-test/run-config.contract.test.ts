/**
 * runtime/contract-test/run-config.contract.test.ts — RunConfig 三层优先级契约测试
 *
 * 验证 resolveRunConfig 的 Project → Session → Turn 三层优先级合并：
 * - turnOverride 优先级最高
 * - sessionDefault 次之
 * - projectDefault 最低
 * - runtimeDefault 仅提供 workspaceRoot 兜底
 */

import { describe, it, expect } from "vitest";
import { AGENT_RUNTIME_SAFETY_DEFAULTS, AGENT_RUNTIME_SAFETY_HARD_LIMITS, resolveAgentRuntimeLimits, resolveAgentRuntimeSafetyLimits, resolveRunConfig } from "../protocol";
import type { SessionRunConfig } from "../domain";
import type { RunConfig } from "../protocol";

describe("resolveRunConfig contract test", function runConfigContractSuite() {
  it("turnOverride 优先级最高，覆盖 sessionDefault 与 projectDefault", function turnOverrideWins() {
    const projectDefault: SessionRunConfig = { permissionMode: "ask", maxSteps: 5 };
    const sessionDefault: SessionRunConfig = { permissionMode: "auto_approve", maxSteps: 10 };
    const turnOverride: Partial<RunConfig> = { permissionMode: "full_access", maxSteps: 20 };

    const frozen = resolveRunConfig({ projectDefault, sessionDefault, turnOverride });

    expect(frozen.permissionMode).toBe("full_access");
    expect(frozen.maxSteps).toBe(20);
  });

  it("turnOverride 缺省时使用 sessionDefault", function sessionDefaultFallback() {
    const projectDefault: SessionRunConfig = { permissionMode: "ask", maxSteps: 5 };
    const sessionDefault: SessionRunConfig = { permissionMode: "auto_approve", maxSteps: 10 };

    const frozen = resolveRunConfig({ projectDefault, sessionDefault });

    expect(frozen.permissionMode).toBe("auto_approve");
    expect(frozen.maxSteps).toBe(10);
  });

  it("sessionDefault 缺省时使用 projectDefault", function projectDefaultFallback() {
    const projectDefault: SessionRunConfig = { permissionMode: "ask", maxSteps: 5 };

    const frozen = resolveRunConfig({ projectDefault });

    expect(frozen.permissionMode).toBe("ask");
    expect(frozen.maxSteps).toBe(5);
  });

  it("三层都缺省时不启用总 step 闸门，但保留工具重试默认值", function leavesStepLimitUnset() {
    const frozen = resolveRunConfig({});

    expect(frozen.permissionMode).toBeUndefined();
    expect(frozen.maxSteps).toBeUndefined();
    expect(frozen.maxToolRetries).toBe(5);
    expect(frozen.modelRef).toBeUndefined();
  });

  it("Turn 覆盖优先，步数按显式值保留且工具重试仍有硬上限", function resolvesLimitOverridesOnce() {
    const frozen = resolveRunConfig({
      projectDefault: { maxSteps: 20, maxToolRetries: 3 },
      sessionDefault: { maxSteps: 30, maxToolRetries: 4 },
      turnOverride: { maxSteps: 500, maxToolRetries: 99 },
    });

    expect(frozen.maxSteps).toBe(500);
    expect(frozen.maxToolRetries).toBe(10);
    expect(resolveAgentRuntimeLimits({ maxSteps: 0, maxToolRetries: 0 })).toEqual({ maxSteps: undefined, maxToolRetries: 5 });
  });

  it("显式 maxSteps=1 仍保留可恢复的总步数保护", function keepsExplicitStepLimit() {
    expect(resolveRunConfig({ turnOverride: { maxSteps: 1 } }).maxSteps).toBe(1);
  });

  it("时长与 token 默认关闭，显式时长不封顶但 token 仍受硬上限约束", function freezesPerTurnSafetyBudget() {
    const defaults = resolveRunConfig({});
    expect(defaults.maxDurationMs).toBeUndefined();
    expect(defaults.maxTotalTokens).toBeUndefined();
    expect(defaults.safetyBudgetVersion).toBe(2);

    const capped = resolveRunConfig({ turnOverride: { maxDurationMs: Number.MAX_SAFE_INTEGER, maxTotalTokens: Number.MAX_SAFE_INTEGER } });
    expect(capped.maxDurationMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(capped.maxTotalTokens).toBe(AGENT_RUNTIME_SAFETY_HARD_LIMITS.maxTotalTokens);
    expect(resolveRunConfig({ turnOverride: { maxTotalTokens: 250_000 } }).maxTotalTokens).toBe(250_000);
    expect(resolveAgentRuntimeSafetyLimits({ maxDurationMs: 0, maxTotalTokens: 0 })).toEqual(AGENT_RUNTIME_SAFETY_DEFAULTS);
  });

  it("modelRef / reasoningProfile / credentialRef 也遵循三层优先级", function refsPriority() {
    const projectDefault: SessionRunConfig = {
      modelRef: { provider: "deepseek", modelId: "deepseek-chat" },
      credentialRef: { provider: "deepseek", key: "PROJECT_KEY" },
    };
    const sessionDefault: SessionRunConfig = {
      modelRef: { provider: "openai", modelId: "gpt-4o" },
    };
    const turnOverride: Partial<RunConfig> = {
      credentialRef: { provider: "openai", key: "TURN_KEY" },
    };

    const frozen = resolveRunConfig({ projectDefault, sessionDefault, turnOverride });

    expect(frozen.modelRef?.provider).toBe("openai");
    expect(frozen.modelRef?.modelId).toBe("gpt-4o");
    expect(frozen.credentialRef?.key).toBe("TURN_KEY");
  });

  it("workspaceRoot 从 turnOverride 或 runtimeDefault 获取", function workspaceRootSource() {
    const frozen1 = resolveRunConfig({
      turnOverride: { workspaceRoot: "/tmp/turn" },
      runtimeDefault: { workspaceRoot: "/tmp/runtime" },
    });
    expect(frozen1.workspaceRoot).toBe("/tmp/turn");

    const frozen2 = resolveRunConfig({
      runtimeDefault: { workspaceRoot: "/tmp/runtime" },
    });
    expect(frozen2.workspaceRoot).toBe("/tmp/runtime");
  });

  it("workspaceTrusted 只能由 Runtime 默认配置注入", function workspaceTrustIsRuntimeOnly() {
    const untrusted = resolveRunConfig({
      turnOverride: { workspaceTrusted: true },
      runtimeDefault: { workspaceTrusted: false },
    });
    expect(untrusted.workspaceTrusted).toBe(false);

    const trusted = resolveRunConfig({
      turnOverride: { workspaceTrusted: false },
      runtimeDefault: { workspaceTrusted: true },
    });
    expect(trusted.workspaceTrusted).toBe(true);
  });
});
