/**
 * grep_files 工具：在工作区硬边界内用 ripgrep 正则定位文本，并提供受限的内容、文件或计数结果。
 */
import { z } from "zod";
import { assertSearchTarget } from "../permissions/workspace-path";
import { resolveFileTarget, resolveExternalTargetRestriction } from "../permissions/path-access-policy";
import { assertRipgrepSucceeded, normalizeSearchPath, runRipgrep } from "../file-search";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import type { AgentToolDefinition } from "../types";

type GrepOutputMode = "content" | "files_with_matches" | "count";

interface GrepJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: unknown[];
  };
}

interface ContentMatch {
  path: string;
  line: number;
  text: string;
  kind: "match" | "context";
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_SERIALIZED_BYTES = 32 * 1024;
const MAX_LINE_CHARS = 500;
const DEFAULT_EXCLUDES = [
  "!**/.git/**",
  "!**/.svn/**",
  "!**/.hg/**",
  "!**/node_modules/**",
  "!**/.next/**",
  "!**/dist/**",
  "!**/coverage/**",
  "!**/.env",
  "!**/.env.{local,development,production,test}",
  "!**/.env.*.local",
  "!**/*.pem",
  "!**/*.key",
  "!**/credentials.json",
  "!**/.npmrc",
] as const;

const grepFilesSchema = z.object({
  pattern: z.string().min(1).max(2048),
  path: z.string().min(1).default("."),
  glob: z.string().min(1).max(512).optional(),
  outputMode: z.enum(["content", "files_with_matches", "count"]).default("content"),
  caseInsensitive: z.boolean().default(false),
  context: z.number().int().min(0).max(5).default(0),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.number().int().min(0).default(0),
}).strict();

/** 构造 grep_files 的 ripgrep argv，敏感文件不会进入内容结果。 */
function buildGrepArguments(input: z.infer<typeof grepFilesSchema>, targetPath: string): string[] {
  const args = [
    "--json",
    "--hidden",
    "--line-number",
    "--color",
    "never",
    "--max-columns",
    String(MAX_LINE_CHARS),
    "--max-columns-preview",
    "--regexp",
    input.pattern,
  ];
  if (input.caseInsensitive) args.push("--ignore-case");
  if (input.context > 0 && input.outputMode === "content") args.push("--context", String(input.context));
  if (input.glob) args.push("--glob", input.glob);
  for (const exclusion of DEFAULT_EXCLUDES) args.push("--glob", exclusion);
  args.push("--", targetPath);
  return args;
}

/** 解析 ripgrep JSONL，只保留匹配/上下文所需的安全字段。 */
function parseGrepEvents(stdout: string): {
  content: ContentMatch[];
  files: string[];
  counts: Array<{ path: string; count: number }>;
} {
  const content: ContentMatch[] = [];
  const fileNames = new Set<string>();
  const countByFile = new Map<string, number>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: GrepJsonEvent;
    try {
      event = JSON.parse(line) as GrepJsonEvent;
    } catch {
      continue;
    }
    if (event.type !== "match" && event.type !== "context") continue;
    const rawPath = event.data?.path?.text;
    const rawText = event.data?.lines?.text;
    const lineNumber = event.data?.line_number;
    if (!rawPath || !rawText || typeof lineNumber !== "number") continue;
    const filePath = normalizeSearchPath(rawPath);
    fileNames.add(filePath);
    if (event.type === "match") {
      const occurrenceCount = Math.max(1, event.data?.submatches?.length ?? 0);
      countByFile.set(filePath, (countByFile.get(filePath) ?? 0) + occurrenceCount);
    }
    content.push({
      path: filePath,
      line: lineNumber,
      text: rawText.replace(/\r?\n$/, "").slice(0, MAX_LINE_CHARS),
      kind: event.type,
    });
  }
  const files = [...fileNames].sort(function comparePaths(left, right) {
    return left.localeCompare(right);
  });
  const counts = [...countByFile.entries()]
    .map(function mapCount([filePath, count]) {
      return { path: filePath, count };
    })
    .sort(function compareCounts(left, right) {
      return left.path.localeCompare(right.path);
    });
  return { content, files, counts };
}

/** 在 32 KB 结构化输出预算内保留完整条目，避免截断 JSON 字段。 */
function applyOutputBudget<T>(items: T[]): { items: T[]; truncated: boolean } {
  const selected: T[] = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (selected.length > 0 ? 1 : 0);
    if (bytes + itemBytes > MAX_SERIALIZED_BYTES) return { items: selected, truncated: true };
    selected.push(item);
    bytes += itemBytes;
  }
  return { items: selected, truncated: false };
}

/** 根据输出模式选择分页结果，并统一返回截断状态。 */
function selectModeResults(
  mode: GrepOutputMode,
  parsed: ReturnType<typeof parseGrepEvents>,
  offset: number,
  limit: number,
  executionTruncated: boolean,
): Record<string, unknown> {
  const source = mode === "content" ? parsed.content : mode === "files_with_matches"
    ? parsed.files.map(function mapFile(filePath) { return { path: filePath }; })
    : parsed.counts;
  const page = source.slice(offset, offset + limit);
  const budgeted = applyOutputBudget(page);
  const outputTruncated = executionTruncated || budgeted.truncated;
  const hasMore = source.length > offset + limit;
  // content 的完整总量按命中行计，context 行不计入；其余模式按文件条目计。
  const total = mode === "content"
    ? parsed.content.filter(function isMatch(entry) { return entry.kind === "match"; }).length
    : source.length;
  return {
    mode,
    matches: budgeted.items,
    returned: budgeted.items.length,
    offset,
    // 保留旧字段兼容调用方，但由 total 是否存在区分“正常分页”与“执行/输出预算截断”。
    truncated: outputTruncated || hasMore,
    // ripgrep 与结构化输出都完整时，total 可证明；正常分页仍保留 total，便于 UI 说明当前页范围。
    ...(outputTruncated ? {} : { total }),
  };
}

/** 创建只读文件内容搜索工具定义。 */
export function createGrepFilesTool(): AgentToolDefinition<z.infer<typeof grepFilesSchema>, Record<string, unknown>> {
  return {
    name: "grep_files",
    description: "使用 ripgrep 正则搜索工作区文本。只知道函数名、组件名、错误文案或代码片段时先用本工具；默认不要通过 run_command 调用 grep、rg、find 或临时脚本。但用户明确要求执行某个命令时必须遵从原请求使用 run_command，不能用本工具绕过命令审批。默认返回相对路径、行号和短预览，也可返回 files_with_matches 或 count。结果截断时缩小 path、glob 或 pattern。",
    inputSchema: grepFilesSchema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 1, resourceKey: "workspace:file-search" }, retry: { safe: false } },
    async createActionFacts(input, context) {
      // Talk-Plan1013 Stage5 R5：外部搜索目标先查当前 Read 限制——deny 硬拒绝，ask 逐次确认；allow 与工作区内目标维持免新增路径审批。
      const target = await resolveFileTarget(context.workspaceRoot, input.path);
      const restriction = await resolveExternalTargetRestriction(context, target, "grep_files");
      return {
        toolName: "grep_files",
        effect: "none",
        destructive: false,
        operation: "search",
        risk: "read_only",
        ...(target.isExternal ? {
          externalTarget: { canonicalTarget: target.canonicalTarget, canonicalWorkspace: target.canonicalWorkspace },
          externalRestriction: restriction,
        } : {}),
        ...(restriction === "deny" ? { hardDenyReason: "搜索该工作区外目录已被显式规则拒绝" } : {}),
        ...(restriction === "ask" ? { requiresApproval: true, approval: { reason: "搜索该工作区外目录需要逐次确认" } } : {}),
      };
    },
    async execute(input, context) {
      // Talk-Plan1013 Stage 1：纯搜索免新增外部路径审批；ripgrep 未启用 -L，默认不跟随跨出搜索根的链接。
      const workspace = await resolveFileTarget(context.workspaceRoot, ".");
      const target = await resolveFileTarget(context.workspaceRoot, input.path);
      if (!target.exists) {
        throw createToolError(TOOL_ERROR_CODES.FILE_NOT_READ, `搜索路径不存在: ${input.path}`);
      }
      await assertSearchTarget(target.absolutePath);
      const result = await runRipgrep(
        buildGrepArguments(input, target.isExternal ? target.canonicalTarget : target.relativePath!),
        workspace.absolutePath,
        context.signal,
      );
      assertRipgrepSucceeded(result);
      const parsed = parseGrepEvents(result.stdout);
      return selectModeResults(
        input.outputMode,
        parsed,
        input.offset,
        input.limit,
        result.truncated,
      );
    },
    serializeOutput(output) { return output; },
  };
}
