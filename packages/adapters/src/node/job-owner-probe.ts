/** Node Job owner 探测：只用 signal 0 提供宿主进程三态线索。 */

import type { JobOwnerProbe } from "@autopilot-agent/core";

/** 创建保守的 Node owner probe；alive 不代表 Runtime 身份仍相同。 */
export function createNodeJobOwnerProbe(): JobOwnerProbe {
  return {
    /** ESRCH 才确认宿主已退出，权限或其他异常一律 unknown。 */
    async probe(owner) {
      if (!Number.isInteger(owner.hostProcessId) || owner.hostProcessId <= 0) return "unknown";
      try {
        process.kill(owner.hostProcessId, 0);
        return "alive";
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
      }
    },
  };
}
