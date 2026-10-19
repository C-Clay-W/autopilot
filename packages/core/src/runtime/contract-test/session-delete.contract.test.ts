/**
 * runtime/contract-test/session-delete.contract.test.ts — Runtime Session 级联删除契约
 *
 * 验证删除 Session 后不会遗留 Turn、checkpoint、transcript、approval、inbox 或 lease。
 */

import { describe, expect, it } from "vitest";
import { createMemoryPorts, MemorySessionResourceStore } from "../adapters/memory";
import { createAgentRuntime } from "../public/create-agent-runtime";
import { createAgentTextMessage } from "../../internal/types/agent-message";

describe("Session delete contract test", function sessionDeleteContractSuite() {
  it("删除 Session 时级联清理所有 Session-owned durable state", async function deletesSessionOwnedState() {
    const ports = createMemoryPorts();
    const runtime = createAgentRuntime({ ports });
    const session = await runtime.sessions.create({ id: "delete-session-001", title: "待删除" });
    const turnId = "delete-turn-001";
    const checkpoint = {
      turnId,
      status: "completed" as const,
      stepCount: 1,
      messages: [createAgentTextMessage("user", "删除测试")],
      completedCallIds: [],
    };
    await ports.turnStore.save({ id: turnId, sessionId: session.id, status: "completed", frozenRunConfig: {}, startedAt: 1, completedAt: 2 });
    await ports.checkpointStore.save(session.id, checkpoint);
    await ports.transcriptStore.append(session.id, {
      seq: 1,
      sessionId: session.id,
      turnId,
      timestamp: "2026-08-20T00:00:00.000Z",
      event: { type: "turn_completed", turnId, checkpoint: { turnId, status: "completed", stepCount: 1, messages: [], completedCallIds: [] } },
    });
    await ports.approvalStore.saveDecision({ approvalId: "approval-001", sessionId: session.id, turnId, callId: "call-001", toolName: "write_file", normalizedInputHash: "hash", decision: "allow_once", createdAt: "2026-08-20T00:00:00.000Z" });
    await ports.approvalStore.savePersistentGrant({ scope: "allow_session", sessionId: session.id, toolName: "write_file", constraint: "path:note.txt", createdAt: "2026-08-20T00:00:00.000Z" });
    await runtime.inbox.post({ sessionId: session.id, delivery: "queue", content: "待处理" });
    const lease = { leaseId: "lease-001", ownerId: "owner-001", heartbeatAt: 1, safeBoundarySeq: 0 };
    await ports.leaseStore.acquire({ sessionId: session.id, turnId, lease, now: 1, staleAfterMs: 10_000 });

    expect(await runtime.sessions.delete(session.id)).toBe(true);
    expect(await ports.sessionStore.get(session.id)).toBeNull();
    expect(await ports.turnStore.list(session.id)).toEqual([]);
    expect(await ports.checkpointStore.getLatest(session.id)).toBeNull();
    expect(await ports.transcriptStore.getEvents(session.id)).toEqual([]);
    expect(await ports.approvalStore.getDecision({ sessionId: session.id, turnId, approvalId: "approval-001" })).toBeNull();
    expect(await ports.approvalStore.getPersistentGrant({ workspaceRoot: "/tmp/test-workspace", sessionId: session.id, toolName: "write_file", constraint: "path:note.txt" })).toBeNull();
    expect(await runtime.inbox.list({ sessionId: session.id })).toEqual([]);
    expect(await ports.leaseStore.acquire({ sessionId: session.id, turnId: "replacement-turn", lease: { ...lease, leaseId: "lease-002" }, now: 2, staleAfterMs: 10_000 })).not.toBeNull();
    expect((ports.sessionResourceStore as MemorySessionResourceStore).hasDeleted(session.id)).toBe(true);
  });
});
