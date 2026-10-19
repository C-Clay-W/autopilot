/**
 * undo-service.ts — 仅响应宿主显式确认的 Session 文件 rollback 编排。
 *
 * 该服务不向模型暴露，也不处理 command、MCP、网络、数据库等外部副作用。
 */

import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../../internal/tools/permissions/workspace-path";
import { buildExternalConstraint, resolveFileTarget } from "../../internal/tools/permissions/path-access-policy";
import { PolicyEngine } from "../../internal/tools/policy-engine";
import type { FileMutation, UndoTransaction } from "../domain";
import type { RuntimePorts } from "../ports";
import { AgentRuntimeError as RuntimeError, createEventEnvelope } from "../protocol";
import { assertHostMutationTargetAllowed } from "../../internal/tools/permissions/mutation-policy";
import { classifyExternalRestriction, normalizeComparablePath } from "../domain/external-permissions";

/**
 * Talk-Plan1013 Stage 2：解析 WAL 记录的真实目标。
 * Stage 1 起外部修改以 `ext:<canonicalTarget>` 记录；Talk-Plan1013 Stage5 R6：此处经共享目标
 * 预检重新解析当前 canonical 身份并与 WAL 记录比较——授权后父链接被替换到其他目录时当前
 * canonical 身份改变，失配（含伪造内部记录与解析异常）一律按 UNDO_CONFLICT 处理，
 * 防止恢复写入转移到未批准目标；内部目标分支行为不变。
 */
export async function resolveFileMutationTarget(workspaceRoot: string, mutationPath: string): Promise<{ absolutePath: string; exists: boolean }> {
  if (!mutationPath.startsWith("ext:")) return resolveWorkspacePath(workspaceRoot, mutationPath);
  const recorded = path.resolve(mutationPath.slice("ext:".length));
  try {
    const target = await resolveFileTarget(workspaceRoot, recorded);
    if (!target.isExternal || normalizeComparablePath(target.canonicalTarget) !== normalizeComparablePath(recorded)) throw new RuntimeError("RUNTIME_ERROR", "UNDO_CONFLICT");
    return { absolutePath: target.canonicalTarget, exists: target.exists };
  } catch (error) {
    if (error instanceof RuntimeError && error.message === "UNDO_CONFLICT") throw error;
    throw new RuntimeError("RUNTIME_ERROR", "UNDO_CONFLICT");
  }
}

/** 宿主可展示的脱敏 preview；不携带 blob ref、绝对路径或文件正文。 */
export interface UndoPreview {
  status: "available" | "unavailable";
  turnId?: string;
  files: Array<{ path: string; operation: FileMutation["operation"] }>;
  reason?: "UNDO_NOT_FOUND" | "UNDO_NON_REVERSIBLE" | "UNDO_CONFLICT" | "WORKSPACE_NOT_TRUSTED";
}

/** 显式确认后的最小结果；中间 journal 细节不进入普通 CLI transcript。 */
export interface UndoResult {
  status: "completed" | "failed";
  turnId?: string;
  restoredPaths: string[];
  compensatedPaths: string[];
  conflicts: string[];
}

/** 计算原始字节 SHA-256，Undo 一律比较字节而非文本解码结果。 */
function sha256(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }

/** 写入同目录 staging 并 fsync，避免跨文件系统 rename 与半写内容。 */
async function writeStaging(targetPath: string, name: string, content: Buffer): Promise<string> {
  const stagingPath = path.join(path.dirname(targetPath), name);
  const handle = await open(stagingPath, "wx");
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  return stagingPath;
}

/** 创建 Undo 服务；只有 Runtime Public Facade 可获得此能力。 */
export function createUndoService(ports: RuntimePorts): UndoService {
  return { preview, execute };

  /** Undo 与自动补偿锁定整批原 canonical 目标，取锁后重验，目标转移不能写入未锁文件。 */
  async function withMutationLocks<T>(workspaceRoot: string, mutationPaths: readonly string[], operation: () => Promise<T>): Promise<T> {
    const targets = await Promise.all(mutationPaths.map(async function resolveTarget(mutationPath) {
      const target = await resolveFileMutationTarget(workspaceRoot, mutationPath);
      return resolveFileTarget(workspaceRoot, target.absolutePath);
    }));
    return ports.fileMutationStore.withWorkspaceLock(workspaceRoot, async function verifyLockedTargets() {
      for (let index = 0; index < mutationPaths.length; index++) {
        const current = await resolveFileMutationTarget(workspaceRoot, mutationPaths[index]!);
        const resolved = await resolveFileTarget(workspaceRoot, current.absolutePath);
        if (normalizeComparablePath(resolved.canonicalTarget) !== normalizeComparablePath(targets[index]!.canonicalTarget)) throw new RuntimeError("RUNTIME_ERROR", "UNDO_CONFLICT");
      }
      return operation();
    }, targets.map(function canonicalTarget(target) { return target.canonicalTarget; }));
  }

  /** 与模型文件修改共用保护判定；历史WAL/恢复不得重建授权状态或权限投影。 */
  async function assertUndoTarget(workspaceRoot: string, absolutePath: string): Promise<void> {
    try { await assertHostMutationTargetAllowed({ workspaceRoot, hostMutationProtection: ports.hostMutationProtection }, absolutePath); }
    catch { throw new RuntimeError("RUNTIME_ERROR", "UNDO_CONFLICT"); }
  }

  /**
   * Talk-Plan1013 Stage5 R6：外部 Undo/补偿写入前经唯一共享入口复查最新外部限制。
   * deny 与 ask 均按 UNDO_CONFLICT 停止（Undo 无逐次确认通道，fail-closed；Plan 7.5 要求
   * 所有调用/恢复均复查最新收紧规则）；缺投影器时与 resolveExternalRestriction 一致按
   * 无已知限制放行，既有外部 Undo 不回归；内部目标不进门。规则匹配复用 domain 共享纯函数，
   * 不写第二套匹配器；本门不重建任何 grant 或投影规则。
   */
  async function assertUndoExternalWriteAllowed(workspaceRoot: string, mutationPath: string, operation: FileMutation["operation"]): Promise<void> {
    if (!mutationPath.startsWith("ext:")) return;
    const projector = ports.externalPermissionProjector;
    if (!projector) return;
    // 规则按原写入工具语义映射：edit_file 的 operation 为 edit，write_file 的 create/overwrite
    // 与 undo 回滚写均为 Write（恢复写只写回原 before 字节，不产生新目录授权）。
    const toolName = operation === "edit" ? "edit_file" : "write_file";
    const constraint = buildExternalConstraint(path.resolve(mutationPath.slice("ext:".length)));
    let restriction: "allow" | "ask" | "deny";
    try {
      restriction = classifyExternalRestriction(await projector.read(workspaceRoot), toolName, constraint);
    } catch {
      throw new RuntimeError("RUNTIME_ERROR", "UNDO_CONFLICT");
    }
    if (restriction !== "allow") throw new RuntimeError("RUNTIME_ERROR", "UNDO_CONFLICT");
  }

  /** 在读取目标正文或写恢复工件前重验原路径/canonical身份，保护冲突保持安全错误。 */
  async function resolveProtectedMutationTarget(workspaceRoot: string, mutationPath: string): Promise<{ absolutePath: string; exists: boolean }> {
    const target = await resolveFileMutationTarget(workspaceRoot, mutationPath);
    await assertUndoTarget(workspaceRoot, target.absolutePath);
    return target;
  }

  /** 写入不含正文的 Undo 审计事件；durable Session 同时写入 transcript，供重启后只读追溯。 */
  async function writeUndoAudit(input: { type: "undo_completed" | "undo_failed"; transaction: UndoTransaction; restoredPaths: string[]; compensatedPaths: string[]; conflicts: string[] }): Promise<void> {
    const events = await ports.transcriptStore.getEvents(input.transaction.sessionId);
    const seq = events.reduce(function latest(current, event) { return Math.max(current, event.seq); }, 0) + 1;
    const envelope = createEventEnvelope({
      seq, sessionId: input.transaction.sessionId, turnId: input.transaction.turnId, timestamp: ports.clock.timestamp(),
      event: { type: input.type, turnId: input.transaction.turnId, transactionId: input.transaction.id, restoredPaths: [...input.restoredPaths], compensatedPaths: [...input.compensatedPaths], conflicts: [...input.conflicts] },
    });
    await ports.eventSink.write(envelope);
    const session = await ports.sessionStore.get(input.transaction.sessionId);
    if (session?.persistenceMode !== "ephemeral") await ports.transcriptStore.append(input.transaction.sessionId, envelope);
  }

  /** 将 crash 遗留的 prepared mutation 依据真实 SHA 收敛，遇到竞争立即标记失败且不覆盖文件。 */
  async function reconcilePrepared(sessionId: string): Promise<void> {
    const prepared = (await ports.fileMutationStore.listBySession(sessionId)).filter(function isPrepared(item) { return item.status === "prepared"; });
    for (const mutation of prepared) {
      const turn = await ports.turnStore.get(mutation.turnId);
      const workspaceRoot = turn?.sessionId === sessionId ? turn.frozenRunConfig.workspaceRoot : undefined;
      if (!workspaceRoot) { mutation.status = "failed"; mutation.failedReason = "PREPARED_CONFLICT"; await ports.fileMutationStore.save(mutation); continue; }
      try {
        const target = await resolveProtectedMutationTarget(workspaceRoot, mutation.path);
        const actual = target.exists ? await readFile(target.absolutePath) : null;
        const actualSha = actual ? sha256(actual) : null;
        if (actualSha === mutation.afterSha) mutation.status = "applied";
        else { mutation.status = "failed"; mutation.failedReason = actualSha === mutation.beforeSha ? "PREPARED_NOT_APPLIED" : "PREPARED_CONFLICT"; }
      } catch { mutation.status = "failed"; mutation.failedReason = "PREPARED_CONFLICT"; }
      await ports.fileMutationStore.save(mutation);
    }
  }

  /** 读取当前目标字节；不存在是 create 回滚和 crash 收敛中的合法状态。 */
  async function readCurrent(targetPath: string): Promise<Buffer | null> {
    try { return await readFile(targetPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** 只校验每条路径最后一次 mutation 的 after SHA；同一路径的旧 mutation 会在逆序恢复时逐步成为当前状态。 */
  async function verifyCandidateCurrent(candidate: { mutations: FileMutation[]; workspaceRoot: string }): Promise<boolean> {
    const expectedByPath = new Map<string, string | null>();
    for (const mutation of candidate.mutations) if (!expectedByPath.has(mutation.path)) expectedByPath.set(mutation.path, mutation.afterSha);
    for (const [relativePath, expectedSha] of expectedByPath) {
      try {
        const target = await resolveProtectedMutationTarget(candidate.workspaceRoot, relativePath);
        const actual = await readCurrent(target.absolutePath);
        if ((actual ? sha256(actual) : null) !== expectedSha) return false;
      } catch { return false; }
    }
    return true;
  }

  /** 将未完成事务恢复到 Undo 前的 after 状态；只在目标仍等于 journal 已知 before/after SHA 时写入。 */
  async function compensateTransaction(transaction: UndoTransaction): Promise<{ compensatedPaths: string[]; conflicts: string[] }> {
    const mutations = new Map((await ports.fileMutationStore.listBySession(transaction.sessionId)).map(function indexMutation(mutation) { return [mutation.id, mutation]; }));
    const compensatedPaths: string[] = [];
    const conflicts: string[] = [];
    for (let index = transaction.files.length - 1; index >= 0; index -= 1) {
      const file = transaction.files[index];
      const mutation = mutations.get(file.mutationId);
      if (!mutation) { file.status = "conflict"; file.errorCode = "UNDO_CONFLICT"; conflicts.push(file.path); continue; }
      try {
        const target = await resolveProtectedMutationTarget(transaction.workspaceRoot, file.path);
        // Talk-Plan1013 Stage5 R6：补偿恢复写前过最新外部限制门（preview 自动补偿同门）。
        await assertUndoExternalWriteAllowed(transaction.workspaceRoot, file.path, mutation.operation);
        const current = await readCurrent(target.absolutePath);
        const currentSha = current ? sha256(current) : null;
        const isolationPath = file.isolationName ? path.join(path.dirname(target.absolutePath), file.isolationName) : undefined;
        if (isolationPath) await assertUndoTarget(transaction.workspaceRoot, isolationPath);
        if (file.stagingName) await assertUndoTarget(transaction.workspaceRoot, path.join(path.dirname(target.absolutePath), file.stagingName));
        const isolated = isolationPath ? await readCurrent(isolationPath) : null;
        const targetWasMovedToIsolation = currentSha === null && isolated !== null && sha256(isolated) === mutation.afterSha;
        if (currentSha !== mutation.afterSha) {
          if (currentSha !== mutation.beforeSha && !targetWasMovedToIsolation) throw new RuntimeError("RUNTIME_ERROR", "UNDO_CONFLICT");
          const after = mutation.afterRef ? await ports.fileMutationStore.getBlob(mutation.afterRef) : null;
          if (!after || sha256(after) !== mutation.afterSha) throw new RuntimeError("RUNTIME_ERROR", "UNDO_BLOB_INVALID");
          const recoveryName = `.${path.basename(target.absolutePath)}.undo.${transaction.id}.${index}.recovery.${randomUUID()}.stage`;
          const recoveryPath = await writeStaging(target.absolutePath, recoveryName, after);
          await rename(recoveryPath, target.absolutePath);
          const restored = await readCurrent(target.absolutePath);
          if ((restored ? sha256(restored) : null) !== mutation.afterSha) throw new RuntimeError("RUNTIME_ERROR", "UNDO_CONFLICT");
        }
        if (isolationPath) {
          if (isolated && sha256(isolated) !== mutation.afterSha) throw new RuntimeError("RUNTIME_ERROR", "UNDO_CONFLICT");
          if (isolated) await rm(isolationPath, { force: true });
        }
        if (file.stagingName) await rm(path.join(path.dirname(target.absolutePath), file.stagingName), { force: true });
        file.status = "compensated";
        compensatedPaths.push(file.path);
      } catch (error) {
        file.status = "conflict";
        file.errorCode = error instanceof RuntimeError && error.message === "UNDO_CONFLICT" ? "UNDO_CONFLICT" : "UNDO_IO_FAILED";
        conflicts.push(file.path);
      }
      transaction.updatedAt = ports.clock.now();
      await ports.fileMutationStore.saveUndoTransaction(transaction);
    }
    transaction.status = "failed";
    transaction.updatedAt = ports.clock.now();
    await ports.fileMutationStore.saveUndoTransaction(transaction);
    return { compensatedPaths, conflicts };
  }

  /** 重启或上次失败后收敛 journal；完全补偿的失败事务保留审计但不阻塞下一次显式 Undo。 */
  async function reconcileUndoTransactions(sessionId: string): Promise<boolean> {
    const transactions = await ports.fileMutationStore.listUndoTransactions(sessionId);
    let unresolved = false;
    for (const transaction of transactions.filter(function incomplete(item) { return item.status !== "completed"; })) {
      try {
        const outcome = await withMutationLocks(transaction.workspaceRoot, transaction.files.map(function mutationPath(file) { return file.path; }), async function reconcileUnderWorkspaceLock() {
          return compensateTransaction(transaction);
        });
        if (outcome.conflicts.length > 0) unresolved = true;
      } catch { unresolved = true; }
    }
    return unresolved;
  }

  /** 选择最近一个包含 canonical 文件变更的 Turn；任一不可撤销记录都会整体 fail closed。 */
  async function findCandidate(sessionId: string): Promise<{ mutations: FileMutation[]; workspaceRoot: string } | null> {
    await reconcilePrepared(sessionId);
    const available = (await ports.fileMutationStore.listBySession(sessionId)).filter(function candidate(item) {
      return item.status === "applied" && item.operation !== "undo" && !item.undoneBy;
    });
    const latest = available.sort(function newest(left, right) { return right.createdAt - left.createdAt; })[0];
    if (!latest) return null;
    const allTurnMutations = (await ports.fileMutationStore.listBySession(sessionId)).filter(function sameTurn(item) {
      return item.turnId === latest.turnId && item.operation !== "undo" && item.status === "applied" && !item.undoneBy;
    });
    if (allTurnMutations.some(function notReversible(item) { return !item.reversible; })) return { mutations: allTurnMutations, workspaceRoot: "" };
    const turn = await ports.turnStore.get(latest.turnId);
    const workspaceRoot = turn?.sessionId === sessionId ? turn.frozenRunConfig.workspaceRoot : undefined;
    if (!workspaceRoot || turn?.frozenRunConfig.workspaceTrusted !== true) return { mutations: allTurnMutations, workspaceRoot: "" };
    return { mutations: allTurnMutations.sort(function reverseOrder(left, right) { return right.createdAt - left.createdAt; }), workspaceRoot };
  }

  /** 返回 preview；仅由 CLI 等显式宿主 action 调用，绝不从模型 prompt 触发。 */
  async function preview(input: { sessionId: string }): Promise<UndoPreview> {
    if (await reconcileUndoTransactions(input.sessionId)) return { status: "unavailable", files: [], reason: "UNDO_CONFLICT" };
    const candidate = await findCandidate(input.sessionId);
    if (!candidate) return { status: "unavailable", files: [], reason: "UNDO_NOT_FOUND" };
    const files = candidate.mutations.map(function summarize(mutation) { return { path: mutation.path, operation: mutation.operation }; });
    if (candidate.mutations.some(function notReversible(mutation) { return !mutation.reversible; })) return { status: "unavailable", turnId: candidate.mutations[0]?.turnId, files, reason: "UNDO_NON_REVERSIBLE" };
    if (!candidate.workspaceRoot) return { status: "unavailable", turnId: candidate.mutations[0]?.turnId, files, reason: "WORKSPACE_NOT_TRUSTED" };
    if (!await verifyCandidateCurrent(candidate)) return { status: "unavailable", turnId: candidate.mutations[0]?.turnId, files, reason: "UNDO_CONFLICT" };
    return { status: "available", turnId: candidate.mutations[0]?.turnId, files };
  }

  /** 执行已 preview 的 Undo；任何 SHA、blob、路径或 IO 异常都停止并尝试补偿。 */
  async function execute(input: { sessionId: string; confirmed: true }): Promise<UndoResult> {
    const safePreview = await preview({ sessionId: input.sessionId });
    if (safePreview.status !== "available" || !safePreview.turnId) {
      throw new RuntimeError("RUNTIME_ERROR", `UNDO_NOT_AVAILABLE:${safePreview.reason ?? "UNKNOWN"}`);
    }
    const candidate = await findCandidate(input.sessionId);
    if (!candidate || !candidate.workspaceRoot) throw new RuntimeError("RUNTIME_ERROR", "UNDO_NOT_AVAILABLE");
    const turn = await ports.turnStore.get(safePreview.turnId);
    if (!turn || turn.sessionId !== input.sessionId || turn.frozenRunConfig.workspaceTrusted !== true) throw new RuntimeError("RUNTIME_ERROR", "WORKSPACE_NOT_TRUSTED");
    const policy = new PolicyEngine().evaluate({
      context: {
        workspaceRoot: candidate.workspaceRoot,
        workspaceTrusted: true,
        permissionMode: turn.frozenRunConfig.permissionMode ?? "ask",
        agentFlow: { async search() { return []; } },
      },
      metadata: { effect: "workspace", destructive: true, concurrency: { max: 1 }, retry: { safe: false } },
      facts: {
        toolName: "undo", effect: "workspace", destructive: true, operation: "undo",
        resource: "session-file-mutations", risk: "workspace_mutating", stableConstraint: `turn:${turn.id}`,
        requiresApproval: true, approval: { reason: "用户已通过独立 Undo 入口确认恢复文件" },
      },
      grantMatched: false,
    });
    if (policy.decision === "deny") throw new RuntimeError("RUNTIME_ERROR", "UNDO_POLICY_DENIED");
    return withMutationLocks(candidate.workspaceRoot, candidate.mutations.map(function mutationPath(mutation) { return mutation.path; }), async function commitUnderWorkspaceLock() {
      if (!await verifyCandidateCurrent(candidate)) throw new RuntimeError("RUNTIME_ERROR", "UNDO_CONFLICT");
      const now = ports.clock.now();
      const transaction: UndoTransaction = {
        id: randomUUID(), sessionId: input.sessionId, turnId: safePreview.turnId!, workspaceRoot: candidate.workspaceRoot, status: "prepared",
        files: candidate.mutations.map(function journalFile(mutation) { return { mutationId: mutation.id, path: mutation.path, status: "prepared" }; }), createdAt: now, updatedAt: now,
      };
      await ports.fileMutationStore.saveUndoTransaction(transaction);
      const undoMutations = new Map<string, FileMutation>();
      try {
        for (let index = 0; index < candidate.mutations.length; index += 1) {
          const mutation = candidate.mutations[index];
          const target = await resolveProtectedMutationTarget(candidate.workspaceRoot, mutation.path);
          // Talk-Plan1013 Stage5 R6：写 staging 工件前过最新外部限制门。
          await assertUndoExternalWriteAllowed(candidate.workspaceRoot, mutation.path, mutation.operation);
          const before = mutation.beforeRef ? await ports.fileMutationStore.getBlob(mutation.beforeRef) : null;
          const after = mutation.afterRef ? await ports.fileMutationStore.getBlob(mutation.afterRef) : null;
          if ((before && sha256(before) !== mutation.beforeSha) || (after && sha256(after) !== mutation.afterSha) || (!before && mutation.beforeSha) || (!after && mutation.afterSha)) throw new RuntimeError("RUNTIME_ERROR", "UNDO_BLOB_INVALID");
          const file = transaction.files[index];
          const stem = `.${path.basename(target.absolutePath)}.undo.${transaction.id}.${index}`;
          if (before) { file.stagingName = `${stem}.stage`; await writeStaging(target.absolutePath, file.stagingName, before); }
          file.isolationName = `${stem}.isolation`;
          transaction.updatedAt = ports.clock.now();
          await ports.fileMutationStore.saveUndoTransaction(transaction);
        }
        transaction.status = "applying"; transaction.updatedAt = ports.clock.now(); await ports.fileMutationStore.saveUndoTransaction(transaction);
        for (let index = 0; index < candidate.mutations.length; index += 1) {
          const mutation = candidate.mutations[index];
          const file = transaction.files[index];
          const target = await resolveProtectedMutationTarget(candidate.workspaceRoot, mutation.path);
          // Talk-Plan1013 Stage5 R6：真实提交（isolation/rename）前复查最新外部限制。
          await assertUndoExternalWriteAllowed(candidate.workspaceRoot, mutation.path, mutation.operation);
          const current = await readCurrent(target.absolutePath);
          if ((current ? sha256(current) : null) !== mutation.afterSha) { file.status = "conflict"; file.errorCode = "UNDO_CONFLICT"; throw new RuntimeError("RUNTIME_ERROR", "UNDO_CONFLICT"); }
          const before = mutation.beforeRef ? await ports.fileMutationStore.getBlob(mutation.beforeRef) : null;
          if ((before && sha256(before) !== mutation.beforeSha) || (!before && mutation.beforeSha)) throw new RuntimeError("RUNTIME_ERROR", "UNDO_BLOB_INVALID");
          const undoMutation = await ports.fileMutationStore.prepare({ sessionId: input.sessionId, turnId: mutation.turnId, toolCallId: `undo:${transaction.id}:${mutation.id}`, path: mutation.path, operation: "undo", before: current, after: before, createdAt: ports.clock.now() });
          undoMutation.undoOf = mutation.id;
          await ports.fileMutationStore.save(undoMutation);
          undoMutations.set(mutation.id, undoMutation);
          const isolationPath = path.join(path.dirname(target.absolutePath), file.isolationName!);
          await rename(target.absolutePath, isolationPath);
          file.status = "isolated";
          transaction.updatedAt = ports.clock.now();
          await ports.fileMutationStore.saveUndoTransaction(transaction);
          if (file.stagingName) await rename(path.join(path.dirname(target.absolutePath), file.stagingName), target.absolutePath);
          const restored = await readCurrent(target.absolutePath);
          if ((restored ? sha256(restored) : null) !== mutation.beforeSha) { file.status = "conflict"; file.errorCode = "UNDO_CONFLICT"; throw new RuntimeError("RUNTIME_ERROR", "UNDO_CONFLICT"); }
          file.status = "applied";
          undoMutation.status = "applied";
          await ports.fileMutationStore.save(undoMutation);
          mutation.undoneBy = undoMutation.id;
          await ports.fileMutationStore.save(mutation);
          transaction.updatedAt = ports.clock.now(); await ports.fileMutationStore.saveUndoTransaction(transaction);
        }
        transaction.status = "completed"; transaction.updatedAt = ports.clock.now(); await ports.fileMutationStore.saveUndoTransaction(transaction);
        await Promise.all(transaction.files.map(async function cleanup(file) {
          const target = await resolveProtectedMutationTarget(candidate.workspaceRoot, file.path);
          if (file.stagingName) await assertUndoTarget(candidate.workspaceRoot, path.join(path.dirname(target.absolutePath), file.stagingName));
          if (file.isolationName) await assertUndoTarget(candidate.workspaceRoot, path.join(path.dirname(target.absolutePath), file.isolationName));
          if (file.stagingName) await rm(path.join(path.dirname(target.absolutePath), file.stagingName), { force: true }).catch(function retainForManualCleanup() { return undefined; });
          if (file.isolationName) await rm(path.join(path.dirname(target.absolutePath), file.isolationName), { force: true }).catch(function retainForManualCleanup() { return undefined; });
        }));
        const result = { status: "completed" as const, turnId: transaction.turnId, restoredPaths: transaction.files.map(function pathOf(file) { return file.path; }), compensatedPaths: [], conflicts: [] };
        await writeUndoAudit({ type: "undo_completed", transaction, ...result });
        return result;
      } catch (error) {
        transaction.status = "compensating"; transaction.updatedAt = ports.clock.now(); await ports.fileMutationStore.saveUndoTransaction(transaction);
        const restoredPaths = transaction.files.filter(function restored(file) { return file.status === "applied" || file.status === "isolated"; }).map(function pathOf(file) { return file.path; });
        const outcome = await compensateTransaction(transaction);
        const result = { status: "failed" as const, turnId: transaction.turnId, restoredPaths, compensatedPaths: outcome.compensatedPaths, conflicts: outcome.conflicts };
        await writeUndoAudit({ type: "undo_failed", transaction, ...result });
        return result;
      }
    });
  }
}

/** Runtime 暴露的 Undo 能力；调用方必须已完成独立的用户确认。 */
export interface UndoService {
  preview(input: { sessionId: string }): Promise<UndoPreview>;
  execute(input: { sessionId: string; confirmed: true }): Promise<UndoResult>;
}
