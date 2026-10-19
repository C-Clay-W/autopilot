/**
 * runtime/provider/first-party-model-sampler.ts — 旧 firstParty 入口的单一迁移转发。
 *
 * Stage 4 后 Anthropic wire 实现唯一位于 anthropic-messages-adapter；此文件保留既有
 * 内部导入路径，避免同一阶段内无关调用方失效，但不含任何 serializer 或协议逻辑。
 */

export {
  createAnthropicMessagesRequest as createMessagesRequest,
  createAnthropicMessagesSampler as createFirstPartyModelSampler,
} from "./anthropic-messages-adapter";
export type { CreateAnthropicMessagesSamplerInput as CreateFirstPartyModelSamplerInput } from "./anthropic-messages-adapter";
