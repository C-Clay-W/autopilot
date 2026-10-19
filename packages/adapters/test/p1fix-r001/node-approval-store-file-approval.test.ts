/**
 * p1fix-r001 Tester 回归用例：R2 必测 #3 的 Node 持久底座（Talk-Plan1013 Stage5 CR R2）。
 *
 * 合同要求（CR R2 fix/verification + Plan §16.5）：文件审批复用 decisions.jsonl +
 * withFileLock 底座，持久原子一次消费，跨进程不能重放。Executor 本轮只在 Core
 * contract 测试覆盖 Memory 实现；Node ApprovalStore 新增的 saveFileApproval/
 * getFileApproval/consumeFileApproval（含 external_file_consumed 落盘标记）
 * 无任何动态覆盖，且本轮未运行 adapters 测试，本文件补齐。
 *
 * 两个 Store 实例共享同一 stateRoot 模拟跨进程重建：消费标记必须经 decisions.jsonl
 * 持久，第二个实例只允许读取，不能重放。全程 mkdtemp 隔离，用后清理。
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
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "p1fix-r001-store-"));
  temporaryRoots.push(stateRoot);
  return { stateRoot, store: createNodeApprovalStore({ stateRoot }) };
}

describe("p1fix-r001 R2 Node 文件审批持久一次消费（Talk-Plan1013 Stage5 CR R2 必测 #3）", () => {
  it("save/get 冻结记录：重复冻结同一审批键只允许第一个 owner 成功", async () => {
    const { store } = await createStoreFixture();
    const request = {
      recordType: "external_file_request" as const,
      sessionId: "s-file",
      turnId: "t-file",
      approvalId: "a-file",
      callId: "c-file",
      toolName: "write_file",
      normalizedInputHash: "hash-file",
      constraint: "ext-file:C:\\outside\\a.txt",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    expect(await store.saveFileApproval!(request)).toBe(true);
    expect(await store.saveFileApproval!(request)).toBe(false);
    expect(await store.getFileApproval!({ sessionId: "s-file", turnId: "t-file", approvalId: "a-file" })).toMatchObject({
      recordType: "external_file_request",
      constraint: "ext-file:C:\\outside\\a.txt",
      callId: "c-file",
    });
    expect(await store.getFileApproval!({ sessionId: "s-file", turnId: "t-file", approvalId: "other" })).toBeNull();
  });

  it("consumeFileApproval 锁内核验真实 decision/约束/身份/TTL，合法消费成功且重放失败", async () => {
    const { store } = await createStoreFixture();
    const key = { sessionId: "s-file", turnId: "t-file", approvalId: "a-file" };
    const request = {
      recordType: "external_file_request" as const,
      ...key,
      callId: "c-file",
      toolName: "write_file",
      normalizedInputHash: "hash-file",
      constraint: "ext-file:C:\\outside\\a.txt",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    const consume = { ...key, constraint: request.constraint, callId: request.callId, normalizedInputHash: request.normalizedInputHash, now: "2026-10-14T00:00:00Z" };
    await store.saveFileApproval!(request);
    // 未提交决定时不可消费。
    expect(await store.consumeFileApproval!(consume)).toBe(false);
    await store.saveDecision({ ...key, callId: request.callId, toolName: request.toolName, normalizedInputHash: request.normalizedInputHash, constraint: request.constraint, expiresAt: request.expiresAt, decision: "allow_once", createdAt: "2026-10-14T00:00:00Z" });
    // 约束/身份失配与过期 TTL 一律拒绝。
    expect(await store.consumeFileApproval!({ ...consume, constraint: "ext-file:C:\\outside\\b.txt" })).toBe(false);
    expect(await store.consumeFileApproval!({ ...consume, callId: "other-call" })).toBe(false);
    expect(await store.consumeFileApproval!({ ...consume, normalizedInputHash: "other-hash" })).toBe(false);
    expect(await store.consumeFileApproval!({ ...consume, now: "2099-06-01T00:00:00Z" })).toBe(false);
    // 合法消费成功；同一审批再次消费（重放）失败。
    expect(await store.consumeFileApproval!(consume)).toBe(true);
    expect(await store.consumeFileApproval!(consume)).toBe(false);
  });

  it("跨进程重建后不能重放：第二个 Store 实例读取 decisions.jsonl 只认已消费标记", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "p1fix-r001-xproc-"));
    temporaryRoots.push(stateRoot);
    const first = createNodeApprovalStore({ stateRoot });
    const key = { sessionId: "s-x", turnId: "t-x", approvalId: "a-x" };
    const request = {
      recordType: "external_file_request" as const,
      ...key,
      callId: "c-x",
      toolName: "write_file",
      normalizedInputHash: "hash-x",
      constraint: "ext-file:C:\\outside\\a.txt",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    const consume = { ...key, constraint: request.constraint, callId: request.callId, normalizedInputHash: request.normalizedInputHash, now: "2026-10-14T00:00:00Z" };
    await first.saveFileApproval!(request);
    await first.saveDecision({ ...key, callId: request.callId, toolName: request.toolName, normalizedInputHash: request.normalizedInputHash, constraint: request.constraint, expiresAt: request.expiresAt, decision: "allow_once", createdAt: "2026-10-14T00:00:00Z" });
    // 第一个实例成功消费并落盘 external_file_consumed 标记。
    expect(await first.consumeFileApproval!(consume)).toBe(true);

    // 模拟进程重启：全新 Store 实例（pending 全空）从同一 stateRoot 重建。
    const second = createNodeApprovalStore({ stateRoot });
    expect(await second.getFileApproval!(key)).toMatchObject({ recordType: "external_file_request", approvalId: "a-x" });
    // 跨进程重放必须被已持久化的消费标记拒绝。
    expect(await second.consumeFileApproval!(consume)).toBe(false);
  });

  it("deny 决定与缺失冻结记录的消费均失败（fail-closed）", async () => {
    const { store } = await createStoreFixture();
    const key = { sessionId: "s-deny", turnId: "t-deny", approvalId: "a-deny" };
    const consume = { ...key, constraint: "ext-file:C:\\outside\\a.txt", callId: "c-deny", normalizedInputHash: "hash-deny", now: "2026-10-14T00:00:00Z" };
    // 没有任何冻结记录。
    expect(await store.consumeFileApproval!(consume)).toBe(false);
    await store.saveFileApproval!({
      recordType: "external_file_request",
      ...key,
      callId: "c-deny",
      toolName: "write_file",
      normalizedInputHash: "hash-deny",
      constraint: "ext-file:C:\\outside\\a.txt",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    await store.saveDecision({ ...key, callId: "c-deny", toolName: "write_file", normalizedInputHash: "hash-deny", constraint: "ext-file:C:\\outside\\a.txt", expiresAt: "2099-01-01T00:00:00Z", decision: "deny", createdAt: "2026-10-14T00:00:00Z" });
    // 用户拒绝的决定不可消费。
    expect(await store.consumeFileApproval!(consume)).toBe(false);
  });
});
