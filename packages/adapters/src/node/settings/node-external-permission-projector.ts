/**
 * Node ExternalPermissionProjector：把 allow_workspace 外部授权的精确规则投影到
 * workspace 的 `.autopilot/settings.local.json`（Talk-Plan1013 Stage 2，Plan 16.4）。
 *
 * - 写入口专用：不经普通 config allowlist；复用 loader 的路径规则与链接安全检查、原子替换。
 * - allow 只来自 local 投影；deny 为 User/Project/Local 并集（只收窄）。
 * - 规则语法校验复用 Core 的 parseExternalPermissionRule，非法语法绝不写入。
 */

import fs from "node:fs";
import os from "node:os";
import { resolveAutopilotSettings, type ExternalPermissionSnapshot } from "@autopilot-agent/core";
import { isValidExternalPermissionRule } from "@autopilot-agent/core";
import { atomicReplace, withFileLock } from "../file-utils";
import { isSafeSettingsFile, resolveNodeSettingsPaths } from "./node-settings-loader";

/** 投影器创建选项；测试可注入 homeDirectory 隔离 User 层。 */
export interface CreateNodeExternalPermissionProjectorOptions {
  homeDirectory?: string;
}

/** 快照读取保持原降级语义；投影写入只有 ENOENT 可视为空，损坏/不可读必须停止并保留原文件。 */
function readScopeValue(filePath: string, strict = false): Record<string, unknown> {
  if (strict) {
    try { fs.lstatSync(filePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("EXTERNAL_RULE_SETTINGS_UNREADABLE");
    }
    if (!isSafeSettingsFile(filePath)) throw new Error("EXTERNAL_RULE_TARGET_UNSAFE");
  } else if (!fs.existsSync(filePath) || !isSafeSettingsFile(filePath)) return {};
  let content: string;
  try { content = fs.readFileSync(filePath, "utf8"); }
  catch {
    if (strict) throw new Error("EXTERNAL_RULE_SETTINGS_UNREADABLE");
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ...(parsed as Record<string, unknown>) };
    if (strict) throw new Error("EXTERNAL_RULE_SETTINGS_INVALID");
    return {};
  } catch {
    if (strict) throw new Error("EXTERNAL_RULE_SETTINGS_INVALID");
    return {};
  }
}

/** 读取 local 文件的 permissions 数组；非法条目按 invalid 处理由调用方丢弃。 */
function readPermissionList(source: Record<string, unknown>, key: "allow" | "deny" | "ask"): string[] {
  const permissions = source.permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return [];
  const list = (permissions as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is string => typeof entry === "string");
}

/** 创建 Node 版外部权限规则投影器。 */
export function createNodeExternalPermissionProjector(options: CreateNodeExternalPermissionProjectorOptions = {}): {
  project(input: { workspaceRoot: string; rule: string; action: "add" | "remove" }): Promise<void>;
  read(workspaceRoot: string): Promise<ExternalPermissionSnapshot>;
} {
  function localSettingsPath(workspaceRoot: string): string {
    return resolveNodeSettingsPaths(workspaceRoot, options.homeDirectory ?? os.homedir()).local;
  }

  return {
    /** 记住/撤销一条精确外部规则；只写 local 文件，失败抛错由调用方把 grant 标记 pending。 */
    async project({ workspaceRoot, rule, action }) {
      if (!isValidExternalPermissionRule(rule)) throw new Error(`EXTERNAL_RULE_INVALID:${rule}`);
      const filePath = localSettingsPath(workspaceRoot);
      // 取锁前拒绝现有不安全链接；锁内再次严格读取，不在损坏配置上做空对象覆盖。
      if (!isSafeSettingsFile(filePath)) throw new Error("EXTERNAL_RULE_TARGET_UNSAFE");
      return withFileLock(filePath, async function projectUnderLock() {
        const source = readScopeValue(filePath, true);
        const current = readPermissionList(source, "allow");
        const next = action === "add"
          ? (current.includes(rule) ? current : [...current, rule])
          : current.filter((entry) => entry !== rule);
        const permissions = {
          ...((source.permissions && typeof source.permissions === "object" && !Array.isArray(source.permissions) ? source.permissions : {}) as Record<string, unknown>),
          allow: next,
        };
        const updated: Record<string, unknown> = { ...source, permissions };
        // 通过 Core schema resolver 做一次纯数据校验（含规则语法与来源约束），失败则不落盘。
        resolveAutopilotSettings([{ scope: "local", value: updated }]);
        if (next.length === 0 && Object.keys(permissions).length === 1) delete updated.permissions;
        // 写入前检查链接安全：目标已存在但非安全实际文件时拒绝（防链接逃逸）。
        if (fs.existsSync(filePath) && !isSafeSettingsFile(filePath)) throw new Error("EXTERNAL_RULE_TARGET_UNSAFE");
        fs.mkdirSync(resolveNodeSettingsPaths(workspaceRoot, options.homeDirectory ?? os.homedir()).local.replace(/[/\\]settings\.local\.json$/u, ""), { recursive: true });
        atomicReplace(filePath, `${JSON.stringify(updated, null, 2)}\n`);
      });
    },

    /** allow 仅 local 投影；deny 为 User/Project/Local 并集（Core 解析器统一校验语法）。 */
    async read(workspaceRoot) {
      const paths = resolveNodeSettingsPaths(workspaceRoot, options.homeDirectory ?? os.homedir());
      const resolved = resolveAutopilotSettings([
        { scope: "user", value: readScopeValue(paths.user) },
        { scope: "project", value: readScopeValue(paths.project) },
        { scope: "local", value: readScopeValue(paths.local) },
      ]);
      return { allow: resolved.permissions.allow, deny: resolved.permissions.deny, ask: resolved.permissions.ask } as ExternalPermissionSnapshot & { ask: readonly string[] };
    },
  };
}
