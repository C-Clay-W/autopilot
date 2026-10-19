/**
 * Stage4 设置集成测试：验证分类保存后的同一 User settings 快照可驱动 Search 与 RAG 装配。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAutopilotSettings } from "../../core/src/runtime/config/autopilot-settings";
import { createNodeCapabilityLoader } from "../src/node/create-node-capability-loader";
import { createNodeRagRuntime } from "../src/node/rag/node-rag-runtime";
import { createNodeUserSettingsService } from "../src/node/settings/node-user-settings-service";

const temporaryRoots: string[] = [];

/** 创建隔离 Home 与工作区，避免读取真实用户设置。 */
function createFixture(): { homeDirectory: string; workspaceRoot: string } {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-stage4-home-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-stage4-workspace-"));
  temporaryRoots.push(homeDirectory, workspaceRoot);
  return { homeDirectory, workspaceRoot };
}

/** 清理本文件创建的隔离目录。 */
afterEach(function removeFixtures() {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Stage4 shared settings integration", function stage4SharedSettingsSuite() {
  it("分类保存后同一快照贯通主模型、Search 与四个 RAG 角色", async function assemblesAllConnectionsFromPersistedSettings() {
    const { homeDirectory, workspaceRoot } = createFixture();
    const service = createNodeUserSettingsService({ homeDirectory });
    const main = await service.saveMainCategory({
      main: {
        baseUrl: "https://main.fixture/anthropic",
        model: "main-pro[1m]",
        apiKey: "fixture-main-key",
        availableModels: ["main-pro[1m]", "main-fast"],
        effort: "max",
        compactWindow: 786432,
        timeoutMs: 120000,
        alwaysThinkingEnabled: true,
      },
      search: {
        enabled: true,
        useMainKey: false,
        provider: "openai-compatible",
        baseUrl: "https://search.fixture/v1",
        model: "search-model",
        apiKey: "fixture-search-key",
      },
    });
    await service.saveRag({
      textRerank: { provider: "bailian", baseUrl: "https://text-rerank.fixture", model: "text-rerank", apiKey: "fixture-text-rerank-key" },
      visionRerank: { provider: "bailian", baseUrl: "https://vision-rerank.fixture", model: "vision-rerank", apiKey: "fixture-vision-rerank-key" },
      textEmbedding: { provider: "openai-compatible", baseUrl: "https://text-embedding.fixture/v1", model: "text-embedding", dimension: 1024, apiKey: "fixture-text-embedding-key" },
      multimodalEmbedding: { provider: "dashscope", baseUrl: "https://multimodal-embedding.fixture", model: "multimodal-embedding", dimension: 1152, apiKey: "fixture-multimodal-embedding-key" },
    }, main.revision);

    const settingsPath = path.join(homeDirectory, ".autopilot", "settings.json");
    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const settings = resolveAutopilotSettings([{ scope: "user", value: saved }]);
    expect(settings).toMatchObject({
      modelRef: { provider: "firstParty", modelId: "main-pro[1m]" },
      reasoningProfile: { effort: "max" },
      firstParty: { baseUrl: "https://main.fixture/anthropic", compactWindow: 786432, timeoutMs: 120000, thinkingEnabled: true },
      webSearch: { provider: "openai-compatible", baseUrl: "https://search.fixture/v1", model: "search-model" },
    });
    const settingsLoader = {
      load: function load() { return { settings, paths: { user: settingsPath, project: "C:/redacted", local: "C:/redacted" } }; },
      loadUser: function loadUser() { return { settings, paths: { user: settingsPath } }; },
    } as any;

    const request = vi.fn(async function respondToSearch() {
      return Response.json({ object: "response", status: "completed", output: [{ type: "web_search_call", status: "completed" }, { type: "message", status: "completed", content: [{ type: "output_text", text: "answer", annotations: [] }] }] });
    });
    const web = createNodeCapabilityLoader({ settingsLoader, env: {}, webSearchFetch: request as typeof fetch });
    await (await web.loadWeb(workspaceRoot))?.search?.search({ query: "public fixture" });
    expect(request.mock.calls[0][0]).toBe("https://search.fixture/v1/responses");
    expect(request.mock.calls[0][1]?.headers).toMatchObject({ authorization: "Bearer fixture-search-key" });
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({ model: "search-model" });

    const rag = createNodeRagRuntime({ settings, userSettingsPath: settingsPath, env: {} });
    expect(rag.rerank.defaultPolicy).toMatchObject({
      text: { baseUrl: "https://text-rerank.fixture", model: "text-rerank" },
      vision: { baseUrl: "https://vision-rerank.fixture", model: "vision-rerank" },
    });
    expect(rag.embedding.text).toMatchObject({ baseUrl: "https://text-embedding.fixture/v1", model: "text-embedding", dimension: 1024 });
    expect(rag.embedding.multimodal).toMatchObject({ baseUrl: "https://multimodal-embedding.fixture", model: "multimodal-embedding", dimension: 1152 });
    await expect(rag.rerank.resolveApiKey("text")).resolves.toBe("fixture-text-rerank-key");
    await expect(rag.rerank.resolveApiKey("vision")).resolves.toBe("fixture-vision-rerank-key");
    await expect(rag.embedding.text?.resolveApiKey()).resolves.toBe("fixture-text-embedding-key");
    await expect(rag.embedding.multimodal?.resolveApiKey()).resolves.toBe("fixture-multimodal-embedding-key");
  });
});
