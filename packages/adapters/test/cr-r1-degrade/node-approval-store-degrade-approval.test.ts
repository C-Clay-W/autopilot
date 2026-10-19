/**
 * cr-r1-degrade 回归用例：R1 修复的 Node 持久底座（web-runtime-20261016 CR R1）。
 *
 * 降级审批复用 decisions.jsonl + withFileLock 底座，持久原子一次消费，跨进程不能重放。
 * Core 流程回归只覆盖 Memory 实现；Node ApprovalStore 新增的 saveDegradeApproval/
 * consumeDegradeApproval（含 sandbox_degrade_consumed 落盘标记）由本文件补齐。
 * 两个 Store 实例共享同一 stateRoot 模拟跨进程重建：第二个实例只允许读取，不能重放。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeApprovalStore } from "../../src/node/stores/node-approval-store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 创建隔离 state root 的 Node 审批存储。 */
async function createStoreFixture(): Promise<{ stateRoot: string; store: ReturnType<typeof createNodeApprovalStore> }> {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "cr-r1-store-"));
  temporaryRoots.push(stateRoot);
  return { stateRoot, store: createNodeApprovalStore({ stateRoot }) };
}

/** 构造一份降级审批冻结记录。 */
function createDegradeRequest(key: { sessionId: string; turnId: string; approvalId: string }) {
  return {
    recordType: "sandbox_degrade_request" as const,
    ...key,
    callId: "c-degrade",
    toolName: "run_command",
    normalizedInputHash: "hash-degrade",
    constraint: "no-sandbox-exec:v1",
    expiresAt: "2099-01-01T00:00:00Z",
  };
}

describe("cr-r1-degrade Node 降级审批持久一次消费（web-runtime-20261016 CR R1）", () => {
  it("save 冻结记录：重复冻结同一审批键只允许第一个 owner 成功", async () => {
    const { store } = await createStoreFixture();
    const key = { sessionId: "s-degrade", turnId: "t-degrade", approvalId: "a-degrade" };
    const request = createDegradeRequest(key);
    expect(await store.saveDegradeApproval!(request)).toBe(true);
    expect(await store.saveDegradeApproval!(request)).toBe(false);
  });

  it("consumeDegradeApproval 锁内核验真实 decision/约束/身份/TTL，合法消费成功且重放失败", async () => {
    const { store } = await createStoreFixture();
    const key = { sessionId: "s-degrade", turnId: "t-degrade", approvalId: "a-degrade" };
    const request = createDegradeRequest(key);
    const consume = { ...key, constraint: request.constraint, callId: request.callId, normalizedInputHash: request.normalizedInputHash, now: "2026-10-14T00:00:00Z" };
    await store.saveDegradeApproval!(request);
    // 未提交决定时不可消费。
    expect(await store.consumeDegradeApproval!(consume)).toBe(false);
    await store.saveDecision({ ...key, callId: request.callId, toolName: request.toolName, normalizedInputHash: request.normalizedInputHash, constraint: request.constraint, expiresAt: request.expiresAt, decision: "allow_once", createdAt: "2026-10-14T00:00:00Z" });
    // 约束/身份失配与过期 TTL 一律拒绝。
    expect(await store.consumeDegradeApproval!({ ...consume, constraint: "cmd:v1:other" })).toBe(false);
    expect(await store.consumeDegradeApproval!({ ...consume, callId: "other-call" })).toBe(false);
    expect(await store.consumeDegradeApproval!({ ...consume, normalizedInputHash: "other-hash" })).toBe(false);
    expect(await store.consumeDegradeApproval!({ ...consume, now: "2099-06-01T00:00:00Z" })).toBe(false);
    // 合法消费成功；同一审批再次消费（重放）失败。
    expect(await store.consumeDegradeApproval!(consume)).toBe(true);
    expect(await store.consumeDegradeApproval!(consume)).toBe(false);
  });

  it("跨进程重建后不能重放：第二个 Store 实例读取 decisions.jsonl 只认已消费标记", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "cr-r1-xproc-"));
    temporaryRoots.push(stateRoot);
    const first = createNodeApprovalStore({ stateRoot });
    const key = { sessionId: "s-x", turnId: "t-x", approvalId: "a-x" };
    const request = createDegradeRequest(key);
    const consume = { ...key, constraint: request.constraint, callId: request.callId, normalizedInputHash: request.normalizedInputHash, now: "2026-10-14T00:00:00Z" };
    await first.saveDegradeApproval!(request);
    await first.saveDecision({ ...key, callId: request.callId, toolName: request.toolName, normalizedInputHash: request.normalizedInputHash, constraint: request.constraint, expiresAt: request.expiresAt, decision: "allow_once", createdAt: "2026-10-14T00:00:00Z" });
    expect(await first.consumeDegradeApproval!(consume)).toBe(true);

    // 模拟进程重启：全新 Store 实例（pending 全空）从同一 stateRoot 重建。
    const second = createNodeApprovalStore({ stateRoot });
    expect(await second.getDecision(key)).toMatchObject({ approvalId: "a-x", decision: "allow_once", constraint: "no-sandbox-exec:v1" });
    // 跨进程重放必须被已持久化的 sandbox_degrade_consumed 标记拒绝。
    expect(await second.consumeDegradeApproval!(consume)).toBe(false);
  });

  it("deny 决定与缺失冻结记录的消费均失败（fail-closed）", async () => {
    const { store } = await createStoreFixture();
    const key = { sessionId: "s-deny", turnId: "t-deny", approvalId: "a-deny" };
    const consume = { ...key, constraint: "no-sandbox-exec:v1", callId: "c-deny", normalizedInputHash: "hash-deny", now: "2026-10-14T00:00:00Z" };
    // 没有任何冻结记录。
    expect(await store.consumeDegradeApproval!(consume)).toBe(false);
    await store.saveDegradeApproval!({
      recordType: "sandbox_degrade_request",
      ...key,
      callId: "c-deny",
      toolName: "run_command",
      normalizedInputHash: "hash-deny",
      constraint: "no-sandbox-exec:v1",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    await store.saveDecision({ ...key, callId: "c-deny", toolName: "run_command", normalizedInputHash: "hash-deny", constraint: "no-sandbox-exec:v1", expiresAt: "2099-01-01T00:00:00Z", decision: "deny", createdAt: "2026-10-14T00:00:00Z" });
    // 用户拒绝的决定不可消费。
    expect(await store.consumeDegradeApproval!(consume)).toBe(false);
  });
});
