/**
 * runtime/contract-test/autopilot-settings.contract.test.ts — CC-compatible settings 纯函数契约。
 *
 * 只验证 Claude Code 风格顶层 env/model 结构、安全 scope 与脱敏快照；不兼容旧 schemaVersion 配置。
 */

import { describe, expect, it } from "vitest";
import { normalizeProviderBaseUrl, resolveAutopilotSettings } from "../config/autopilot-settings";

/** 视觉角色只引用 User catalog，项目不能替换连接或重新启用已关闭的角色。 */
it("User 视觉角色引用与关闭状态受控，非法协议和项目覆盖拒绝", function userVisionRole() {
  const route = { id: "visual", apiProtocol: "openai-chat-completions", baseUrl: "https://vision.fixture/v1", credentialRef: { provider: "visual", key: "VISION" }, models: [{ id: "image-model" }] };
  const user = { providerRoutes: { visual: route }, visionModel: "visual/image-model" };
  const valid = resolveAutopilotSettings([{ scope: "user", value: user }]);
  expect(valid.visionModelRef).toEqual({ provider: "visual", modelId: "image-model" });
  expect(valid.diagnostics).toEqual([]);
  const disabled = resolveAutopilotSettings([{ scope: "user", value: { ...user, visionModel: false } }, { scope: "project", value: { visionModel: "visual/image-model" } }]);
  expect(disabled.visionModelRef).toBe(false);
  expect(disabled.diagnostics).toContainEqual({ scope: "project", code: "SETTINGS_MODEL_NOT_ALLOWED", field: "visionModel" });
  const invalid = resolveAutopilotSettings([{ scope: "user", value: { ...user, providerRoutes: { visual: { ...route, apiProtocol: "anthropic-messages" } } } }]);
  expect(invalid.visionModelRef).toBe(false);
  expect(invalid.diagnostics.some(function vision(diagnostic) { return diagnostic.field === "visionModel"; })).toBe(true);
});

describe("Autopilot settings contract", function settingsContractSuite() {
  it("maxTurns 按 User/Project/Local 优先级解析正整数且不设固定平台封顶", function resolvesMaxTurns() {
    const settings = resolveAutopilotSettings([
      { scope: "user", value: { maxTurns: 150 } },
      { scope: "project", value: { maxTurns: 500 } },
      { scope: "local", value: { maxTurns: 0 } },
    ]);
    expect(settings.maxTurns).toBe(500);
    expect(settings.diagnostics).toContainEqual({ scope: "local", code: "SETTINGS_VALUE_OUT_OF_RANGE", field: "maxTurns" });
    expect(resolveAutopilotSettings([]).maxTurns).toBeUndefined();
  });
  it("将四个 RAG 角色解析为独立的非敏感连接快照", function resolvesIndependentRagConnections() {
    const settings = resolveAutopilotSettings([{
      scope: "user",
      value: {
        env: {
          RAG_TEXT_RERANK_API_KEY: "fixture-text-rerank",
          RAG_VISION_RERANK_API_KEY: "fixture-vision-rerank",
          RAG_TEXT_EMBEDDING_API_KEY: "fixture-text-embedding",
          RAG_MULTIMODAL_EMBEDDING_API_KEY: "fixture-multimodal-embedding",
        },
        rag: {
          textRerank: { provider: "bailian", baseUrl: "https://rerank.fixture", model: "text-rerank" },
          visionRerank: { provider: "bailian", baseUrl: "https://rerank.fixture", model: "vision-rerank" },
          textEmbedding: { provider: "openai-compatible", baseUrl: "https://embedding.fixture/v1", model: "text-embedding", dimension: 1024 },
          multimodalEmbedding: { provider: "dashscope", baseUrl: "https://embedding.fixture/multimodal", model: "multimodal-embedding", dimension: 1152 },
        },
      },
    }]);

    expect(settings.diagnostics).toEqual([]);
    expect(settings.rag.textRerank).toMatchObject({ provider: "bailian", model: "text-rerank", credentialRef: { provider: "rag-textRerank", key: "RAG_TEXT_RERANK_API_KEY" } });
    expect(settings.rag.visionRerank?.credentialRef).toEqual({ provider: "rag-visionRerank", key: "RAG_VISION_RERANK_API_KEY" });
    expect(settings.rag.textEmbedding).toMatchObject({ provider: "openai-compatible", dimension: 1024 });
    expect(settings.rag.multimodalEmbedding).toMatchObject({ provider: "dashscope", dimension: 1152 });
    expect(JSON.stringify(settings)).not.toContain("fixture-text-rerank");
    expect(JSON.stringify(settings)).not.toContain("fixture-multimodal-embedding");
  });

  it("拒绝不完整 RAG 角色且不从其他角色拼接凭据", function rejectsIncompleteRagConnections() {
    const settings = resolveAutopilotSettings([{
      scope: "user",
      value: {
        env: { RAG_TEXT_RERANK_API_KEY: "fixture-only-other-role" },
        rag: {
          visionRerank: { provider: "bailian", baseUrl: "https://rerank.fixture", model: "vision-rerank" },
          textEmbedding: { provider: "openai-compatible", baseUrl: "https://embedding.fixture/v1", model: "text-embedding" },
        },
      },
    }]);

    expect(settings.rag).toEqual({});
    expect(settings.diagnostics).toEqual(expect.arrayContaining([
      { scope: "user", code: "SETTINGS_RAG_CONNECTION_INVALID", field: "rag.visionRerank" },
      { scope: "user", code: "SETTINGS_RAG_CONNECTION_INVALID", field: "rag.textEmbedding" },
    ]));
  });

  it("只消费 User 的 CC env，并按 env ANTHROPIC_MODEL 优先级生成不含认证原文的 firstParty 快照", function resolvesCcUserSettingsWithoutSecrets() {
    const settings = resolveAutopilotSettings([{
      scope: "user",
      value: {
        env: {
          ANTHROPIC_AUTH_TOKEN: "fixture-auth-token",
          ANTHROPIC_BASE_URL: "https://provider.example/anthropic/",
          ANTHROPIC_MODEL: "provider-main[1m]",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "provider-fast",
          CLAUDE_CODE_SUBAGENT_MODEL: "provider-subagent",
          CLAUDE_CODE_EFFORT_LEVEL: "max",
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432",
          API_TIMEOUT_MS: "120000",
          UNRELATED_VALUE: "must-not-enter-runtime",
        },
        model: "haiku",
        availableModels: ["provider-main[1m]", "provider-fast", "provider-subagent"],
        modelOverrides: { "provider-old": "provider-main[1m]" },
        maxOutputTokens: 65536,
        alwaysThinkingEnabled: false,
        permissions: { allow: ["*"] },
      },
    }]);

    expect(settings.modelRef).toEqual({ provider: "firstParty", modelId: "provider-main[1m]" });
    expect(settings.modelSource).toBe("environment");
    expect(settings.reasoningProfile).toEqual({ effort: "max" });
    expect(settings.firstParty).toEqual({
      baseUrl: "https://provider.example/anthropic",
      credentialRef: { provider: "firstParty", key: "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN" },
      subagentModelId: "provider-subagent",
      maxOutputTokens: 65536,
      compactWindow: 786432,
      timeoutMs: 120000,
      thinkingEnabled: false,
    });
    expect(settings.availableModels).toEqual(["provider-main[1m]", "provider-fast", "provider-subagent"]);
    expect(settings.modelCandidates).toEqual(["provider-main[1m]", "provider-fast", "provider-subagent"]);
    expect(settings.modelOverrides).toEqual({ "provider-old": "provider-main[1m]" });
    expect(JSON.stringify(settings)).not.toContain("fixture-auth-token");
    expect(JSON.stringify(settings)).not.toContain("must-not-enter-runtime");
  });

  it("只接受 User scope 的单次输出上限并拒绝越界值", function validatesMaxOutputTokens() {
    const settings = resolveAutopilotSettings([
      { scope: "user", value: { maxOutputTokens: 65536 } },
      { scope: "project", value: { maxOutputTokens: 32768 } },
      { scope: "local", value: { maxOutputTokens: 0 } },
    ]);

    expect(settings.firstParty.maxOutputTokens).toBe(65536);
    expect(settings.diagnostics).toEqual(expect.arrayContaining([
      { scope: "project", code: "SETTINGS_OUTPUT_TOKENS_SCOPE_FORBIDDEN", field: "maxOutputTokens" },
      { scope: "local", code: "SETTINGS_VALUE_OUT_OF_RANGE", field: "maxOutputTokens" },
      { scope: "local", code: "SETTINGS_OUTPUT_TOKENS_SCOPE_FORBIDDEN", field: "maxOutputTokens" },
    ]));
  });

  it("Project/Local 不能通过 env 注入认证、endpoint 或模型映射，且只能选择 User allowlist 中的模型", function rejectsSensitiveScopeOverrides() {
    const settings = resolveAutopilotSettings([
      { scope: "user", value: { model: "provider-main", availableModels: ["provider-main", "provider-fast"] } },
      { scope: "project", value: { env: { ANTHROPIC_AUTH_TOKEN: "project-token", ANTHROPIC_BASE_URL: "https://project.example", ANTHROPIC_DEFAULT_HAIKU_MODEL: "project-fast" }, model: "provider-fast" } },
      { scope: "local", value: { env: { ANTHROPIC_MODEL: "local-model" }, model: "outside-user-list" } },
    ]);

    expect(settings.modelRef).toEqual({ provider: "firstParty", modelId: "provider-fast" });
    expect(settings.firstParty).toEqual({});
    expect(settings.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "SETTINGS_SECRET_SCOPE_FORBIDDEN",
      "SETTINGS_ENDPOINT_SCOPE_FORBIDDEN",
      "SETTINGS_ENV_SCOPE_FORBIDDEN",
      "SETTINGS_MODEL_NOT_ALLOWED",
    ]));
    expect(JSON.stringify(settings)).not.toContain("project-token");
  });

  it("CC alias、effort 值域和单跳 modelOverrides 均 fail closed", function validatesCcAliasesEffortAndOverrides() {
    const settings = resolveAutopilotSettings([
      { scope: "user", value: { model: "haiku", effortLevel: "max", modelOverrides: { first: "second", second: "third" } } },
      { scope: "local", value: { effortLevel: "medium" } },
      { scope: "user", value: { env: { CLAUDE_CODE_EFFORT_LEVEL: "unset" } } },
    ]);

    expect(settings.modelRef).toBeUndefined();
    expect(settings.reasoningProfile).toBeUndefined();
    expect(settings.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "SETTINGS_MODEL_ALIAS_UNRESOLVED",
      "SETTINGS_EFFORT_INVALID",
      "SETTINGS_MODEL_OVERRIDE_INVALID",
    ]));
  });

  it("未配置 availableModels 时按 Claude Code 默认模型 alias 构造可切换目录", function derivesCandidatesFromCcDefaultAliases() {
    const settings = resolveAutopilotSettings([{
      scope: "user",
      value: {
        model: "haiku",
        env: {
          ANTHROPIC_DEFAULT_OPUS_MODEL: "provider-pro",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "provider-standard",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "provider-fast",
        },
      },
    }]);

    expect(settings.availableModels).toEqual([]);
    expect(settings.modelRef).toEqual({ provider: "firstParty", modelId: "provider-fast" });
    expect(settings.modelCandidates).toEqual(["provider-fast", "provider-pro", "provider-standard"]);
  });

  it("将 env alias、单跳 override、allowlist 与 subagent 在同一快照内收敛", function routesCcModelsDeterministically() {
    const settings = resolveAutopilotSettings([{
      scope: "user",
      value: {
        env: {
          ANTHROPIC_MODEL: "opus",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "provider-opus[1m]",
          CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "provider-haiku",
        },
        availableModels: ["provider-main[1m]", "provider-subagent"],
        modelOverrides: {
          "provider-opus[1m]": "provider-main[1m]",
          "provider-haiku": "provider-subagent",
        },
      },
    }]);

    expect(settings.modelRef).toEqual({ provider: "firstParty", modelId: "provider-main[1m]" });
    expect(settings.firstParty.subagentModelId).toBe("provider-subagent");
    expect(settings.diagnostics).toEqual([]);
  });

  it("allowlist 不包含最终 route 时拒绝主模型和子模型", function rejectsModelsOutsideFinalAllowlist() {
    const settings = resolveAutopilotSettings([{
      scope: "user",
      value: {
        model: "provider-main",
        availableModels: ["provider-allowed"],
        env: { CLAUDE_CODE_SUBAGENT_MODEL: "provider-subagent" },
      },
    }]);

    expect(settings.modelRef).toBeUndefined();
    expect(settings.firstParty.subagentModelId).toBeUndefined();
    expect(settings.diagnostics.filter((item) => item.code === "SETTINGS_MODEL_NOT_ALLOWED")).toHaveLength(2);
  });

  it("拒绝旧 schemaVersion 配置，不自动转换 models 或 providers 结构", function rejectsLegacySettingsWithoutMigration() {
    const settings = resolveAutopilotSettings([{
      scope: "user",
      value: {
        schemaVersion: 2,
        models: { primary: { provider: "legacy-route", modelId: "legacy-model", apiKey: "legacy-key" } },
        providers: { "legacy-route": { baseUrl: "https://legacy.example" } },
      },
    }]);

    expect(settings.modelRef).toBeUndefined();
    expect(settings.firstParty).toEqual({});
    expect(settings.diagnostics).toContainEqual({ scope: "user", code: "SETTINGS_SCHEMA_VERSION_UNSUPPORTED", field: "schemaVersion" });
    expect(JSON.stringify(settings)).not.toContain("legacy-key");
  });

  it("端点规范化拒绝 userinfo、query、fragment 与非 HTTP 协议", function validatesEndpoint() {
    expect(normalizeProviderBaseUrl("https://example.com/v1/")).toBe("https://example.com/v1");
    expect(normalizeProviderBaseUrl("file:///tmp/test")).toBeUndefined();
    expect(normalizeProviderBaseUrl("https://user@example.com/v1")).toBeUndefined();
    expect(normalizeProviderBaseUrl("https://example.com/v1#part")).toBeUndefined();
  });

  it("只接受 User scope 的任意显式第三方 route，并冻结封闭 compat profile", function resolvesTrustedProviderRoutes() {
    const settings = resolveAutopilotSettings([{
      scope: "user",
      value: {
        providerRoutes: {
          "gateway-route": {
            id: "gateway-route",
            apiProtocol: "openai-chat-completions",
            baseUrl: "https://provider.example/v1/",
            credentialRef: { provider: "gateway-route", key: "USER_SETTINGS_GATEWAY_KEY" },
            protocolProfile: {
              apiProtocol: "openai-chat-completions",
              assistantToolCallContent: "empty-string",
              supportsReasoningContent: true,
              supportsUsageInStreaming: true,
            },
            models: [{ id: "gateway-chat" }],
          },
        },
      },
    }]);

    expect(settings.providerRoutes["gateway-route"]).toMatchObject({
      apiProtocol: "openai-chat-completions",
      baseUrl: "https://provider.example/v1",
      credentialRef: { provider: "gateway-route", key: "USER_SETTINGS_GATEWAY_KEY" },
    });
    expect(settings.diagnostics).toEqual([]);
  });

  it("第三方 route 缺失字段、跨 scope 或错误 profile 时拒绝进入快照", function rejectsInvalidProviderRoutes() {
    const settings = resolveAutopilotSettings([
      { scope: "user", value: { providerRoutes: { bad: { id: "bad", apiProtocol: "openai-chat-completions", baseUrl: "https://provider.example", credentialRef: { provider: "bad", key: "KEY" }, models: [{ id: "model", protocolProfile: { apiProtocol: "openai-chat-completions", extraProfileField: "unsupported", assistantToolCallContent: "empty-string", supportsReasoningContent: true, supportsUsageInStreaming: true } }] } } } },
      { scope: "project", value: { providerRoutes: {} } },
    ]);

    expect(settings.providerRoutes).toEqual({});
    expect(settings.diagnostics.map(function getCode(item) { return item.code; })).toEqual(expect.arrayContaining([
      "SETTINGS_PROVIDER_ROUTE_INVALID",
      "SETTINGS_PROVIDER_ROUTE_SCOPE_FORBIDDEN",
    ]));
  });

  it("保留 route 模型的受信 contextWindowTokens，缺省字段与现状逐字段一致", function preservesRouteModelContextWindowTokens() {
    const settings = resolveAutopilotSettings([{
      scope: "user",
      value: {
        providerRoutes: {
          "gateway-route": {
            id: "gateway-route",
            apiProtocol: "openai-chat-completions",
            baseUrl: "https://provider.example/v1",
            credentialRef: { provider: "gateway-route", key: "USER_SETTINGS_GATEWAY_KEY" },
            models: [{ id: "gateway-chat", contextWindowTokens: 262_144 }, { id: "gateway-fast" }],
          },
        },
      },
    }]);

    expect(settings.providerRoutes["gateway-route"]?.models).toEqual([
      { id: "gateway-chat", contextWindowTokens: 262_144 },
      { id: "gateway-fast" },
    ]);
    expect(settings.diagnostics).toEqual([]);
  });

  it("route 模型的 contextWindowTokens 越界或类型非法时整体拒绝 route", function rejectsInvalidRouteModelContextWindowTokens() {
    for (const invalid of [0, -1, 1.5, 10_000_001, "262144"]) {
      const settings = resolveAutopilotSettings([{
        scope: "user",
        value: {
          providerRoutes: {
            "gateway-route": {
              id: "gateway-route",
              apiProtocol: "openai-chat-completions",
              baseUrl: "https://provider.example/v1",
              credentialRef: { provider: "gateway-route", key: "USER_SETTINGS_GATEWAY_KEY" },
              models: [{ id: "gateway-chat", contextWindowTokens: invalid as number }],
            },
          },
        },
      }]);

      expect(settings.providerRoutes).toEqual({});
      expect(settings.diagnostics).toContainEqual({ scope: "user", code: "SETTINGS_PROVIDER_ROUTE_INVALID", field: "providerRoutes" });
    }
  });

  it("保留顶层 provider/model，并把 route 模型加入可切换目录", function preservesProviderModelSelection() {
    const settings = resolveAutopilotSettings([{
      scope: "user",
      value: {
        model: "gateway-route/gateway-chat",
        availableModels: ["provider-fast"],
        providerRoutes: {
          "gateway-route": {
            id: "gateway-route",
            apiProtocol: "openai-chat-completions",
            baseUrl: "https://provider.example/v1",
            credentialRef: { provider: "gateway-route", key: "USER_SETTINGS_GATEWAY_KEY" },
            models: [{ id: "gateway-chat" }, { id: "gateway-fast" }],
          },
        },
      },
    }]);

    expect(settings.modelRef).toEqual({ provider: "gateway-route", modelId: "gateway-chat" });
    expect(settings.modelCandidates).toEqual(["provider-fast", "gateway-route/gateway-chat", "gateway-route/gateway-fast"]);
    expect(settings.diagnostics).toEqual([]);
  });

  /** 验证 Web Search 只从 User scope 接受完整连接，且不复制明文 Key。 */
  it("解析 User scope 的完整 Web Search 连接", function resolvesUserWebSearchCredentialReference() {
    const settings = resolveAutopilotSettings([{
      scope: "user",
      value: {
        ignoredSecret: "fixture-secret-must-not-enter-snapshot",
        webSearch: { provider: "openai-compatible", baseUrl: "https://search.fixture/v1/", model: "search-model", credentialRef: { provider: "openai-compatible", key: "USER_SETTINGS_SEARCH_API_KEY" } },
      },
    }]);

    expect(settings.webSearch).toEqual({
      provider: "openai-compatible", baseUrl: "https://search.fixture/v1", model: "search-model",
      credentialRef: { provider: "openai-compatible", key: "USER_SETTINGS_SEARCH_API_KEY" },
    });
    expect(JSON.stringify(settings)).not.toContain("fixture-secret-must-not-enter-snapshot");
    expect(settings.diagnostics).toEqual([]);
  });

  /** 验证非 User 覆盖、额外字段和空凭据引用全部 fail closed。 */
  it("拒绝跨 scope 或非严格 CredentialRef 的 Web Search 设置", function rejectsUnsafeWebSearchSettings() {
    const settings = resolveAutopilotSettings([
      { scope: "user", value: { webSearch: { provider: "openai-compatible", baseUrl: "file:///unsafe", model: "override", credentialRef: { provider: "openai-compatible", key: "SEARCH_KEY" } } } },
      { scope: "project", value: { webSearch: { credentialRef: { provider: "search-provider", key: "PROJECT_KEY" } } } },
      { scope: "local", value: { webSearch: { credentialRef: { provider: "search-provider", key: "LOCAL_KEY" } } } },
    ]);

    expect(settings.webSearch).toBeUndefined();
    expect(settings.diagnostics).toContainEqual({ scope: "user", code: "SETTINGS_WEB_SEARCH_INVALID", field: "webSearch" });
    expect(settings.diagnostics).toContainEqual({ scope: "project", code: "SETTINGS_WEB_SEARCH_SCOPE_FORBIDDEN", field: "webSearch" });
    expect(settings.diagnostics).toContainEqual({ scope: "local", code: "SETTINGS_WEB_SEARCH_SCOPE_FORBIDDEN", field: "webSearch" });
  });

  /** Talk-Plan0917 Stage 2：sandbox 字段的 scope 收窄、deny 并集与危险值拒绝。 */
  it("sandbox mode 与 allowlist 仅 User 可声明，deny 列表跨 scope 并集收窄", function sandboxSettingsContract() {
    const settings = resolveAutopilotSettings([
      { scope: "user", value: { sandbox: { mode: "read-only", allowedDomains: ["registry.npmjs.org"], deniedRead: ["/secret"] } } },
      { scope: "project", value: { sandbox: { allowedDomains: ["evil.example.com"], deniedRead: ["/ws/.env"] } } },
      { scope: "local", value: { sandbox: { deniedWrite: ["/outside"] } } },
    ]);
    expect(settings.sandbox.mode).toBe("read-only");
    expect(settings.sandbox.allowedDomains).toEqual(["registry.npmjs.org"]);
    expect(settings.sandbox.deniedRead).toEqual(["/secret", "/ws/.env"]);
    expect(settings.sandbox.deniedWrite).toEqual(["/outside"]);
    expect(settings.diagnostics).toContainEqual({ scope: "project", code: "SETTINGS_SANDBOX_SCOPE_FORBIDDEN", field: "sandbox.allowedDomains" });
  });

  it("sandbox 拒绝 danger-full-access、裸 * 通配与未知字段", function sandboxSettingsRejectsUnsafeValues() {
    const settings = resolveAutopilotSettings([
      { scope: "user", value: { sandbox: { mode: "danger-full-access" } } },
      { scope: "user", value: { sandbox: { allowedDomains: ["*"] } } },
      { scope: "user", value: { sandbox: { unknownField: true } } },
    ]);
    expect(settings.sandbox.mode).toBeUndefined();
    expect(settings.sandbox.allowedDomains).toEqual([]);
    expect(settings.diagnostics).toContainEqual({ scope: "user", code: "SETTINGS_SANDBOX_MODE_FORBIDDEN", field: "sandbox.mode" });
    expect(settings.diagnostics).toContainEqual({ scope: "user", code: "SETTINGS_SANDBOX_INVALID", field: "sandbox.allowedDomains" });
    expect(settings.diagnostics).toContainEqual({ scope: "user", code: "SETTINGS_SANDBOX_INVALID", field: "sandbox" });
  });
});
