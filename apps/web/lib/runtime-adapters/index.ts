/**
 * Web Runtime Adapter 兼容出口：真实实现位于 @autopilot-agent/adapters，保留旧 Web 导入路径。
 */

import type { RuntimePorts } from "@autopilot-agent/core";
import {
  createNodeApprovalStore as createSharedApprovalStore,
  createNodeCapabilityLoader,
  createNodeCheckpointStore as createSharedCheckpointStore,
  createNodeClock,
  createNodeCredentialStore as createSharedCredentialStore,
  createNodeEventSink as createSharedEventSink,
  createNodeInputInbox as createSharedInputInbox,
  createNodeProjectStore as createSharedProjectStore,
  createNodeRuntimePorts,
  createNodeSessionStore as createSharedSessionStore,
  createNodeTranscriptStore as createSharedTranscriptStore,
  createNodeTurnStore as createSharedTurnStore,
  createNodeWorkspaceAdapter as createSharedWorkspaceAdapter,
  resolveNodeStateRoot,
} from "@autopilot-agent/adapters";
export { createNodeCapabilityLoader };
export { createWebTrustPolicy } from "./web-trust-policy";
export { loadMcpConfigFromWorkspace } from "./node-mcp-loader";

/** Web 兼容 Adapter 选项；新宿主应直接使用 @autopilot-agent/adapters 并显式传 stateRoot。 */
export interface WebRuntimeAdapterOptions {
  stateRoot?: string;
  workspaceRoot?: string;
}

/** 解析 Web 兼容状态根；默认按 canonical workspace identity 生成稳定目录。 */
function resolveWebStateRoot(options: WebRuntimeAdapterOptions = {}): string {
  return resolveNodeStateRoot({ stateRoot: options.stateRoot, workspaceRoot: options.workspaceRoot });
}

/** 创建一组共享 Node Port 的 Web 兼容封装。 */
export function createWebRuntimePorts(options: WebRuntimeAdapterOptions = {}): RuntimePorts {
  return createNodeRuntimePorts({
    stateRoot: resolveWebStateRoot(options),
    workspaceRoot: options.workspaceRoot,
  });
}

/** 以下工厂保留旧 Web 模块名称，统一转发到共享包并要求显式或兼容解析的状态根。 */
export function createNodeSessionStore(options: WebRuntimeAdapterOptions = {}) { return createSharedSessionStore({ stateRoot: resolveWebStateRoot(options) }); }
export function createNodeCheckpointStore(options: WebRuntimeAdapterOptions = {}) { return createSharedCheckpointStore({ stateRoot: resolveWebStateRoot(options) }); }
export function createNodeTranscriptStore(options: WebRuntimeAdapterOptions = {}) { return createSharedTranscriptStore({ stateRoot: resolveWebStateRoot(options) }); }
export function createNodeCredentialStore() { return createSharedCredentialStore(); }
export function createNodeProjectStore(options: WebRuntimeAdapterOptions = {}) { return createSharedProjectStore({ stateRoot: resolveWebStateRoot(options) }); }
export function createNodeEventSink(options: WebRuntimeAdapterOptions = {}) { return createSharedEventSink({ stateRoot: resolveWebStateRoot(options) }); }
export function createNodeWorkspaceAdapter(options: WebRuntimeAdapterOptions = {}) { return createSharedWorkspaceAdapter({ workspaceRoot: options.workspaceRoot }); }
export function createNodeTurnStore(options: WebRuntimeAdapterOptions = {}) { return createSharedTurnStore({ stateRoot: resolveWebStateRoot(options) }); }
export function createNodeApprovalStore(options: WebRuntimeAdapterOptions = {}) { return createSharedApprovalStore({ stateRoot: resolveWebStateRoot(options) }); }
export function createNodeInputInbox(options: WebRuntimeAdapterOptions = {}) { return createSharedInputInbox({ stateRoot: resolveWebStateRoot(options) }); }
export function createDefaultClock() { return createNodeClock(); }
