/**
 * write_file 工具：在工作区内原子创建或基于 SHA-256 前置条件覆写 UTF-8 文本文件。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertRegularFile } from "../permissions/workspace-path";
import { buildExternalConstraint, getReadStateKey, resolveFileTarget, resolveExternalTargetRestriction } from "../permissions/path-access-policy";
import { assertFileMutationAllowed, assertFileMutationAuthorized, assertHostMutationTargetAllowed } from "../permissions/mutation-policy";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import type { AgentToolDefinition, ToolExecutionContext } from "../types";

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).strict();

/** 计算内容哈希，作为覆写的乐观并发前置条件。 */
function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 同目录临时写入、fsync 与 rename，避免跨盘替换并确保失败不污染目标文件。 */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/** 在真实替换前写入 mutation WAL，并在替换后以原始字节 SHA 收敛有限状态。 */
async function applyWithMutation(
  context: ToolExecutionContext,
  input: { path: string; operation: "create" | "overwrite"; before: Buffer | null; after: Buffer; targetPath: string },
  apply: () => Promise<void>,
): Promise<void> {
  const binding = context.fileMutations;
  if (!binding || !context.toolCallId) return apply();
  const mutation = await binding.store.prepare({ sessionId: binding.sessionId, turnId: binding.turnId, toolCallId: context.toolCallId, path: input.path, operation: input.operation, before: input.before, after: input.after, createdAt: Date.now() });
  try {
    await apply();
    const actual = await readFile(input.targetPath);
    if (sha256(actual) !== sha256(input.after)) throw createToolError(TOOL_ERROR_CODES.FILE_STALE, "文件替换后校验失败，已停止后续操作");
    mutation.status = "applied";
    await binding.store.save(mutation);
  } catch (error) {
    const actual = await readFile(input.targetPath).catch(function missingFile() { return null; });
    mutation.status = actual && sha256(actual) === sha256(input.after) ? "applied" : "failed";
    mutation.failedReason = mutation.status === "failed" ? "FILE_APPLY_FAILED" : undefined;
    await binding.store.save(mutation).catch(function preserveOriginalError() { return undefined; });
    throw error;
  }
}

/** 创建受控写文件工具定义；所有写入先进入统一审批，再由权限模式决定是否自动通过。 */
export function createWriteFileTool(): AgentToolDefinition<z.infer<typeof writeFileSchema>, Record<string, unknown>> {
  return {
    name: "write_file",
    description: "在工作区内创建新文件。已有文件优先使用 edit_file（只发送差异），write_file 仅用于新建文件或用户明确要求的完整重写；覆写已有文件必须携带 read_file 返回的 expectedSha256。大内容应拆分为可验证的结构化步骤，避免单次超大 content。",
    inputSchema: writeFileSchema,
    metadata: { effect: "workspace", destructive: true, concurrency: { max: 1 }, retry: { safe: false } },
    async createActionFacts(input, context) {
      await assertHostMutationTargetAllowed(context, input.path);
      const target = await resolveFileTarget(context.workspaceRoot, input.path);
      // Talk-Plan1013 Stage5 R5：外部目标先查当前 Write 限制——deny 硬拒绝，ask 逐次询问（即便有 grant 也单次确认）。
      const restriction = await resolveExternalTargetRestriction(context, target, "write_file");
      return {
        toolName: "write_file",
        effect: target.isExternal ? ("external" as const) : ("workspace" as const),
        destructive: true,
        operation: input.expectedSha256 ? "overwrite" : "create",
        resource: target.isExternal ? target.canonicalTarget : target.relativePath,
        risk: target.isExternal ? ("external_side_effect" as const) : ("workspace_mutating" as const),
        stableConstraint: target.isExternal ? buildExternalConstraint(target.canonicalTarget) : `path:${target.relativePath!.replace(/\\/g, "/")}`,
        requiresApproval: true,
        ...(target.isExternal ? {
          externalMutation: true,
          externalTarget: { canonicalTarget: target.canonicalTarget, canonicalWorkspace: target.canonicalWorkspace },
          externalRestriction: restriction,
        } : {}),
        approval: {
          reason: target.isExternal
            ? "写入工作区外文件需要明确用户授权"
            : input.expectedSha256 ? "覆写已有文件需要用户审批" : "在工作区内新建文件需要用户审批",
          preview: { path: target.isExternal ? target.canonicalTarget : input.path, contentBytes: Buffer.byteLength(input.content, "utf8"), operation: input.expectedSha256 ? "update" : "create" },
        },
      };
    },
    async execute(input, context) {
      const lockedTarget = await resolveFileTarget(context.workspaceRoot, input.path);
      const executeLocked = async function executeLockedWrite() {
        // Stage 5：锁内、真实 mutation 前查询 Turn 冻结沙箱模式；read-only 拒绝且零磁盘变化。
        assertFileMutationAllowed(context);
        await assertHostMutationTargetAllowed(context, input.path);
        // Talk-Plan1013 Stage 1：执行层复查——锁内重新解析 canonical 身份；gate 已在策略层拦截未授权外部修改。
        const target = await resolveFileTarget(context.workspaceRoot, input.path);
        // Talk-Plan1013 Stage5 R3：锁内复核批准绑定——等待目标锁期间父链接被替换导致当前
        // canonical 目标/操作与绑定失配、或内部目标改指外部时，在任何磁盘变化前停止。
        assertFileMutationAuthorized(context, target, input.expectedSha256 ? "overwrite" : "create");
        if (target.canonicalTarget !== lockedTarget.canonicalTarget) throw createToolError(TOOL_ERROR_CODES.FILE_STALE, "等待文件锁期间目标身份已改变");
        const mutationPath = target.isExternal ? `ext:${target.canonicalTarget}` : target.relativePath!;
        const next = Buffer.from(input.content, "utf8");
        if (target.exists) {
          await assertRegularFile(target.absolutePath);
          if (!input.expectedSha256) throw createToolError(TOOL_ERROR_CODES.FILE_STALE, "覆写已有文件必须提供 read_file 返回的 expectedSha256");
          const current = await readFile(target.absolutePath);
          if (sha256(current) !== input.expectedSha256) throw createToolError(TOOL_ERROR_CODES.FILE_STALE, "文件已变化，请重新读取后再覆写");
          await applyWithMutation(context, { path: mutationPath, operation: "overwrite", before: current, after: next, targetPath: target.absolutePath }, async function replaceExisting() { await atomicWrite(target.absolutePath, input.content); });
          const updated = await stat(target.absolutePath);
          context.fileReadStates?.set(getReadStateKey(target), { sha256: sha256(next), mtimeMs: updated.mtimeMs, observedRanges: [{ startLine: 1, endLine: input.content.split("\n").length }] });
          return { path: target.isExternal ? target.canonicalTarget : target.relativePath!, changeType: "update", bytes: next.byteLength, sha256: sha256(next) };
        }
        if (input.expectedSha256) throw createToolError(TOOL_ERROR_CODES.FILE_STALE, "目标不存在，不能使用覆写前置条件创建文件");
        // 创建目标父目录发生在已批准的执行段内；审批（facts）阶段不产生任何磁盘变化。
        await mkdir(path.dirname(target.absolutePath), { recursive: true });
        const appeared = await stat(target.absolutePath).then(() => true).catch(() => false);
        if (appeared) throw createToolError(TOOL_ERROR_CODES.FILE_STALE, "目标在创建前已出现，请重新确认操作");
        await applyWithMutation(context, { path: mutationPath, operation: "create", before: null, after: next, targetPath: target.absolutePath }, async function createNewFile() { await atomicWrite(target.absolutePath, input.content); });
        const created = await stat(target.absolutePath);
        context.fileReadStates?.set(getReadStateKey(target), { sha256: sha256(next), mtimeMs: created.mtimeMs, observedRanges: [{ startLine: 1, endLine: input.content.split("\n").length }] });
        return { path: target.isExternal ? target.canonicalTarget : target.relativePath!, changeType: "create", bytes: next.byteLength, sha256: sha256(next) };
      };
      if (!context.fileMutations || !context.workspaceRoot) return executeLocked();
      return context.fileMutations.store.withWorkspaceLock(context.workspaceRoot, executeLocked, [lockedTarget.canonicalTarget]);
    },
    serializeOutput(output) { return output; },
  };
}
