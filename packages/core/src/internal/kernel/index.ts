/**
 * Agent Kernel 公开出口。
 * Phase 1 将执行闭环从 Web/Route 解耦，提供可供 headless runner、测试与后续 CLI/Desktop 复用的无头入口。
 */

export type { ModelSampler } from "./model-sampler";
export { createDefaultModelSampler } from "./model-sampler";

export type { PermissionContext, RunContext } from "./run-context";

export { compactMessages, estimateMessageTokens, projectMessagesForSummary } from "./compact";

export type { AgentKernel } from "./agent-kernel";
export { createAgentKernel, runKernel } from "./agent-kernel";
export type { CompletionDecision, CompletionIntentSignal, CompletionPolicy, CompletionPolicyState } from "./completion-policy";
export { createMutationCompletionPolicy } from "./completion-policy";
