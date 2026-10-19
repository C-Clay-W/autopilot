/**
 * core-loader.ts — Web 服务端运行时加载 Core
 *
 * 使用 CJS require 保持 Core 的 Node 原生依赖留在服务端，避免 Next/Turbopack
 * 将 Core 的 ESM 产物打包后改写动态 require。
 */

import type * as Core from "@autopilot-agent/core";

/** 通过服务端 CJS 边界加载 Core，避免 Turbopack 静态分析 Core 依赖树。 */
export function loadCore(): typeof Core {
  return eval("require")("@autopilot-agent/core") as typeof Core;
}
