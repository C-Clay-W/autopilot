/**
 * @autopilot-agent/adapters Node contract tests：验证状态根隔离、兼容布局、幂等事件、Inbox、Trust 和 Skill loader。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import type {
  AgentCheckpoint,
  AgentEventEnvelope,
  ApprovalDecision,
  Session,
  Turn,
} from "@autopilot-agent/core";
import { createAgentRuntime } from "@autopilot-agent/core";
import {
  createNodeCapabilityLoader,
  createNodeSettingsWriter,
  createNodeRuntimePorts,
  createNodeStateSchemaManager,
  createNodeTrustPolicy,
  createNodeWorkspaceRegistry,
  getNodeStateCorruptionDiagnostics,
  getNodeMemoryDirectory,
  getLegacyWebMemoryDirectory,
  retrieveNodeMemories,
  getNodeStateSchemaDiagnostic,
  discoverInstructions,
  getNodeStatePaths,
  initializeNodeStateRoot,
  NODE_STATE_SCHEMA_VERSION,
  resolveNodeStateRoot,
  resolveNodeTrustRoot,
} from "../src/index";

const temporaryRoots: string[] = [];

/** 旧 Memory 缺少可验证来源，兼容入口与 Node loader 都必须保持文件原样并停止注入。 */
it("未验证 Memory 不进入 Work Context，也不自动迁移或删除", function excludesUnverifiedMemory() {
  const root = createTemporaryRoot("memory-boundary");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const stateRoot = path.join(root, "state");
  const payload = `<!-- memory:${Buffer.from(JSON.stringify({ id: "old", category: "user", summary: "PRIVATE_RAG_CANARY", confidence: 1, updatedAt: new Date().toISOString(), accessCount: 1 })).toString("base64")} -->`;
  const files = [getNodeMemoryDirectory(stateRoot, workspace), getLegacyWebMemoryDirectory(workspace, root)].map(function writeLegacy(directory) {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "user.md"); fs.writeFileSync(file, payload); return file;
  });
  expect(retrieveNodeMemories(stateRoot, workspace, "PRIVATE_RAG_CANARY")).toEqual([]);
  const context = createNodeCapabilityLoader({ stateRoot, env: {} }).loadContext(workspace, "PRIVATE_RAG_CANARY");
  expect(context.memories).toEqual([]);
  expect(context.budget.diagnostics).toContain("LEGACY_MEMORY_REVIEW_REQUIRED");
  for (const file of files) expect(fs.readFileSync(file, "utf8")).toBe(payload);
});

/** 创建当前测试独占的临时目录。 */
function createTemporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rag-next-${prefix}-`));
  temporaryRoots.push(root);
  return root;
}

/** 构造最小合法事件信封，避免测试依赖 Kernel 私有事件构造器。 */
function createEnvelope(sessionId: string, turnId: string, seq: number, delta = "ok"): AgentEventEnvelope {
  return {
    seq,
    sessionId,
    turnId,
    timestamp: new Date(seq * 1_000).toISOString(),
    event: { type: "answer_delta", turnId, stepId: `step-${seq}`, delta },
  };
}

/** 构造最小 durable Session。 */
function createSession(sessionId: string, projectId: string): Session {
  return {
    id: sessionId,
    productMode: "work",
    projectId,
    persistenceMode: "durable",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
  };
}

/** 构造最小 Turn 元数据。 */
function createTurn(turnId: string, sessionId: string): Turn {
  return {
    id: turnId,
    sessionId,
    status: "completed",
    frozenRunConfig: { workspaceRoot: "/workspace" },
    startedAt: 1,
    schemaVersion: 1,
  };
}

/** 构造最小 checkpoint，覆盖 activeSkills 和恢复所需字段。 */
function createCheckpoint(turnId: string, status: AgentCheckpoint["status"] = "completed"): AgentCheckpoint {
  return {
    turnId,
    status,
    stepCount: 1,
    messages: [],
    completedCallIds: [],
    activeSkills: [{ skillId: "repo:demo", contentHash: "skill-hash" }],
  };
}

afterEach(function cleanTemporaryRoots() {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

/** 复核共享 durable Port 的持久化、迁移恢复和错误协议。 */
describe("Node durable Adapter contracts", function nodeDurableAdapterContracts() {
  it("按 Turn 读取 JSONL 中最近一次私有 checkpoint", async function readsLatestCheckpointForTurn() {
    const root = createTemporaryRoot("checkpoint-by-turn");
    initializeNodeStateRoot(root);
    const ports = createNodeRuntimePorts({ stateRoot: root });
    const first = { ...createCheckpoint("turn-a"), stepCount: 1 };
    const second = { ...createCheckpoint("turn-b"), stepCount: 2 };
    const latestFirst = { ...createCheckpoint("turn-a"), stepCount: 3 };

    await ports.checkpointStore.save("session-checkpoints", first);
    await ports.checkpointStore.save("session-checkpoints", second);
    await ports.checkpointStore.save("session-checkpoints", latestFirst);

    await expect(ports.checkpointStore.getByTurn("session-checkpoints", "turn-a")).resolves.toEqual(latestFirst);
    await expect(ports.checkpointStore.getByTurn("session-checkpoints", "turn-b")).resolves.toEqual(second);
    await expect(ports.checkpointStore.getByTurn("session-checkpoints", "turn-missing")).resolves.toBeNull();
  });

  it("将缺少 manifest 的 v0 状态逐级迁移为当前版本，并保留可恢复备份和诊断", function migratesLegacyStateWithBackup() {
    const root = createTemporaryRoot("schema-v0");
    const legacySessionPath = path.join(root, "sessions", "legacy-session.json");
    fs.mkdirSync(path.dirname(legacySessionPath), { recursive: true });
    fs.writeFileSync(legacySessionPath, JSON.stringify(createSession("legacy-session", "legacy-project")), "utf8");

    initializeNodeStateRoot(root);

    const manifest = JSON.parse(fs.readFileSync(getNodeStatePaths(root).schemaFile, "utf8")) as { schemaVersion: number };
    const diagnostic = getNodeStateSchemaDiagnostic(root);
    expect(manifest.schemaVersion).toBe(NODE_STATE_SCHEMA_VERSION);
    expect(fs.existsSync(legacySessionPath)).toBe(true);
    expect(fs.existsSync(getNodeStatePaths(root).jobsDir)).toBe(true);
    expect(diagnostic).toMatchObject({ code: "STATE_SCHEMA_MIGRATED", fromVersion: 0, toVersion: NODE_STATE_SCHEMA_VERSION });
    expect(diagnostic && fs.existsSync(path.join(diagnostic.backupPath, "sessions", "legacy-session.json"))).toBe(true);
  });

  /** 迁移失败保留原数据与备份，对调用方仅提供明确的存储错误码。 */
  it("迁移步骤失败时保留原状态和恢复备份", function preservesOriginalStateOnMigrationFailure() {
    const root = createTemporaryRoot("schema-failure");
    const legacySessionPath = path.join(root, "sessions", "legacy-session.json");
    fs.mkdirSync(path.dirname(legacySessionPath), { recursive: true });
    fs.writeFileSync(legacySessionPath, "legacy", "utf8");
    const manager = createNodeStateSchemaManager({
      stateRoot: root,
      targetVersion: 1,
      migrations: [{
        fromVersion: 0,
        toVersion: 1,
        migrate(stagingRoot) {
          fs.writeFileSync(path.join(stagingRoot, "partial-migration.txt"), "partial", "utf8");
          throw new Error("fixture migration failure");
        },
      }],
    });

    expect(() => manager.migrate()).toThrow(expect.objectContaining({ name: "NodeStateError", code: "STATE_SCHEMA_MIGRATION_FAILED" }));
    expect(fs.readFileSync(legacySessionPath, "utf8")).toBe("legacy");
    expect(fs.existsSync(path.join(root, "schema.json"))).toBe(false);
    const backupRoot = path.join(path.dirname(root), `${path.basename(root)}.schema-backups`);
    expect(fs.readdirSync(backupRoot)).toHaveLength(1);
    expect(fs.existsSync(path.join(backupRoot, fs.readdirSync(backupRoot)[0], "sessions", "legacy-session.json"))).toBe(true);
  });

  it("同一显式 stateRoot 可被两组 Port 互读，且 cwd 改变不影响状态根", async function sharedStateRootIsCwdIndependent() {
    const root = createTemporaryRoot("shared");
    initializeNodeStateRoot(root);
    const workspaceRoot = createTemporaryRoot("workspace");
    const first = createNodeRuntimePorts({ stateRoot: root, workspaceRoot });
    const second = createNodeRuntimePorts({ stateRoot: root, workspaceRoot });
    const project = await first.projectStore.create({ name: "shared", workspaceRoot });
    const session = createSession("session-shared", project.id);
    const turn = createTurn("turn-shared", session.id);

    await first.sessionStore.save(session);
    await first.turnStore.save(turn);
    await first.checkpointStore.save(session.id, createCheckpoint(turn.id));
    await first.transcriptStore.append(session.id, createEnvelope(session.id, turn.id, 1));
    await first.approvalStore.savePersistentGrant({
      scope: "allow_workspace",
      workspaceRoot,
      toolName: "edit_file",
      constraint: "path:README.md",
      createdAt: new Date(1_000).toISOString(),
    });
    const input = await first.inputInbox.post({ sessionId: session.id, turnId: turn.id, delivery: "steer", content: "补充", attachments: [], selectedSkills: [] });

    const originalCwd = process.cwd();
    const otherCwd = createTemporaryRoot("cwd");
    process.chdir(otherCwd);
    try {
      expect(await second.projectStore.get(project.id)).toEqual(project);
      expect(await second.sessionStore.get(session.id)).toEqual(session);
      expect(await second.turnStore.get(turn.id)).toEqual(turn);
      expect(await second.checkpointStore.getLatest(session.id)).toEqual(createCheckpoint(turn.id));
      expect(await second.transcriptStore.getEvents(session.id)).toEqual([createEnvelope(session.id, turn.id, 1)]);
      expect(await second.approvalStore.getPersistentGrant({ workspaceRoot, sessionId: session.id, toolName: "edit_file", constraint: "path:README.md" })).toMatchObject({ constraint: "path:README.md" });
      expect(await second.inputInbox.list({ sessionId: session.id })).toEqual([input]);
      expect(getNodeStatePaths(root).root).toBe(resolveNodeStateRoot({ stateRoot: root }));
    } finally {
      process.chdir(originalCwd);
    }
  });

  /** 验证状态根隔离，并以稳定错误协议拒绝当前程序不支持的 schema。 */
  it("不同 stateRoot 完全隔离，并保留 schemaVersion manifest", async function isolatesStateRoots() {
    const firstRoot = createTemporaryRoot("first");
    const secondRoot = createTemporaryRoot("second");
    initializeNodeStateRoot(firstRoot);
    initializeNodeStateRoot(secondRoot);
    const manifest = JSON.parse(fs.readFileSync(getNodeStatePaths(firstRoot).schemaFile, "utf8")) as { schemaVersion: number };
    expect(manifest.schemaVersion).toBe(NODE_STATE_SCHEMA_VERSION);
    const first = createNodeRuntimePorts({ stateRoot: firstRoot });
    const second = createNodeRuntimePorts({ stateRoot: secondRoot });
    const project = await first.projectStore.create({ name: "isolated" });
    await first.transcriptStore.append("session-isolated", createEnvelope("session-isolated", "turn-isolated", 1));

    expect(await second.projectStore.get(project.id)).toBeNull();
    expect(await second.transcriptStore.getEvents("session-isolated")).toEqual([]);

    fs.writeFileSync(getNodeStatePaths(secondRoot).schemaFile, JSON.stringify({ schemaVersion: 999 }), "utf8");
    await expect(second.sessionStore.list()).rejects.toMatchObject({ name: "NodeStateError", code: "STATE_SCHEMA_VERSION_UNSUPPORTED" });
  });

  it("EventSink 不写 Transcript，Transcript 对完整信封幂等且兼容旧相邻重复", async function transcriptHasSingleWriterAndRemainsCompatible() {
    const root = createTemporaryRoot("transcript");
    initializeNodeStateRoot(root);
    const ports = createNodeRuntimePorts({ stateRoot: root });
    const first = createEnvelope("session-transcript", "turn-a", 1, "a");
    const second = createEnvelope("session-transcript", "turn-b", 1, "b");
    await ports.eventSink.write(first);
    expect(await ports.transcriptStore.getEvents(first.sessionId)).toEqual([]);
    await Promise.all([ports.transcriptStore.append(first.sessionId, first), ports.transcriptStore.append(first.sessionId, first)]);
    await ports.transcriptStore.append(first.sessionId, second);
    const transcriptPath = path.join(getNodeStatePaths(root).transcriptsDir, "session-transcript.jsonl");
    fs.appendFileSync(transcriptPath, `${JSON.stringify(second)}\n`, "utf8");
    const beforeRead = fs.readFileSync(transcriptPath, "utf8");

    expect(await ports.transcriptStore.getEvents(first.sessionId)).toEqual([first, second]);
    expect(fs.readFileSync(transcriptPath, "utf8")).toBe(beforeRead);
  });

  it("同一 workspace 从不同 cwd 启动时共享稳定 stateRoot、Session 与 Trust", async function stableWorkspaceIdentityUsesSameState() {
    const globalStateRoot = createTemporaryRoot("global-state");
    const workspaceRoot = createTemporaryRoot("workspace-identity");
    const firstCwd = createTemporaryRoot("cwd-first");
    const secondCwd = createTemporaryRoot("cwd-second");
    const firstStateRoot = resolveNodeStateRoot({ workspaceRoot, globalStateRoot, cwd: firstCwd });
    const secondStateRoot = resolveNodeStateRoot({ workspaceRoot, globalStateRoot, cwd: secondCwd });
    expect(secondStateRoot).toBe(firstStateRoot);
    expect(firstStateRoot).toContain(path.join("workspaces", "v1-"));

    initializeNodeStateRoot(firstStateRoot);
    const first = createNodeRuntimePorts({ stateRoot: firstStateRoot, workspaceRoot });
    const second = createNodeRuntimePorts({ stateRoot: secondStateRoot, workspaceRoot });
    const project = await first.projectStore.create({ name: "identity", workspaceRoot });
    const session = createSession("session-identity", project.id);
    await first.sessionStore.save(session);
    const firstTrust = createNodeTrustPolicy({ stateRoot: firstStateRoot, trustRoot: resolveNodeTrustRoot({ stateRoot: firstStateRoot }) });
    const secondTrust = createNodeTrustPolicy({ stateRoot: secondStateRoot, trustRoot: resolveNodeTrustRoot({ stateRoot: secondStateRoot }) });
    await firstTrust.grantTrust(workspaceRoot);

    expect(await second.sessionStore.get(session.id)).toEqual(session);
    expect((await secondTrust.getTrustStatus(workspaceRoot)).status).toBe("trusted");
  });

  it("JSONL 损坏时保留有效记录并返回不含正文的诊断", async function reportsJsonlCorruptionWithoutContent() {
    const root = createTemporaryRoot("jsonl-corruption");
    initializeNodeStateRoot(root);
    const ports = createNodeRuntimePorts({ stateRoot: root });
    const first = createEnvelope("session-corruption", "turn-corruption", 1, "safe");
    await ports.transcriptStore.append(first.sessionId, first);
    const transcriptPath = path.join(getNodeStatePaths(root).transcriptsDir, "session-corruption.jsonl");
    fs.appendFileSync(transcriptPath, "this record must never appear in diagnostics\n", "utf8");
    const second = createEnvelope("session-corruption", "turn-corruption", 2, "still-safe");
    fs.appendFileSync(transcriptPath, `${JSON.stringify(second)}\n`, "utf8");

    expect(await ports.transcriptStore.getEvents(first.sessionId)).toEqual([first, second]);
    expect(getNodeStateCorruptionDiagnostics(root)).toEqual([{
      code: "DURABLE_JSONL_CORRUPTED",
      file: path.join("transcripts", "session-corruption.jsonl"),
      line: 2,
      reason: "INVALID_JSON",
    }]);
  });

  it("并发 append 保持每个完整事件一行且 JSONL 可恢复", async function concurrentAppendIsSerialized() {
    const root = createTemporaryRoot("append");
    initializeNodeStateRoot(root);
    const ports = createNodeRuntimePorts({ stateRoot: root });
    const envelopes = Array.from({ length: 24 }, function makeEnvelope(_, index) {
      return createEnvelope("session-concurrent", "turn-concurrent", index + 1, `delta-${index}`);
    });
    await Promise.all(envelopes.map(function appendEnvelope(envelope) {
      return ports.transcriptStore.append(envelope.sessionId, envelope);
    }));

    const events = await ports.transcriptStore.getEvents("session-concurrent");
    expect(events).toHaveLength(envelopes.length);
    expect(new Set(events.map((event) => JSON.stringify(event))).size).toBe(envelopes.length);
    expect(() => JSON.parse(fs.readFileSync(path.join(getNodeStatePaths(root).transcriptsDir, "session-concurrent.jsonl"), "utf8").trim().split("\n")[0])).not.toThrow();
  });

  it("InputInbox 完成 drain → consume，已消费输入不会再次出现在 pending 生命周期", async function inboxConsumesOnce() {
    const root = createTemporaryRoot("inbox");
    initializeNodeStateRoot(root);
    const first = createNodeRuntimePorts({ stateRoot: root });
    const second = createNodeRuntimePorts({ stateRoot: root });
    const posted = await first.inputInbox.post({ sessionId: "session-inbox", turnId: "turn-inbox", delivery: "steer", content: "steer", attachments: [], selectedSkills: [] });
    const drained = await first.inputInbox.drain({ sessionId: "session-inbox", turnId: "turn-inbox", maxDelivery: "steer", boundary: "before_sample" });
    expect(drained).toEqual([expect.objectContaining({ inputId: posted.inputId, status: "claimed" })]);
    expect((await second.inputInbox.list({ sessionId: "session-inbox" }))[0].status).toBe("claimed");
    expect(await second.inputInbox.consume({ sessionId: "session-inbox", inputId: posted.inputId, turnId: "turn-inbox" })).toBe(true);
    expect((await first.inputInbox.list({ sessionId: "session-inbox" }))[0]).toMatchObject({ inputId: posted.inputId, status: "consumed", turnId: "turn-inbox" });
    expect(await first.inputInbox.drain({ sessionId: "session-inbox", turnId: "turn-inbox", maxDelivery: "steer", boundary: "before_sample" })).toEqual([]);
    expect(await first.inputInbox.consume({ sessionId: "session-inbox", inputId: posted.inputId, turnId: "turn-inbox" })).toBe(false);
  });

  it("ApprovalStore 按稳定 constraint 跨实例读取，同时保留一次性完整 hash 决策", async function approvalScopesRemainSeparate() {
    const root = createTemporaryRoot("approval");
    initializeNodeStateRoot(root);
    const workspaceRoot = createTemporaryRoot("approval-workspace");
    const first = createNodeRuntimePorts({ stateRoot: root });
    const second = createNodeRuntimePorts({ stateRoot: root });
    const decision: ApprovalDecision = {
      sessionId: "session-approval",
      turnId: "turn-approval",
      approvalId: "approval-1",
      callId: "call-1",
      toolName: "edit_file",
      normalizedInputHash: crypto.createHash("sha256").update("old patch").digest("hex"),
      decision: "allow_once",
      createdAt: new Date(1_000).toISOString(),
    };
    await first.approvalStore.saveDecision(decision);
    await first.approvalStore.savePersistentGrant({ scope: "allow_workspace", workspaceRoot, toolName: "edit_file", constraint: "path:src/file.ts", createdAt: new Date(2_000).toISOString() });

    expect(await second.approvalStore.getDecision({ sessionId: decision.sessionId, turnId: decision.turnId, approvalId: decision.approvalId })).toEqual(decision);
    expect(await second.approvalStore.getPersistentGrant({ workspaceRoot, sessionId: decision.sessionId, toolName: "edit_file", constraint: "path:src/file.ts" })).toMatchObject({ scope: "allow_workspace", constraint: "path:src/file.ts" });
    expect((await second.approvalStore.getDecision({ sessionId: decision.sessionId, turnId: decision.turnId, approvalId: decision.approvalId }))?.normalizedInputHash).toBe(decision.normalizedInputHash);
  });

  it("Node Port 删除 durable Session 状态时跨重启不遗留 Session-owned 文件", async function deleteBySessionPersistsAcrossRestart() {
    const root = createTemporaryRoot("session-delete");
    const workspaceRoot = createTemporaryRoot("session-delete-workspace");
    initializeNodeStateRoot(root);
    const firstPorts = createNodeRuntimePorts({ stateRoot: root, workspaceRoot });
    const session = createSession("session-delete", "project-delete");
    const turnId = "turn-delete";
    const checkpoint = createCheckpoint(turnId);
    const decision: ApprovalDecision = {
      approvalId: "approval-delete",
      sessionId: session.id,
      turnId,
      callId: "call-delete",
      toolName: "edit_file",
      normalizedInputHash: "delete-hash",
      decision: "allow_once",
      createdAt: new Date(1_000).toISOString(),
    };
    await firstPorts.sessionStore.save(session);
    await firstPorts.turnStore.save(createTurn(turnId, session.id));
    await firstPorts.checkpointStore.save(session.id, checkpoint);
    await firstPorts.transcriptStore.append(session.id, createEnvelope(session.id, turnId, 1));
    await firstPorts.approvalStore.saveDecision(decision);
    await firstPorts.approvalStore.savePersistentGrant({ scope: "allow_session", sessionId: session.id, toolName: "edit_file", constraint: "path:README.md", createdAt: new Date(1_000).toISOString() });
    await firstPorts.inputInbox.post({ sessionId: session.id, turnId, delivery: "queue", content: "待清理", attachments: [], selectedSkills: [] });
    await firstPorts.leaseStore.acquire({ sessionId: session.id, turnId, lease: { leaseId: "lease-delete", ownerId: "owner-delete", heartbeatAt: 1, safeBoundarySeq: 0 }, now: 1, staleAfterMs: 10_000 });

    await firstPorts.leaseStore.deleteBySession(session.id);
    await firstPorts.inputInbox.deleteBySession(session.id);
    await firstPorts.approvalStore.deleteBySession(session.id);
    await firstPorts.checkpointStore.deleteBySession(session.id);
    await firstPorts.transcriptStore.deleteBySession(session.id);
    await firstPorts.turnStore.deleteBySession(session.id);
    expect(await firstPorts.sessionStore.delete(session.id)).toBe(true);
    const restartedPorts = createNodeRuntimePorts({ stateRoot: root, workspaceRoot });
    expect(await restartedPorts.sessionStore.get(session.id)).toBeNull();
    expect(await restartedPorts.turnStore.list(session.id)).toEqual([]);
    expect(await restartedPorts.checkpointStore.getLatest(session.id)).toBeNull();
    expect(await restartedPorts.transcriptStore.getEvents(session.id)).toEqual([]);
    expect(await restartedPorts.approvalStore.getDecision({ sessionId: session.id, turnId, approvalId: decision.approvalId })).toBeNull();
    expect(await restartedPorts.approvalStore.getPersistentGrant({ workspaceRoot, sessionId: session.id, toolName: "edit_file", constraint: "path:README.md" })).toBeNull();
    expect(await restartedPorts.inputInbox.list({ sessionId: session.id })).toEqual([]);
    expect(await restartedPorts.leaseStore.acquire({ sessionId: session.id, turnId: "turn-replacement", lease: { leaseId: "lease-replacement", ownerId: "owner-replacement", heartbeatAt: 2, safeBoundarySeq: 0 }, now: 2, staleAfterMs: 10_000 })).not.toBeNull();
  });

  it("共享 SessionService 删除 Web 图片附件，CLI 与 Web 使用同一清理边界", async function deletesSessionOwnedAttachments() {
    const root = createTemporaryRoot("session-resources-state");
    const workspaceRoot = createTemporaryRoot("session-resources-workspace");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    initializeNodeStateRoot(root);
    const ports = createNodeRuntimePorts({ stateRoot: root, workspaceRoot });
    const attachmentDirectory = path.join(workspaceRoot, ".local", "session-uploads", sessionId);
    fs.mkdirSync(attachmentDirectory, { recursive: true });
    fs.writeFileSync(path.join(attachmentDirectory, "image.png"), "image", "utf8");
    const runtime = createAgentRuntime({ ports });
    await runtime.sessions.create({ id: sessionId });

    await expect(runtime.sessions.delete(sessionId)).resolves.toBe(true);
    expect(fs.existsSync(attachmentDirectory)).toBe(false);
  });

  it("Workspace、Trust、Context/Skill loader 使用 canonical workspaceRoot 且跨实例恢复 Skill 身份", async function capabilitiesAreCanonicalAndRepeatable() {
    const stateRoot = createTemporaryRoot("capabilities-state");
    const workspaceRoot = createTemporaryRoot("capabilities-workspace");
    const trustRoot = createTemporaryRoot("capabilities-trust");
    fs.mkdirSync(path.join(workspaceRoot, ".autopilot", "skills", "demo", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "项目规则\n", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, ".autopilot", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo skill\nallowed-tools: [read_file, edit_file]\n---\n正文\n", "utf8");
    const loaderA = createNodeCapabilityLoader({ homeDirectory: createTemporaryRoot("empty-home"), env: {} });
    const loaderB = createNodeCapabilityLoader({ homeDirectory: createTemporaryRoot("empty-home"), env: {} });
    const skillsA = loaderA.loadSkills(workspaceRoot);
    const skillsB = loaderB.loadSkills(workspaceRoot);
    expect(skillsA?.catalog).toEqual(skillsB?.catalog);
    const loadedA = await skillsA?.loadSkill({ skill: "demo" });
    const loadedB = await skillsB?.loadSkill({ skill: "demo" });
    expect(loadedA).toMatchObject({ skillId: loadedB?.skillId, contentHash: loadedB?.contentHash, allowedTools: ["read_file", "edit_file"] });
    expect(discoverInstructions(workspaceRoot).instructions[0].contentHash).toHaveLength(64);

    const policyA = createNodeTrustPolicy({ stateRoot, trustRoot });
    const policyB = createNodeTrustPolicy({ stateRoot, trustRoot });
    await policyA.grantTrust(workspaceRoot);
    expect((await policyB.getTrustStatus(workspaceRoot)).status).toBe("trusted");
    expect((await policyB.getTrustStatus(path.join(workspaceRoot, "."))).workspaceRoot).toBe(fs.realpathSync.native(workspaceRoot));
  });

  it("WorkspaceRegistry 只管理全局索引，不删除工作区或 durable state", function managesWorkspaceRegistryWithoutDeletingWorkspace() {
    const globalStateRoot = createTemporaryRoot("workspace-registry");
    const workspaceRoot = createTemporaryRoot("registry-workspace");
    const registry = createNodeWorkspaceRegistry({ globalStateRoot, now: () => 123 });
    const entry = registry.register(workspaceRoot);

    expect(registry.list()).toEqual([{ ...entry, lastOpenedAt: 123 }]);
    expect(registry.get(entry.workspaceId)).toEqual(entry);
    expect(registry.get("unknown-workspace")).toBeUndefined();
    expect(registry.remove(entry.workspaceId)).toBe(true);
    expect(registry.list()).toEqual([]);
    expect(fs.existsSync(workspaceRoot)).toBe(true);
  });

  it("settings writer 复用 scope 路径，仅允许非敏感 allowlist 且不回显 endpoint", function writesSafeScopedSettings() {
    const workspaceRoot = createTemporaryRoot("settings-writer-workspace");
    const homeDirectory = createTemporaryRoot("settings-writer-home");
    const writer = createNodeSettingsWriter({ homeDirectory });

    writer.set("project", "model", "provider-pro", workspaceRoot);
    expect(writer.get("project", "model", workspaceRoot)).toBe("provider-pro");
    expect(writer.show("project", workspaceRoot)).toMatchObject({ model: "provider-pro" });
    expect(() => writer.set("project", "models.primary.apiKey", "secret", workspaceRoot)).toThrow("CONFIG_KEY_NOT_ALLOWED");

    const settingsPath = path.join(workspaceRoot, ".autopilot", "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ model: "provider-model", env: { ANTHROPIC_BASE_URL: "https://provider.example/anthropic" } }), "utf8");
    expect(writer.show("project", workspaceRoot)).not.toHaveProperty("env");
  });

  it("settings writer 修改 User 非敏感字段时保留未实现的 CC 顶层字段与 env", function preservesCcPassthroughWhenWritingUserSettings() {
    const workspaceRoot = createTemporaryRoot("settings-writer-cc-workspace");
    const homeDirectory = createTemporaryRoot("settings-writer-cc-home");
    const settingsDirectory = path.join(homeDirectory, ".autopilot");
    const settingsPath = path.join(settingsDirectory, "settings.json");
    fs.mkdirSync(settingsDirectory);
    fs.writeFileSync(settingsPath, JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: "fixture-auth-token", ANTHROPIC_MODEL: "fixture-model" },
      statusLine: { type: "command", command: "fixture-status" },
      enabledPlugins: { "fixture@marketplace": true },
      model: "fixture-model",
    }), "utf8");
    const writer = createNodeSettingsWriter({ homeDirectory });

    writer.set("user", "effortLevel", "high", workspaceRoot);

    const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(written).toMatchObject({
      env: { ANTHROPIC_AUTH_TOKEN: "fixture-auth-token", ANTHROPIC_MODEL: "fixture-model" },
      statusLine: { type: "command", command: "fixture-status" },
      enabledPlugins: { "fixture@marketplace": true },
      effortLevel: "high",
    });
    expect(writer.show("user", workspaceRoot)).not.toHaveProperty("env");
  });

  /** 验证合法 Search 连接不会阻断普通 User config 更新，endpoint 和凭据引用都不被 show 回显。 */
  it("保留 User Web Search 连接并继续安全写入普通配置", function preservesWebSearchReferenceDuringSafeWrites() {
    const workspaceRoot = createTemporaryRoot("settings-writer-web-search-workspace");
    const homeDirectory = createTemporaryRoot("settings-writer-web-search-home");
    const settingsDirectory = path.join(homeDirectory, ".autopilot");
    const settingsPath = path.join(settingsDirectory, "settings.json");
    fs.mkdirSync(settingsDirectory);
    fs.writeFileSync(settingsPath, JSON.stringify({
      webSearch: { provider: "openai-compatible", baseUrl: "https://search.fixture/v1", model: "search-model", credentialRef: { provider: "openai-compatible", key: "USER_SETTINGS_SEARCH_API_KEY" } },
    }), "utf8");
    const writer = createNodeSettingsWriter({ homeDirectory });

    writer.set("user", "model", "provider-model", workspaceRoot);

    const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(written.webSearch).toEqual({ provider: "openai-compatible", baseUrl: "https://search.fixture/v1", model: "search-model", credentialRef: { provider: "openai-compatible", key: "USER_SETTINGS_SEARCH_API_KEY" } });
    expect(writer.show("user", workspaceRoot)).toEqual({ webSearch: { provider: "openai-compatible", model: "search-model" }, model: "provider-model" });
  });
});
