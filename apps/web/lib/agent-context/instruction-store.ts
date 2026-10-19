/**
 * Web Context 兼容入口；持久指令发现实现统一位于 @autopilot-agent/adapters。
 */

export { discoverInstructions } from "@autopilot-agent/adapters";
export type { InstructionDiscovery, NodeFrozenInstruction as FrozenInstruction } from "@autopilot-agent/adapters";
