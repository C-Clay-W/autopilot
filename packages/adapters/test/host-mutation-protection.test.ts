/** Stage3宿主权限状态攻击的全合成复现；真实Node Store/projector与Core源码，无任何进程/沙箱调用。 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeRuntimePorts } from "../src/node/create-node-runtime-ports";
import { createNodeExternalPermissionProjector } from "../src/node/settings/node-external-permission-projector";
import { createNodeSettingsWriter } from "../src/node/settings/node-settings-writer";
import { createApprovalService } from "../../core/src/runtime/application/approval-service";
import { createWriteFileTool } from "../../core/src/internal/tools/builtins/write-file-tool";
import { createEditFileTool } from "../../core/src/internal/tools/builtins/edit-file-tool";
import { createReadFileTool } from "../../core/src/internal/tools/builtins/read-file-tool";
import { createUndoService } from "../../core/src/runtime/application/undo-service";
import { createMemoryPorts } from "../../core/src/runtime/adapters/memory";
import { createTurnRuntimeConfigResolver } from "../../core/src/runtime/application/turn/turn-runtime-config-resolver";
import type { ToolExecutionContext, ToolPermissionMode } from "../../core/src/internal/tools/types";
import { createAgentRuntime } from "../../core/src/internal/agent-runtime";
import { createAgentTextMessage } from "../../core/src/internal/types/agent-message";
import { ToolExecutor } from "../../core/src/internal/tools/tool-executor";
import { ToolRegistry } from "../../core/src/internal/tools/tool-registry";

const temporaryRoots: string[] = [];
afterEach(async function cleanSyntheticRoots() {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** 仅使用本测试mkdtemp目录；User settings也定向合成home，禁止读真实用户配置。 */
async function fixture(stateInside = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stage3-host-authority-"));
  temporaryRoots.push(root);
  const requestedWorkspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  await mkdir(requestedWorkspace);
  const workspaceRoot = await realpath(requestedWorkspace);
  await mkdir(home);
  await mkdir(path.join(root, "outside"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const stateRoot = stateInside ? path.join(workspaceRoot, "state") : path.join(root, "global-state");
  const trustRoot = path.join(root, "actual-trust");
  const credentialPath = path.join(home, "actual-credential-settings.json");
  const ports = createNodeRuntimePorts({ stateRoot, trustRoot, workspaceRoot, userSettingsPath: credentialPath });
  ports.externalPermissionProjector = createNodeExternalPermissionProjector({ homeDirectory: home });
  const approvals = createApprovalService({ ...ports, externalRuleProjector: ports.externalPermissionProjector });
  const registry = new ToolRegistry();
  registry.register(createWriteFileTool());
  registry.register(createEditFileTool());
  registry.register(createReadFileTool());
  const context: ToolExecutionContext = { workspaceRoot, permissionMode: "full_access", workspaceTrusted: true, hostMutationProtection: ports.hostMutationProtection, fileReadStates: new Map() };
  const target = path.join(root, "outside", "target.txt");
  const rule = `Write(${target})`;
  const constraint = `ext-file:${target}`;
  const query = { workspaceRoot, sessionId: "synthetic-session", toolName: "write_file", constraint };

  /** 由模型文件工具写合成权限文件，存在文件时仅补既有hash前置条件。 */
  async function modelWrite(filePath: string, content: string, mode: ToolPermissionMode = "full_access") {
    const before = await readFile(filePath).catch(function missing() { return null; });
    return new ToolExecutor(registry, { ...context, permissionMode: mode }).execute({ callId: filePath, toolName: "write_file", input: { path: filePath, content, ...(before ? { expectedSha256: createHash("sha256").update(before).digest("hex") } : {}) } });
  }
  return { root, workspaceRoot, stateRoot, trustRoot, credentialPath, home, ports, approvals, target, rule, constraint, query, context, registry, modelWrite };
}

describe("Stage3宿主授权保护", function hostAuthorityProtection() {
  it.each([true, false])("stateRoot内部=%s：全部模式不能伪造grant/decision或投影，未存在父目录不创建", async function rejectsForgedAuthority(stateInside) {
    const f = await fixture(stateInside);
    const grant = { scope: "allow_workspace", workspaceRoot: f.workspaceRoot, toolName: "write_file", constraint: f.constraint, externalRule: f.rule, projection: "synced", createdAt: new Date().toISOString() };
    for (const mode of ["ask", "auto_approve", "full_access"] as const) {
      for (const target of [path.join(f.stateRoot, "approvals", "grants.jsonl"), path.join(f.stateRoot, "approvals", "decisions.jsonl"), path.join(f.workspaceRoot, ".autopilot", "settings.local.json")]) {
        expect(await f.modelWrite(target, `${JSON.stringify(grant)}\n`, mode)).toMatchObject({ status: "error", error: { code: "FS_SANDBOX_DENIED" } });
      }
    }
    expect(await stat(f.stateRoot).then(function exists() { return true; }).catch(function absent() { return false; })).toBe(false);
    expect(await f.approvals.hasPersistentGrant(f.query)).toBe(false);
    expect(await stat(f.target).then(function exists() { return true; }).catch(function absent() { return false; })).toBe(false);
  });

  it("真实批准的受控投影仍可写；外部stateRoot下模型不能恢复被删投影使grant复活", async function protectsProjectionRevival() {
    const f = await fixture(false);
    const sessionId = f.query.sessionId;
    const turnId = "trusted-turn";
    const memory = createMemoryPorts(f.workspaceRoot);
    const approvals = createApprovalService({ ...memory, approvalStore: f.ports.approvalStore, externalRuleProjector: f.ports.externalPermissionProjector });
    await memory.turnStore.save({ id: turnId, sessionId, status: "waiting_approval", startedAt: 1, frozenRunConfig: { workspaceRoot: f.workspaceRoot } });
    const request = { callId: "real-human-request", toolName: "write_file", input: { path: f.target, content: "not-executed" } };
    const required = await new ToolExecutor(f.registry, f.context).execute(request);
    if (required.status !== "approval_required") throw new Error("需要真实Core待审批事实");
    await memory.checkpointStore.save(sessionId, { turnId, status: "awaiting_approval", stepCount: 1, messages: [], completedCallIds: [], pendingCalls: [{ id: request.callId, name: request.toolName, input: request.input }] });
    await memory.transcriptStore.append(sessionId, { seq: 1, sessionId, turnId, timestamp: memory.clock.timestamp(), event: { type: "approval_required", turnId, stepId: "step", callId: request.callId, toolName: request.toolName, result: required } });
    await approvals.submit({ sessionId, turnId, approvalId: required.approval.approvalId, decision: "allow_workspace" });
    expect(await approvals.hasPersistentGrant(f.query)).toBe(true);
    await f.ports.externalPermissionProjector!.project({ workspaceRoot: f.workspaceRoot, rule: f.rule, action: "remove" });
    expect(await approvals.hasPersistentGrant(f.query)).toBe(false);
    const local = path.join(f.workspaceRoot, ".autopilot", "settings.local.json");
    expect(await f.modelWrite(local, JSON.stringify({ permissions: { allow: [f.rule] } }))).toMatchObject({ status: "error", error: { code: "FS_SANDBOX_DENIED" } });
    expect(await approvals.hasPersistentGrant(f.query)).toBe(false);
    await f.ports.externalPermissionProjector!.project({ workspaceRoot: f.workspaceRoot, rule: f.rule, action: "add" });
    expect(await approvals.hasPersistentGrant(f.query)).toBe(true);
    expect(function controlledConfigWrite() { createNodeSettingsWriter({ homeDirectory: f.home }).set("local", "availableModels", "[]", f.workspaceRoot); }).not.toThrow();
    expect(await approvals.hasPersistentGrant(f.query)).toBe(true);
    expect(await stat(f.target).then(function exists() { return true; }).catch(function absent() { return false; })).toBe(false);
  });

  it("Write/Edit facts与direct执行均拒绝权威目标；edit在diff/正文/快照读取前停止", async function guardsDirectAndPreparation() {
    const f = await fixture();
    const protectedFile = path.join(f.workspaceRoot, ".autopilot", "settings.local.json");
    await mkdir(path.dirname(protectedFile));
    await writeFile(protectedFile, "private-fixture-content");
    const readStateLookup = vi.spyOn(f.context.fileReadStates!, "get");
    const write = createWriteFileTool();
    const edit = createEditFileTool();
    const writeInput = write.inputSchema.parse({ path: protectedFile, content: "replace", expectedSha256: createHash("sha256").update("private-fixture-content").digest("hex") });
    const editInput = edit.inputSchema.parse({ path: protectedFile, oldString: "private", newString: "replaced" });
    for (const mode of ["ask", "auto_approve", "full_access"] as const) {
      const context = { ...f.context, permissionMode: mode, toolCallId: "approved-once" };
      await expect(write.createActionFacts(writeInput, context)).rejects.toMatchObject({ toolError: { code: "FS_SANDBOX_DENIED" } });
      await expect(write.execute(writeInput, context)).rejects.toMatchObject({ toolError: { code: "FS_SANDBOX_DENIED" } });
      await expect(edit.createActionFacts(editInput, context)).rejects.toMatchObject({ toolError: { code: "FS_SANDBOX_DENIED" } });
      await expect(edit.execute(editInput, context)).rejects.toMatchObject({ toolError: { code: "FS_SANDBOX_DENIED" } });
    }
    expect(readStateLookup).not.toHaveBeenCalled();
    expect(await readFile(protectedFile, "utf8")).toBe("private-fixture-content");
    expect(write.inputSchema.safeParse({ ...writeInput, hostMutationProtection: null, canonicalTarget: "unprotected" }).success).toBe(false);
  });

  it("Runtime只从ports注入保护，真实Trust/credential及三层配置均受保护", async function protectsActualHostSources() {
    const f = await fixture();
    const options = createTurnRuntimeConfigResolver({ ports: f.ports, defaultRunConfig: {} }).buildAgentOptions({ workspaceRoot: f.workspaceRoot }, { hostMutationProtection: undefined } as never, "s1", "t1");
    expect(options.hostMutationProtection).toBe(f.ports.hostMutationProtection);
    for (const target of [path.join(f.trustRoot, "trust.json"), f.credentialPath, path.join(f.home, ".autopilot", "settings.json"), path.join(f.workspaceRoot, ".autopilot", "settings.json"), path.join(f.workspaceRoot, ".autopilot", "settings.local.json")]) {
      expect(await f.modelWrite(target, "{}", "full_access")).toMatchObject({ status: "error", error: { code: "FS_SANDBOX_DENIED" } });
    }
  });

  it("真实Runtime→RunContext→Kernel接线不能丢保护域；fake sampler的写权限文件调用失败", async function wiresRealRuntime() {
    const f = await fixture();
    let sampled = false;
    const options = createTurnRuntimeConfigResolver({ ports: f.ports, defaultRunConfig: {} }).buildAgentOptions({ workspaceRoot: f.workspaceRoot, permissionMode: "full_access", workspaceTrusted: true }, {}, "runtime-session", "runtime-turn");
    const runtime = createAgentRuntime({ ...options, modelSampler: {
      async sample() {
        if (sampled) return { content: "未执行文件修改。", toolCalls: [], reasoningSummary: "" };
        sampled = true;
        return { content: "", toolCalls: [{ id: "model-write", name: "write_file", input: { path: path.join(f.stateRoot, "approvals", "decisions.jsonl"), content: "forged" } }], reasoningSummary: "" };
      },
    } });
    const events = [];
    for await (const event of runtime.run({ turnId: "runtime-turn", messages: [createAgentTextMessage("user", "尝试写入测试权限文件。")], maxSteps: 3 })) events.push(event);
    expect(events.some(function protectedToolResult(event) { return event.type === "tool_result" && event.result.status === "error" && event.result.error.code === "FS_SANDBOX_DENIED"; })).toBe(true);
    expect(await stat(path.join(f.stateRoot, "approvals", "decisions.jsonl")).then(function exists() { return true; }).catch(function absent() { return false; })).toBe(false);
  });

  it("junction别名/大小写/未存在目标不能绕过，相似前缀与正常外部读取保持", async function guardsPathIdentity() {
    const f = await fixture();
    await mkdir(f.stateRoot);
    const alias = path.join(f.workspaceRoot, "state-alias");
    await symlink(f.stateRoot, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await f.modelWrite(path.join(alias, "not-created", "grants.jsonl"), "forged")).toMatchObject({ status: "error", error: { code: "FS_SANDBOX_DENIED" } });
    if (process.platform === "win32") expect(await f.modelWrite(path.join(f.stateRoot.toUpperCase(), "MISSING", "GRANTS.JSONL"), "forged")).toMatchObject({ status: "error", error: { code: "FS_SANDBOX_DENIED" } });
    const neighbour = `${f.stateRoot}-neighbour`;
    const normal = path.join(neighbour, "note.txt");
    expect(await f.modelWrite(normal, "normal")).toMatchObject({ status: "success" });
    expect(await stat(path.join(f.stateRoot, "not-created")).then(function exists() { return true; }).catch(function absent() { return false; })).toBe(false);
    await writeFile(f.target, "external-read-fixture");
    expect(await new ToolExecutor(f.registry, f.context).execute({ callId: "read", toolName: "read_file", input: { path: f.target } })).toMatchObject({ status: "success", output: { content: "external-read-fixture" } });
  });

  it("锁内再次检查保护域，facts通过后新增保护也不能写", async function rechecksUnderLock() {
    const f = await fixture();
    const allowedFile = path.join(f.workspaceRoot, "ordinary.txt");
    let protect = false;
    const context = { ...f.context, hostMutationProtection: { async getProtectedTargets() { return protect ? [{ path: allowedFile, scope: "file" as const }] : []; } }, fileMutations: { sessionId: "s1", turnId: "t1", store: { async withWorkspaceLock(_root: string, operation: () => Promise<unknown>) { protect = true; return operation(); } } as never } };
    const tool = createWriteFileTool();
    const input = tool.inputSchema.parse({ path: allowedFile, content: "must-not-write" });
    await expect(tool.createActionFacts(input, context)).resolves.toBeDefined();
    await expect(tool.execute(input, context)).rejects.toMatchObject({ toolError: { code: "FS_SANDBOX_DENIED" } });
    expect(await stat(allowedFile).then(function exists() { return true; }).catch(function absent() { return false; })).toBe(false);
  });

  it("历史WAL与恢复journal不能恢复投影或绕过辅助路径；普通Undo仍可执行", async function guardsHistoricalUndo() {
    const f = await fixture();
    const memory = createMemoryPorts(f.workspaceRoot);
    memory.hostMutationProtection = f.ports.hostMutationProtection;
    const sessionId = "undo-session";
    const turnId = "undo-turn";
    await memory.turnStore.save({ id: turnId, sessionId, status: "completed", startedAt: 1, frozenRunConfig: { workspaceRoot: f.workspaceRoot, workspaceTrusted: true, permissionMode: "full_access" } });
    const local = path.join(f.workspaceRoot, ".autopilot", "settings.local.json");
    await mkdir(path.dirname(local));
    await writeFile(local, "{}", "utf8");
    const old = await memory.fileMutationStore.prepare({ sessionId, turnId, toolCallId: "old", path: ".autopilot/settings.local.json", operation: "overwrite", before: Buffer.from("old-permission"), after: Buffer.from("{}"), createdAt: 1 });
    old.status = "applied";
    await memory.fileMutationStore.save(old);
    const undo = createUndoService(memory);
    expect(await undo.preview({ sessionId })).toMatchObject({ status: "unavailable", reason: "UNDO_CONFLICT" });
    await expect(undo.execute({ sessionId, confirmed: true })).rejects.toThrow("UNDO_CONFLICT");
    expect(await readFile(local, "utf8")).toBe("{}");

    const normalSession = "normal-undo";
    await memory.turnStore.save({ id: "normal-turn", sessionId: normalSession, status: "completed", startedAt: 1, frozenRunConfig: { workspaceRoot: f.workspaceRoot, workspaceTrusted: true, permissionMode: "full_access" } });
    const normal = path.join(f.workspaceRoot, "note.txt");
    await writeFile(normal, "after");
    const mutation = await memory.fileMutationStore.prepare({ sessionId: normalSession, turnId: "normal-turn", toolCallId: "normal", path: "note.txt", operation: "overwrite", before: Buffer.from("before"), after: Buffer.from("after"), createdAt: 2 });
    mutation.status = "applied";
    await memory.fileMutationStore.save(mutation);
    expect(await undo.execute({ sessionId: normalSession, confirmed: true })).toMatchObject({ status: "completed" });
    expect(await readFile(normal, "utf8")).toBe("before");

    // 使用同Session的普通mutation让journal可以走到辅助路径保护，而非先因缺mutation停止。
    const ordinary = await memory.fileMutationStore.prepare({ sessionId, turnId, toolCallId: "ordinary", path: "note.txt", operation: "overwrite", before: Buffer.from("before"), after: Buffer.from("before"), createdAt: 3 });
    ordinary.status = "applied";
    await memory.fileMutationStore.save(ordinary);
    await memory.fileMutationStore.saveUndoTransaction({ id: "old-journal", sessionId, turnId, workspaceRoot: f.workspaceRoot, status: "prepared", createdAt: 1, updatedAt: 1, files: [{ mutationId: ordinary.id, path: "note.txt", status: "prepared", isolationName: ".autopilot/settings.local.json" }] });
    expect(await undo.preview({ sessionId })).toMatchObject({ status: "unavailable", reason: "UNDO_CONFLICT" });
    expect(await readFile(local, "utf8")).toBe("{}");
  });
});
