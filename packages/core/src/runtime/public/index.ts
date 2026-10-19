/**
 * runtime/public — Runtime 公开 API 统一出口
 *
 * Phase 3 起 AgentRuntime 接口抽离到 agent-runtime.ts，便于 type-only 引用。
 */

export { createAgentRuntime } from "./create-agent-runtime";
export type { CreateAgentRuntimeOptions } from "./create-agent-runtime";
export type { AgentRuntime, AgentRuntimeFacade } from "./agent-runtime";
