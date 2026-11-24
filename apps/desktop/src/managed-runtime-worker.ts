/** 受管子进程的私有 IPC 装配；生产能力由受信 bootstrap 注入，不从页面接收 Runtime 配置。 */
import { createAgentRuntime, projectRuntimeFact, type AgentRuntime, type CreateAgentRuntimeOptions } from "@autopilot-agent/core";
import { withNodeRuntimeOwner } from "@autopilot-agent/adapters";
import { ManagedRuntimeService, type ManagedRuntimeIdentity } from "./managed-runtime-service";
import { createOrchestrationToolLoader } from "./orchestration-tools";

/** 一个进程只装配一个 Checkout Runtime；只读事实提示失败不会回滚 Core 的持久事件。 */
export async function attachManagedRuntimeWorker(options: CreateAgentRuntimeOptions & { identity: ManagedRuntimeIdentity; journalPath: string; workspaceRoot: string; stateRoot: string; orchestration?: boolean }): Promise<void> {
  if (!process.send || !process.connected) throw new Error("MANAGED_PRIVATE_CHANNEL_REQUIRED");
  await withNodeRuntimeOwner(options.stateRoot, async function ownRuntime() {
  if (!process.connected) return;
  const sink = options.ports.eventSink;
  const ports = { ...options.ports, eventSink: { async write(envelope: Parameters<typeof sink.write>[0]) {
    await sink.write(envelope);
    if (process.connected && projectRuntimeFact(envelope)) process.send?.({ kind: "changed", ...options.identity, sessionId: envelope.sessionId });
  } } };
  const runtime = createAgentRuntime({ ...options, ports, defaultRunConfig: { ...options.defaultRunConfig, ...(options.orchestration ? { hostToolsLoader: createOrchestrationToolLoader(options.identity) } : {}) } });
  await serveManagedRuntime(runtime, options);
  });
  process.exit(0);
}

/** 可信 bootstrap 和测试装配共用同一私有通道，不另建模型循环。 */
export async function serveManagedRuntime(runtime: AgentRuntime, options: { identity: ManagedRuntimeIdentity; journalPath: string; workspaceRoot: string; orchestration?: boolean; ports: CreateAgentRuntimeOptions["ports"]; cli?: import("./managed-runtime-service").ManagedCliServices }): Promise<void> {
  const service = new ManagedRuntimeService(runtime, options.identity, options.journalPath, options.workspaceRoot, options.ports.transcriptStore, options.cli);
  /** IPC 只接受父进程固定形状，所有命令再过服务身份/目标校验。 */
  async function receive(message: unknown) {
    if (!message || typeof message !== "object") return;
    const frame = message as { kind?: string; id?: string; command?: unknown; human?: boolean };
    if (frame.kind !== "command" || typeof frame.id !== "string" || !/^[\w-]{1,128}$/.test(frame.id) || Object.keys(frame).some(function invalid(key) { return !["kind", "id", "command", "human"].includes(key); })) return;
    try {
      const result = await service.dispatch(frame.command, frame.human === true ? "human" : "host");
      const command = frame.command as { operation: string; sessionId?: string };
      if (process.connected && command.sessionId && !["read", "transcript", "snapshot", "activity", "lease_activity", "active_turns", "inspect", "query"].includes(command.operation)) process.send?.({ kind: "changed", ...options.identity, sessionId: command.sessionId });
      if (process.connected) process.send?.({ kind: "reply", ...options.identity, id: frame.id, result });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const message = typeof code === "string" ? code : error instanceof Error ? error.message : "";
      if (process.connected) process.send?.({ kind: "reply", ...options.identity, id: frame.id, error: /^[A-Z][A-Z_]{1,80}$/.test(message) ? message : "MANAGED_OPERATION_FAILED" });
    }
  }
  process.on("message", function message(value) { void receive(value); });
  const disconnected = new Promise<void>(function wait(resolve) { process.once("disconnect", resolve); });
  process.send?.({ kind: "ready", ...options.identity, orchestration: options.orchestration === true });
  await disconnected;
  await runtime.shutdown?.();
}
