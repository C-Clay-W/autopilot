/**
 * node/stores/node-credential-store.test.ts — 用户 settings 凭据按需读取契约
 *
 * 验证用户级明文 Key 不进入 Core 快照，且只接受 Claude Code env 认证字段。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeCredentialStore } from "./node-credential-store";

const temporaryDirectories: string[] = [];

afterEach(function removeTemporaryDirectories() {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Node CredentialStore", function nodeCredentialStoreSuite() {
  it("仅在 firstParty CredentialRef 被解析时读取 User settings env", async function readsUserSettingsOnDemand() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-settings-"));
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "fixture-user-key" } }), "utf8");
    const store = createNodeCredentialStore({ env: {}, userSettingsPath: settingsPath });
    await expect(store.resolve({ provider: "firstParty", key: "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN" })).resolves.toEqual({ apiKey: "fixture-user-key" });
  });

  it("保留通用 CredentialRef 的环境变量兜底", async function keepsEnvironmentCompatibility() {
    const store = createNodeCredentialStore({ env: { FIRSTPARTY_EXISTING_KEY: "fixture-env-key" } });
    await expect(store.resolve({ provider: "firstParty", key: "existing_key" })).resolves.toEqual({ apiKey: "fixture-env-key" });
  });

  it("旧 USER_SETTINGS_API_KEY 不再从 settings 结构读取", async function rejectsLegacySettingsCredentialReference() {
    const store = createNodeCredentialStore({ env: {} });
    await expect(store.resolve({ provider: "firstParty", key: "USER_SETTINGS_API_KEY" })).rejects.toThrow("FIRSTPARTY_USER_SETTINGS_API_KEY");
  });

  it("按任意 route 的命名引用读取 User settings，并拒绝 ambient fallback", async function isolatesNamedRouteCredentials() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-route-settings-"));
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { GATEWAY_KEY: "fixture-gateway-key" } }), "utf8");
    const store = createNodeCredentialStore({ env: { GATEWAY_ROUTE_USER_SETTINGS_GATEWAY_KEY: "wrong-ambient-key" }, userSettingsPath: settingsPath });

    await expect(store.resolve({ provider: "gateway-route", key: "USER_SETTINGS_GATEWAY_KEY" })).resolves.toEqual({ apiKey: "fixture-gateway-key" });
    await expect(store.resolve({ provider: "gateway-route", key: "USER_SETTINGS_MISSING_KEY" })).rejects.toThrow("凭据未配置");
  });
});
