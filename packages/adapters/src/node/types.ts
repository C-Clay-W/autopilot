/**
 * Node Adapter 的宿主选项：把状态根、工作区根和能力扫描配置显式注入共享实现。
 */

/** 所有 durable Store 共用的状态根选项。 */
export interface NodeStoreOptions {
  stateRoot: string;
}

/** Node WorkspaceAdapter 的解析选项。 */
export interface NodeWorkspaceAdapterOptions {
  workspaceRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Node TrustPolicy 的持久化选项。 */
export interface NodeTrustPolicyOptions {
  stateRoot: string;
  /** 未传时按 stateRoot 的兼容布局解析为相邻的 agent 目录。 */
  trustRoot?: string;
  /** Web 可注入既有配额预检；共享包不依赖 Web 配额模块。 */
  beforeWrite?: (requiredBytes: number) => void;
  now?: () => number;
}

/** Node Context / Skill / MCP loader 的环境选项。 */
export interface NodeCapabilityLoaderOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  /** 共享 Runtime stateRoot；Memory 读取以此作为主事实源。 */
  stateRoot?: string;
  /** Trust 后读取 User-only Web Search 设置；安全 Web Fetch 不依赖该配置。 */
  settingsLoader?: Pick<import("./settings/node-settings-loader").NodeSettingsLoader, "load"> & Partial<Pick<import("./settings/node-settings-loader").NodeUserSettingsLoader, "loadUser">>;
  /** Web Search 请求的 fake HTTP 测试 seam；生产默认使用平台原生 fetch。 */
  webSearchFetch?: typeof fetch;
  /** Web Search 连通探测的 fake HTTP 测试 seam；不发送凭据或正文。 */
  webSearchConnectivityFetch?: typeof fetch;
}
