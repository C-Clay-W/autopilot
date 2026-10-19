/** Stage3 私有执行审批复用decisions存储的合成测试；新Store实例并发只消费一次，无进程/系统操作。 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeApprovalStore } from "./node-approval-store";
import type { ExternalExecutionApproval } from "@autopilot-agent/core";

describe("Stage3 Node执行批准", function privateExecutionApprovals() {
  it("私有冻结不是decision；重建Store后真正批准、约束/TTL和并发一次消费", async function persistsAtomicConsumption() {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "stage3-node-approval-"));
    try {
      const first = createNodeApprovalStore({ stateRoot });
      const key = { sessionId: "session", turnId: "turn", approvalId: "approval" };
      const request: ExternalExecutionApproval = { ...key, recordType: "external_execution_request", callId: "call", toolName: "run_command", normalizedInputHash: "input-hash", constraint: `ext-exec-file:v1:${"a".repeat(64)}`, expiresAt: "2099-01-01T00:00:00Z", target: { schemaVersion: 1, canonicalWorkspace: "C:\\fixture\\workspace", canonicalTarget: "C:\\fixture\\outside\\file.txt", scope: "file", operation: "write", commandDigest: "b".repeat(64) } };
      expect(await first.saveExecutionApproval!(request)).toBe(true);
      expect(await first.getDecision(key)).toBeNull();
      const consume = { ...key, callId: "call", normalizedInputHash: "input-hash", constraint: request.constraint, now: "2026-10-13T00:00:00Z" };
      expect(await first.consumeExecutionApproval!(consume)).toBe(false);
      expect(await first.saveDecision({ ...key, callId: "call", toolName: "run_command", normalizedInputHash: "input-hash", constraint: request.constraint, expiresAt: request.expiresAt, decision: "allow_once", createdAt: consume.now })).toBe(true);
      const restored = createNodeApprovalStore({ stateRoot });
      expect(await restored.getExecutionApproval!(key)).toEqual(request);
      expect(await restored.consumeExecutionApproval!({ ...consume, constraint: "program:node" })).toBe(false);
      expect(await restored.consumeExecutionApproval!({ ...consume, now: "2099-01-01T00:00:00Z" })).toBe(false);
      const results = await Promise.all([first.consumeExecutionApproval!(consume), restored.consumeExecutionApproval!(consume)]);
      expect(results.filter(function accepted(value) { return value; })).toHaveLength(1);
      expect(await createNodeApprovalStore({ stateRoot }).consumeExecutionApproval!(consume)).toBe(false);
      const contents = await readFile(path.join(stateRoot, "approvals", "decisions.jsonl"), "utf8");
      expect(contents).toContain("external_execution_request");
      expect(contents).toContain("external_execution_consumed");
      expect(await restored.getDecision(key)).toMatchObject({ decision: "allow_once" });
      await restored.deleteBySession(key.sessionId);
      expect(await restored.getExecutionApproval!(key)).toBeNull();
    } finally { await rm(stateRoot, { recursive: true, force: true }); }
  });
});
