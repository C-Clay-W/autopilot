/**
 * Node CredentialStore：按需从用户 settings 或环境变量解析 CredentialRef，真实凭据不进入 durable 状态。
 */

import fs from "node:fs";
import type { CredentialRef, CredentialStore, ResolvedCredential } from "@autopilot-agent/core";

/** Node 凭据解析器的受限来源；用户 settings 路径只能在 trust 后由宿主传入。 */
export interface CreateNodeCredentialStoreOptions {
  env?: NodeJS.ProcessEnv;
  userSettingsPath?: string;
  /** 操作开始时冻结凭据来源，后续文件修改只影响新实例。 */
  snapshot?: boolean;
}

/** 读取 User settings 中与 CredentialRef 精确匹配的认证；异常、未知结构或空值均按未配置处理。 */
function readUserSettingsCredential(filePath: string, ref: CredentialRef, snapshotContent?: string): string | undefined {
  try {
    const value: unknown = JSON.parse(snapshotContent ?? fs.readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const environment = (value as { env?: unknown }).env;
    if (environment && typeof environment === "object" && !Array.isArray(environment)) {
      const environmentRecord = environment as Record<string, unknown>;
      const key = ref.provider === "firstParty" && ref.key === "USER_SETTINGS_ANTHROPIC_AUTH_TOKEN" ? "ANTHROPIC_AUTH_TOKEN"
        : ref.provider === "firstParty" && ref.key === "USER_SETTINGS_ANTHROPIC_API_KEY" ? "ANTHROPIC_API_KEY"
          : ref.key;
      const credential = environmentRecord[key]
        ?? (ref.key.startsWith("USER_SETTINGS_") ? environmentRecord[ref.key.slice("USER_SETTINGS_".length)] : undefined);
      if (typeof credential === "string" && credential.trim()) return credential;
      return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 创建按需读取用户 CC settings 的凭据解析器。 */
export function createNodeCredentialStore(options: CreateNodeCredentialStoreOptions = {}): CredentialStore {
  const env = options.snapshot ? { ...(options.env ?? process.env) } : options.env ?? process.env;
  let snapshotContent: string | undefined;
  if (options.snapshot && options.userSettingsPath) {
    try { snapshotContent = fs.readFileSync(options.userSettingsPath, "utf8"); } catch { snapshotContent = "{}"; }
  }
  return {
    async resolve(ref: CredentialRef): Promise<ResolvedCredential> {
      const isNamedUserSettingsReference = ref.key.startsWith("USER_SETTINGS_");
      if (options.userSettingsPath) {
        const apiKey = readUserSettingsCredential(options.userSettingsPath, ref, snapshotContent);
        if (apiKey) return { apiKey };
      }
      // USER_SETTINGS_* 是显式命名空间；缺失时禁止退回进程环境，避免跨 route/ambient 凭据串用。
      if (isNamedUserSettingsReference) {
        const missingReference = ref.provider === "firstParty" ? `${ref.provider.toUpperCase()}_${ref.key}` : `${ref.provider}/${ref.key}`;
        throw new Error(`凭据未配置: ${missingReference}`);
      }
      const key = ref.key.toUpperCase();
      const provider = ref.provider?.trim();
      const envKey = provider ? `${provider.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_${key}` : key;
      const value = env[envKey];
      if (!value) throw new Error(`凭据未配置: ${envKey}`);
      return { apiKey: value };
    },
  };
}
