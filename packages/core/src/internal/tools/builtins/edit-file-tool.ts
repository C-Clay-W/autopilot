/**
 * edit_file 工具：完整读取后才可编辑，统一换行匹配、保留原编码，并给审批卡提供统一 diff。
 */
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertRegularFile } from "../permissions/workspace-path";
import { buildExternalConstraint, getReadStateKey, resolveFileTarget, resolveExternalTargetRestriction } from "../permissions/path-access-policy";
import { assertFileMutationAllowed, assertFileMutationAuthorized, assertHostMutationTargetAllowed } from "../permissions/mutation-policy";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import { decodeTextFile, detectLineEnding, encodeTextFile, normalizeLineEndings, restoreLineEndings } from "../text-file";
import type { AgentToolDefinition, ToolExecutionContext } from "../types";
import { MAX_TEXT_SCAN_BYTES } from "./text-read-limits";

const maxDiffBytes = 8 * 1024;
const editFileSchema = z.object({
  path: z.string().min(1),
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().default(false),
}).strict();

/** 计算原始字节哈希，作为 read-before-edit 的乐观并发前置条件。 */
function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 只规范化引号用于匹配，实际写入仍保留目标文本的原始引号样式。 */
function normalizeQuotes(content: string): string {
  return content.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

/** 以同目录临时文件和 rename 替换目标，避免失败时破坏已有文件。 */
async function atomicWrite(targetPath: string, content: Buffer): Promise<void> {
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/** 在 edit 真正覆盖文件前持久化 before/after WAL，失败也保留可审计状态。 */
async function applyWithMutation(
  context: ToolExecutionContext,
  input: { path: string; before: Buffer; after: Buffer; targetPath: string },
  apply: () => Promise<void>,
): Promise<void> {
  const binding = context.fileMutations;
  if (!binding || !context.toolCallId) return apply();
  const mutation = await binding.store.prepare({ sessionId: binding.sessionId, turnId: binding.turnId, toolCallId: context.toolCallId, path: input.path, operation: "edit", before: input.before, after: input.after, createdAt: Date.now() });
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

/** 生成稳定的统一 diff；过长时从完整行边界截断并标记。 */
function createUnifiedDiff(filePath: string, before: string, after: string): { diff: string; truncated: boolean } {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);
  const oldStart = prefix + 1;
  const newStart = prefix + 1;
  const lines = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${oldStart},${oldChanged.length} +${newStart},${newChanged.length} @@`,
    ...oldChanged.map((line) => `-${line}`),
    ...newChanged.map((line) => `+${line}`),
  ];
  const complete = lines.join("\n");
  if (Buffer.byteLength(complete, "utf8") <= maxDiffBytes) return { diff: complete, truncated: false };
  let preview = "";
  for (const line of lines) {
    const candidate = `${preview}${preview ? "\n" : ""}${line}`;
    if (Buffer.byteLength(candidate, "utf8") > maxDiffBytes) break;
    preview = candidate;
  }
  return { diff: `${preview}\n…[diff 已截断]`, truncated: true };
}

/** 读取并验证快照（支持分页读取后的增量编辑），返回规范化内容和编码/换行元数据；外部目标经共享预检。 */
async function loadEditableFile(inputPath: string, context: ToolExecutionContext): Promise<{
  absolutePath: string;
  isExternal: boolean;
  canonicalTarget: string;
  canonicalWorkspace: string;
  relativePath?: string;
  bytes: Buffer;
  content: string;
  normalizedContent: string;
  lineEnding: "\n" | "\r\n" | "\r";
  encoding: ReturnType<typeof decodeTextFile>["encoding"];
  observedRanges: Array<{ startLine: number; endLine: number }>;
}> {
  await assertHostMutationTargetAllowed(context, inputPath);
  // Talk-Plan1013 Stage 1：修改审批前的准备段允许读取外部正文以计算 diff（读取例外），零写入。
  const target = await resolveFileTarget(context.workspaceRoot, inputPath);
  if (!target.exists) throw createToolError(TOOL_ERROR_CODES.FILE_NOT_READ, "edit_file 只能编辑已存在文件");
  await assertRegularFile(target.absolutePath);
  // Talk-Plan1013 Stage5 R5：读正文/算 diff 前先过同一 Read 限制——deny 在任何字节读取前硬拒绝；
  // ask 由本 turn 的 read_file 逐次确认满足（edit 依赖 read state，而 read state 只能由过闸的 read_file 建立）。
  if (target.isExternal) {
    const readRestriction = await resolveExternalTargetRestriction(context, target, "read_file");
    if (readRestriction === "deny") throw createToolError(TOOL_ERROR_CODES.COMMAND_FORBIDDEN, "该外部文件的读取已被显式规则拒绝，不能读取正文准备编辑");
  }
  const readState = context.fileReadStates?.get(getReadStateKey(target));
  if (!readState) throw createToolError(TOOL_ERROR_CODES.FILE_NOT_READ, "编辑前必须先用 read_file 读取目标文件");
  const currentStats = await stat(target.absolutePath);
  if (currentStats.size > MAX_TEXT_SCAN_BYTES) throw createToolError(TOOL_ERROR_CODES.FILE_TOO_LARGE, "文件超过 8 MiB 安全编辑上限");
  const bytes = await readFile(target.absolutePath);
  if (currentStats.mtimeMs !== readState.mtimeMs || sha256(bytes) !== readState.sha256) {
    throw createToolError(TOOL_ERROR_CODES.FILE_STALE, "文件在读取后已变化，请重新读取");
  }
  const decoded = decodeTextFile(bytes);
  return {
    absolutePath: target.absolutePath,
    isExternal: target.isExternal,
    canonicalTarget: target.canonicalTarget,
    canonicalWorkspace: target.canonicalWorkspace,
    relativePath: target.relativePath,
    bytes,
    content: decoded.content,
    normalizedContent: normalizeLineEndings(decoded.content),
    lineEnding: detectLineEnding(decoded.content),
    encoding: decoded.encoding,
    observedRanges: readState.observedRanges ?? [],
  };
}

/** 记录精确替换在规范化文本中的 span 与行边界，避免把行内子串误当作未命中。 */
interface TextMatch {
  start: number;
  end: number;
  text: string;
  startLine: number;
  endLine: number;
}

/** 查找全部可替换 span；引号归一化只用于定位，实际替换始终使用原始字符边界。 */
function findTextMatches(content: string, oldString: string): TextMatch[] {
  const exact = content.includes(oldString);
  const searchableContent = exact ? content : normalizeQuotes(content);
  const searchableOld = exact ? oldString : normalizeQuotes(oldString);
  const matches: TextMatch[] = [];
  let start = 0;
  while (start <= searchableContent.length - searchableOld.length) {
    const index = searchableContent.indexOf(searchableOld, start);
    if (index < 0) break;
    const text = content.slice(index, index + oldString.length);
    const startLine = content.slice(0, index).split("\n").length;
    const endLine = startLine + text.split("\n").length - 1;
    matches.push({ start: index, end: index + oldString.length, text, startLine, endLine });
    start = index + oldString.length;
  }
  return matches;
}

/** 校验每个实际替换 span 及相邻上下文都位于同一个已观察区间。 */
function validateObservedRanges(matches: TextMatch[], normalizedContent: string, observedRanges: Array<{ startLine: number; endLine: number }>): void {
  if (observedRanges.length === 0) throw createToolError(TOOL_ERROR_CODES.FILE_NOT_READ, "编辑前必须先 read_file 定位到目标范围");
  const lines = normalizedContent.split("\n");
  for (const match of matches) {
    const contextStart = Math.max(1, match.startLine - 1);
    const contextEnd = Math.min(lines.length, match.endLine + 1);
    const inRange = observedRanges.some(function containsContext(range) { return range.startLine <= contextStart && range.endLine >= contextEnd; });
    if (!inRange) {
      throw createToolError(TOOL_ERROR_CODES.FILE_NOT_READ,
        `目标行 ${match.startLine}-${match.endLine} 不在已读取范围内。请用 read_file 读取包含第 ${contextStart}-${contextEnd} 行的区域后再编辑。`);
    }
  }
}

/** 将实际 match 替换为新文本，支持不同弯引号形式的 replaceAll。 */
function replaceTextMatches(content: string, matches: TextMatch[], newString: string): string {
  let cursor = 0;
  let next = "";
  for (const match of matches) {
    next += content.slice(cursor, match.start);
    next += newString;
    cursor = match.end;
  }
  return `${next}${content.slice(cursor)}`;
}

/** 按替换引起的行偏移更新已读取范围，绝不把未读取的整份文件升级为已观察。 */
function updateObservedRanges(observedRanges: Array<{ startLine: number; endLine: number }>, matches: TextMatch[], newString: string): Array<{ startLine: number; endLine: number }> {
  return observedRanges.map(function updateRange(original) {
    let startLine = original.startLine;
    let endLine = original.endLine;
    for (const match of matches) {
      const lineDelta = newString.split("\n").length - match.text.split("\n").length;
      if (match.endLine < startLine) {
        startLine += lineDelta;
        endLine += lineDelta;
      } else if (match.startLine <= endLine) {
        endLine += lineDelta;
      }
    }
    return { startLine, endLine };
  });
}

/** 计算唯一替换及统一 diff，审批和真正写入共用同一语义；diff 头使用目标的稳定显示身份。 */
async function prepareEdit(input: z.infer<typeof editFileSchema>, context: ToolExecutionContext) {
  const file = await loadEditableFile(input.path, context);
  const targetLabel = file.isExternal ? file.canonicalTarget : file.relativePath!;
  const oldString = normalizeLineEndings(input.oldString);
  const matches = findTextMatches(file.normalizedContent, oldString);
  if (matches.length === 0) throw createToolError(TOOL_ERROR_CODES.FILE_STALE, "oldString 未命中，请重新读取并提供精确文本");
  if (matches.length > 1 && !input.replaceAll) {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "oldString 命中多处；请改为唯一文本或显式 replaceAll");
  }
  const replacements = input.replaceAll ? matches : [matches[0]];
  validateObservedRanges(replacements, file.normalizedContent, file.observedRanges);
  const newString = normalizeLineEndings(input.newString);
  const normalizedNext = replaceTextMatches(file.normalizedContent, replacements, newString);
  if (normalizedNext === file.normalizedContent) throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "编辑不会产生变化");
  const nextContent = restoreLineEndings(normalizedNext, file.lineEnding);
  return { ...file, targetLabel, nextContent, replacements: replacements.length, nextObservedRanges: updateObservedRanges(file.observedRanges, replacements, newString), diff: createUnifiedDiff(targetLabel, file.normalizedContent, normalizedNext) };
}

/** 创建精确文本编辑工具定义；已命中的 session/workspace grant 由 ToolExecutor 在此审批之后复用。 */
export function createEditFileTool(): AgentToolDefinition<z.infer<typeof editFileSchema>, Record<string, unknown>> {
  return {
    name: "edit_file",
    description: "编辑已有文件的首选工具，只发送差异。oldString 使用 2-4 个相邻行即可唯一定位；一次只做一个内聚 patch，大修改拆为多次调用。必须先 read_file 让服务端建立文件快照，编辑时服务端校验目标行位于已观察范围且文件未被外部修改。",
    inputSchema: editFileSchema,
    metadata: { effect: "workspace", destructive: true, concurrency: { max: 1 }, retry: { safe: false } },
    async createActionFacts(input, context) {
      // Talk-Plan1013 Stage5 R5：外部目标先查当前 Edit 限制——deny 在准备 diff（读正文）前硬拒绝，
      // ask 收窄为逐次询问（即便有 grant 也单次确认，不写持久规则）。
      const restrictionTarget = await resolveFileTarget(context.workspaceRoot, input.path);
      const restriction = await resolveExternalTargetRestriction(context, restrictionTarget, "edit_file");
      if (restriction === "deny") {
        return {
          toolName: "edit_file",
          effect: "external" as const,
          destructive: true,
          operation: "edit",
          risk: "external_side_effect" as const,
          stableConstraint: buildExternalConstraint(restrictionTarget.canonicalTarget),
          requiresApproval: true,
          externalMutation: true,
          externalTarget: { canonicalTarget: restrictionTarget.canonicalTarget, canonicalWorkspace: restrictionTarget.canonicalWorkspace },
          externalRestriction: "deny" as const,
          approval: { reason: "编辑该工作区外文件已被显式规则拒绝" },
        };
      }
      const prepared = await prepareEdit(input, context);
      // Talk-Plan1013 Stage 1：外部编辑标记 externalMutation，由全模式外部修改 gate 强制精确授权。
      return {
        toolName: "edit_file",
        effect: prepared.isExternal ? ("external" as const) : ("workspace" as const),
        destructive: true,
        operation: "edit",
        resource: prepared.targetLabel,
        risk: prepared.isExternal ? ("external_side_effect" as const) : ("workspace_mutating" as const),
        stableConstraint: prepared.isExternal ? buildExternalConstraint(prepared.canonicalTarget) : `path:${prepared.relativePath!.replace(/\\/g, "/")}`,
        requiresApproval: true,
        ...(prepared.isExternal ? {
          externalMutation: true,
          externalTarget: { canonicalTarget: prepared.canonicalTarget, canonicalWorkspace: prepared.canonicalWorkspace },
          ...(restriction === "ask" ? { externalRestriction: "ask" as const } : {}),
        } : {}),
        approval: {
          reason: prepared.isExternal ? "编辑工作区外文件需要明确用户授权" : "编辑已有文件需要用户审批",
          preview: { path: prepared.targetLabel, operation: "edit", replacements: prepared.replacements, diff: prepared.diff.diff, diffTruncated: prepared.diff.truncated },
        },
      };
    },
    async execute(input, context) {
      const lockedTarget = await resolveFileTarget(context.workspaceRoot, input.path);
      const executeLocked = async function executeLockedEdit() {
        // Stage 5：锁内、真实 mutation 前查询 Turn 冻结沙箱模式；read-only 拒绝且零磁盘变化。
        assertFileMutationAllowed(context);
        // Talk-Plan1013 Stage 1：执行层复查——锁内重新解析 canonical 身份；allow_once 的约束一致性由 Executor 审批消费复核。
        const prepared = await prepareEdit(input, context);
        // Talk-Plan1013 Stage5 R3：锁内复核批准绑定——当前 canonical 目标/操作与 ToolExecutor
        // 注入的授权失配、或内部目标改指外部时，在真实替换与任何磁盘变化前停止。
        assertFileMutationAuthorized(context, prepared, "edit");
        if (prepared.canonicalTarget !== lockedTarget.canonicalTarget) throw createToolError(TOOL_ERROR_CODES.FILE_STALE, "等待文件锁期间目标身份已改变");
        const nextBytes = encodeTextFile(prepared.nextContent, prepared.encoding);
        if (nextBytes.byteLength > MAX_TEXT_SCAN_BYTES) throw createToolError(TOOL_ERROR_CODES.FILE_TOO_LARGE, "编辑后的文件超过 8 MiB 安全编辑上限");
        await applyWithMutation(context, { path: prepared.isExternal ? `ext:${prepared.canonicalTarget}` : prepared.relativePath!, before: prepared.bytes, after: nextBytes, targetPath: prepared.absolutePath }, async function replaceEditedFile() { await atomicWrite(prepared.absolutePath, nextBytes); });
        const newStats = await stat(prepared.absolutePath);
        const newHash = sha256(nextBytes);
        context.fileReadStates?.set(getReadStateKey(prepared), { sha256: newHash, mtimeMs: newStats.mtimeMs, observedRanges: prepared.nextObservedRanges });
        return { path: prepared.targetLabel, changeType: "edit", replacements: prepared.replacements, diff: prepared.diff.diff, diffTruncated: prepared.diff.truncated, sha256: newHash, encoding: prepared.encoding, lineEnding: prepared.lineEnding };
      };
      if (!context.fileMutations || !context.workspaceRoot) return executeLocked();
      return context.fileMutations.store.withWorkspaceLock(context.workspaceRoot, executeLocked, [lockedTarget.canonicalTarget]);
    },
    serializeOutput(output) { return output; },
  };
}
