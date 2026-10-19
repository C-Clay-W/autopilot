/**
 * Node ApprovalStore 外部授权新方法测试（Talk-Plan1013 Stage 2）：
 * listPersistentGrants（canonical workspace 过滤）、setGrantProjection（锁内重写、未命中 null）、
 * deletePersistentGrant 的 allow_session 精确撤销。全程使用 mkdtemp 隔离 state root。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeApprovalStore } from "./node-approval-store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 创建隔离 state root 的 Node 审批存储。 */
async function createStoreFixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "node-approval-ext-"));
  temporaryRoots.push(base);
  return createNodeApprovalStore({ stateRoot: base });
}

describe("Node ApprovalStore 外部授权（Talk-Plan1013 Stage 2）", () => {
  it("listPersistentGrants 按 canonical workspace 过滤并返回外部投影字段", async () => {
    const store = await createStoreFixture();
    await store.savePersistentGrant({ scope: "allow_workspace", workspaceRoot: "C:\\ws-a", toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt", externalRule: "Write(C:\\outside\\a.txt)", projection: "pending", createdAt: "2026-10-13T00:00:00Z" });
    await store.savePersistentGrant({ scope: "allow_session", sessionId: "s1", toolName: "edit_file", constraint: "path:note.txt", createdAt: "2026-10-13T00:00:00Z" });
    const grants = await store.listPersistentGrants({ workspaceRoot: "C:\\ws-a" });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ toolName: "write_file", externalRule: "Write(C:\\outside\\a.txt)", projection: "pending" });
    expect((await store.listPersistentGrants({ sessionId: "s1" }))).toHaveLength(1);
  });

  it("setGrantProjection 锁内重写状态并持久化；未命中返回 null", async () => {
    const store = await createStoreFixture();
    await store.savePersistentGrant({ scope: "allow_workspace", workspaceRoot: "C:\\ws-a", toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt", createdAt: "2026-10-13T00:00:00Z" });
    const updated = await store.setGrantProjection({ workspaceRoot: "C:\\ws-a", sessionId: "s1", toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt", projection: "synced" });
    expect(updated?.projection).toBe("synced");
    await expect(store.setGrantProjection({ workspaceRoot: "C:\\ws-a", sessionId: "s1", toolName: "write_file", constraint: "ext-file:C:\\missing", projection: "synced" })).resolves.toBeNull();
    const persisted = await store.getPersistentGrant({ workspaceRoot: "C:\\ws-a", sessionId: "s1", toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" });
    expect(persisted?.projection).toBe("synced");
  });

  it("deletePersistentGrant 精确撤销 allow_session，不影响同工具其他约束", async () => {
    const store = await createStoreFixture();
    await store.savePersistentGrant({ scope: "allow_session", sessionId: "s1", toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt", createdAt: "2026-10-13T00:00:00Z" });
    await store.savePersistentGrant({ scope: "allow_session", sessionId: "s1", toolName: "write_file", constraint: "ext-file:C:\\outside\\b.txt", createdAt: "2026-10-13T00:00:00Z" });
    await expect(store.deletePersistentGrant({ workspaceRoot: "C:\\ws-a", sessionId: "s1", toolName: "write_file", constraint: "ext-file:C:\\outside\\a.txt" })).resolves.toBe(true);
    const remaining = await store.listPersistentGrants({ sessionId: "s1" });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.constraint).toBe("ext-file:C:\\outside\\b.txt");
  });
});
