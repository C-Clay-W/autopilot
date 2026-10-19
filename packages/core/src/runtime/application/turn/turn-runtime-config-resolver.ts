/**
 * runtime/application/turn/turn-runtime-config-resolver.ts — Turn 运行配置冻结
 *
 * 负责把动态 Runtime defaults、宿主 capability 与持久化 FrozenRunConfig 组合为
 * 本次 Turn 的 Provider 快照和内部 AgentOptions；凭据只在调用期间传入，不写回公开状态。
 */

import type { TurnCapabilities } from "./turn-capability-ceiling";
import type { AgentOptions } from "../../../internal/agent-runtime";
import { createDefaultModelSampler } from "../../../internal/kernel/model-sampler";
import type { ModelSampler } from "../../../internal/kernel/model-sampler";
import type { ToolApprovalDecision } from "../../../internal/tools/types";
import type { ResolvedCredential, FrozenRunConfig } from "../../domain";
import type { RuntimePorts } from "../../ports";
import { createAgentInputInboxCapability } from "../input-inbox-service";
import type { ApprovalService, InternalApprovalService } from "../approval-service";
import type { InputInboxService } from "../input-inbox-service";
import type { JobService } from "../job-service";
import type { RunConfig } from "../../protocol";
import { resolveFirstPartyModelSampleOptions, resolveModelSampleOptions } from "../../provider/model-sample-resolver";
import type { FrozenProviderConfig } from "../../provider/frozen-provider-config";
import { isApiProtocol, isProtocolProfileForApiProtocol } from "../../provider/api-protocol";
import { getModelCapabilityForRef } from "../../provider/model-capability-catalog";
import { AgentRuntimeError } from "../../protocol/error-code";
import { isExternalFileConstraint } from "../../domain/external-permissions";
import { isNoSandboxExecConstraint } from "../../domain/sandbox-policy";
import { createVisionAnalyzer } from "../../provider/vision-analyzer";
import type { UserQuestionService } from "../user-question-service";

/** Turn 运行配置解析器对依赖组合的内部输入。 */
export interface TurnRuntimeConfigResolverDependencies {
  ports: RuntimePorts;
  defaultRunConfig: RunConfig;
  approvalService?: ApprovalService & Partial<InternalApprovalService>;
  inputInboxService?: InputInboxService;
  jobService?: JobService;
  userQuestionService?: UserQuestionService;
  enableUserQuestions?: boolean;
}

/** Turn 运行配置解析器的内部职责。 */
export interface TurnRuntimeConfigResolver {
  mergeRunConfig(override?: Partial<RunConfig>, runtimeDefault?: RunConfig): RunConfig;
  readRuntimeDefault(): RunConfig;
  freezeProviderConfig(frozen: FrozenRunConfig, capabilities: RunConfig): FrozenProviderConfig | undefined;
  normalizeFrozenProviderConfig(providerConfig: FrozenProviderConfig | undefined): FrozenProviderConfig | undefined;
  buildAgentOptions(frozen: FrozenRunConfig, capabilities: RunConfig, sessionId: string, turnId: string, credential?: ResolvedCredential, providerConfig?: FrozenProviderConfig): AgentOptions;
  buildCompactionSampler(frozen: FrozenRunConfig, capabilities: RunConfig, sessionId: string, turnId: string, credential?: ResolvedCredential, providerConfig?: FrozenProviderConfig): ModelSampler;
}

/** 创建只负责当前 Turn 配置冻结和内部执行选项构建的解析器。 */
export function createTurnRuntimeConfigResolver(
  dependencies: TurnRuntimeConfigResolverDependencies,
): TurnRuntimeConfigResolver {
  const { ports, defaultRunConfig, approvalService, inputInboxService, jobService, userQuestionService, enableUserQuestions } = dependencies;

  /** 合并默认配置与单次调用覆盖；用于 capability 字段（rag/context/skills 等）。 */
  function mergeRunConfig(override?: Partial<RunConfig>, runtimeDefault = defaultRunConfig): RunConfig {
    return { ...runtimeDefault, ...override };
  }

  /** 在新 Turn 开始时读取一次宿主已原子替换的 settings 快照，旧 Turn 永不重新读取。 */
  function readRuntimeDefault(): RunConfig {
    const dynamic = defaultRunConfig.getRuntimeDefaults?.() ?? {};
    /** 静态宿主上限与动态设置取交集，动态列表不能扩大能力。 */
    const toolAllowlist = defaultRunConfig.toolAllowlist?.filter(function withinHostLimit(name) { return !dynamic.toolAllowlist || dynamic.toolAllowlist.includes(name); }) ?? dynamic.toolAllowlist;
    return { ...defaultRunConfig, ...dynamic, toolAllowlist, getRuntimeDefaults: defaultRunConfig.getRuntimeDefaults };
  }

  /** 验证协议/profile，并将旧 firstParty durable 快照迁移到显式 Anthropic 协议。 */
  function normalizeFrozenProviderConfig(providerConfig: FrozenProviderConfig | undefined): FrozenProviderConfig | undefined {
    if (!providerConfig) return undefined;
    if (!providerConfig.apiProtocol) {
      if (providerConfig.provider === "firstParty") {
        return { ...providerConfig, apiProtocol: "anthropic-messages" };
      }
      throw new AgentRuntimeError("PROVIDER_PROTOCOL_REQUIRED", "旧 Provider 快照缺少 apiProtocol，不能猜测协议");
    }
    if (!isApiProtocol(providerConfig.apiProtocol)) {
      throw new AgentRuntimeError("UNSUPPORTED_API_PROTOCOL", "冻结的 apiProtocol 不受支持");
    }
    if (providerConfig.protocolProfile && !isProtocolProfileForApiProtocol(providerConfig.protocolProfile, providerConfig.apiProtocol)) {
      throw new AgentRuntimeError("INVALID_PROTOCOL_PROFILE", "冻结的 protocolProfile 与 apiProtocol 不匹配");
    }
    return providerConfig;
  }

  /** 从已冻结 RunConfig 与 settings 生成仅供内部 durable Turn 使用的 Provider 快照。 */
  function freezeProviderConfig(frozen: FrozenRunConfig, capabilities: RunConfig): FrozenProviderConfig | undefined {
    if (!frozen.modelRef) return undefined;
    const primarySettings = capabilities.providerSettings?.primary;
    const route = capabilities.providerSettings?.routes?.[frozen.modelRef.provider];
    const routeModel = route?.models.find(function matchesModel(model) { return model.id === frozen.modelRef?.modelId; });
    const routeSettings = route
      ? {
          baseUrl: route.baseUrl,
          credentialRef: route.credentialRef,
          apiProtocol: route.apiProtocol,
          protocolProfile: routeModel?.protocolProfile ?? route.protocolProfile,
        }
      : frozen.modelRef.provider === "firstParty" ? primarySettings : undefined;
    if (route && !routeModel) {
      throw new AgentRuntimeError("MODEL_NOT_SUPPORTED", "选定模型不属于受信 Provider route");
    }
    if (!routeSettings?.apiProtocol) {
      if (capabilities.modelSampler && !capabilities.modelSamplerFactory) {
        // 显式注入 sampler 的 headless 测试不走生产 Provider，不为它猜测协议。
        return undefined;
      }
      throw new AgentRuntimeError("PROVIDER_PROTOCOL_REQUIRED", "ModelRef 已配置时必须由受信 Host 冻结 apiProtocol");
    }
    if (!isApiProtocol(routeSettings.apiProtocol)) {
      throw new AgentRuntimeError("UNSUPPORTED_API_PROTOCOL", "受信 route 声明了不支持的 apiProtocol");
    }
    if (routeSettings.protocolProfile && !isProtocolProfileForApiProtocol(routeSettings.protocolProfile, routeSettings.apiProtocol)) {
      throw new AgentRuntimeError("INVALID_PROTOCOL_PROFILE", "受信 route 的 protocolProfile 与 apiProtocol 不匹配");
    }
    const resolved = frozen.modelRef.provider === "firstParty"
      ? resolveFirstPartyModelSampleOptions(frozen.modelRef, frozen.reasoningProfile, { thinkingEnabled: primarySettings?.thinkingEnabled })
      : { sampleOptions: resolveModelSampleOptions(frozen.modelRef, frozen.reasoningProfile) };
    const contextWindowTokens = getModelCapabilityForRef(frozen.modelRef)?.contextWindowTokens ?? routeModel?.contextWindowTokens;
    const visionRef = capabilities.providerSettings?.visionModelRef;
    const visionSettings = visionRef ? capabilities.providerSettings?.vision ?? primarySettings : undefined;
    const visionApiProtocol = visionSettings?.apiProtocol ?? (visionRef?.provider === "firstParty" ? primarySettings?.apiProtocol : visionRef ? "openai-chat-completions" : undefined);
    return {
      provider: frozen.modelRef.provider,
      apiProtocol: routeSettings.apiProtocol,
      protocolProfile: routeSettings.protocolProfile,
      baseUrl: routeSettings.baseUrl,
      credentialRef: routeSettings.credentialRef ?? frozen.credentialRef,
      sampleOptions: {
        ...resolved.sampleOptions,
        ...(primarySettings?.maxOutputTokens !== undefined ? { maxTokens: primarySettings.maxOutputTokens } : {}),
        ...(primarySettings?.temperature !== undefined ? { temperature: primarySettings.temperature } : {}),
        ...(primarySettings?.topP !== undefined ? { topP: primarySettings.topP } : {}),
      },
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      compactThresholdTokens: primarySettings?.compactThresholdTokens,
      timeoutMs: primarySettings?.timeoutMs,
      subagentModelId: primarySettings?.subagentModelId,
      effectiveReasoning: resolved.effectiveReasoning,
      vision: visionRef && visionApiProtocol ? { ref: visionRef, apiProtocol: visionApiProtocol, baseUrl: visionSettings?.baseUrl, credentialRef: visionSettings?.credentialRef } : undefined,
    };
  }

  /** 把冻结配置与 capability 配置合并为内部 AgentOptions。 */
  function buildAgentOptions(
    frozen: FrozenRunConfig,
    capabilities: RunConfig,
    sessionId: string,
    turnId: string,
    credential?: ResolvedCredential,
    providerConfig?: FrozenProviderConfig,
  ): AgentOptions {
    const isChat = frozen.capabilityCeiling?.productMode === "chat";
    const chatCapability = isChat ? (capabilities as TurnCapabilities).chatCapability : undefined;
    const visionAnalyzer = providerConfig?.vision ? createVisionAnalyzer(providerConfig.vision, async function resolveFrozenVisionCredential() {
      return providerConfig.vision?.credentialRef ? ports.credentialStore.resolve(providerConfig.vision.credentialRef) : undefined;
    }) : undefined;
    const modelSampleOptions = providerConfig?.sampleOptions
      ?? (frozen.modelRef?.provider === "firstParty"
        ? resolveFirstPartyModelSampleOptions(frozen.modelRef, frozen.reasoningProfile).sampleOptions
        : resolveModelSampleOptions(frozen.modelRef, frozen.reasoningProfile));
    return {
      capabilityCeiling: frozen.capabilityCeiling,
      chatCapability: chatCapability && visionAnalyzer && chatCapability.visionAnalyzer ? { ...chatCapability, visionAnalyzer } : chatCapability,
      chatAttachmentGrants: frozen.chatAttachmentGrants,
      /** 使用宿主时钟判断引用有效期，便于确定性测试。 */
      clock: () => ports.clock.now(),
      workspaceRoot: isChat ? undefined : frozen.workspaceRoot ?? capabilities.workspaceRoot,
      permissionMode: frozen.permissionMode ?? capabilities.permissionMode ?? "ask",
      workspaceTrusted: !isChat && (frozen.workspaceTrusted ?? capabilities.workspaceTrusted ?? false),
      web: isChat && frozen.capabilityCeiling?.chatRetrievalMode !== "web" ? undefined : capabilities.web,
      databaseSearch: !isChat && frozen.databaseSearchPolicy?.enabled === true ? capabilities.databaseSearch : undefined,
      context: isChat ? undefined : capabilities.context,
      skills: isChat ? undefined : capabilities.skills,
      inputInbox: inputInboxService
        ? createAgentInputInboxCapability(ports.inputInbox, sessionId, turnId)
        : undefined,
      // ModelRef 实际选 sampler：优先走 modelSamplerFactory.create(modelRef, credential)，
      // 无 factory 或未配置 ModelRef 时回退兼容字段 modelSampler。
      modelSampler: capabilities.modelSamplerFactory
        ? capabilities.modelSamplerFactory.create({ ref: frozen.modelRef, credential, reasoningProfile: frozen.reasoningProfile, sampleOptions: modelSampleOptions, providerConfig })
        : capabilities.modelSampler,
      // 按 provider 分发至单一 resolver；Kernel 只透传已解析的请求值。
      modelSampleOptions,
      visionAnalyzer: isChat ? undefined : visionAnalyzer,
      mcp: isChat ? undefined : capabilities.mcp,
      credentialStore: ports.credentialStore,
      jobs: isChat ? undefined : jobService,
      jobBinding: !isChat && jobService ? { workspaceId: frozen.workspaceRoot ?? capabilities.workspaceRoot ?? "", sessionId, turnId } : undefined,
      fileMutationStore: isChat ? undefined : ports.fileMutationStore,
      hostMutationProtection: isChat ? undefined : ports.hostMutationProtection,
      // Talk-Plan0917 Stage 3：Work Turn 注入冻结沙箱绑定（Port 来自 RuntimePorts，模式与
      // tempRoot 来自 FrozenRunConfig）；Chat 不注入。旧记录缺省 mode 按 fail-safe 范式取 read-only。
      sandbox: isChat ? undefined : {
        port: ports.sandboxPort,
        mode: frozen.sandboxMode ?? "read-only",
        ...(frozen.sandboxTempRoot !== undefined ? { tempRoot: frozen.sandboxTempRoot } : {}),
      },
      sessionId,
      userQuestions: !isChat && enableUserQuestions && userQuestionService
        ? { request: async function requestUserQuestion(input) { return userQuestionService.request({ sessionId, turnId, questions: input.questions }); } }
        : undefined,
      resolvePersistentGrant: !isChat && approvalService
        ? async function resolvePersistentGrant({ toolName, inputHash, constraint }) {
            const normalizedConstraint = constraint ?? inputHash;
            if (await approvalService.hasPersistentGrant({
              workspaceRoot: frozen.workspaceRoot ?? capabilities.workspaceRoot ?? "",
              sessionId,
              toolName,
              constraint: normalizedConstraint,
            })) return true;
            // 任务文件集合（2.4）：write/edit 逐调用核对 Turn 级已批准集合成员；
            // 操作与声明绑定（edit_file→edit，write_file→create），非成员与跨 Turn 一律不命中。
            if ((toolName === "write_file" || toolName === "edit_file") && normalizedConstraint.startsWith("path:") && approvalService.hasTaskFileSetGrant) {
              return approvalService.hasTaskFileSetGrant({
                sessionId,
                turnId,
                workspaceRoot: frozen.workspaceRoot ?? capabilities.workspaceRoot ?? "",
                path: normalizedConstraint.slice("path:".length),
                operation: toolName === "edit_file" ? "edit" : "create",
              });
            }
            // 外部文件集合（2.4 第 4 项）：外部目标约束为 ext-file:<canonicalTarget>，
            // 命中判定复用同一 Turn 级集合 grant 语义（canonical 精确成员 + 操作绑定）；
            // ask/deny 快照收窄仍由 PolicyEngine 在 grant 之前强制，不会因集合授权被绕过。
            if ((toolName === "write_file" || toolName === "edit_file") && normalizedConstraint.startsWith("ext-file:") && approvalService.hasExternalTaskFileSetGrant) {
              return approvalService.hasExternalTaskFileSetGrant({
                sessionId,
                turnId,
                workspaceRoot: frozen.workspaceRoot ?? capabilities.workspaceRoot ?? "",
                canonicalTarget: normalizedConstraint.slice("ext-file:".length),
                operation: toolName === "edit_file" ? "edit" : "create",
              });
            }
            return false;
          }
        : undefined,
      // Talk-Plan1013 Stage5 R5：唯一共享权限事实入口；规则来源只有 ApprovalService + projector 快照。
      resolveExternalRestriction: !isChat && approvalService?.resolveExternalRestriction
        ? async function resolveExternalRestriction({ toolName, constraint }) {
            return approvalService.resolveExternalRestriction!({
              workspaceRoot: frozen.workspaceRoot ?? capabilities.workspaceRoot ?? "",
              toolName,
              constraint,
            });
          }
        : undefined,
      externalExecutionAuthority: !isChat && approvalService?.freezeExecutionApproval && approvalService?.authorizeExecution ? {
        /** 私有目标由Core重新预检并冻结，宿主不提交目标身份。 */
        async freeze(input) { await approvalService.freezeExecutionApproval!({ sessionId, turnId, workspaceRoot: frozen.workspaceRoot ?? capabilities.workspaceRoot ?? "", ...input }); },
        /** 只有真实Service批准/完整grant可以签发，旧validator布尔值不扩权。 */
        async authorize(input) { return approvalService.authorizeExecution!({ sessionId, turnId, workspaceRoot: frozen.workspaceRoot ?? capabilities.workspaceRoot ?? "", ...input }); },
      } : undefined,
      validateApproval: !isChat && approvalService
        ? async function validateApproval({ approvalId, decision, callId, toolName, inputHash, constraint }) {
            const stored = await approvalService.getDecision({ sessionId, turnId, approvalId });
            if (!stored) return false;
            if (stored.callId !== callId || stored.toolName !== toolName || stored.normalizedInputHash !== inputHash || !matchesApprovalDecision(stored.decision, decision)) return false;
            // Talk-Plan1013 Stage5 R2：恢复路径同样校验 TTL（内存执行路径早已校验，这里补齐跨进程恢复）。
            const expiresAtMs = Date.parse(stored.expiresAt ?? "");
            if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.parse(ports.clock.timestamp())) return false;
            // 外部文件审批：必须绑定当前 facts 的 constraint，并经持久底座原子一次消费；
            // 目标经链接切换改变后约束失配、过期与重放均返回 false。
            if (decision !== "deny" && isExternalFileConstraint(stored.constraint)) {
              if (!constraint || stored.constraint !== constraint || !approvalService.consumeFileApproval) return false;
              // Talk-Plan1013 Stage5 D1（CR R2 必测 #4）：非 allow_once 的文件审批在恢复/内存持久
              // 消费前重查持久 grant——撤销（deletePersistentGrant）或 allow_workspace 双边不一致
              // （投影规则被删）时旧审批不能复活权限；allow_once 无 grant 可撤销，一次审批即权威。
              // 复用 hasPersistentGrant 的既有 deny/ask 收窄与 allow_workspace 双边一致逻辑，
              // 不新建第二授权来源；内存 pending 路径经 tool-executor 同一 validateApproval 入口覆盖。
              if (stored.decision !== "allow_once" && !await approvalService.hasPersistentGrant({
                workspaceRoot: frozen.workspaceRoot ?? capabilities.workspaceRoot ?? "",
                sessionId,
                toolName,
                constraint: stored.constraint,
              })) return false;
              return approvalService.consumeFileApproval({ sessionId, turnId, approvalId, constraint: stored.constraint, callId, normalizedInputHash: inputHash, now: ports.clock.timestamp() });
            }
            // R1：降级批准只能按无沙箱约束消费，并经持久底座原子一次认领；已认领后
            // 执行终态未知（崩溃窗口/重复 continue）不得再次直执。
            if (decision !== "deny" && isNoSandboxExecConstraint(stored.constraint)) {
              if (!constraint || stored.constraint !== constraint || !approvalService.consumeDegradeApproval) return false;
              return approvalService.consumeDegradeApproval({ sessionId, turnId, approvalId, constraint: stored.constraint, callId, normalizedInputHash: inputHash, now: ports.clock.timestamp() });
            }
            // R1：普通批准没有降级约束，恢复时不能被当作无沙箱批准消费
            // （CR 20261016 R2 后执行链不再签发降级批准，该约束保留休眠）。
            if (constraint && isNoSandboxExecConstraint(constraint) && stored.constraint !== constraint) return false;
            return true;
          }
        : undefined,
    };
  }

  /** 基于当前 Turn 冻结的 Provider 配置创建无工具摘要采样器，凭据仅保留在闭包中。 */
  function buildCompactionSampler(
    frozen: FrozenRunConfig,
    capabilities: RunConfig,
    sessionId: string,
    turnId: string,
    credential?: ResolvedCredential,
    providerConfig?: FrozenProviderConfig,
  ): ModelSampler {
    return buildAgentOptions(frozen, capabilities, sessionId, turnId, credential, providerConfig).modelSampler
      ?? createDefaultModelSampler();
  }

  return { mergeRunConfig, readRuntimeDefault, freezeProviderConfig, normalizeFrozenProviderConfig, buildAgentOptions, buildCompactionSampler };
}

/** 将允许类持久审批决定收窄为 continue 协议可提交的一次 allow。 */
function matchesApprovalDecision(stored: ToolApprovalDecision, requested: ToolApprovalDecision): boolean {
  if (requested === "deny") return stored === "deny";
  return stored === "allow_once" || stored === "allow_session" || stored === "allow_workspace";
}
