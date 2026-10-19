/** Node SessionResourceStore：删除工作区内由 Session 独占的 Web 图片附件目录。 */

import fs from "node:fs";
import path from "node:path";
import type { SessionResourceStore } from "@autopilot-agent/core";
import { canonicalizeNodePath } from "../state-root";

/** 判断 Session ID 是否能对应 Web 图片附件目录；非 UUID 兼容 Session 没有此类资源。 */
function isAttachmentSessionId(sessionId: string): boolean {
  return /^[0-9a-f-]{36}$/iu.test(sessionId);
}

/** 创建绑定 canonical workspaceRoot 的附件清理 Port。 */
export function createNodeSessionResourceStore(workspaceRoot: string): SessionResourceStore {
  const root = canonicalizeNodePath(workspaceRoot);
  const uploadsRoot = path.join(root, ".local", "session-uploads");
  return {
    async deleteBySession(sessionId: string): Promise<void> {
      if (!isAttachmentSessionId(sessionId)) return;
      const target = path.join(uploadsRoot, sessionId);
      if (!target.startsWith(`${uploadsRoot}${path.sep}`)) throw new Error("SESSION_RESOURCE_PATH_INVALID");
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 });
    },
  };
}
