/** 受管 Worker 的反向工具桥：真实 Runtime 绑定身份，模型只传业务 JSON。 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserCapability, RunConfig } from "@autopilot-agent/core";
import type { ManagedRuntimeIdentity } from "./managed-runtime-service";

/** 仅受信 bootstrap 启用；主控复用普通 Runtime 能力，恢复解释单独限权，受管 Thread 仍由 Core 禁用。 */
export function createOrchestrationToolLoader(identity: ManagedRuntimeIdentity): NonNullable<RunConfig["hostToolsLoader"]> {
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; cleanup(): void }>();
  process.on("message", function reply(value: any) {
    if (value?.kind !== "tool_reply" || value.hostId !== identity.hostId || value.owner !== identity.owner || value.generation !== identity.generation) return;
    const item = pending.get(value.id);
    if (!item) return;
    item.cleanup();
    if (value.error) item.reject(new Error(value.error)); else item.resolve(value.result);
  });
  /** 原请求超时只返回未知，不在 RPC 层重试副作用。 */
  function call(binding: { sessionId: string; turnId: string }, operation: string, input: unknown, signal?: AbortSignal): Promise<any> {
    if (!process.connected) return Promise.reject(new Error("MANAGED_NOT_CONNECTED"));
    if (signal?.aborted) return Promise.reject(new Error("BROWSER_CANCELLED"));
    const id = randomUUID();
    return new Promise(function request(resolve, reject) {
      const timer = setTimeout(function timeout() { cleanup(); if (signal) abortHost(); reject(new Error("MANAGED_REPLY_UNKNOWN")); }, signal ? 600_000 : 15000);
      /** Worker 可能同时退出，IPC 写入失败不改变本次取消结果。 */
      function abortHost() { if (process.connected) process.send?.({ kind: "tool_cancel", ...identity, id }, function sent() {}); }
      /** 清理原 RPC，通知 Main 中止本次浏览器审批/动作。 */
      function cancel() { cleanup(); abortHost(); reject(new Error("BROWSER_CANCELLED")); }
      /** 同一请求无论正常完成、取消或超时都只移除自身。 */
      function cleanup() { pending.delete(id); clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
      pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", cancel, { once: true });
      process.send?.({ kind: "tool", ...identity, ...binding, id, operation, input }, function sent(error) {
        if (error) { cleanup(); reject(new Error("MANAGED_REPLY_UNKNOWN")); }
      });
    });
  }
  return async function load(binding) {
    const catalog = await call(binding, "catalog", {});
    const browser: BrowserCapability | undefined = typeof catalog.browserKey === "string" ? {
      confirmsDocument: true,
      managesApprovals: true,
      /** 浏览器身份取自 Core 的闭包，模型只提供 BrowserOperation。 */
      request(actual, callId, operation, signal, authorization) {
        if (actual.sessionId !== binding.sessionId || actual.turnId !== binding.turnId) throw new Error("BROWSER_TURN_UNAVAILABLE");
        return call(binding, "browser_request", { key: catalog.browserKey, callId, operation, authorization }, signal ?? new AbortController().signal);
      },
      /** 结束只撤销该闭包的执行段，允许 Worker 断开时由宿主清理。 */
      async endTurn(actual) {
        if (actual.sessionId === binding.sessionId && actual.turnId === binding.turnId) await call(binding, "browser_end", { key: catalog.browserKey }).catch(function disconnected() {});
      },
    } : undefined;
    const names: string[] = catalog.role === "recovery" ? ["orchestration_recovery"] : catalog.role === "controller" ? ["orchestration_query", "orchestration_decide", "orchestration_relay"] : ["orchestration_query", "orchestration_report", "orchestration_relay"];
    return { browser, beforeExecute: catalog.role !== "recovery" ? async function admit(toolName) { await call(binding, "tool_admission", { toolName }); } : undefined, allowedTools: catalog.role === "recovery" ? names : undefined, tools: names.map(function tool(name) {
      return { name, description: name === "orchestration_recovery" ? "仅解释恢复选择，payload只有choice:continue|new|details。不是执行、审批或资源释放许可。" : name === "orchestration_query" ? "查询绑定角色、最新摘要、待处理意图、版本和该角色可用合同。先查询，不混用角色字段。" : name === "orchestration_relay" ? "登记直输影响、处理结果、主控裁决或实际接收移交。先查 orchestration_query 合同，payload 为 {expectedRevision,action}。" : name === "orchestration_decide" ? "仅主控提交语义决定。payload顶层只允许intentId、basis、expectedRevision、reason、actions；禁止附加执行者report/local/result。复杂委派先查询；简单请求可直接使用普通工具或回答，无需 decide；也可用空 actions 显式确认消费，无需计划或封批。只有复杂委派才按合同封批；不能代人类审批。" : "提交自身委派 report：local 局部流程与 result 证据；不宣告全局验收。",
        inputSchema: z.object({ payload: z.string().max(60000) }).strict(),
        metadata: { effect: "none" as const, destructive: false, concurrency: { max: 1 }, retry: { safe: false } },
        /** 这里只提交宿主业务意图；实际执行另经 S5 和 Core 权限检查。 */
        createActionFacts: function facts() { return { toolName: name, effect: "none" as const, destructive: false, operation: name }; },
        /** Session/Turn 来自闭包，JSON 无权改写调用者身份。 */
        execute: async function execute(input: { payload: string }) { return call(binding, name, JSON.parse(input.payload)); },
        /** 返回有界关系摘要，不返回其他会话 transcript。 */
        serializeOutput: function output(value: unknown) { return value; },
      };
    }) };
  };
}
