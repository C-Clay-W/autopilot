/** TUI 启动期一次性解析的渲染模式纯函数：颜色/读屏/降级/渲染模式策略。 */

import type { TuiRenderMode } from "./types.js";

/** 判断当前环境是否要求关闭 ANSI 颜色。 */
export function resolveNoColor(env: NodeJS.ProcessEnv): boolean {
  return env.NO_COLOR !== undefined && env.NO_COLOR !== "";
}

/** 解析 Ink screen-reader 开关，并保留 Ink 官方环境变量兼容性。 */
export function resolveScreenReader(env: NodeJS.ProcessEnv): boolean {
  return env.INK_SCREEN_READER === "true" || env.SCREEN_READER === "1" || env.SCREEN_READER === "true";
}

/** 交互统一使用inline主屏，滚动交给终端，不启用备用屏/正文滚动条。 */
export function resolveTuiRenderModePolicy(_input: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform | string }): TuiRenderMode {
  return "inline";
}

/** 各平台统一inline，不增加额外模式回落提示。 */
export function getTuiRenderModeFallbackNotice(_input: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform | string }): string | undefined {
  return undefined;
}

/** 仅在 TUI 启动期决定内联或备用屏；宿主 TTY/Plain 门禁仍由 main.ts 保持。 */
export function resolveTuiRenderMode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform | string = process.platform): TuiRenderMode {
  return resolveTuiRenderModePolicy({ env, platform });
}

/** 解析终端 reduced-motion 开关；非标准环境变量只作为 CLI 宿主的本地降级提示。 */
export function resolveReducedMotion(env: NodeJS.ProcessEnv): boolean {
  return env.REDUCED_MOTION === "1" || env.REDUCED_MOTION === "true" || env.TERM_REDUCED_MOTION === "1" || env.TERM_REDUCED_MOTION === "true";
}
