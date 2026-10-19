/**
 * Node Clock：生产环境使用系统时间，测试可通过 Core Memory Clock 替换。
 */

import type { Clock } from "@autopilot-agent/core";

/** 创建默认系统时钟。 */
export function createNodeClock(): Clock {
  return {
    now: () => Date.now(),
    timestamp: () => new Date().toISOString(),
  };
}
