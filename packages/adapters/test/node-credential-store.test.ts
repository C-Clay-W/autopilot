/**
 * node-credential-store.test.ts — User CC settings 的按引用凭据读取契约。
 *
 * 验证认证原文只在 Adapter resolve 阶段读取，Core settings 快照仅持有 CredentialRef。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeCredentialStore } from "../src/node/stores/node-credential-store";

const temporaryRoots: string[] = [];

/** 创建测试独占临时目录，并在本例结束时清理。 */
function createTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-credential-store-"));
  temporaryRoots.push(root);
  return root;
}

/** 清理由本测试创建的临时目录。 */
afterEach(function cleanTemporaryRoots() {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Node credential store", function nodeCredentialStoreSuite() {
  it("只按 firstParty CredentialRef 读取 User settings 中对应的 Anthropic 认证", async function resolvesCcCredentialsByReference() {
    const filePath = path.join(createTemporaryRoot(), "settings.json");
    fs.writeFileSync(filePath, JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "fixture-auth-token",
        ANTHROPIC_API_KEY: "fixture-api-key",
      },
    }));
    const store = createNodeCredentialStore({ userSettingsPath: filePath, env: {} });

    await expect(store.resolve({ provider: "firstParty", key: "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN" })).resolves.toEqual({ apiKey: "fixture-auth-token" });
    await expect(store.resolve({ provider: "firstParty", key: "USER_SETTINGS_ANTHROPIC_API_KEY" })).resolves.toEqual({ apiKey: "fixture-api-key" });
    await expect(store.resolve({ provider: "firstParty", key: "UNKNOWN_REFERENCE" })).rejects.toThrow("凭据未配置");
  });
});
