/** Node Job Adapter Stage1 契约：验证跨实例 CAS、owner 隔离和 v5→v6 迁移。 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Job } from "../../core/src/runtime/domain";
import { SANDBOX_ERROR_CODES, type SandboxExecutionRequest, type SandboxPreparedCommand } from "../../core/src/runtime/domain/sandbox-policy";
import { SandboxPortError, type SandboxPort } from "../../core/src/runtime/ports";
import { createJobService } from "../../core/src/runtime/application/job-service";
import { createSessionService } from "../../core/src/runtime/application/session-service";
import { createNodeRuntimePorts, getNodeStatePaths, initializeNodeStateRoot, NODE_STATE_SCHEMA_VERSION } from "../src/index";

const roots: string[] = [];

/** 透传式 fake 沙箱 Port：prepare 原样返回 argv，供 JobService 启动路径消费。 */
function createFakeSandboxPort(workspaceRoot: string): { port: SandboxPort; binding: { port: SandboxPort; policy: { mode: "workspace-write"; workspaceRoot: string; allowedDomains: readonly string[]; deniedRead: readonly string[]; deniedWrite: readonly string[] } } } {
  const port: SandboxPort = {
    async status() { return { platform: "macos", backend: "fake", enforcement: "full" }; },
    async setup() { throw new SandboxPortError(SANDBOX_ERROR_CODES.UNAVAILABLE, "fake sandbox setup 不可用"); },
    async prepare(request: SandboxExecutionRequest): Promise<SandboxPreparedCommand> {
      return { executionId: request.commandId, executable: request.program, args: [...request.args], env: {}, enforcement: "full" };
    },
    async release() {},
    async shutdown() {},
  };
  return { port, binding: { port, policy: { mode: "workspace-write", workspaceRoot, allowedDomains: [], deniedRead: [], deniedWrite: [] } } };
}

/** 真实测试状态只允许位于 env 指向的工作区。 */
function createStateRoot(label: string): string {
  const workspaceRoot = process.env.AGENT_WORKSPACE_ROOT?.trim();
  if (!workspaceRoot) throw new Error("AGENT_WORKSPACE_ROOT 未配置，拒绝运行 Node Job Adapter 测试");
  const root = path.join(path.resolve(workspaceRoot), `.stage1-job-${label}-${randomUUID()}`);
  fs.mkdirSync(root);
  roots.push(root);
  return root;
}

/** 构造最小 v2 Job 记录。 */
function job(root: string): Job {
  return {
    jobRecordVersion: 2,
    id: "job-cas",
    workspaceId: root,
    sessionId: "session-cas",
    program: process.execPath,
    args: [],
    cwd: ".",
    status: "running",
    owner: { runtimeInstanceId: "owner-a", hostProcessId: process.pid },
    revision: 0,
    startedAt: 1,
    updatedAt: 1,
    output: { stdout: "", stderr: "", stdoutCursor: 0, stderrCursor: 0, stdoutStartCursor: 0, stderrStartCursor: 0, totalStdoutBytes: 0, totalStderrBytes: 0, stdoutTruncated: false, stderrTruncated: false },
  };
}

/** 只删除本用例在 env 工作区创建并登记的合成状态根。 */
afterEach(function cleanup() {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** 未配置 AGENT_WORKSPACE_ROOT 时整组跳过：这些用例写真实文件系统状态根，属实机测试。 */
const hasWorkspaceRoot = Boolean(process.env.AGENT_WORKSPACE_ROOT?.trim());

describe.skipIf(!hasWorkspaceRoot)("Node Job owner/CAS", function suite() {
  it("两个 Store 读取同一 revision 时只有一个条件更新成功", async function serializesCas() {
    const stateRoot = createStateRoot("cas");
    const first = createNodeRuntimePorts({ stateRoot, workspaceRoot: path.dirname(stateRoot) }).jobStore;
    const second = createNodeRuntimePorts({ stateRoot, workspaceRoot: path.dirname(stateRoot) }).jobStore;
    const initial = job(stateRoot);
    expect(await first.create(initial)).toBe(true);
    const firstNext = { ...initial, revision: 1, updatedAt: 2 };
    const secondNext = { ...initial, revision: 1, updatedAt: 3, status: "interrupted" as const };
    const results = await Promise.all([
      first.compareAndSave(firstNext, { expectedRevision: 0, expectedOwner: initial.owner! }),
      second.compareAndSave(secondNext, { expectedRevision: 0, expectedOwner: initial.owner! }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await first.get(initial.id))?.revision).toBe(1);
  });

  it("Runtime B 查询不改写 Runtime A 的 Node 记录并拒绝跨 owner stop", async function preservesLiveOwner() {
    const workspaceRoot = path.dirname(createStateRoot("owner"));
    const stateRoot = roots.at(-1)!;
    const firstPorts = createNodeRuntimePorts({ stateRoot, workspaceRoot });
    const secondPorts = createNodeRuntimePorts({ stateRoot, workspaceRoot });
    await createSessionService(firstPorts).create({ id: "session-owner" });
    const runtimeA = createJobService({ store: firstPorts.jobStore, ownerProbe: firstPorts.jobOwnerProbe, sessionStore: firstPorts.sessionStore, runtimeInstanceId: "node-runtime-a" });
    const runtimeB = createJobService({ store: secondPorts.jobStore, ownerProbe: secondPorts.jobOwnerProbe, sessionStore: secondPorts.sessionStore, runtimeInstanceId: "node-runtime-b" });
    const started = await runtimeA.start({ workspaceId: workspaceRoot, workspaceRoot, sessionId: "session-owner", program: process.execPath, args: ["-e", "setInterval(function keepAlive() {}, 1000)"], cwd: ".", sandbox: createFakeSandboxPort(workspaceRoot).binding });
    try {
      expect((await runtimeB.list(workspaceRoot)).find(function same(entry) { return entry.id === started.id; })).toMatchObject({ status: "running", revision: started.revision });
      await expect(runtimeB.kill(started.id)).rejects.toMatchObject({ code: "JOB_OWNER_UNAVAILABLE" });
      expect(await firstPorts.jobStore.get(started.id)).toMatchObject({ status: "running", revision: started.revision });
    } finally {
      await runtimeA.kill(started.id);
      await runtimeB.shutdown();
    }
  });

  it("v5 状态根原子迁移到 v6 并保留备份诊断", function migratesJobSchemaGate() {
    const stateRoot = createStateRoot("schema");
    fs.writeFileSync(getNodeStatePaths(stateRoot).schemaFile, JSON.stringify({ schemaVersion: 5 }), "utf8");
    initializeNodeStateRoot(stateRoot);
    const manifest = JSON.parse(fs.readFileSync(getNodeStatePaths(stateRoot).schemaFile, "utf8")) as { schemaVersion: number };
    expect(NODE_STATE_SCHEMA_VERSION).toBe(6);
    expect(manifest.schemaVersion).toBe(6);
  });
});
