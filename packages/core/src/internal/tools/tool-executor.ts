/**
 * 工具执行器：固定执行校验、权限、审批、取消与审计顺序，保证每次调用都有终态。
 */
import { isToolWithinCeiling } from "../../runtime/domain/product-mode";
import { randomUUID } from "node:crypto";
import { hashNormalizedToolInput as hashInput } from "./normalized-tool-input";
import { emitToolEvent } from "./tool-audit";
import { createToolError, TOOL_ERROR_CODES, toToolError } from "./tool-error";
import { SANDBOX_START_MAX_ATTEMPTS, SandboxPrepareExhaustedError } from "./process-utils";
import { ToolRegistry } from "./tool-registry";
import { PolicyEngine } from "./policy-engine";
import { resolveSandboxPolicy } from "./sandbox-policy-resolver";
import { isNoSandboxExecConstraint } from "../../runtime/domain/sandbox-policy";
import { issueExternalWriteCapability } from "./permissions/external-execution-policy";
import { buildExternalConstraint } from "./permissions/path-access-policy";
import { isExternalFileConstraint } from "../../runtime/domain/external-permissions";
import { isExternalTaskFileSetConstraint } from "../../runtime/domain/approval";
import type { ExternalExecutionAuthorization } from "../../runtime/domain/external-execution";
import { AgentRuntimeError } from "../../runtime/protocol/error-code";
import { WebFetchRedirect, bindWebFetchRedirect, getWebFetchRedirectBudget } from "./web-fetch-redirect";
import type {
  ToolApprovalRequest,
  ToolExecutionContext,
  ToolExecutionOptions,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolInterruptionState,
  ToolApprovalDecision,
  ToolActionFacts,
  ToolDisplayDetail,
  ToolDisplayFacts,
  ToolJobDisplayFacts,
  ToolPolicyResult,
  SandboxExecutionScope,
} from "./types";

interface PendingApproval {
  request: ToolApprovalRequest;
}

type ToolTimeoutResult = {
  status: "timeout";
  callId: string;
  toolName: string;
  error: { code: string; message: string };
  meta: { durationMs: number; inputHash: string };
  interruption: ToolInterruptionState;
  display?: ToolDisplayFacts;
};

/** 私有授权Service的稳定失败码保持原样，不降级成普通工具执行失败。 */
async function callExecutionAuthority<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof AgentRuntimeError) throw createToolError(error.code, error.message);
    throw error;
  }
}

/** 将审批命令的已校验参数压缩为有限且脱敏的展示预览。 */
function createSafeActionPreview(facts: ToolActionFacts): string | undefined {
  const preview = facts.approval?.preview;
  if (facts.operation === "mcp_tools_call" && facts.executionIsolation) {
    return facts.executionIsolation === "unisolated"
      ? "MCP server 执行边界：未隔离（宿主直接运行）"
      : "MCP server 执行边界：OS 沙箱隔离";
  }
  // 任务文件集合审批（工作区与外部）：卡片直接展示冻结清单与对应操作，用户批准的就是这份清单本身。
  // 外部集合另列一张卡（2.4 第 4 项），文案明确"工作区外"，不与工作区集合批准混淆。
  if (facts.taskFileSet?.length) {
    const list = facts.taskFileSet.map((entry) => `${entry.path}（${entry.operation === "create" ? "创建" : "编辑"}）`).join("、");
    const scope = isExternalTaskFileSetConstraint(facts.stableConstraint) ? "个工作区外文件" : "个文件";
    return `本任务将修改 ${facts.taskFileSet.length} ${scope}：${list}`;
  }
  if (facts.operation !== "command" || !preview || typeof preview.program !== "string") return undefined;
  const args = Array.isArray(preview.args) ? preview.args : [];
  const safeArgs: string[] = [];
  let redactNext = false;
  let truncated = false;
  for (const value of args.slice(0, 12)) {
    const argument = typeof value === "string" ? value : "";
    const hasSensitiveName = /(?:token|secret|password|credential|api[-_]?key|authorization)/i.test(argument);
    if (redactNext) {
      safeArgs.push("<redacted>");
      redactNext = false;
      continue;
    }
    if (hasSensitiveName) {
      if (argument.startsWith("-") && !argument.includes("=")) {
        safeArgs.push(argument);
        redactNext = true;
      } else if (argument.includes("=")) {
        safeArgs.push(`${argument.split("=", 1)[0]}=<redacted>`);
      } else {
        safeArgs.push("<redacted>");
      }
      continue;
    }
    if (argument.length > 120) {
      safeArgs.push(`${argument.slice(0, 120)}…`);
      truncated = true;
      continue;
    }
    safeArgs.push(argument);
  }
  if (args.length > 12) truncated = true;
  const text = [preview.program, ...safeArgs].join(" ").trim();
  const limited = text.slice(0, 512);
  const suffix = [truncated ? "（参数已截断）" : "", text.length > 512 ? "（超出展示预算已截断）" : ""].filter(Boolean).join("");
  return limited && suffix ? `${limited}${suffix}` : limited || undefined;
}

/** 将内置工具名映射为 Presentation 已冻结的展示文案键，未知工具继续使用安全回退。 */
function getToolDisplayTitleKey(toolName: string): string {
  if (toolName === "read_file") return "tool.read.completed";
  if (toolName === "glob_files" || toolName === "grep_files") return "tool.search.completed";
  if (toolName === "web_search") return "tool.web_search.completed";
  if (toolName === "web_fetch") return "tool.web_fetch.completed";
  if (toolName === "write_file") return "tool.write.completed";
  if (toolName === "edit_file") return "tool.edit.completed";
  if (toolName === "run_command") return "tool.command.completed";
  if (toolName === "start_background_job") return "tool.job.start.completed";
  if (toolName === "list_background_jobs") return "tool.job.list.completed";
  if (toolName === "read_background_job") return "tool.job.read.completed";
  if (toolName === "stop_background_job") return "tool.job.stop.completed";
  if (toolName.startsWith("mcp__")) return "tool.external.completed";
  return "tool.other.completed";
}

/** 从 edit_file 已序列化的受控结果提取最终 Diff，不读取任意工具的原始输出。 */
function getEditDiffFacts(facts: ToolActionFacts, output: unknown): ToolDisplayFacts["diff"] | undefined {
  if (facts.toolName !== "edit_file" || !output || typeof output !== "object") return undefined;
  const record = output as Record<string, unknown>;
  const text = typeof record.diff === "string" ? record.diff : undefined;
  if (!text) return undefined;
  return {
    text,
    files: 1,
    added: text.split("\n").filter(function countAdded(line) { return line.startsWith("+") && !line.startsWith("+++"); }).length,
    removed: text.split("\n").filter(function countRemoved(line) { return line.startsWith("-") && !line.startsWith("---"); }).length,
    truncated: record.diffTruncated === true,
  };
}

/** display 专用的条目与字节预算，显著小于工具自身的输出预算，避免长列表无界进入 transcript。 */
const MAX_DISPLAY_DETAIL_ITEMS = 100;
const MAX_DISPLAY_DETAIL_BYTES = 8 * 1024;
const MAX_DISPLAY_LINE_NUMBERS_PER_FILE = 100;

/** 在 display 预算内保留完整条目；超出即停止追加，绝不裁剪单个条目内部字段。 */
function takeWithinDisplayBudget<T>(items: T[]): { items: T[]; truncated: boolean } {
  const selected: T[] = [];
  let bytes = 2;
  for (const item of items) {
    if (selected.length >= MAX_DISPLAY_DETAIL_ITEMS) return { items: selected, truncated: true };
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (selected.length > 0 ? 1 : 0);
    if (bytes + itemBytes > MAX_DISPLAY_DETAIL_BYTES) return { items: selected, truncated: true };
    selected.push(item);
    bytes += itemBytes;
  }
  return { items: selected, truncated: false };
}

/** 只接受受控 serialized output 的对象形态；数组或标量一律放弃生成明细。 */
function readOutputRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** 只接受安全整数，避免 NaN、浮点或超范围数值进入展示明细。 */
function readInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** 校验并归一化工具返回的工作区相对路径，拒绝绝对路径、盘符、UNC 与跳出工作区的片段。 */
function readRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const normalized = value.replace(/\\/g, "/");
  if (
    normalized.startsWith("/")
    || /^[a-zA-Z]:/.test(normalized)
    || normalized.split("/").some(function isUnsafeSegment(segment) { return !segment || segment === "." || segment === ".."; })
  ) return undefined;
  return normalized;
}

/** 从 read_file 的受控结果投影行范围明细；不复制 content、sha256 或 encoding。 */
function projectReadDetail(output: unknown): ToolDisplayDetail | undefined {
  const record = readOutputRecord(output);
  if (!record) return undefined;
  const relativePath = readRelativePath(record.path);
  const startLine = readInteger(record.startLine);
  const endLine = readInteger(record.endLine);
  const totalLines = readInteger(record.totalLines);
  if (relativePath === undefined || startLine === undefined || endLine === undefined || totalLines === undefined) return undefined;
  const returnedLines = Math.max(0, endLine - startLine + 1);
  return {
    kind: "read_file",
    path: relativePath,
    startLine,
    endLine: returnedLines > 0 ? endLine : null,
    totalLines,
    returnedLines,
    truncated: record.truncated === true,
  };
}

/** 从 glob_files 的受控结果投影受限相对路径列表。 */
function projectGlobDetail(output: unknown): ToolDisplayDetail | undefined {
  const record = readOutputRecord(output);
  if (!record || !Array.isArray(record.files)) return undefined;
  const paths: string[] = [];
  for (const value of record.files) {
    const relativePath = readRelativePath(value);
    if (relativePath !== undefined) paths.push(relativePath);
  }
  const bounded = takeWithinDisplayBudget(paths);
  const totalCount = readInteger(record.total);
  const executionTruncated = record.executionTruncated === true || (record.executionTruncated !== false && record.truncated === true && totalCount === undefined);
  return {
    kind: "glob_files",
    paths: bounded.items,
    shownCount: bounded.items.length,
    ...(totalCount === undefined ? {} : { totalCount }),
    executionTruncated,
    ...(bounded.truncated ? { displayTruncated: true as const } : {}),
  };
}

/** 按文件分组 grep content 的命中行；context 行与匹配文本一律丢弃，同一行只计一次。 */
function projectGrepContentDetail(matches: unknown[], total: number | undefined, executionTruncated: boolean): ToolDisplayDetail {
  const linesByPath = new Map<string, Set<number>>();
  for (const entry of matches) {
    const record = readOutputRecord(entry);
    if (!record || record.kind !== "match") continue;
    const relativePath = readRelativePath(record.path);
    const line = readInteger(record.line);
    if (relativePath === undefined || line === undefined) continue;
    const lines = linesByPath.get(relativePath) ?? new Set<number>();
    lines.add(line);
    linesByPath.set(relativePath, lines);
  }
  const groupedWithLineLimit = [...linesByPath.entries()]
    .map(function toFileGroup([relativePath, lines]) {
      const allLineNumbers = [...lines].sort(function byLineNumber(left, right) { return left - right; });
      const lineNumbers = allLineNumbers.slice(0, MAX_DISPLAY_LINE_NUMBERS_PER_FILE);
      return { path: relativePath, matchedLineCount: lineNumbers.length, lineNumbers, lineNumbersTruncated: lineNumbers.length < allLineNumbers.length };
    })
    .sort(function byPath(left, right) { return left.path.localeCompare(right.path); });
  const grouped = groupedWithLineLimit.map(function dropInternalTruncationFlag(file) {
    return { path: file.path, matchedLineCount: file.matchedLineCount, lineNumbers: file.lineNumbers };
  });
  const bounded = takeWithinDisplayBudget(grouped);
  return {
    kind: "grep_content",
    files: bounded.items,
    shownMatchedLineCount: bounded.items.reduce(function sumMatchedLines(sum, file) { return sum + file.matchedLineCount; }, 0),
    ...(total === undefined ? {} : { totalMatchedLineCount: total }),
    executionTruncated,
    ...(bounded.truncated || groupedWithLineLimit.some(function hasTruncatedLineNumbers(file) { return file.lineNumbersTruncated; }) ? { displayTruncated: true as const } : {}),
  };
}

/** 投影 files_with_matches 的相对路径列表；不伪造每文件匹配数或行号。 */
function projectGrepPathsDetail(matches: unknown[], total: number | undefined, executionTruncated: boolean): ToolDisplayDetail {
  const paths: string[] = [];
  for (const entry of matches) {
    const record = readOutputRecord(entry);
    const relativePath = record ? readRelativePath(record.path) : undefined;
    if (relativePath !== undefined) paths.push(relativePath);
  }
  const bounded = takeWithinDisplayBudget(paths);
  return {
    kind: "grep_paths",
    paths: bounded.items,
    shownCount: bounded.items.length,
    ...(total === undefined ? {} : { totalCount: total }),
    executionTruncated,
    ...(bounded.truncated ? { displayTruncated: true as const } : {}),
  };
}

/** 投影 count 模式的每文件计数；不伪造行号。 */
function projectGrepCountsDetail(matches: unknown[], total: number | undefined, executionTruncated: boolean): ToolDisplayDetail {
  const files: Array<{ path: string; count: number }> = [];
  for (const entry of matches) {
    const record = readOutputRecord(entry);
    if (!record) continue;
    const relativePath = readRelativePath(record.path);
    const count = readInteger(record.count);
    if (relativePath === undefined || count === undefined) continue;
    files.push({ path: relativePath, count });
  }
  const bounded = takeWithinDisplayBudget(files);
  return {
    kind: "grep_counts",
    files: bounded.items,
    shownFileCount: bounded.items.length,
    ...(total === undefined ? {} : { totalFileCount: total }),
    executionTruncated,
    ...(bounded.truncated ? { displayTruncated: true as const } : {}),
  };
}

/** grep_files 必须先按 mode 分支，不能用单一数组形状猜测结果语义。 */
function projectGrepDetail(output: unknown): ToolDisplayDetail | undefined {
  const record = readOutputRecord(output);
  if (!record || !Array.isArray(record.matches)) return undefined;
  const total = readInteger(record.total);
  const executionTruncated = record.executionTruncated === true || (record.executionTruncated !== false && record.truncated === true && total === undefined);
  if (record.mode === "content") return projectGrepContentDetail(record.matches, total, executionTruncated);
  if (record.mode === "files_with_matches") return projectGrepPathsDetail(record.matches, total, executionTruncated);
  if (record.mode === "count") return projectGrepCountsDetail(record.matches, total, executionTruncated);
  return undefined;
}

/** 从 web_search 结果投影数量与裁剪状态，不复制 query、回答、标题、摘要或 URL。 */
function projectWebSearchDetail(output: unknown): ToolDisplayDetail | undefined {
  const record = readOutputRecord(output);
  if (!record || !Array.isArray(record.sources)) return undefined;
  return {
    kind: "web_search",
    sourceCount: record.sources.length,
    truncated: record.truncated === true,
  };
}

/** 从 web_fetch 结果只投影最终域名、内容类型与裁剪状态，不复制网页正文。 */
function projectWebFetchDetail(output: unknown): ToolDisplayDetail | undefined {
  const record = readOutputRecord(output);
  if (!record || typeof record.finalUrl !== "string" || typeof record.contentType !== "string") return undefined;
  try {
    const parsed = new URL(record.finalUrl);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return undefined;
    return {
      kind: "web_fetch",
      host: parsed.hostname.toLowerCase(),
      contentType: record.contentType.slice(0, 128),
      truncated: record.truncated === true,
    };
  } catch {
    return undefined;
  }
}

/** 按可信 toolName 选择专用 projector；只有成功执行的受控 serialized output 才会进入。 */
function createToolDisplayDetail(toolName: string, output: unknown): ToolDisplayDetail | undefined {
  if (toolName === "read_file") return projectReadDetail(output);
  if (toolName === "glob_files") return projectGlobDetail(output);
  if (toolName === "grep_files") return projectGrepDetail(output);
  if (toolName === "web_search") return projectWebSearchDetail(output);
  if (toolName === "web_fetch") return projectWebFetchDetail(output);
  return undefined;
}

/** 由专用明细生成安全的目标与摘要，使收起行不再只显示 read/discover/search 这类类别词。 */
function describeToolDisplayDetail(detail: ToolDisplayDetail): { target?: string; summary: string } {
  switch (detail.kind) {
    case "read_file":
      return {
        target: detail.path,
        summary: detail.endLine === null
          ? `未读取到内容 · 共 ${detail.totalLines} 行`
          : `已读取第 ${detail.startLine}–${detail.endLine} 行 · 共 ${detail.totalLines} 行`,
      };
    case "glob_files":
      if (detail.shownCount === 0) return { summary: "未发现文件" };
      if (detail.executionTruncated) return { summary: `显示 ${detail.shownCount} 个路径，结果已截断` };
      if (detail.totalCount !== undefined && detail.totalCount > detail.shownCount) return { summary: `显示 ${detail.shownCount} 个路径，共 ${detail.totalCount} 个` };
      return { summary: `发现 ${detail.shownCount} 个路径` };
    case "grep_content":
      if (detail.files.length === 0) return { summary: "未找到匹配" };
      return { summary: `${detail.files.length} 个文件命中 ${detail.shownMatchedLineCount} 行${detail.executionTruncated ? "，结果已截断" : detail.totalMatchedLineCount !== undefined && detail.totalMatchedLineCount > detail.shownMatchedLineCount ? `，当前显示 ${detail.shownMatchedLineCount}/${detail.totalMatchedLineCount} 行` : ""}` };
    case "grep_paths":
      if (detail.shownCount === 0) return { summary: "未找到匹配" };
      return { summary: `${detail.shownCount} 个文件命中${detail.executionTruncated ? "，结果已截断" : detail.totalCount !== undefined && detail.totalCount > detail.shownCount ? `，当前显示 ${detail.shownCount}/${detail.totalCount} 个` : ""}` };
    case "grep_counts":
      if (detail.files.length === 0) return { summary: "未找到匹配" };
      return { summary: `${detail.files.length} 个文件命中${detail.executionTruncated ? "，结果已截断" : detail.totalFileCount !== undefined && detail.totalFileCount > detail.shownFileCount ? `，当前显示 ${detail.shownFileCount}/${detail.totalFileCount} 个文件` : ""}` };
    case "web_search":
      return { summary: detail.sourceCount === 0 ? "搜索服务未返回结构化引用" : `找到 ${detail.sourceCount} 个公开来源${detail.truncated ? "，结果已截断" : ""}` };
    case "web_fetch":
      return { target: detail.host, summary: `已读取 ${detail.contentType}${detail.truncated ? "，内容已截断" : ""}` };
    default: {
      const exhaustive: never = detail;
      return exhaustive;
    }
  }
}

/** 从后台启动 ActionFacts 提取受限 executable basename；不允许目录、参数或自由文本进入展示协议。 */
function createSafeProgramLabel(facts: ToolActionFacts): string | undefined {
  if (facts.toolName !== "start_background_job") return undefined;
  const program = facts.approval?.preview?.program;
  if (typeof program !== "string") return undefined;
  const basename = program.trim().split(/[\\/]/u).pop()?.replace(/\.(cmd|exe)$/iu, "").toLowerCase();
  if (!basename || !/^[a-z0-9][a-z0-9._+-]{0,63}$/u.test(basename)) return undefined;
  return basename;
}

/** 从四个 Job 工具的受控 serialized output 与 ActionFacts 提取有限身份/状态事实。 */
function createJobDisplayFacts(facts: ToolActionFacts, output: unknown): ToolJobDisplayFacts | undefined {
  if (!output || typeof output !== "object") return undefined;
  const record = output as Record<string, unknown>;
  const action = facts.toolName === "start_background_job" ? "start" : facts.toolName === "list_background_jobs" ? "list" : facts.toolName === "read_background_job" ? "read" : facts.toolName === "stop_background_job" ? "stop" : undefined;
  if (!action) return undefined;
  if (action === "list") {
    return { action, observedCount: Array.isArray(record.jobs) ? record.jobs.length : 0, hasMore: typeof record.nextPageCursor === "string" };
  }
  const candidate = action === "read" && record.job && typeof record.job === "object" ? record.job as Record<string, unknown> : record;
  const statuses = new Set(["starting", "running", "stopping", "completed", "failed", "stopped", "interrupted"]);
  if (typeof candidate.jobId !== "string" || !statuses.has(candidate.status as string)) return undefined;
  const programLabel = action === "start" ? createSafeProgramLabel(facts) : undefined;
  return {
    action,
    jobId: candidate.jobId,
    ...(programLabel ? { programLabel } : {}),
    observedStatus: candidate.status as ToolJobDisplayFacts["observedStatus"],
    waitOutcome: action === "read" && (record.waitOutcome === "snapshot" || record.waitOutcome === "terminal" || record.waitOutcome === "timeout") ? record.waitOutcome : undefined,
  };
}

/** 将 Job 专用事实转换为固定摘要，避免把进程输出或命令重建到展示层。 */
function describeJobDisplayFacts(job: ToolJobDisplayFacts): { target?: string; summary: string; metrics?: ToolDisplayFacts["metrics"] } {
  if (job.action === "list") return { summary: `查看了 ${job.observedCount ?? 0} 个后台任务`, metrics: { count: job.observedCount ?? 0, hasMore: job.hasMore === true } };
  if (job.action === "start") return { target: job.programLabel ?? job.jobId, summary: `${job.programLabel && job.jobId ? `${job.jobId} · ` : ""}当前状态：${job.observedStatus}` };
  if (job.action === "stop") return { target: job.jobId, summary: `后台任务停止结果：${job.observedStatus}` };
  return { target: job.jobId, summary: `后台任务状态：${job.observedStatus}`, metrics: job.waitOutcome ? { waitOutcome: job.waitOutcome } : undefined };
}

/** 从工具本地生成的 ActionFacts 构造展示层可消费的安全事实。 */
function createToolDisplayFacts(facts: ToolActionFacts, metrics?: ToolDisplayFacts["metrics"], output?: unknown): ToolDisplayFacts {
  const diff = getEditDiffFacts(facts, output);
  // 只有成功执行才会传入 output；审批、拒绝与运行中阶段继续只提供通用类别事实。
  const detail = output === undefined ? undefined : createToolDisplayDetail(facts.toolName, output);
  const described = detail ? describeToolDisplayDetail(detail) : undefined;
  const job = output === undefined ? undefined : createJobDisplayFacts(facts, output);
  const describedJob = job ? describeJobDisplayFacts(job) : undefined;
  const programLabel = createSafeProgramLabel(facts);
  return {
    titleKey: getToolDisplayTitleKey(facts.toolName),
    target: describedJob?.target ?? described?.target ?? programLabel ?? facts.resource,
    summary: describedJob?.summary ?? described?.summary ?? facts.operation,
    ...(describedJob?.metrics ?? metrics ? { metrics: { ...metrics, ...describedJob?.metrics } } : {}),
    ...(detail ? { detail } : {}),
    ...(job ? { job } : {}),
    ...(diff ? { diff } : {}),
  };
}

/** 从权限结果创建短时审批请求，预览由工具提供且不包含原始敏感内容。 */
function createApprovalRequest(
  request: ToolExecutionRequest,
  inputHash: string,
  constraint: string,
  policy: ToolPolicyResult,
  facts: ToolActionFacts,
): ToolApprovalRequest {
  const allowedDecisions = policy.allowedApprovalDecisions ?? ["allow_once", "deny"];
  return {
    approvalId: randomUUID(),
    callId: request.callId,
    toolName: request.toolName,
    normalizedInputHash: inputHash,
    constraint,
    reason: policy.reason,
    risk: policy.risk ?? "unknown",
    preview: policy.preview ?? {},
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    allowedDecisions,
    ...(facts.taskFileSet?.length ? { taskFileSet: facts.taskFileSet } : {}),
    display: {
      operation: facts.operation,
      effect: facts.effect,
      destructive: facts.destructive,
      resource: facts.resource,
      risk: facts.risk,
      actionPreview: createSafeActionPreview(facts),
      ...(facts.commandCwd ? { cwd: facts.commandCwd } : {}),
      // 命令声明外部效果但没有精确目标声明：修改范围无法精确限定，展示层不得宣称"仅覆盖精确目标"。
      ...(facts.operation === "command" && facts.effect === "external" && !facts.externalExecutionTarget ? { unknownScope: true } : {}),
      allowedDecisions,
    },
  };
}

/** 构造取消终态，供 P3 checkpoint 判断是否能安全重试。 */
function createCancelledResult(
  request: ToolExecutionRequest,
  inputHash: string,
  durationMs: number,
  reason: string,
  phase: ToolInterruptionState["phase"],
  sideEffectState: ToolInterruptionState["sideEffectState"]
): {
  status: "cancelled";
  callId: string;
  toolName: string;
  error: { code: string; message: string };
  meta: { durationMs: number; inputHash: string };
  interruption: ToolInterruptionState;
} {
  const interruption: ToolInterruptionState = {
    phase,
    normalizedInputHash: inputHash,
    sideEffectState,
    safeToRetry: sideEffectState === "not_started",
    reason,
  };
  return {
    status: "cancelled",
    callId: request.callId,
    toolName: request.toolName,
    error: { code: TOOL_ERROR_CODES.EXECUTION_CANCELLED, message: reason },
    meta: { durationMs, inputHash },
    interruption,
  };
}

/** 构造工具自身超时终态；超时后的副作用是否完成无法可靠判断，因此禁止自动重试。 */
function createTimeoutResult(request: ToolExecutionRequest, inputHash: string, durationMs: number, reason: string): ToolTimeoutResult {
  const interruption: ToolInterruptionState = { phase: "executing", normalizedInputHash: inputHash, sideEffectState: "unknown", safeToRetry: false, reason };
  return {
    status: "timeout",
    callId: request.callId,
    toolName: request.toolName,
    error: { code: TOOL_ERROR_CODES.EXECUTION_TIMEOUT, message: reason },
    meta: { durationMs, inputHash },
    interruption,
  };
}

/** 组合 Runtime 取消与 metadata 超时；超时仅中止当前工具，不替代上层 Runtime 的 AbortSignal。 */
function createExecutionDeadline(signal: AbortSignal | undefined, timeoutMs: number | undefined): { signal: AbortSignal | undefined; timedOut: () => boolean; cleanup: () => void } {
  if (!timeoutMs) return { signal, timedOut: () => false, cleanup: () => undefined };
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export class ToolExecutor {
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly policyEngine = new PolicyEngine();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly context: ToolExecutionContext,
  ) {}

  /** Kernel 在任何执行展示前预检；Executor 实际调用仍独立复查产品上限及引用。 */
  async preflight(request: ToolExecutionRequest, signal?: AbortSignal): Promise<Extract<ToolExecutionResult, { status: "error" }> | undefined> {
    try {
      if (!isToolWithinCeiling(this.context.capabilityCeiling, request.toolName)) throw createToolError(TOOL_ERROR_CODES.CHAT_TOOL_FORBIDDEN, "产品模式禁止此工具");
      const definition = this.registry.get(request.toolName);
      // 脱敏 Web 参数由 Kernel 的恢复分支闭合，绝不进入实际执行。
      if ((request.toolName === "web_search" || request.toolName === "web_fetch") && (request.input as { redacted?: boolean })?.redacted === true) return undefined;
      const parsed = definition.inputSchema.safeParse(request.input);
      if (!parsed.success) throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "工具参数不符合 Schema");
      await definition.validateInput?.(parsed.data, { ...this.context, signal });
      return undefined;
    } catch (error) {
      return { status: "error", callId: request.callId, toolName: request.toolName, error: toToolError(error) };
    }
  }

  /** 执行单次工具调用；所有校验、审批、异常与中止都会转换为结构化终态。 */
  async execute(request: ToolExecutionRequest, options: ToolExecutionOptions = {}): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    let inputHash = "";
    let timeoutMs = options.timeoutMs;
    let deadline: ReturnType<typeof createExecutionDeadline> | undefined;
    let display: ToolDisplayFacts | undefined;
    try {
      if (!request.callId || !request.toolName) {
        throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "callId 和 toolName 均为必填项");
      }
      if (!isToolWithinCeiling(this.context.capabilityCeiling, request.toolName)) throw createToolError(TOOL_ERROR_CODES.CHAT_TOOL_FORBIDDEN, "产品模式禁止此工具");
      const definition = this.registry.get(request.toolName);
      timeoutMs ??= definition.metadata.timeout?.defaultMs;
      const parsed = definition.inputSchema.safeParse(request.input);
      if (!parsed.success) {
        emitToolEvent(this.context, { type: "tool_validation_failed", callId: request.callId, toolName: request.toolName, errorCode: TOOL_ERROR_CODES.INVALID_INPUT });
        throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "工具参数不符合 Schema");
      }
      inputHash = hashInput(parsed.data);
      deadline = createExecutionDeadline(options.signal ?? this.context.signal, timeoutMs);
      const signal = deadline.signal;
      if (signal?.aborted) {
        const result = createCancelledResult(request, inputHash, Date.now() - startedAt, "用户已取消工具调用", "before_execution", "not_started");
        emitToolEvent(this.context, { type: "tool_cancelled", callId: request.callId, toolName: request.toolName, inputHash, status: result.status, durationMs: result.meta.durationMs, errorCode: result.error.code });
        return result;
      }

      const policyContext = { ...this.context, signal };
      await definition.validateInput?.(parsed.data, policyContext);
      const facts = await definition.createActionFacts(parsed.data, policyContext);
      display = createToolDisplayFacts(facts);
      // Stage 3/4：run_command（前台）与 start_background_job（后台）是仅有的两个进程类
      // 入口。先解析沙箱执行范围：绑定缺失或能力不可执行都得到 undefined，evaluate 时以
      // available:false fail-closed（G3/G7），不转普通审批，更不裸跑。其他工具不注入沙箱
      // 事实，行为与本字段引入前一致。
      const sandboxEligible = request.toolName === "run_command" || request.toolName === "start_background_job";
      // 进程类工具先解析沙箱执行范围。探测只读 status 不启动目标命令，重试安全；
      // 最多 3 次尝试，仍失败按模式分流（CR 20261016 R2 fail-closed）：read-only 与
      // workspace-write 一律 fail-closed deny——沙箱不可用即不存在受控执行通道，无法
      // 证明授权状态保护与外部写门禁，无沙箱直执不提供任何权限豁免；只有 danger-full-access
      // 由宿主配置明确授权无隔离，直接执行不经过沙箱失败流程。
      let sandboxScope: SandboxExecutionScope | undefined;
      let sandboxDiagnostics: string[] = [];
      let directSandboxBypass = false;
      if (sandboxEligible) {
        for (let attempt = 1; attempt <= SANDBOX_START_MAX_ATTEMPTS; attempt++) {
          const probe = await this.resolveSandboxProbe();
          if (probe.scope) {
            sandboxScope = probe.scope;
            break;
          }
          sandboxDiagnostics = probe.diagnostics;
        }
      }
      const externalAuthority = this.context.externalExecutionAuthority;
      if (facts.externalExecutionTarget && this.context.sandbox?.mode === "read-only") throw createToolError("SANDBOX_POLICY_DENIED", "只读沙箱不接受外部写请求");
      if (facts.externalExecutionTarget && !this.context.externalExecutionAuthority) throw createToolError("SANDBOX_UNAVAILABLE", "未绑定真实外部执行审批权威，目标命令未启动");
      let executionAuthorization: ExternalExecutionAuthorization | null = facts.externalExecutionTarget
        ? await callExecutionAuthority(async function authorizeGrant() { return externalAuthority!.authorize({ toolName: request.toolName, input: parsed.data, callId: request.callId, inputHash, constraint: facts.stableConstraint! }); }) : null;
      let sandboxFacts: { available: boolean } | undefined;
      if (sandboxEligible && !sandboxScope) {
        const sandboxMode = this.context.sandbox?.mode;
        if (sandboxMode === "danger-full-access") {
          directSandboxBypass = true;
          // danger-full-access 是宿主可信配置的明确无隔离授权：执行决策不因沙箱底座故障改变
          // （与沙箱可用时的放行行为一致）。available 仅供 PolicyEngine 维持该一致性；
          // 执行层仍以 override 直接执行，结果 enforcement=unavailable，展示层不得宣称隔离。
          sandboxFacts = { available: true };
        }
      }
      if (sandboxEligible && !sandboxFacts && !directSandboxBypass) sandboxFacts = { available: sandboxScope !== undefined };
      // R5：进程类调用把实际执行方式与脱敏诊断冻结为结构化展示事实（sandboxed/unisolated/unavailable）。
      // deny 不再把诊断拼接进 error.message；Web/TUI/Plain/JSONL/历史共用同一份事实，
      // 展示层不得把 unisolated/unavailable 宣称隔离。
      if (sandboxEligible && display) {
        display = {
          ...display,
          executionMode: sandboxScope ? "sandboxed" : directSandboxBypass ? "unisolated" : "unavailable",
          ...(!sandboxScope && !directSandboxBypass && sandboxDiagnostics.length ? { diagnostics: sandboxDiagnostics } : {}),
        };
      }
      const grantMatched = facts.externalExecutionTarget ? executionAuthorization !== null : this.policyEngine.canUsePersistentGrant(policyContext, facts)
        && await policyContext.resolvePersistentGrant?.({ toolName: request.toolName, inputHash, input: parsed.data, constraint: facts.stableConstraint, risk: facts.risk }) === true;
      const policy = this.policyEngine.evaluate({ context: policyContext, metadata: definition.metadata, facts, grantMatched, ...(sandboxFacts ? { sandbox: sandboxFacts } : {}) });
      if (policy.decision === "deny") {
        // R5：诊断已提升为 display.diagnostics 结构化事实；消息保持策略原因本身，不重复拼接。
        const error = { code: policy.errorCode ?? TOOL_ERROR_CODES.COMMAND_FORBIDDEN, message: policy.reason };
        emitToolEvent(this.context, { type: "tool_denied", callId: request.callId, toolName: request.toolName, inputHash, status: "denied", errorCode: error.code });
        return { status: "denied", callId: request.callId, toolName: request.toolName, error, display };
      }
      if (request.approval?.decision === "deny") {
        const error = { code: TOOL_ERROR_CODES.APPROVAL_REQUIRED, message: "用户拒绝执行本次工具调用" };
        emitToolEvent(this.context, { type: "tool_denied", callId: request.callId, toolName: request.toolName, inputHash, status: "denied", errorCode: error.code });
        return { status: "denied", callId: request.callId, toolName: request.toolName, error, display };
      }
      if (policy.decision === "approval_required" && this.context.capabilityCeiling?.productMode === "chat") {
        throw createToolError(TOOL_ERROR_CODES.CHAT_TOOL_FORBIDDEN, "Chat 不支持需要审批的工具操作");
      }
      // 即使命中持久grant，携带的原审批也必须消费；不能留下未消费凭证在撤权后复活。
      if (facts.externalExecutionTarget && request.approval) executionAuthorization = await callExecutionAuthority(async function consumeApprovedExecution() { return externalAuthority!.authorize({ toolName: request.toolName, input: parsed.data, callId: request.callId, inputHash, constraint: facts.stableConstraint!, approval: request.approval }); });
      let consumed = true;
      if (policy.decision === "approval_required") {
        if (facts.externalExecutionTarget) {
          consumed = executionAuthorization !== null;
        } else consumed = await this.consumeApproval(request, inputHash, policy.allowedApprovalDecisions, policy.constraint);
      }
      if (policy.decision === "approval_required" && !consumed) {
        const approval = createApprovalRequest(request, inputHash, policy.constraint ?? inputHash, policy, facts);
        if (facts.externalExecutionTarget) await callExecutionAuthority(async function freezeExecution() { await externalAuthority!.freeze({ approval, input: parsed.data }); });
        this.pendingApprovals.set(approval.approvalId, { request: approval });
        emitToolEvent(this.context, { type: "tool_approval_required", callId: request.callId, toolName: request.toolName, inputHash, status: "approval_required" });
        return { status: "approval_required", callId: request.callId, toolName: request.toolName, approval, display };
      }
      if (facts.externalExecutionTarget && request.approval) this.pendingApprovals.delete(request.approval.approvalId);
      // Talk-Plan1013 Stage5 R5：审批消费后、执行前重查最新外部限制；批准后新增的 deny 必须使执行失败。
      if (facts.externalTarget && request.approval && consumed) await this.assertLatestExternalRestrictionAllowed(facts);
      if (policy.decision === "allow" && facts.requiresApproval) {
        emitToolEvent(this.context, { type: "tool_auto_approved", callId: request.callId, toolName: request.toolName, inputHash });
      }

      emitToolEvent(this.context, { type: "tool_start", callId: request.callId, toolName: request.toolName, inputHash });
      if (facts.externalExecutionTarget) {
        if (!sandboxScope || !executionAuthorization) throw createToolError("SANDBOX_UNAVAILABLE", "外部执行能力不可验证");
        sandboxScope.policy = { ...sandboxScope.policy, externalWriteCapability: issueExternalWriteCapability({ target: facts.externalExecutionTarget, toolName: request.toolName, callId: request.callId, inputHash, authorization: executionAuthorization }) };
      }
      const output = await definition.execute(parsed.data, {
        ...this.context,
        signal,
        toolCallId: request.callId,
        webFetchRedirectsRemaining: getWebFetchRedirectBudget(request.input),
        ...(sandboxScope ? { sandboxPolicy: sandboxScope } : {}),
        ...(directSandboxBypass ? { sandboxExecutionOverride: "direct" as const } : {}),
        // Talk-Plan1013 Stage5 R3：外部文件修改授权绑定——到达此处必已过外部 gate（deny 已拒绝、
        // 未消费审批已返回 approval_required），绑定由 facts 的 canonical 身份生成，模型不可构造；
        // write_file/edit_file 在目标锁内比较当前 canonical 目标与操作，失配即停止。
        ...(facts.externalMutation === true && facts.externalTarget ? {
          fileMutationAuthorization: {
            canonicalTarget: facts.externalTarget.canonicalTarget,
            canonicalWorkspace: facts.externalTarget.canonicalWorkspace,
            operation: facts.operation,
            constraint: facts.stableConstraint!,
          },
        } : {}),
        ...(options.onProgress ? { onToolProgress: function forwardToolProgress(chunk: string): void { options.onProgress?.(request.callId, chunk); } } : {}),
      });
      if (deadline.timedOut()) {
        const result = createTimeoutResult(request, inputHash, Date.now() - startedAt, "工具执行超过 metadata 声明的超时限制");
        emitToolEvent(this.context, { type: "tool_error", callId: request.callId, toolName: request.toolName, inputHash, status: result.status, durationMs: result.meta.durationMs, errorCode: result.error.code });
        return { ...result, display };
      }
      const serialized = definition.serializeOutput(output);
      const outputBytes = Buffer.byteLength(JSON.stringify(serialized), "utf8");
      const truncated = Boolean(serialized && typeof serialized === "object" && "truncated" in serialized && (serialized as { truncated?: unknown }).truncated);
      const meta = { durationMs: Date.now() - startedAt, inputHash, outputBytes, truncated };
      const interactionResult = definition.createExecutionResult?.(parsed.data, output, { callId: request.callId, toolName: request.toolName, inputHash, meta });
      if (interactionResult) {
        emitToolEvent(this.context, { type: "tool_result", callId: request.callId, toolName: request.toolName, inputHash, status: interactionResult.status, durationMs: meta.durationMs, outputBytes, truncated });
        return interactionResult;
      }
      emitToolEvent(this.context, { type: "tool_result", callId: request.callId, toolName: request.toolName, inputHash, status: "success", durationMs: meta.durationMs, outputBytes, truncated });
      const resultDisplay = createToolDisplayFacts(facts, { durationMs: meta.durationMs, outputBytes, truncated }, serialized);
      return {
        status: "success",
        callId: request.callId,
        toolName: request.toolName,
        output: serialized,
        meta,
        // R5：成功终态同样携带进程类的结构化执行方式（sandboxed/unisolated），展示层不得宣称隔离。
        display: display?.executionMode
          ? { ...resultDisplay, executionMode: display.executionMode, ...(display.diagnostics?.length ? { diagnostics: display.diagnostics } : {}) }
          : resultDisplay,
      };
    } catch (error) {
      if (error instanceof WebFetchRedirect && this.context.capabilityCeiling?.productMode === "chat") {
        return { status: "error", callId: request.callId, toolName: request.toolName, error: { code: TOOL_ERROR_CODES.WEB_URL_BLOCKED, message: "Chat 不允许需要额外审批的网页重定向" } };
      }
      if (error instanceof WebFetchRedirect && request.toolName === "web_fetch" && !deadline?.timedOut()) {
        const remainingMs = timeoutMs === undefined ? undefined : Math.max(1, timeoutMs - (Date.now() - startedAt));
        const result = await this.execute({ ...request, input: error.input, approval: undefined }, { ...options, timeoutMs: remainingMs });
        bindWebFetchRedirect(result, error.input);
        return result;
      }
      // CR 20261016 R4：沙箱 prepare 重试耗尽（目标命令确定未启动）按 R2 fail-closed 语义
      // deny 终态化，不作为普通工具错误回到模型；附逐次脱敏诊断供环境阻塞与用户拒绝区分。
      if (error instanceof SandboxPrepareExhaustedError) {
        const message = `沙箱包装在 ${SANDBOX_START_MAX_ATTEMPTS} 次尝试后仍不可用，目标命令未启动；诊断：${error.diagnostics.join("；")}`;
        emitToolEvent(this.context, { type: "tool_denied", callId: request.callId, toolName: request.toolName, inputHash, status: "denied", errorCode: error.code });
        return { status: "denied", callId: request.callId, toolName: request.toolName, error: { code: error.code, message }, display };
      }
      const safeError = toToolError(error);
      const durationMs = Date.now() - startedAt;
      if (deadline?.timedOut()) {
        const result = createTimeoutResult(request, inputHash, durationMs, "工具执行超过 metadata 声明的超时限制");
        emitToolEvent(this.context, { type: "tool_error", callId: request.callId, toolName: request.toolName, inputHash, status: result.status, durationMs, errorCode: result.error.code });
        return { ...result, display };
      }
      if (safeError.code === TOOL_ERROR_CODES.EXECUTION_CANCELLED) {
        const result = createCancelledResult(request, inputHash, durationMs, safeError.message, "executing", "unknown");
        emitToolEvent(this.context, { type: "tool_cancelled", callId: request.callId, toolName: request.toolName, inputHash, status: result.status, durationMs, errorCode: safeError.code });
        return { ...result, display };
      }
      if (safeError.code === TOOL_ERROR_CODES.EXECUTION_TIMEOUT) {
        const interruption: ToolInterruptionState = { phase: "executing", normalizedInputHash: inputHash, sideEffectState: "unknown", safeToRetry: false, reason: safeError.message };
        const meta = { durationMs, inputHash };
        emitToolEvent(this.context, { type: "tool_error", callId: request.callId, toolName: request.toolName, inputHash, status: "timeout", durationMs, errorCode: safeError.code });
        return { status: "timeout", callId: request.callId, toolName: request.toolName, error: safeError, meta, interruption, display };
      }
      emitToolEvent(this.context, { type: "tool_error", callId: request.callId, toolName: request.toolName, inputHash, status: "error", durationMs, errorCode: safeError.code });
      return { status: "error", callId: request.callId, toolName: request.toolName, error: safeError, meta: inputHash ? { durationMs, inputHash } : undefined, display };
    } finally {
      deadline?.cleanup();
    }
  }

  /** 解析进程类工具（run_command/start_background_job）的沙箱执行范围；绑定缺失或能力不可执行时 scope 为 undefined，并保留脱敏诊断供拒绝/降级展示。 */
  private async resolveSandboxProbe(): Promise<{ scope: SandboxExecutionScope | undefined; diagnostics: string[] }> {
    const binding = this.context.sandbox;
    if (!binding) return { scope: undefined, diagnostics: ["未绑定沙箱执行底座"] };
    let capability: import("../../runtime/domain/sandbox-policy").SandboxCapabilityReport;
    try {
      capability = await binding.port.status();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { scope: undefined, diagnostics: [`status 探测失败：${message}`] };
    }
    const resolution = resolveSandboxPolicy({
      mode: binding.mode,
      workspaceRoot: this.context.workspaceRoot,
      tempRoot: binding.tempRoot,
      capability,
      permissionMode: this.context.permissionMode,
      workspaceTrusted: this.context.workspaceTrusted === true,
    });
    if (!resolution.executable) {
      return { scope: undefined, diagnostics: [`能力报告：backend=${capability.backend}，enforcement=${capability.enforcement}`, ...(capability.diagnostics ?? [])] };
    }
    return { scope: { port: binding.port, policy: resolution.policy }, diagnostics: [] };
  }

  /** 校验并消费一次性审批，阻止批准 A 后用同一 approval 执行 B；constraint 复核防止链接切换转移授权目标。
   * softMismatch 为 true 时不抛错而是返回 false（降级路径据此重新弹卡，零执行）。 */
  private async consumeApproval(request: ToolExecutionRequest, inputHash: string, allowedDecisions?: ToolApprovalDecision[], expectedConstraint?: string, softMismatch = false): Promise<boolean> {    if (!request.approval) return false;
    if (allowedDecisions && !allowedDecisions.includes(request.approval.decision)) {
      if (softMismatch) return false;
      throw createToolError(TOOL_ERROR_CODES.APPROVAL_MISMATCH, "审批决定不在当前 Policy 冻结的允许范围内");
    }
    const pending = this.pendingApprovals.get(request.approval.approvalId)?.request;
    if (!pending && this.context.validateApproval) {
      // Talk-Plan1013 Stage5 R2：恢复路径（pending 为空，如进程重启/新建 Executor）同样核对当前
      // constraint 与 TTL，并由 Runtime 权威链持久原子消费；重复消费与链接切换转移目标均拒绝。
      const valid = await this.context.validateApproval({
        approvalId: request.approval.approvalId,
        decision: request.approval.decision,
        callId: request.callId,
        toolName: request.toolName,
        inputHash,
        ...(expectedConstraint ? { constraint: expectedConstraint } : {}),
      });
      if (!valid) {
        if (softMismatch) return false;
        throw createToolError(TOOL_ERROR_CODES.APPROVAL_MISMATCH, "审批不存在、已过期或与当前工具输入不匹配");
      }
      return request.approval.decision !== "deny";
    }
    if (!pending) {
      if (softMismatch) return false;
      throw createToolError(TOOL_ERROR_CODES.APPROVAL_MISMATCH, "审批不存在或已被使用");
    }
    const expiresAt = Date.parse(pending.expiresAt);
    // Talk-Plan1013 Stage 1：审批期间目标链接被替换时，本次 facts 重解析出的 canonical 约束会与
    // 冻结审批的约束不一致；此时拒绝消费，防止 allow_once 授权经链接切换转移到新目标。
    const constraintMatches = !expectedConstraint || !pending.constraint || pending.constraint === expectedConstraint;
    const matches = pending.callId === request.callId
      && pending.toolName === request.toolName
      && pending.normalizedInputHash === inputHash
      && constraintMatches
      && Number.isFinite(expiresAt)
      && expiresAt > Date.now();
    if (!matches) {
      if (softMismatch) return false;
      throw createToolError(TOOL_ERROR_CODES.APPROVAL_MISMATCH, "审批已过期或与当前工具输入不匹配");
    }
    this.pendingApprovals.delete(pending.approvalId);
    // Talk-Plan1013 Stage5 R2：内存路径消费后，外部文件审批再经同一持久底座标记一次消费，
    // 避免同一进程内内存消费后跨进程重放（恢复路径只认持久消费标记）。
    // R1：降级审批同样持久一次认领，崩溃窗口与重复 continue 不得再次直执。
    if ((isExternalFileConstraint(pending.constraint) || isNoSandboxExecConstraint(pending.constraint)) && this.context.validateApproval) {
      const persisted = await this.context.validateApproval({
        approvalId: pending.approvalId,
        decision: request.approval.decision,
        callId: request.callId,
        toolName: request.toolName,
        inputHash,
        constraint: pending.constraint,
      });
      if (!persisted) {
        if (softMismatch) return false;
        throw createToolError(TOOL_ERROR_CODES.APPROVAL_MISMATCH, "审批已被消费或与当前调用不匹配");
      }
    }
    return true;
  }

  /** R5：审批消费后、执行前重查最新外部限制；批准后新增的 deny 必须使本次执行失败（锁内执行层复查由后续派工复用同一入口）。 */
  private async assertLatestExternalRestrictionAllowed(facts: ToolActionFacts): Promise<void> {
    const target = facts.externalTarget;
    if (!target || !this.context.resolveExternalRestriction) return;
    const latest = await this.context.resolveExternalRestriction({ workspaceRoot: target.canonicalWorkspace, toolName: facts.toolName, constraint: buildExternalConstraint(target.canonicalTarget) });
    if (latest === "deny") throw createToolError(TOOL_ERROR_CODES.COMMAND_FORBIDDEN, "该外部目标在批准后已被显式规则拒绝，本次执行已停止");
  }
}
