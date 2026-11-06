/** Core 失败提示与中立原因校验的浏览器安全公开入口，不依赖 Core 主入口。 */
export {
  getAgentProviderFailureMessage,
  sanitizeAgentProviderFailureReason,
  sanitizeAgentProviderFailureDetail,
} from "./runtime/provider/provider-failure-guidance";
export { normalizeLegacyProviderFailureReason } from "./runtime/provider/provider-failure-normalization";
export type { AgentProviderFailureReason } from "./runtime/provider/provider-failure-guidance";
