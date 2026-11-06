/** r007在隔离内存Store验证执行代次和安全attention语义，不访问现场。 */
import { expect, it, vi } from "vitest";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";
import { readTurnExecutionView } from "../../../src/runtime/application/turn/turn-execution-view";
import { createThreadFacade } from "../../../src/runtime/application/thread-service";
import { createThreadTools } from "../../../src/internal/tools/builtins/thread-tools";
import { createThreadObservationDisplay } from "../../../src/internal/tools/thread-observation-display";

/** 建立同Turn/同lease运行记录，读取间推进由具体用例控制。 */
async function fixture() {
 const ports = createMemoryPorts();
 await ports.projectStore.save({ id: "project", name: "controlled", workspaceRoot: await ports.workspaceAdapter.resolveWorkspaceRoot(), createdAt: 1, updatedAt: 1 });
 await ports.sessionStore.save({ id: "target", projectId: "project", productMode: "work", persistenceMode: "durable", status: "running", activeTurnId: "turn", createdAt: 1, updatedAt: 1 });
 await ports.turnStore.save({ id: "turn", sessionId: "target", status: "running", frozenRunConfig: {}, startedAt: 1, schemaVersion: 2 } as any);
 const lease = { leaseId: "lease", ownerId: "owner", heartbeatAt: ports.clock.now(), safeBoundarySeq: 1 };
 const checkpoint: any = { turnId: "turn", status: "running", stepCount: 1, messages: [], completedCallIds: [], lease };
 await ports.checkpointStore.save("target", checkpoint);
 ports.leaseStore.readCurrent = vi.fn(async function owner() { return { sessionId: "target", turnId: "turn", lease }; });
 await ports.transcriptStore.append("target", { sessionId: "target", turnId: "turn", seq: 1, timestamp: new Date().toISOString(), event: { type: "turn_started", turnId: "turn", stepCount: 0 } });
 return { ports, checkpoint, lease };
}
it("r007 同Turn同lease running边界持续单调前进仍为active", async function monotonicRunning() {
 const f = await fixture(); let seq = 1;
 vi.spyOn(f.ports.checkpointStore, "getLatest").mockImplementation(async function advancing() { return { ...f.checkpoint, lease: { ...f.lease, safeBoundarySeq: seq++ } }; });
 expect(await readTurnExecutionView(f.ports, { sessionId: "target" })).toMatchObject({ status: "running", execution: "active" });
 expect(f.ports.checkpointStore.getLatest).toHaveBeenCalledTimes(2);
});
it.each(["lease", "owner", "backward"])("r007 %s变化不能套用running推进，重读耗尽保留安全原因", async function executionChanged(change) {
 const f = await fixture(); let reads = 0;
 vi.spyOn(f.ports.checkpointStore, "getLatest").mockImplementation(async function changing() { reads++; return { ...f.checkpoint, lease: { ...f.lease, ...(change === "lease" ? { leaseId: `lease-${reads}` } : change === "owner" ? { ownerId: `owner-${reads}` } : { safeBoundarySeq: 100 - reads }) } }; });
 expect(await readTurnExecutionView(f.ports, { sessionId: "target" })).toMatchObject({ execution: "unconfirmed", unconfirmedReason: "snapshot_changed" });
});
it("r007读取间真实暂停须重读后按精确pending审批显示，不能变running", async function realPause() {
 const f = await fixture(); let reads = 0;
 const approval: any = { type: "approval_required", turnId: "turn", stepId: "step", callId: "call", toolName: "run_command", result: { status: "approval_required", approval: { approvalId: "approval", callId: "call", toolName: "run_command", expiresAt: new Date(Date.now() + 60000).toISOString(), allowedDecisions: ["allow_once", "deny"] } } };
 await f.ports.transcriptStore.append("target", { sessionId: "target", turnId: "turn", seq: 2, timestamp: new Date().toISOString(), event: approval });
 vi.spyOn(f.ports.checkpointStore, "getLatest").mockImplementation(async function pause() { return ++reads === 1 ? f.checkpoint : { ...f.checkpoint, status: "awaiting_approval", pendingCalls: [{ id: "call", name: "run_command", input: {} }], lease: { ...f.lease, safeBoundarySeq: 2 } }; });
 expect(await readTurnExecutionView(f.ports, { sessionId: "target" })).toMatchObject({ status: "waiting_approval", execution: "inactive", interaction: { state: "pending" } });
});
it("r007 unconfirmed/lost只暴露对应attentionKind与安全原因，工具契约不允许推导审批", async function attentionMeaning() {
 const f = await fixture();
 const human = createThreadFacade(f.ports, { workspaceId: "workspace", stateRootId: "state", projectId: "project", allowedTools: [], modelCatalog: [], actor: { kind: "human", principalId: "user" } });
 const session = (await f.ports.sessionStore.get("target"))!;
 await f.ports.sessionStore.save({ ...session, status: "idle", activeTurnId: undefined });
 const enabled = await human.enable({ protocolVersion: 1, rootThreadId: "target", requestId: "enable" });
 await f.ports.sessionStore.save(session);
 vi.spyOn(f.ports.checkpointStore, "getLatest").mockResolvedValue(null as any);
 const result = await human.wait({ protocolVersion: 1, groupId: enabled.group.groupId, targets: [{ threadId: "target" }], timeoutMs: 0 });
 expect(result.results[0]).toMatchObject({ reason: "attention", summary: { execution: "unconfirmed", attentionKind: "execution_unconfirmed", unconfirmedReason: "checkpoint_missing" } });
 const display = createThreadObservationDisplay("wait_threads", { targets: [{ threadId: "target" }] }, result);
 expect(display).not.toHaveProperty("approvalTargets");
 expect(display?.lines.join(" ")).toContain("attentionKind=execution_unconfirmed");
 vi.restoreAllMocks();
 f.ports.leaseStore.readCurrent = async function stale() { return { sessionId: "target", turnId: "turn", lease: { ...f.lease, heartbeatAt: Date.now() - 120000 } }; };
 const lost = await human.wait({ protocolVersion: 1, groupId: enabled.group.groupId, targets: [{ threadId: "target" }], timeoutMs: 0 });
 expect(lost.results[0].summary).toMatchObject({ attentionKind: "execution_lost", execution: "lost" });
 expect(createThreadTools({} as any).waitThreads.description).toContain("attention仅表示需要关注，不等于审批");
 expect(createThreadTools({} as any).waitThreads.description).toContain("不得推导审批或主动恢复");
});
