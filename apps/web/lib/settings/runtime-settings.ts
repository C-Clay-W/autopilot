/** 将受信 settings 转为两种宿主共用的 Core 模型配置。 */
import type { ResolvedAutopilotSettings, RunConfig } from "@autopilot-agent/core";

/** 将已信任的 settings 快照映射为新 Turn 可冻结的 Runtime 默认项，绝不包含明文凭据。 */
export function createSettingsRunConfig(settings: ResolvedAutopilotSettings): Partial<RunConfig> {
  const selectedRoute = settings.modelRef && settings.modelRef.provider !== "firstParty"
    ? settings.providerRoutes[settings.modelRef.provider]
    : undefined;
  const primary = selectedRoute
    ? {
        apiProtocol: selectedRoute.apiProtocol,
        baseUrl: selectedRoute.baseUrl,
        credentialRef: selectedRoute.credentialRef,
        protocolProfile: selectedRoute.protocolProfile,
        maxOutputTokens: settings.firstParty.maxOutputTokens,
      }
    : settings.modelRef && settings.modelRef.provider !== "firstParty"
      ? undefined
      : {
          apiProtocol: "anthropic-messages" as const,
          baseUrl: settings.firstParty.baseUrl,
          credentialRef: settings.firstParty.credentialRef,
          maxOutputTokens: settings.firstParty.maxOutputTokens,
          compactThresholdTokens: settings.firstParty.compactWindow,
          timeoutMs: settings.firstParty.timeoutMs,
          subagentModelId: settings.firstParty.subagentModelId,
          thinkingEnabled: settings.firstParty.thinkingEnabled,
        };
  const credentialRef = selectedRoute
    ? selectedRoute.credentialRef
    : settings.modelRef && settings.modelRef.provider !== "firstParty"
      ? undefined
      : settings.firstParty.credentialRef;
  const visionRef = settings.visionModelRef === false ? undefined : settings.visionModelRef ?? settings.modelRef;
  const visionRoute = visionRef && settings.providerRoutes[visionRef.provider];
  return {
    ...(settings.maxTurns !== undefined ? { maxSteps: settings.maxTurns } : {}),
    ...(settings.modelRef ? { modelRef: settings.modelRef } : {}),
    ...(settings.reasoningProfile ? { reasoningProfile: settings.reasoningProfile } : {}),
    ...(credentialRef ? { credentialRef } : {}),
    providerSettings: {
      ...(primary ? { primary } : {}),
      routes: settings.providerRoutes,
      ...(visionRef ? {
        visionModelRef: visionRef,
        vision: visionRoute
          ? { apiProtocol: visionRoute.apiProtocol, baseUrl: visionRoute.baseUrl, credentialRef: visionRoute.credentialRef }
          : primary,
      } : {}),
      ...(settings.visionModelRef === false ? { visionModelRef: undefined, vision: undefined } : {}),
    },
  };
}

