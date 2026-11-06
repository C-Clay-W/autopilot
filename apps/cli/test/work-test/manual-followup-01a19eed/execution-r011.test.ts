/** r011父子同源审批：真实Core安全请求不依赖摘要或正文百页追赶。 */
import { expect, it } from "vitest";
import { createAgentRuntime, type AgentEventEnvelope } from "@autopilot-agent/core";
import { createMemoryPorts } from "../../../../../packages/core/src/runtime/adapters/memory";
import { createSessionService } from "../../../../../packages/core/src/runtime/application/session-service";
import { readCliSessionSummary } from "../../../src/session-summary";
import { createCliController } from "../../../src/controller";
import { createPlainRenderer } from "../../../src/renderer";
import { createCliSessionManager } from "../../../src/tui/session-manager";

it("父关联与子会话引用同一安全请求，101页旧正文不决定可见性", async function sameRequestAcrossViews() {
  const ports = createMemoryPorts(process.cwd());
  const root = await createSessionService(ports).create({ title: "父" });
  const child = await createSessionService(ports).create({ title: "子" });
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { workspaceRoot: process.cwd(), permissionMode: "ask", modelSampler: { async sample() { return { content: "", toolCalls: [{ id: "write-cli", name: "write_file", input: { path: "r011-not-written.txt", content: "test" } }], reasoningSummary: "审批" }; } } } });
  const stream = runtime.turns.start({ sessionId: child.id, content: "隔离测试" });
  const controllers = new Map<string, ReturnType<typeof createCliController>>();
  /** 固定每个目标的Controller身份，视图切换不重建请求或执行。 */
  function controller(sessionId: string) { const existing = controllers.get(sessionId); if (existing) return existing; const value = createCliController({ runtime, sessionId, renderer: createPlainRenderer("text") }); controllers.set(sessionId, value); return value; }
  let childPages = 0;
  const manager = createCliSessionManager({ runtime, projectId: root.projectId!, initialSession: root, initialController: controller(root.id), createController: controller,
    readSummary: function summary(id) { return readCliSessionSummary(ports, id); },
    readRelations: async function relations() { const summary = await readCliSessionSummary(ports, child.id); return [{ threadId: child.id, parentThreadId: root.id, title: child.title, status: summary!.status, activeTurnId: summary!.currentTurnId, executionView: summary!.executionView }]; },
    readEventPage: async function page(id, input) {
      if (id === root.id) return { items: [], cursor: "root-tail" };
      childPages++;
      const start = Number(input.cursor ?? 0); const end = Math.min(10100, start + 100);
      const items: AgentEventEnvelope[] = Array.from({ length: end - start }, function old(_, index) { return { sessionId: child.id, turnId: "old-turn", seq: start + index + 1, timestamp: new Date(0).toISOString(), event: { type: "answer_delta", turnId: "old-turn", stepId: "old", delta: "旧正文\n" } }; });
      return { items, cursor: String(end), ...(end < 10100 ? { nextCursor: String(end) } : {}) };
    },
  });
  try {
    while ((await stream.next()).value?.type !== "turn_paused") { /* 保持旧流停在暂停输出。 */ }
    const turn = (await ports.turnStore.getLatest(child.id))!;
    await ports.turnStore.save({ ...turn, status: "running" });
    await ports.sessionStore.save({ ...(await ports.sessionStore.get(child.id))!, status: "running", activeTurnId: turn.id });
    await manager.refresh();
    const linked = manager.related()[0]!;
    const request = linked.controller.getProjection().pendingApproval!;
    expect(request.approvalId).toBeDefined(); expect(childPages).toBe(0);
    await manager.select(child.id);
    expect(manager.selected().controller.getProjection().pendingApproval?.approvalId).toBe(request.approvalId);
    expect(manager.selected().historyMore).toBe(true);
    while (manager.selected().historyMore) await manager.loadHistory(child.id);
    expect(childPages).toBe(101);
    expect(manager.selected().controller.getProjection().pendingApproval?.approvalId).toBe(request.approvalId);
    await manager.select(root.id); await manager.refresh();
    expect(manager.related()[0]?.controller.getProjection().pendingApproval?.approvalId).toBe(request.approvalId);
    await runtime.approvals.submit({ sessionId: child.id, turnId: turn.id, approvalId: request.approvalId, decision: "allow_once" });
    await manager.refresh();
    expect(manager.related()[0]?.controller.getProjection().pendingApproval).toBeUndefined();
    expect(manager.related()[0]?.interactionNotice).toBe("审批决定已保存，等待继续执行");
  } finally { await stream.return(undefined); await manager.stop(); }
}, 20000);
