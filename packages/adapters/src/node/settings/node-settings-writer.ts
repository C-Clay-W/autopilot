/**
 * Node settings writer：复用 loader 的路径与 Core schema，只允许写入非敏感标量配置。
 */

import fs from "node:fs";
import { resolveAutopilotSettings, type AutopilotSettingsScope } from "@autopilot-agent/core";
import { atomicReplace } from "../file-utils";
import { resolveNodeSettingsPaths, type CreateNodeSettingsLoaderOptions, type NodeSettingsPaths } from "./node-settings-loader";

/** 普通 config 命令允许的非敏感键；凭据和 Provider endpoint 一律不在此入口管理。 */
const CONFIG_KEY_ALLOWLIST = new Set([
  "model",
  "effortLevel",
  "availableModels",
]);

/** Settings writer 的最小公共接口。 */
export interface NodeSettingsWriter {
  get(scope: AutopilotSettingsScope, key: string, workspaceRoot: string): unknown;
  show(scope: AutopilotSettingsScope, workspaceRoot: string): Record<string, unknown>;
  set(scope: AutopilotSettingsScope, key: string, value: string, workspaceRoot: string): Record<string, unknown>;
}

/** 创建 settings writer；调用者负责在 project/local 使用前完成 Trust。 */
export function createNodeSettingsWriter(options: CreateNodeSettingsLoaderOptions = {}): NodeSettingsWriter {
  /** 复用 loader 的路径规则，确保 reader/writer 不会指向不同文件。 */
  function getPaths(workspaceRoot: string): NodeSettingsPaths {
    return resolveNodeSettingsPaths(workspaceRoot, options.homeDirectory);
  }

  /** 读取单份 scope 文件；损坏或非对象内容以空对象安全降级。 */
  function readScope(scope: AutopilotSettingsScope, workspaceRoot: string): Record<string, unknown> {
    const filePath = getPaths(workspaceRoot)[scope];
    if (!fs.existsSync(filePath)) return {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
    } catch {
      return {};
    }
  }

  /** 删除敏感字段并将原始 scope 投影为普通 config 可安全显示的结构。 */
  function toSafeView(source: Record<string, unknown>): Record<string, unknown> {
    const value = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
    removeSensitiveFields(value);
    return value;
  }

  /** 读取点分 key，不允许原型链或数组路径。 */
  function readKey(source: Record<string, unknown>, key: string): unknown {
    return key.split(".").reduce<unknown>(function walk(current, part) {
      if (!current || typeof current !== "object" || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
      return (current as Record<string, unknown>)[part];
    }, source);
  }

  /** 校验配置值后写入点分路径，拒绝 JSON 注入和敏感字段。 */
  function set(scope: AutopilotSettingsScope, key: string, rawValue: string, workspaceRoot: string): Record<string, unknown> {
    if (!CONFIG_KEY_ALLOWLIST.has(key)) throw new Error("CONFIG_KEY_NOT_ALLOWED");
    const source = readScope(scope, workspaceRoot);
    if (containsForbiddenSensitiveFields(source, scope)) throw new Error("CONFIG_SCOPE_CONTAINS_SENSITIVE_FIELDS");
    const parsedValue = parseConfigValue(key, rawValue);
    const target = source as Record<string, unknown>;
    const parts = key.split(".");
    let cursor = target;
    for (const part of parts.slice(0, -1)) {
      const child = cursor[part];
      if (!child || typeof child !== "object" || Array.isArray(child)) cursor[part] = {};
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = parsedValue;
    // 通过 Core 的 schema resolver 执行一次纯数据验证；CC-compatible 新文件不补写 schemaVersion。
    resolveAutopilotSettings([{ scope, value: target }]);
    atomicReplace(getPaths(workspaceRoot)[scope], JSON.stringify(target, null, 2));
    return toSafeView(target);
  }

  return {
    get(scope, key, workspaceRoot) {
      if (!CONFIG_KEY_ALLOWLIST.has(key)) throw new Error("CONFIG_KEY_NOT_ALLOWED");
      return readKey(toSafeView(readScope(scope, workspaceRoot)), key);
    },
    show(scope, workspaceRoot) {
      return toSafeView(readScope(scope, workspaceRoot));
    },
    set,
  };
}

/** 判断写入 scope 是否含有明确禁止的凭据字段；User 的既有 env 仅原样保留。 */
function containsForbiddenSensitiveFields(value: unknown, scope: AutopilotSettingsScope, atRoot = true): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(
    /** 数组子项不再拥有顶层 User 例外。 */
    function containsArrayItem(item) { return containsForbiddenSensitiveFields(item, scope, false); },
  );
  return Object.entries(value as Record<string, unknown>).some(
    /** 仅允许 User 顶层 env 与严格的 Web Search 引用原样保留。 */
    function contains([key, child]) {
      if (scope === "user" && atRoot && key === "env") return false;
      if (scope === "user" && atRoot && key === "webSearch" && isSafeWebSearchReference(child)) return false;
      return /(?:api[_-]?key|token|password|secret|credentialref)/iu.test(key) || containsForbiddenSensitiveFields(child, scope, false);
    },
  );
}

/** 判断 User settings 中的 Web Search 值是否为受限完整连接或旧 CredentialRef。 */
function isSafeWebSearchReference(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!record.credentialRef || typeof record.credentialRef !== "object" || Array.isArray(record.credentialRef)) return false;
  const credentialRef = record.credentialRef as Record<string, unknown>;
  const safeReference = Object.keys(credentialRef).length === 2
    && typeof credentialRef.provider === "string"
    && credentialRef.provider.trim() === credentialRef.provider
    && credentialRef.provider.length > 0
    && typeof credentialRef.key === "string"
    && credentialRef.key.trim() === credentialRef.key
    && credentialRef.key.length > 0;
  if (!safeReference) return false;
  if (Object.keys(record).length === 1) return credentialRef.provider === "deepseek";
  return Object.keys(record).length === 4
    && (record.provider === "deepseek" || record.provider === "openai-compatible" || record.provider === "xiaomi-mimo")
    && credentialRef.provider === record.provider
    && typeof record.baseUrl === "string"
    && /^https:\/\/[^\s]+$/u.test(record.baseUrl)
    && typeof record.model === "string"
    && record.model.trim() === record.model
    && record.model.length > 0;
}

/** 从安全投影中递归移除敏感键和值。 */
function removeSensitiveFields(value: Record<string, unknown>): void {
  for (const [key, child] of Object.entries(value)) {
    if (key === "env" || /(?:api[_-]?key|token|password|secret|credentialref|baseurl)/iu.test(key)) {
      delete value[key];
    } else if (child && typeof child === "object" && !Array.isArray(child)) {
      removeSensitiveFields(child as Record<string, unknown>);
    }
  }
}

/** 将 argv 标量解析为 allowlist 对应的安全类型。 */
function parseConfigValue(key: string, rawValue: string): string | number | boolean | string[] {
  if (key === "availableModels") {
    const values = rawValue.split(",").map(function normalize(value) { return value.trim(); }).filter(Boolean);
    if (values.length === 0 || new Set(values).size !== values.length) throw new Error("CONFIG_VALUE_INVALID");
    return values;
  }
  if (key === "model" && (!rawValue || rawValue.trim() !== rawValue)) throw new Error("CONFIG_VALUE_INVALID");
  if (key === "effortLevel" && !["low", "medium", "high"].includes(rawValue)) throw new Error("CONFIG_VALUE_INVALID");
  return rawValue;
}
