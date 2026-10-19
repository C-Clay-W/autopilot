/**
 * runtime/bootstrap/safe-bootstrap-config.ts — 安全启动配置
 *
 * SafeBootstrapConfig 在 trust 建立前即可读取，只包含：
 * - 来自环境变量/命令行的只读参数
 * - 日志级别、快路径标志等不触发工作区加载的字段
 *
 * 它不能包含项目级 hook、MCP、Skill、Memory 或 Provider 的可执行配置。
 */

/** 安全启动配置；trust 前只允许读取这些字段。 */
export interface SafeBootstrapConfig {
  /** 当前宿主类型；影响 Adapter 选择与快路径行为。 */
  host: "web" | "cli" | "desktop" | "test";

  /** 是否启用调试日志。 */
  debug: boolean;

  /** 日志级别。 */
  logLevel: "silent" | "error" | "warn" | "info" | "debug";

  /** 快路径命令名；非空时表示当前走轻量入口，不创建完整 Runtime。 */
  fastPath?: string;

  /** 显式指定的工作区根目录；未指定时由 WorkspaceAdapter 推导。 */
  workspaceRoot?: string;

  /** 是否跳过信任检查（仅测试使用）。 */
  skipTrustCheck?: boolean;

  /** 额外只读上下文；键值必须是字符串/数字/布尔，不能是函数或对象。 */
  readonly context: Record<string, string | number | boolean>;
}

/** 从环境变量构建最小安全启动配置。 */
export function createSafeBootstrapConfig(
  overrides: Partial<Omit<SafeBootstrapConfig, "context">> & { context?: Record<string, string | number | boolean> } = {},
): SafeBootstrapConfig {
  return {
    host: overrides.host ?? "web",
    debug: overrides.debug ?? process.env.AGENT_DEBUG === "true",
    logLevel: (overrides.logLevel as SafeBootstrapConfig["logLevel"]) ?? (process.env.AGENT_LOG_LEVEL as SafeBootstrapConfig["logLevel"]) ?? "info",
    fastPath: overrides.fastPath,
    workspaceRoot: overrides.workspaceRoot ?? process.env.AGENT_WORKSPACE_ROOT,
    skipTrustCheck: overrides.skipTrustCheck ?? process.env.AGENT_SKIP_TRUST_CHECK === "true",
    context: overrides.context ?? {},
  };
}
