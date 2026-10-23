/** 从持久化 Session 派生 Turn 能力上限；Chat 只读取受信宿主能力，不采用请求中的能力对象。 */
import type { Session, FrozenRunConfig } from "../../domain";
import { readSessionIdentity, restrictCapabilityCeiling } from "../../domain/product-mode";
import type { ChatCapability, ChatCapabilityBinding } from "../../protocol/chat-capability";
import type { RunConfig } from "../../protocol/run-config";
import { AgentRuntimeError } from "../../protocol/error-code";
import { getChatToolNames } from "../../../internal/tools/chat-tool-runtime";

/** 只在执行期间存在的 Chat 端口，不能进入 Session、Turn 或公开配置视图。 */
export interface TurnCapabilities extends RunConfig {
  chatCapability?: ChatCapability;
}

/** 冻结开始时的实际目录，恢复时与原快照取交集；缺少 Chat 快照或模式不一致时默认拒绝。 */
export async function resolveTurnCapabilities(input: {
  session: Session;
  turnId: string;
  runtimeDefault: RunConfig;
  override?: Partial<RunConfig>;
  frozen: FrozenRunConfig;
  continuing?: boolean;
  now: number;
}): Promise<{ capabilities: TurnCapabilities; frozen: FrozenRunConfig }> {
  const { session, runtimeDefault, override, turnId, continuing, now } = input;
  const identity = readSessionIdentity(session);
  const previous = input.frozen.capabilityCeiling;
  if (continuing && ((identity.productMode === "chat" && !previous) || (previous && (previous.productMode !== identity.productMode || previous.chatRetrievalMode !== identity.chatRetrievalMode)))) {
    throw new AgentRuntimeError("SESSION_MODE_MISMATCH", "Turn 冻结身份与 Session 不匹配");
  }
  let ceiling = restrictCapabilityCeiling(identity, previous?.allowedTools, runtimeDefault.toolAllowlist, override?.toolAllowlist);
  if (identity.productMode === "work") {
    // Work 预览能力只从受信宿主 runtimeDefault 装配；override 不可注入或替换，
    // 旧 Turn（冻结缺失/禁用）不开新能力，禁用或宿主移除时明确不可用且不换 OS opener。
    const capabilities: TurnCapabilities = { ...runtimeDefault, ...override, rag: undefined, chatLoader: undefined, ragSourcePolicy: undefined, rerankPolicy: undefined, focusedPdfFileName: undefined, workPreview: undefined, workPreviewLoader: undefined };
    if (capabilities.webLoader) capabilities.web = await capabilities.webLoader();
    if (input.frozen.workPreviewEnabled === true) capabilities.workPreview = await runtimeDefault.workPreviewLoader?.();
    return { capabilities, frozen: { ...input.frozen, workContextVersion: 1, ragSourcePolicy: undefined, rerankPolicy: undefined, capabilityCeiling: ceiling } };
  }
  const binding: ChatCapabilityBinding = { sessionId: session.id, turnId, retrievalMode: identity.chatRetrievalMode! };
  const loaded = await runtimeDefault.chatLoader?.(binding);
  const chatCapability = loaded ? { ...loaded, knowledge: binding.retrievalMode === "rag" ? loaded.knowledge : undefined } : undefined;
  const suppliedGrants = binding.retrievalMode === "rag" ? [] : loaded?.attachments ?? [];
  const grants = (continuing ? input.frozen.chatAttachmentGrants ?? [] : suppliedGrants).filter(
    /** 保留本会话未过期授权，非法 ref 会在目录和调用校验中继续拒绝。 */
    function validGrant(grant) {
      return grant.sessionId === session.id && grant.expiresAt > now && (!continuing || suppliedGrants.some(
        /** Host 当前目录可以撤销旧授权，但不能追加冻结集合之外的引用。 */
        function stillGranted(current) { return current.ref === grant.ref && current.kind === grant.kind && current.sessionId === grant.sessionId && current.expiresAt > now; },
      ));
    },
  ).map(
    /** 私有冻结记录也只保存授权字段，不复制 Host 附带的存储元数据。 */
    function freezeGrant(grant) { return { ref: grant.ref, sessionId: grant.sessionId, kind: grant.kind, expiresAt: grant.expiresAt }; },
  );
  const web = binding.retrievalMode === "web" ? (runtimeDefault.webLoader ? await runtimeDefault.webLoader() : runtimeDefault.web) : undefined;
  const tools = getChatToolNames(binding, chatCapability, grants, now);
  if (web?.search) tools.push("web_search");
  if (web?.fetch) tools.push("web_fetch");
  ceiling = restrictCapabilityCeiling(ceiling, tools);
  // 只从宿主保留模型配置；请求可选模型及预算，但不能替换 loader、sampler、上下文或其他 capability。
  const capabilities: TurnCapabilities = {
    modelRef: override?.modelRef ?? runtimeDefault.modelRef,
    reasoningProfile: override?.reasoningProfile ?? runtimeDefault.reasoningProfile,
    credentialRef: runtimeDefault.credentialRef,
    modelSampler: runtimeDefault.modelSampler,
    modelSamplerFactory: runtimeDefault.modelSamplerFactory,
    providerSettings: runtimeDefault.providerSettings,
    compactPolicy: runtimeDefault.compactPolicy,
    permissionMode: "ask",
    web,
    chatCapability,
  };
  return { capabilities, frozen: { ...input.frozen, workspaceRoot: undefined, workspaceTrusted: false, permissionMode: "ask", workPreviewEnabled: false, databaseSearchPolicy: { enabled: false }, ragSourcePolicy: undefined, rerankPolicy: undefined, capabilityCeiling: ceiling, chatAttachmentGrants: grants } };
}
