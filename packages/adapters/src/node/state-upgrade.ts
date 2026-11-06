/** 已发布状态格式的相邻升级：只在迁移副本补齐可证明的身份，不推断任务归属或权限。 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ThreadControl } from "@autopilot-agent/core";
import { NodeStateError } from "./node-errors";
import { normalizeNodeSession } from "./session-record";

/** 逐条验证旧 Session；v6 缺省产品身份仅按当时已发布的 Work 规则补齐。 */
export function upgradeSessionIdentity(root: string, allowLegacyWork: boolean): void {
  const directory = path.join(root, "sessions");
  if (!fs.existsSync(directory)) return;
  for (const file of fs.readdirSync(directory)) {
    if (!file.endsWith(".json")) continue;
    const target = path.join(directory, file);
    let value;
    try { value = JSON.parse(fs.readFileSync(target, "utf8")); }
    catch { throw new NodeStateError("STATE_SESSION_CORRUPTED"); }
    const missingMode = value && typeof value === "object" && value.productMode === undefined;
    if (missingMode && allowLegacyWork) value.productMode = "work";
    const session = normalizeNodeSession(value, file.slice(0, -5));
    if (missingMode && allowLegacyWork) fs.writeFileSync(target, JSON.stringify(session, null, 2), "utf8");
  }
}

/** 从旧版创建意图和稳定创建摘要恢复可信来源，保留旧协作权限及全部消息/进展。 */
export function upgradeThreadCreationSources(root: string): void {
  upgradeSessionIdentity(root, false);
  const groups = path.join(root, "threads", "groups");
  if (!fs.existsSync(groups)) return;
  for (const groupId of fs.readdirSync(groups)) {
    const file = path.join(groups, groupId, "control.json");
    if (!fs.existsSync(file)) continue;
    const control = JSON.parse(fs.readFileSync(file, "utf8")) as ThreadControl;
    if (control.group?.groupId !== groupId || !Array.isArray(control.creates)) throw new NodeStateError("STATE_SESSION_CORRUPTED");
    for (const intent of control.creates) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(intent.threadId)) throw new NodeStateError("STATE_SESSION_CORRUPTED");
      const target = path.join(root, "sessions", `${intent.threadId}.json`);
      if (!fs.existsSync(target)) continue;
      const session = normalizeNodeSession(JSON.parse(fs.readFileSync(target, "utf8")), intent.threadId);
      const creationId = createHash("sha256").update(JSON.stringify([groupId, intent.actorKey, intent.requestId])).digest("hex");
      if (session.collaborationCreationId !== creationId || session.projectId !== control.group.projectId) throw new NodeStateError("STATE_SESSION_CORRUPTED");
      const source = { actor: intent.from, requestId: intent.requestId };
      const next = normalizeNodeSession({ ...session, creationSource: source }, session.id);
      if (session.creationSource !== undefined && JSON.stringify(session.creationSource) !== JSON.stringify(source)) throw new NodeStateError("STATE_SESSION_CORRUPTED");
      if (session.creationSource === undefined) fs.writeFileSync(target, JSON.stringify(next, null, 2), "utf8");
    }
  }
}
