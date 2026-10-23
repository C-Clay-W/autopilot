/**
 * Agent Kernel：无 UI 的执行闭环。
 * 只接收 RunContext + 依赖端口，只输出 AsyncIterable<AgentLoopEvent>；
 * 不依赖 Next.js、React、Electron、终端 UI 或 SSE 转换。
 */

import { isToolWithinCeiling } from "../../runtime/domain/product-mode";
import { isSandboxAvailabilityFailureCode } from "../../runtime/domain/sandbox-policy";
import { applyWebFetchRedirect } from "../tools/web-fetch-redirect";
import { randomUUID } from "node:crypto";
import type { AgentToolCall, ModelSampleOptions } from "../types";
import { createAgentTextMessage, createAgentToolResultMessage, getAgentMessageText, getAgentToolCalls, type AgentMessage, validateAgentMessages } from "../types/agent-message";
import type {
  AgentCheckpoint,
  AgentLoopEvent,
} from "../agent-runtime";
import { getUsageAnchorRequestSignature } from "../agent-runtime";
import { createToolScheduler, serializeToolResultForModel, type ScheduledToolResult } from "../tool-scheduler";
import { ToolExecutor } from "../tools/tool-executor";
import type { ToolExecutionResult } from "../tools/types";
import { createSyntheticToolErrorResult } from "../tools/synthetic-tool-result";
import type { TodoSnapshot, TodoWriteResult } from "../../runtime/domain/todo";
import type { AgentContextSnapshot } from "../agent-context";
import type { AgentModelToolDefinition, AgentSampleErrorCode, AgentSampleResult } from "../lib/llm";
import { AgentSampleError } from "../lib/llm";
import type { ModelSampler } from "./model-sampler";
import type { RunContext } from "./run-context";
import { getToolSignature, projectContextUsage, type ContextUsageCategoryKind, type ContextUsageContribution, type ContextUsageView } from "./context-budget";
import { estimateMessageTokens, serializeCanonicalMessagesForSignature } from "./compact";
import { createMutationCompletionPolicy } from "./completion-policy";
import { resolveAgentRuntimeLimits } from "../../runtime/config/runtime-limits";
import { AGENT_REPETITION_GUARDRAIL, getToolProgressFingerprint } from "./runtime-safety";
import { CHAT_RAG_ANSWER_TOOL, CHAT_RAG_ANSWER_CORRECTION_MESSAGE } from "../tools/chat-tool-runtime";

/** 将 P4 模型定义转换为 OpenAI tools 结构。 */
function toModelTools(definitions: ReturnType<import("../tools/tool-registry").ToolRegistry["getModelDefinitions"]>): AgentModelToolDefinition[] {
  return definitions.map((definition) => ({ type: "function", function: { name: definition.name, description: definition.description, parameters: definition.inputSchema } }));
}

/** 构造模型可见的工具结果消息，审计细节不进入上下文。 */
function toToolMessage(call: AgentToolCall, result: ToolExecutionResult): AgentMessage {
  return createAgentToolResultMessage({ toolCallId: call.id, text: serializeToolResultForModel(result), isError: result.status !== "success" });
}

/** 将采样结果一次性写成 canonical assistant 内容块，调度 DTO 只从该消息投影。 */
function toAssistantMessage(sampled: AgentSampleResult): AgentMessage {
  const toolCalls = sampled.toolCalls.map(function createToolCallBlock(call) {
    if (!call.input || typeof call.input !== "object" || Array.isArray(call.input)) throw new Error(`工具调用 ${call.id} 的 input 必须是对象`);
    return { type: "tool-call" as const, id: call.id, name: call.name, input: call.input as Record<string, unknown> };
  });
  const content = [
    ...(sampled.content ? [{ type: "text" as const, text: sampled.content }] : []),
    ...(sampled.reasoningContent ? [{ type: "reasoning" as const, text: sampled.reasoningContent }] : []),
    ...toolCalls,
  ];
  if (content.length === 0) throw new Error("模型响应没有可写入的 canonical 内容");
  return sampled.adapterReplayState
    ? { role: "assistant", content, adapterReplayState: sampled.adapterReplayState }
    : { role: "assistant", content };
}

/** 为混合交互调用生成统一拒绝结果，确保同一步中的写工具永不开始执行。 */
function createInteractiveToolConflictResult(call: AgentToolCall): Extract<ToolExecutionResult, { status: "error" }> {
  return {
    status: "error",
    callId: call.id,
    toolName: call.name,
    error: { code: "INTERACTIVE_TOOL_CONFLICT", message: "ask_user_question 必须单独调用，不能与其他工具混合执行" },
  };
}

/** 把已由 Runtime 校验并持久化的回答转换为原 ask_user_question 的成功工具结果。 */
function createUserQuestionAnswerResult(
  call: AgentToolCall,
  answer: import("../../runtime/domain").UserQuestionAnswer,
  requestId: string,
): Extract<ToolExecutionResult, { status: "success" }> {
  return {
    status: "success",
    callId: call.id,
    toolName: call.name,
    output: { answers: answer.answers },
    meta: { durationMs: 0, inputHash: `question:${requestId}` },
  };
}

/** 生成可公开记录、但不包含用户补充正文的回答摘要。 */
function summarizeUserQuestionAnswer(answer: import("../../runtime/domain").UserQuestionAnswer) {
  return {
    questionCount: answer.answers.length,
    selectedLabels: answer.answers.flatMap(function collectSelectedLabels(item) { return item.selected; }),
    hasCustom: answer.answers.some(function hasCustomAnswer(item) { return item.custom !== undefined; }),
  };
}

/** 权限拒绝是当前 Turn 的终止边界，使用稳定答复明确不会尝试替代执行路径。 */
function getPermissionDeniedMessage(): string {
  return "本次工具执行已被拒绝，当前任务已停止，不会尝试其他命令、等价工具或替代方式。";
}

/** 2.5：拒绝终止必须结构化区分用户拒绝与沙箱等环境阻塞；后者不是用户意愿，文案不得显示为"已被拒绝"。 */
function getDeniedTerminalMessage(errorCode: string | undefined): string {
  if (isSandboxAvailabilityFailureCode(errorCode ?? "")) {
    return "沙箱不可用，无法提供已隔离执行，本次任务已停止，不会无沙箱直接执行。";
  }
  return getPermissionDeniedMessage();
}

/** 提取最新用户任务，供首次采样前自动附加 Claude Code 风格的 Skill 候选提醒。 */
function getLatestUserTask(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const text = getAgentMessageText(message);
    if (message.role === "user" && text.trim()) return text.trim();
  }
  return undefined;
}

/** 提取并校验环境变量中的整型配置；非法或缺失时回退到默认值。 */
function readPositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

/** 模型输出截断恢复上限：output_limit 最多 3 次，stream_incomplete 最多 1 次。 */
const MAX_OUTPUT_RECOVERY_ATTEMPTS = 3;
/**
 * 输出达到上限后的升级预算；首轮保持默认值，首次截断后按 Claude Code 的思路做一次更大的干净重试。
 * 可通过 AGENT_OUTPUT_RECOVERY_MAX_TOKENS 覆盖，避免不同供应商的最大输出限制不一致。
 */
const DEFAULT_OUTPUT_RECOVERY_MAX_TOKENS = readPositiveIntEnv("AGENT_OUTPUT_RECOVERY_MAX_TOKENS", 64_000);
/** tool_call_invalid_json 最多允许 1 次格式修复采样。 */
const MAX_INVALID_JSON_RETRIES = 1;
/** 空响应最多允许 1 次附带恢复指令的重采样。 */
const MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS = 1;
/** 连接、超时、限流、5xx 或流中断共用一次瞬时故障恢复预算。 */
const MAX_PROVIDER_RECOVERY_ATTEMPTS = 1;
/** 写入型任务未实际执行或未完成写后验证时，只允许一次模型自我修正。 */
// 未写入场景的提醒耗尽后交由模型终审（接受答案），写后未验证仍硬失败；见 mutation gate 判定处。
const MAX_MUTATION_GATE_RECOVERY_ATTEMPTS = 1;

/** 模型输出恢复 meta message：仅服务端注入，不携带工具参数。 */
const RECOVERY_META_MESSAGE = "上一轮输出在工具参数完成前被截断。直接继续当前任务，不要道歉或复述；把剩余文件修改拆成更小的 edit_file 调用。已有文件优先 edit_file，write_file 只用于新建小文件或明确的完整重写。";
/** 空响应恢复提示：要求模型产生工具调用或可显示答复，不把隐藏推理当成完成结果。 */
const EMPTY_RESPONSE_RECOVERY_MESSAGE = "上一轮没有产生可显示正文或工具调用。请直接继续当前任务并执行必要工具；如果要创建大型 HTML 或文本文件，先用 write_file 创建最小可读骨架，再 read_file，随后用多个小范围 edit_file 分块补齐。不要只输出思考过程，也不要声称尚未执行的操作已经完成。";
const MUTATION_EXECUTION_GATE_MESSAGE = "系统怀疑当前任务需要修改工作区，但尚未检测到成功的 write_file 或 edit_file。若确实需要修改，请先用工具实际写入目标文件，随后 read_file 读取修改后的文件再给出结论；若任务实际为只读或无需修改文件，请直接给出最终答复。";
const MUTATION_VERIFICATION_GATE_MESSAGE = "已检测到文件写入，但尚未读取写入后的目标文件完成验证。下一步只能对每个已修改文件调用 read_file；确认内容后再答复，不要先输出完成结论。";

/** 判断模型错误是否属于不应污染对话消息的瞬时 Provider 故障。 */
function isTransientProviderError(code: AgentSampleErrorCode): boolean {
  return code === "PROVIDER_CONNECTION"
    || code === "PROVIDER_TIMEOUT"
    || code === "PROVIDER_RATE_LIMIT"
    || code === "PROVIDER_SERVER_ERROR"
    || code === "STREAM_INCOMPLETE";
}

/** 将恢复预算耗尽映射为稳定、安全且不包含供应商原文的终态说明。 */
function getRecoveryLimitMessage(code: AgentSampleErrorCode): string {
  if (code === "PROVIDER_CONNECTION") return "供应商连接持续失败，已停止自动恢复";
  if (code === "PROVIDER_TIMEOUT") return "供应商请求持续超时，已停止自动恢复";
  if (code === "PROVIDER_RATE_LIMIT") return "供应商请求持续被限流，已停止自动恢复";
  if (code === "PROVIDER_SERVER_ERROR") return "供应商服务持续不可用，已停止自动恢复";
  if (code === "STREAM_INCOMPLETE") return "供应商流式响应持续中断，已停止自动恢复";
  if (code === "TOOL_CALL_INVALID_JSON") return "模型返回非法工具参数 JSON，格式修复后仍失败";
  if (code === "EMPTY_RESPONSE") return "模型连续返回空响应，未执行工具或产生可显示答复";
  return "模型输出连续截断，已达到最大恢复次数";
}

/** 从受控文件工具的输入或成功输出中提取相对路径。 */
function getToolFilePath(call: AgentToolCall, result: ToolExecutionResult): string | undefined {
  const input = call.input as Record<string, unknown>;
  const output = result.status === "success" ? result.output as Record<string, unknown> : undefined;
  const path = output?.path ?? input.path;
  return typeof path === "string" && path.trim() ? path : undefined;
}

/** 从工具 input / output 安全抽取 UI 展示信息。
 *  不 import 工具模块——只按已知字段名读取。零耦合、零破坏。
 *  不传 output 时返回 tool_started 使用的前端描述；传入 output 时返回 tool_result 描述及可选的 diff/detail。
 *  errorCode 为工具失败时展示的错误码（如 "FILE_NOT_READ"），此时 output 为空且 errorCode 替代正常 summary。 */
function buildToolDisplayInfo(
  toolName: string,
  input: unknown,
  output?: unknown,
  errorCode?: string,
): { summary: string; detail?: string; diff?: string } {
  if (!output && errorCode) return { summary: `${toolName}: ${errorCode}` };
  const inp = (input ?? {}) as Record<string, unknown>;

  const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const arrLen = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  const byteLen = (s: unknown): number => Buffer.byteLength(str(s), "utf8");

  switch (toolName) {
    case "read_file": {
      const filePath = str(inp.path, "file");
      if (!output) return { summary: `Reading ${filePath}` };
      const out = output as Record<string, unknown>;
      const totalLines = num(out.totalLines);
      return { summary: `Read ${totalLines} lines`, detail: str(out.content).slice(0, 200) || undefined };
    }
    case "glob_files": {
      const pattern = str(inp.pattern, "*").slice(0, 80);
      if (!output) return { summary: `Searching files: ${pattern}` };
      const out = output as Record<string, unknown>;
      return { summary: `Found ${num(out.returned)} files${out.truncated ? " (truncated)" : ""}` };
    }
    case "grep_files": {
      const pattern = str(inp.pattern).slice(0, 80);
      if (!output) return { summary: pattern ? `Searching code: ${pattern}` : "Searching code" };
      const out = output as Record<string, unknown>;
      return { summary: `Found ${num(out.returned)} ${str(out.mode, "content") === "files_with_matches" ? "files" : "matches"}${out.truncated ? " (truncated)" : ""}` };
    }
    case "todo_write": {
      if (!output) return { summary: `Updating todos (${arrLen(inp.todos)} items)` };
      const out = output as Record<string, unknown>;
      const counts = (out.counts ?? {}) as Record<string, unknown>;
      const total = num(counts.completed) + num(counts.inProgress) + num(counts.pending);
      return { summary: `Todo ${num(counts.completed)}/${total}` };
    }
    case "write_file": {
      const filePath = str(inp.path, "file");
      if (!output) return { summary: `Writing ${filePath} (${byteLen(inp.content)}B)` };
      const out = output as Record<string, unknown>;
      return { summary: `Wrote ${num(out.bytes)}B` };
    }
    case "edit_file": {
      const filePath = str(inp.path, "file");
      if (!output) {
        const preview = [
          `--- a/${filePath}`,
          `+++ b/${filePath}`,
          "@@ 编辑预览（尚未写入） @@",
          ...str(inp.oldString).split("\n").map((line) => `-${line}`),
          ...str(inp.newString).split("\n").map((line) => `+${line}`),
        ].join("\n");
        const diff = preview.length > 4096 ? `${preview.slice(0, 4096)}\n… (preview truncated)` : preview;
        return { summary: `正在写入 ${filePath}`, diff };
      }
      const out = output as Record<string, unknown>;
      const replacements = num(out.replacements);
      const rawDiff = str(out.diff);
      const diff = rawDiff.length > 4096 ? rawDiff.slice(0, 4096) + "\n… (diff truncated)" : rawDiff || undefined;
      return { summary: `Edited ${filePath} (${replacements} changes)`, diff };
    }
    case "run_command": {
      const prog = str(inp.program, "command");
      const args = Array.isArray(inp.args) ? (inp.args as string[]).map(String) : [];
      const cmd = [prog, ...args].join(" ").slice(0, 80) || prog;
      if (!output) return { summary: `$ ${cmd}` };
      const out = output as Record<string, unknown>;
      const exitCode = num(out.exitCode);
      const stdout = str(out.stdout);
      const stderr = str(out.stderr);
      const preview = (stdout + stderr).slice(0, 300) || undefined;
      return { summary: exitCode === 0 ? "✓ Exit 0" : `Exit ${exitCode}`, detail: preview };
    }
    case "rag_search": {
      const query = str(inp.query).slice(0, 60);
      if (!output) return { summary: query ? `Searching: ${query}` : "Searching knowledge base" };
      const out = output as Record<string, unknown>;
      return { summary: `Found ${arrLen(out.results)} sources` };
    }
    case "database_search": {
      const sql = str(inp.sql).slice(0, 80);
      const query = str(inp.query).slice(0, 80);
      if (!output) return { summary: sql ? `Querying: ${sql}` : query ? `Searching database: ${query}` : "Querying database" };
      const out = output as Record<string, unknown>;
      return { summary: out.kind === "semantic" ? `Found ${arrLen(out.results)} database matches` : `Returned ${arrLen(out.rows)} rows` };
    }
    case "skill": {
      const skillName = str(inp.skill, "skill");
      if (!output) return { summary: `Loading Skill: ${skillName}` };
      const out = output as Record<string, unknown>;
      return { summary: `Loaded Skill: ${skillName} (${byteLen(out.content)}B)` };
    }
    case "discover_skills": {
      const query = str(inp.query).slice(0, 60);
      if (!output) return { summary: query ? `Discovering Skills: ${query}` : "Discovering Skills" };
      const count = Array.isArray(output) ? (output as unknown[]).length : 0;
      return { summary: `Found ${count} candidates` };
    }
    case "vision_analyze": {
      const filePath = str(inp.path, "image");
      if (!output) return { summary: `Analyzing: ${filePath}` };
      const out = output as Record<string, unknown>;
      return { summary: `Analyzed (${num(out.bytes)}B, ${str(out.mimeType)})` };
    }
    case "lancedb_query": {
      if (!output) return { summary: "Querying vector store" };
      const out = output as Record<string, unknown>;
      if (Array.isArray(out.tables)) return { summary: `Listed ${out.tables.length} tables` };
      if (Array.isArray(out.rows)) return { summary: `${str(out.tableName, "table")}: ${out.rows.length} rows` };
      return { summary: "Query complete" };
    }
    default:
      if (!output) return { summary: `Executing ${toolName}` };
      return { summary: `${toolName}: success` };
  }
}

/** 生成 checkpoint 中可复现的上下文引用，避免将完整持久内容复制进 Session。 */
function checkpointContext(contextSnapshot: AgentContextSnapshot | undefined, activeSkills: Array<{ skillId: string; contentHash: string }>) {
  return {
    contextSummary: contextSnapshot ? {
      instructionHashes: contextSnapshot.instructions.map((item) => item.contentHash),
      memoryIds: contextSnapshot.memories.map((item) => item.memoryId),
      estimatedTokens: contextSnapshot.budget.estimatedTokens,
    } : undefined,
    activeSkills,
  };
}

/** Stream visible model text as process events while preserving the completed sample for tool-call parsing. */
async function* streamModelSample(
  sampler: ModelSampler,
  messages: AgentMessage[],
  tools: AgentModelToolDefinition[],
  signal: AbortSignal,
  maxTokens?: number,
  modelSampleOptions?: ModelSampleOptions,
): AsyncGenerator<{ delta: string } | { sampled: AgentSampleResult }> {
  const deltas: string[] = [];
  let notify: () => void = () => undefined;
  let settled = false;
  let sampled: AgentSampleResult | undefined;
  let failure: unknown;
  // Kernel 只透传已解析的 Provider 采样选项（model/thinking/reasoningEffort），不在此处猜测 Provider。
  const sampleOptions: { signal?: AbortSignal; maxTokens?: number } & ModelSampleOptions = {
    signal,
    ...(modelSampleOptions ?? {}),
  };
  if (maxTokens !== undefined) sampleOptions.maxTokens = maxTokens;
  /** Abort 必须立即唤醒等待中的生成器，不能等供应商流主动结束后再停止转发正文。 */
  function notifyAbort(): void {
    notify();
  }
  signal.addEventListener("abort", notifyAbort, { once: true });
  void sampler.sample(messages, tools, sampleOptions, (delta) => {
    if (signal.aborted) return;
    deltas.push(delta);
    notify();
  }).then((result) => {
    sampled = result;
  }).catch((error: unknown) => {
    failure = error;
  }).finally(() => {
    settled = true;
    notify();
  });

  try {
    while (!settled || deltas.length > 0) {
      if (signal.aborted) throw new Error("用户已取消模型采样");
      const delta = deltas.shift();
      if (delta) {
        yield { delta };
        continue;
      }
      await new Promise<void>((resolve) => {
        notify = resolve;
        if (signal.aborted) resolve();
      });
    }
    if (signal.aborted) throw new Error("用户已取消模型采样");
    if (failure) throw failure;
    if (!sampled) throw new Error("Agent 模型采样未返回结果");
    yield { sampled };
  } finally {
    signal.removeEventListener("abort", notifyAbort);
  }
}

/** Kernel 内部持有的可变执行状态。 */
interface KernelState {
  turnId: string;
  stepCount: number;
  runStepLimit?: number;
  messages: AgentMessage[];
  completedCallIds: Set<string>;
  consumedInputIds: Set<string>;
  activeSkills: Array<{ skillId: string; contentHash: string }>;
  pendingCalls: AgentToolCall[] | undefined;
  mutationRequired: boolean;
  changedPaths: Set<string>;
  verifiedPaths: Set<string>;
  mutationGateRecoveryAttempts: number;
  emptyReplyRetries: number;
  resumeApprovalAvailable: boolean;
  needsResumeApproval: boolean;
  outputRecoveryAttempts: number;
  invalidJsonRetries: number;
  providerRecoveryAttempts: number;
  injectedSinceSample: boolean;
}

/** Agent Kernel 实例；与 createAgentRuntime 保持同样的 run/resume 调用范式。 */
export interface AgentKernel {
  /** 执行或恢复一个 Agent turn；每个 yield 都可被 Session Runtime 记录为 durable event。 */
  run(): AsyncGenerator<AgentLoopEvent>;
}

/** 构造 Agent Kernel 执行闭环。 */
export function createAgentKernel(context: RunContext): AgentKernel {
  const resolvedContext = context.runtimeLimitsResolved
    ? context
    : { ...context, ...resolveAgentRuntimeLimits({ maxSteps: context.maxSteps, maxToolRetries: context.maxToolRetries }), runtimeLimitsResolved: true };
  return {
    /** 执行或恢复一个 Agent turn；每个 yield 都可被 Session Runtime 记录为 durable event。 */
    async *run(): AsyncGenerator<AgentLoopEvent> {
      yield* runKernel(resolvedContext);
    },
  };
}

/**
 * 执行 Agent Kernel 单次运行闭环。
 * @param context 运行上下文与依赖端口
 * @returns Agent 生命周期事件流
 */
export async function* runKernel(context: RunContext): AsyncGenerator<AgentLoopEvent> {
  const fileReadStates = new Map<string, { sha256: string; mtimeMs: number; observedRanges: Array<{ startLine: number; endLine: number }> }>();

  /** 从受控 checkpoint 恢复文件观察元数据，忽略不完整条目，避免跨 turn 复用内存状态。 */
  function restoreFileReadStates(checkpoint?: AgentCheckpoint): void {
    fileReadStates.clear();
    for (const state of checkpoint?.fileReadStates ?? []) {
      if (!state.path || !state.sha256 || !Number.isFinite(state.mtimeMs)) continue;
      const observedRanges = state.observedRanges.filter(function validObservedRange(range) {
        return Number.isInteger(range.startLine) && Number.isInteger(range.endLine) && range.startLine > 0 && range.endLine >= range.startLine;
      }).map(function copyObservedRange(range) { return { ...range }; });
      fileReadStates.set(state.path, { sha256: state.sha256, mtimeMs: state.mtimeMs, observedRanges });
    }
  }

  /** 将文件观察元数据写入 checkpoint；不保存文件正文，恢复后仍由工具重新校验 hash 与 mtime。 */
  function fileReadStatesSnapshot(): Pick<AgentCheckpoint, "fileReadStates"> {
    return {
      fileReadStates: [...fileReadStates.entries()].map(function serializeFileReadState([path, state]) {
        return {
          path,
          sha256: state.sha256,
          mtimeMs: state.mtimeMs,
          observedRanges: state.observedRanges.map(function copyObservedRange(range) { return { ...range }; }),
        };
      }),
    };
  }

  const currentSignal = context.signal ?? new AbortController().signal;

  restoreFileReadStates(context.checkpoint);
  const activeSkills = [...(context.checkpoint?.activeSkills ?? context.activeSkills ?? [])];
  const skillRestrictions = activeSkills
    .map((active) => context.skills?.catalog.find((skill) => skill.skillId === active.skillId)?.allowedTools)
    .filter((value): value is string[] => Boolean(value?.length));
  const skillAllowedIntersection = skillRestrictions.reduce(
    (current, restriction) => new Set([...current].filter((tool) => restriction.includes(tool))),
    new Set(context.toolRegistry.getModelDefinitions().map((definition) => definition.name)),
  );
  const verificationContinuation = context.checkpoint?.interruptionReason === "write_verification" || context.checkpoint?.mutationGate?.verificationOnly === true;
  let verificationOnly = verificationContinuation;
  const policyAllowedTools = verificationContinuation
    ? (skillRestrictions.length ? [...skillAllowedIntersection].filter(function onlyRead(tool) { return tool === "read_file"; }) : ["read_file"])
    : skillRestrictions.length ? [...skillAllowedIntersection, "skill"] : undefined;

  const executor = new ToolExecutor(context.toolRegistry, {
    capabilityCeiling: context.capabilityCeiling,
    workspaceRoot: context.workspaceRoot,
    permissionMode: context.permissionContext.mode,
    workspaceTrusted: context.permissionContext.workspaceTrusted,
    onToolEvent: context.onToolEvent,
    fileMutations: context.fileMutationStore && context.sessionId
      ? { store: context.fileMutationStore, sessionId: context.sessionId, turnId: context.checkpoint?.turnId ?? context.turnId ?? "" }
      : undefined,
    fileReadStates,
    resolvePersistentGrant: context.permissionContext.resolvePersistentGrant,
    validateApproval: context.permissionContext.validateApproval,
    resolveExternalRestriction: context.permissionContext.resolveExternalRestriction,
    externalExecutionAuthority: context.permissionContext.externalExecutionAuthority,
    executionSessionId: context.sessionId,
    allowedTools: policyAllowedTools,
    visionAnalyzer: context.visionAnalyzer,
    sandbox: context.sandbox,
    hostMutationProtection: context.hostMutationProtection,
  });
  const scheduler = createToolScheduler(context.toolRegistry, (request, executionOptions) => executor.execute(request, executionOptions));

  const turnId = context.checkpoint?.turnId ?? context.turnId ?? randomUUID();
  // RunContext 的限制已由 facade 或 Turn Runtime 冻结解析；这里不能再次读取环境变量。
  const maxSteps = context.maxSteps;
  const messages = [...context.messages];
  // 标记绑定 Turn 并随 checkpoint 保留；历史轮次的纠正不消耗本轮预算。
  const answerCorrectionMarker = `【RAG 本轮纠正 ${turnId}】`;
  const answerFinalizeMarker = `【RAG 收尾 ${turnId}】`;
  /** 仅查询本轮持久消息标记，恢复不能重新获得纠正预算。 */
  function hasAnswerMarker(marker: string): boolean {
    return messages.some(function matches(message) { return message.role === "system" && getAgentMessageText(message).startsWith(marker); });
  }
  const completionPolicy = context.completionPolicy ?? createMutationCompletionPolicy();
  const initialIntent = completionPolicy.initialSignal(messages);
  const completedCallIds = new Set(context.checkpoint?.completedCallIds ?? []);
  const consumedInputIds = new Set(context.checkpoint?.consumedInputIds ?? []);
  const changedPaths = new Set(context.checkpoint?.mutationGate?.changedPaths ?? []);
  const verifiedPaths = new Set(context.checkpoint?.mutationGate?.verifiedPaths ?? []);
  let mutationRequired = changedPaths.size > 0 || initialIntent.required;
  let mutationStrong = changedPaths.size > 0 ? false : initialIntent.strong;
  let mutationGateRecoveryAttempts = changedPaths.size > 0 ? context.checkpoint?.mutationGate?.recoveryAttempts ?? 0 : 0;
  let stepCount = context.checkpoint?.stepCount ?? 0;
  const runStepLimit = maxSteps === undefined ? undefined : stepCount + maxSteps;
  let pendingCalls = context.checkpoint?.pendingCalls;
  let pendingUserQuestion = context.checkpoint?.pendingUserQuestion;
  let emptyReplyRetries = 0;
  let resumeApprovalAvailable = Boolean(context.approval);
  let needsResumeApproval = context.checkpoint?.status === "awaiting_approval";
  let outputRecoveryAttempts = 0;
  let invalidJsonRetries = 0;
  let providerRecoveryAttempts = 0;
  let injectedSinceSample = false;
  let usageAnchor = context.checkpoint?.usageAnchor ?? context.inheritedUsageAnchor;
  /** 最近一次安全边界生成的上下文用量快照；恢复时以私有 checkpoint 的快照为初始值。 */
  let latestContextUsage: ContextUsageView | undefined = context.checkpoint?.contextUsage;
  /** 最近一次已对外发射的 Context Usage 快照 JSON；undefined 表示本 Turn 尚未发射过任何事件。 */
  let emittedContextUsageJson: string | null | undefined;
  // 账本与 messages 一一对应：新 Turn 来自请求组装，恢复 Turn 只记录本进程新增贡献。
  let contextLedgerComplete = Array.isArray(context.initialContextContributions) && context.initialContextContributions.length === messages.length;
  let messageContributions: ContextUsageContribution[][] = contextLedgerComplete
    ? context.initialContextContributions!.map((entries) => [...entries])
    : [];
  const clock = context.clock ?? Date.now;
  const maxDurationMs = context.maxDurationMs;
  const maxTotalTokens = context.maxTotalTokens;
  // 应用层在 Continue 取得 lease 后重开执行段起点；Turn 范围 token 累计仍沿用 checkpoint。
  const runtimeBudget = context.checkpoint?.runtimeBudget ?? { startedAt: clock(), totalTokens: 0, executionSegmentVersion: 1 as const };
  let toolGuardrailFingerprint = context.checkpoint?.toolGuardrail?.fingerprint;
  let toolGuardrailCount = context.checkpoint?.toolGuardrail?.repeatCount ?? 0;
  const todoChainId = context.todoChainId ?? turnId;
  let todoSnapshot = context.checkpoint?.todoSnapshot;

  /** 把持久化 Todo 快照转换为模型可读 reminder，避免压缩后丢失完整任务进度。 */
  function createTodoSnapshotReminder(snapshot: TodoSnapshot): AgentMessage {
    const lines = snapshot.todos.map(function formatTodo(todo, index) {
      return `${index + 1}. [${todo.status}] ${todo.content}${todo.status === "in_progress" ? ` —— ${todo.activeForm}` : ""}`;
    });
    return createAgentTextMessage("system", `【Todo 快照】当前任务链最近待办（来自 durable 事件）：\n${lines.join("\n")}\n请在后续 todo_write 中整表替换维护；验证失败或未完成时不要标记 completed。`);
  }

  /** 判断当前上下文是否已包含同一 Todo 快照，防止 Continue 或压缩恢复重复注入。 */
  function hasTodoSnapshot(snapshot: TodoSnapshot): boolean {
    const expected = JSON.stringify(snapshot.todos);
    return messages.some(function containsTodoSnapshot(message) {
      return message.content.some(function containsTodoResult(block) { return block.type === "tool-result" && block.content.some(function containsSnapshot(item) { return item.text.includes(expected); }); });
    }) || messages.some(function containsTodoReminder(message) {
      return message.role === "system" && getAgentMessageText(message).startsWith("【Todo 快照】");
    });
  }

  /** 在 Todo 工具结果已被压缩时恢复一条 system reminder，保留 Continue 与 steer 的完整上下文。 */
  function restoreTodoSnapshotIfNeeded(): void {
    if (!todoSnapshot || hasTodoSnapshot(todoSnapshot)) return;
    pushMessage(createTodoSnapshotReminder(todoSnapshot), "system");
  }

  /** 生成每个 durable checkpoint 复用的私有 usage anchor 快照。 */
  function usageAnchorSnapshot(): Pick<AgentCheckpoint, "usageAnchor"> {
    return usageAnchor ? { usageAnchor } : {};
  }

  /** 追加模型上下文消息并同步登记固定分类贡献；账本与 messages 严格同步增长。 */
  function pushMessage(message: AgentMessage, kind: ContextUsageCategoryKind): void {
    messages.push(message);
    messageContributions.push([{ kind, weight: estimateMessageTokens([message]) }]);
  }

  /** 生成每个 durable checkpoint 复用的安全上下文用量快照。 */
  function contextUsageSnapshot(): Pick<AgentCheckpoint, "contextUsage"> {
    return latestContextUsage ? { contextUsage: latestContextUsage } : {};
  }

  /**
   * 构造 context_usage_updated 事件：与上次发射完全相同则省略，避免每个循环产生 transcript 噪音；
   * 投影 fail closed 为空时以 usage=null 明确清空旧状态；未注入冻结窗口配置时保持沉默。
   */
  function contextUsageUpdatedEvent(): AgentLoopEvent | undefined {
    if (!context.contextUsageProjection) return undefined;
    const json = latestContextUsage ? JSON.stringify(latestContextUsage) : null;
    if (emittedContextUsageJson === json) return undefined;
    emittedContextUsageJson = json;
    return { type: "context_usage_updated", turnId, usage: latestContextUsage ?? null };
  }

  /** 在安全边界生成当前请求的上下文用量投影；未注入冻结窗口配置时保持缺失，投影失败时清除旧快照。 */
  function projectContextUsageSnapshot(targetMessages: AgentMessage[] = messages): ContextUsageView | undefined {
    const projection = context.contextUsageProjection;
    if (!projection) return undefined;
    latestContextUsage = projectContextUsage({
      checkpoint: {
        ...(usageAnchor ? { usageAnchor } : {}),
        ...(latestContextUsage ? { contextUsage: latestContextUsage } : {}),
      },
      messages: targetMessages,
      tools: toModelTools(getVisibleToolDefinitions()),
      contributions: messageContributions.flat(),
      contributionsComplete: contextLedgerComplete,
      contextWindowTokens: projection.contextWindowTokens,
      outputReserveTokens: projection.outputReserveTokens,
      compactTriggerTokens: projection.compactTriggerTokens,
      modelRef: projection.modelRef,
      sampleOptions: context.modelSampleOptions,
    }) ?? undefined;
    return latestContextUsage;
  }

  /** compact 用内容一致的规范化副本替换消息投影；按内容签名迁移已知贡献，摘要与保留尾部归入 conversation。 */
  function rebuildLedgerAfterCompact(nextMessages: AgentMessage[]): void {
    const ledgerBySignature = new Map<string, ContextUsageContribution[]>();
    messages.forEach(function captureLedger(message, index) {
      ledgerBySignature.set(serializeCanonicalMessagesForSignature([message]), messageContributions[index] ?? []);
    });
    messages.splice(0, messages.length, ...nextMessages);
    messageContributions = nextMessages.map(function projectCompactMessage(message) {
      return ledgerBySignature.get(serializeCanonicalMessagesForSignature([message]))
        ?? [{ kind: "conversation" as const, weight: estimateMessageTokens([message]) }];
    });
    contextLedgerComplete = true;
  }

  /** 保存当前执行段起点与跨 Continue 保留的累计 token；不把 Provider 原始响应写入 checkpoint。 */
  function runtimeBudgetSnapshot(): Pick<AgentCheckpoint, "runtimeBudget" | "safetyBudgetVersion"> {
    return { runtimeBudget: { ...runtimeBudget, executionSegmentVersion: 1 }, safetyBudgetVersion: 2 };
  }

  /** 生成连续重复调用的脱敏状态；只保留哈希与次数。 */
  function toolGuardrailSnapshot(): Pick<AgentCheckpoint, "toolGuardrail"> {
    return toolGuardrailFingerprint
      ? { toolGuardrail: { fingerprint: toolGuardrailFingerprint, repeatCount: toolGuardrailCount } }
      : {};
  }

  /** 生成最近一次成功 Todo 快照，确保 compact/Continue 后任务进度仍可恢复。 */
  function todoSnapshotSnapshot(): Pick<AgentCheckpoint, "todoSnapshot"> {
    return todoSnapshot ? { todoSnapshot } : {};
  }

  /** 在完整工具批次结束后交给宿主持久化运行快照，防止进程重启重放已完成副作用。 */
  async function persistSafeToolBatchCheckpoint(remainingCalls: AgentToolCall[] = []): Promise<void> {
    if (!context.onSafeToolBatch) return;
    const checkpoint: AgentCheckpoint = {
      turnId,
      status: "running",
      stepCount,
      messages: [...messages],
      ...(remainingCalls.length > 0 ? { pendingCalls: [...remainingCalls] } : {}),
      completedCallIds: [...completedCallIds],
      consumedInputIds: [...consumedInputIds],
      ...mutationGateSnapshot(),
      ...usageAnchorSnapshot(),
      ...runtimeBudgetSnapshot(),
      ...contextUsageSnapshot(),
      ...toolGuardrailSnapshot(),
      ...todoSnapshotSnapshot(),
      ...checkpointContext(context.contextSnapshot, activeSkills),
    };
    await context.onSafeToolBatch(checkpoint);
  }

  /** 将一次完整模型采样的 usage 累加到当前 Turn 的 token 安全预算。 */
  function recordSampleUsage(sampled: AgentSampleResult): void {
    if (sampled.usage) runtimeBudget.totalTokens += sampled.usage.contextTokens;
  }

  /** 将当前采样 usage 绑定到已写入的 canonical 消息边界。 */
  function updateUsageAnchor(sampled: AgentSampleResult, messageCount: number, messageSnapshot: AgentMessage[] = messages): void {
    if (!sampled.usage) return;
    usageAnchor = { usage: sampled.usage, messageCount, toolSignature: getToolSignature(toModelTools(getVisibleToolDefinitions())), requestSignature: getUsageAnchorRequestSignature(messageSnapshot, context.modelSampleOptions) };
  }

  /** steer 或真实任务推进会打断连续重复计数。 */
  function resetToolGuardrail(): void {
    toolGuardrailFingerprint = undefined;
    toolGuardrailCount = 0;
  }

  /** 只有 Todo 列表实际变化才算推进，重复提交同一快照不能绕过空转护栏。 */
  function hasTodoProgress(previous: TodoSnapshot | undefined, next: TodoWriteResult["todos"]): boolean {
    if (!previous) return next.length > 0;
    return JSON.stringify(previous.todos) !== JSON.stringify(next);
  }

  /** 记录工具结果并返回本次应注入的提醒级别。 */
  function observeToolProgress(call: AgentToolCall, result: ToolExecutionResult): "reminder" | "strong" | "pause" | undefined {
    const effect = context.toolRegistry.get(call.name).metadata.effect;
    if (result.status === "success" && effect !== "none") {
      resetToolGuardrail();
      return undefined;
    }
    const fingerprint = getToolProgressFingerprint(call, result);
    toolGuardrailCount = fingerprint === toolGuardrailFingerprint ? toolGuardrailCount + 1 : 1;
    toolGuardrailFingerprint = fingerprint;
    if (toolGuardrailCount >= AGENT_REPETITION_GUARDRAIL.pauseAt) return "pause";
    if (toolGuardrailCount === AGENT_REPETITION_GUARDRAIL.strongReminderAt) return "strong";
    if (toolGuardrailCount === AGENT_REPETITION_GUARDRAIL.reminderAt) return "reminder";
    return undefined;
  }

  /** 在安全边界判断活动执行段时长或 Turn 累计 token 是否已达到硬止损。 */
  function getSafetyBudgetReason(): "runtime_budget" | "token_budget" | undefined {
    if (maxTotalTokens !== undefined && runtimeBudget.totalTokens >= maxTotalTokens) return "token_budget";
    if (maxDurationMs !== undefined && clock() - runtimeBudget.startedAt >= maxDurationMs) return "runtime_budget";
    return undefined;
  }

  /** 将安全止损原因转换为用户可读诊断。 */
  function getSafetyBudgetMessage(reason: "runtime_budget" | "token_budget"): string {
    return reason === "token_budget"
      ? "显式配置的 Agent 累计 Token 上限已耗尽，当前 Turn 不能继续。"
      : "Agent 当前执行段的运行时长已达到安全上限，已在安全边界暂停；可继续当前 Turn。";
  }

  /** 将重复调用级别转换为模型下一步可执行的策略提醒。 */
  function getToolGuardrailMessage(action: "reminder" | "strong" | "pause"): string {
    return action === "pause"
      ? "检测到同一工具、参数和结果连续重复，当前 Turn 已暂停。继续前请改变策略或补充新的验证，不要重放同一失败调用。"
      : action === "strong"
        ? "强提醒：工具调用与结果连续重复且没有取得进展。请停止重放，改变参数、读取新的事实或向用户说明阻塞。"
        : "提醒：检测到工具调用与结果连续重复。请核对结果并改用新的策略，避免无进展循环。";
  }

  /** 按严重程度合并同一工具批次中的重复调用提醒，避免强提醒被低级提醒覆盖。 */
  function getToolGuardrailPriority(action: "reminder" | "strong" | "pause"): number {
    return action === "pause" ? 3 : action === "strong" ? 2 : 1;
  }

  /** 保存真实文件写入的读回验证状态与只读视觉预算，恢复时保留客观事实。 */
  function mutationGateSnapshot(): Pick<AgentCheckpoint, "mutationGate" | "fileReadStates" | "chatBudget"> {
    return {
      ...(context.chat ? { chatBudget: context.chat.budgetSnapshot() } : {}),
      mutationGate: {
        required: mutationRequired,
        strong: mutationStrong,
        changedPaths: [...changedPaths],
        verifiedPaths: [...verifiedPaths],
        recoveryAttempts: mutationGateRecoveryAttempts,
        ...(verificationOnly ? { verificationOnly: true } : {}),
      },
      ...fileReadStatesSnapshot(),
    };
  }

  /** 按成功文件工具事实记录待读回验路径，不依据用户文字预测写入意图。 */
  function recordMutationToolResult(call: AgentToolCall, result: ToolExecutionResult): void {
    if (result.status !== "success") return;
    const isMutation = call.name === "write_file" || call.name === "edit_file";
    if (isMutation) {
      mutationRequired = true;
      mutationStrong = false;
    }
    const path = getToolFilePath(call, result);
    if (!path) return;
    if (isMutation) {
      changedPaths.add(path);
      verifiedPaths.delete(path);
    }
    if (call.name === "read_file" && changedPaths.has(path)) verifiedPaths.add(path);
  }

  /** Skill allowed-tools 只能收窄模型可见集合；没有声明时不额外收窄宿主能力。 */
  function getVisibleToolDefinitions() {
    const definitions = context.toolRegistry.getModelDefinitions();
    if (!policyAllowedTools) return definitions;
    return definitions.filter((definition) => policyAllowedTools.includes(definition.name));
  }

  /** 仅在采样前后、完整工具组或完成前注入 steer，绝不拆开 tool call/result 原子组。 */
  async function* drainSteer(boundary: "before_sample" | "after_sample" | "after_tools" | "before_complete"): AsyncGenerator<AgentLoopEvent> {
    if (!context.inputInbox) return;
    const inputs = await context.inputInbox.drain({ turnId, maxDelivery: "steer", boundary });
    for (const injected of inputs) {
      if (consumedInputIds.has(injected.inputId)) continue;
      context.chat?.invalidateEvidence();
      pushMessage(createAgentTextMessage("user", injected.content), "conversation");
      resetToolGuardrail();
      const injectedIntent = completionPolicy.observeInput(injected.content);
      mutationRequired = mutationRequired || injectedIntent.required;
      mutationStrong = mutationStrong || injectedIntent.strong;
      consumedInputIds.add(injected.inputId);
      if (boundary !== "before_sample") injectedSinceSample = true;
      const checkpoint: AgentCheckpoint = {
        turnId,
        status: "running",
        stepCount,
        messages,
        pendingCalls,
        completedCallIds: [...completedCallIds],
        consumedInputIds: [...consumedInputIds],
        ...mutationGateSnapshot(),
        ...usageAnchorSnapshot(),
        ...runtimeBudgetSnapshot(),
        ...contextUsageSnapshot(),
        ...toolGuardrailSnapshot(),
        ...todoSnapshotSnapshot(),
        ...checkpointContext(context.contextSnapshot, activeSkills),
      };
      yield { type: "input_joined", turnId, inputId: injected.inputId, checkpoint };
      yield { type: "input_consumed", turnId, inputId: injected.inputId, checkpoint };
    }
  }

  /** 在首个执行展示前检查整批调用；任何越权或无效 ref 都阻止本批全部 handler。 */
  async function* rejectInvalidCalls(calls: AgentToolCall[], stepId: string): AsyncGenerator<AgentLoopEvent, boolean> {
    for (const call of calls) {
      if (context.capabilityCeiling?.productMode !== "chat" && isToolWithinCeiling(context.capabilityCeiling, call.name)) continue;
      const rejected = await executor.preflight({ callId: call.id, toolName: call.name, input: call.input }, currentSignal);
      if (!rejected) continue;
      for (const item of calls) {
        const result = item.id === call.id ? rejected : createSyntheticToolErrorResult(item, "TOOL_ABORTED_BEFORE_DISPATCH", "同批工具未通过权限校验，本次未执行");
        pushMessage(toToolMessage(item, result), "conversation");
        completedCallIds.add(item.id);
        projectContextUsageSnapshot();
        const rejectedUsageEvent = contextUsageUpdatedEvent();
        if (rejectedUsageEvent) yield rejectedUsageEvent;
        yield { type: "tool_result", turnId, stepId, callId: item.id, toolName: item.name, result, retryCount: 0, summary: result.error.code };
      }
      yield { type: "turn_failed", turnId, error: rejected.error.code, errorCode: isSandboxAvailabilityFailureCode(rejected.error.code) ? rejected.error.code : undefined, checkpoint: { turnId, status: "failed", stepCount, messages, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) } };
      return true;
    }
    return false;
  }

  restoreTodoSnapshotIfNeeded();
  // 首个安全边界：恢复的 Turn 立即获得最近一次安全快照，新 Turn 生成首次估算投影。
  projectContextUsageSnapshot();
  yield { type: "turn_started", turnId, stepCount };

  try {
    // 同一 Turn 内连续相同的推理摘要只向展示端发一次，避免 Web/CLI 时间线重复显示相同文案。
    let lastYieldedReasoningSummary = "";
    while (runStepLimit === undefined || stepCount < runStepLimit) {
      if (currentSignal.aborted) {
        const checkpoint: AgentCheckpoint = { turnId, status: "interrupted", stepCount, messages, pendingCalls, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
        yield { type: "turn_interrupted", turnId, checkpoint };
        return;
      }
      const safetyBudgetReason = getSafetyBudgetReason();
      if (safetyBudgetReason) {
        if (safetyBudgetReason === "token_budget") {
          const checkpoint: AgentCheckpoint = { turnId, status: "failed", interruptionReason: "token_budget", stepCount, messages, pendingCalls, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
          yield {
            type: "turn_failed",
            turnId,
            checkpoint,
            error: getSafetyBudgetMessage(safetyBudgetReason),
            termination: { reason: "token_budget", budget: { used: runtimeBudget.totalTokens, limit: maxTotalTokens!, unit: "tokens" } },
          };
          return;
        }
        const checkpoint: AgentCheckpoint = { turnId, status: "interrupted_recoverable", interruptionReason: safetyBudgetReason, stepCount, messages, pendingCalls, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
        yield {
          type: "turn_interrupted",
          turnId,
          checkpoint,
          error: getSafetyBudgetMessage(safetyBudgetReason),
          termination: { reason: "runtime_budget", budget: { used: Math.max(0, clock() - runtimeBudget.startedAt), limit: maxDurationMs!, unit: "ms" } },
        };
        return;
      }
      const stepId = `${turnId}:${stepCount + 1}`;
      if (pendingCalls?.length) {
        yield { type: "reasoning_summary", turnId, stepId, summary: "正在根据已保存的审批决定恢复工具调用" };
        const calls = pendingCalls;
        if (yield* rejectInvalidCalls(calls, stepId)) return;
        pendingCalls = undefined;
        const pendingCall = calls[0];
        if (needsResumeApproval && !resumeApprovalAvailable) {
          const checkpoint: AgentCheckpoint = { turnId, status: "awaiting_approval", stepCount, messages, pendingCalls: calls, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
          yield { type: "turn_paused", turnId, checkpoint };
          return;
        }

        const lostWebInput = calls.some(function isRedactedWebCall(call) {
          if (call.name !== "web_search" && call.name !== "web_fetch") return false;
          const input = call.input as { redacted?: boolean; query?: string } | undefined;
          return input?.redacted === true || (call.name === "web_search" && input?.query === "[redacted]");
        });
        if (lostWebInput) {
          for (const call of calls) {
            const result = createSyntheticToolErrorResult(call, "WEB_INPUT_UNAVAILABLE", "网络调用参数未持久化或已失效，本批未执行；请根据用户要求重新规划，不能执行脱敏占位参数");
            pushMessage(toToolMessage(call, result), "conversation");
            completedCallIds.add(call.id);
            projectContextUsageSnapshot();
            const unavailableUsageEvent = contextUsageUpdatedEvent();
            if (unavailableUsageEvent) yield unavailableUsageEvent;
            yield { type: "tool_result", turnId, stepId, callId: call.id, toolName: call.name, result, retryCount: 0, ...buildToolDisplayInfo(call.name, call.input, undefined, result.error.code) };
          }
          if (context.approval?.decision === "deny") {
            const deniedMessage = getPermissionDeniedMessage();
            yield { type: "answer_delta", turnId, stepId, delta: deniedMessage };
            yield { type: "turn_failed", turnId, error: deniedMessage, checkpoint: { turnId, status: "failed", stepCount, messages: [...messages, createAgentTextMessage("assistant", deniedMessage)], completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) } };
            return;
          }
          resumeApprovalAvailable = false;
          needsResumeApproval = false;
          // 本批所有调用都已用合成错误闭合，不能把已完成调用再次写入 pendingCalls。
          pendingCalls = undefined;
          await persistSafeToolBatchCheckpoint();
          stepCount++;
          continue;
        }

        const questionAnswer = pendingCall.name === "ask_user_question" ? context.userQuestion : undefined;
        if (pendingCall.name === "ask_user_question" && !questionAnswer) {
          if (!pendingUserQuestion || pendingUserQuestion.callId !== pendingCall.id) throw new Error("等待用户回答的 Turn 缺少问题请求绑定");
          const checkpoint: AgentCheckpoint = { turnId, status: "awaiting_user_input", stepCount, messages, pendingCalls: calls, pendingUserQuestion, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
          yield { type: "question_required", turnId, stepId, callId: pendingCall.id, requestId: pendingUserQuestion.requestId, questions: pendingUserQuestion.questions };
          yield { type: "turn_paused", turnId, checkpoint };
          return;
        }
        const result = questionAnswer
          ? createUserQuestionAnswerResult(pendingCall, questionAnswer.answer, questionAnswer.requestId)
          : await executor.execute({ callId: pendingCall.id, toolName: pendingCall.name, input: pendingCall.input, approval: needsResumeApproval && resumeApprovalAvailable ? context.approval : undefined }, { signal: currentSignal });
        if (result.status === "approval_required") {
          applyWebFetchRedirect(pendingCall, result, messages);
          const checkpoint: AgentCheckpoint = { turnId, status: "awaiting_approval", stepCount, messages, pendingCalls: calls, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
          yield { type: "approval_required", turnId, stepId, callId: pendingCall.id, toolName: pendingCall.name, result };
          yield { type: "turn_paused", turnId, checkpoint };
          return;
        }
        if (questionAnswer) {
          yield { type: "question_answered", turnId, requestId: questionAnswer.requestId, answerSummary: summarizeUserQuestionAnswer(questionAnswer.answer) };
          pendingUserQuestion = undefined;
        }
        pushMessage(toToolMessage(pendingCall, result), "conversation");
        projectContextUsageSnapshot();
        const resumeUsageEvent = contextUsageUpdatedEvent();
        if (resumeUsageEvent) yield resumeUsageEvent;
        recordMutationToolResult(pendingCall, result);
        completedCallIds.add(pendingCall.id);
        const resumeErrorCode = result.status === "error" ? (result as { error: { code: string } }).error.code : undefined;
        const resumeDisplay = buildToolDisplayInfo(pendingCall.name, pendingCall.input, "output" in result ? (result as Record<string, unknown>).output : undefined, resumeErrorCode);
        yield { type: "tool_result", turnId, stepId, callId: pendingCall.id, toolName: pendingCall.name, result, retryCount: 0, ...resumeDisplay };
        const pendingGuardrailAction = observeToolProgress(pendingCall, result);
        if (pendingGuardrailAction) {
          const guardrailMessage = getToolGuardrailMessage(pendingGuardrailAction);
          pushMessage(createAgentTextMessage("system", guardrailMessage), "system");
          yield { type: "reasoning_summary", turnId, stepId, summary: guardrailMessage };
          if (pendingGuardrailAction === "pause") {
            pendingCalls = calls.slice(1);
            stepCount++;
            await persistSafeToolBatchCheckpoint(pendingCalls);
            const checkpoint: AgentCheckpoint = { turnId, status: "interrupted_recoverable", interruptionReason: "repeated_tool_calls", stepCount, messages, pendingCalls, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
            yield { type: "turn_interrupted", turnId, checkpoint, error: guardrailMessage, termination: { reason: "repeated_tool_calls" } };
            return;
          }
        }
        if (result.status === "denied" && !verificationContinuation) {
          for (const skippedCall of calls.slice(1)) {
            const skippedResult = createSyntheticToolErrorResult(skippedCall, "TOOL_NOT_EXECUTED_AFTER_DENIAL", "前序工具调用被拒绝，后续同批工具未执行");
            pushMessage(toToolMessage(skippedCall, skippedResult), "conversation");
            projectContextUsageSnapshot();
            const resumeSkippedUsageEvent = contextUsageUpdatedEvent();
            if (resumeSkippedUsageEvent) yield resumeSkippedUsageEvent;
            completedCallIds.add(skippedCall.id);
            const skippedDisplay = buildToolDisplayInfo(skippedCall.name, skippedCall.input, undefined, skippedResult.error.code);
            yield { type: "tool_result", turnId, stepId, callId: skippedCall.id, toolName: skippedCall.name, result: skippedResult, retryCount: 0, ...skippedDisplay };
          }
          await persistSafeToolBatchCheckpoint([]);
          const resumeDeniedCode = result.status === "denied" ? result.error.code : undefined;
          const deniedMessage = getDeniedTerminalMessage(resumeDeniedCode);
          yield { type: "answer_delta", turnId, stepId, delta: deniedMessage };
          const checkpoint: AgentCheckpoint = { turnId, status: "failed", stepCount, messages: [...messages, createAgentTextMessage("assistant", deniedMessage)], completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
          yield { type: "turn_failed", turnId, error: deniedMessage, errorCode: isSandboxAvailabilityFailureCode(resumeDeniedCode ?? "") ? resumeDeniedCode : undefined, checkpoint };
          return;
        }
        resumeApprovalAvailable = false;
        needsResumeApproval = false;
        pendingCalls = calls.slice(1);
        await persistSafeToolBatchCheckpoint(pendingCalls);
        for await (const inputEvent of drainSteer("after_tools")) yield inputEvent;
        stepCount++;
        continue;
      }
      for await (const inputEvent of drainSteer("before_sample")) yield inputEvent;
      const visibleTools = toModelTools(getVisibleToolDefinitions());
      if (context.contextCompaction?.shouldCompact({ messages, usageAnchor, tools: visibleTools })) {
        yield { type: "context_compact_started", turnId, trigger: "auto" };
        try {
          const compacted = await context.contextCompaction.compact({ messages: [...messages], signal: currentSignal });
          rebuildLedgerAfterCompact(compacted.messages);
          restoreTodoSnapshotIfNeeded();
          usageAnchor = undefined;
          // compact 后旧 usage 立即失效：投影降级为估算，直到下一次完整 Provider usage 到达。
          projectContextUsageSnapshot();
          const checkpoint: AgentCheckpoint = {
            turnId,
            status: "running",
            stepCount,
            messages,
            pendingCalls,
            completedCallIds: [...completedCallIds],
            consumedInputIds: [...consumedInputIds],
            ...mutationGateSnapshot(),
            ...runtimeBudgetSnapshot(),
            ...contextUsageSnapshot(),
            ...toolGuardrailSnapshot(),
            ...todoSnapshotSnapshot(),
            ...checkpointContext(context.contextSnapshot, activeSkills),
          };
          yield {
            type: "context_compacted",
            turnId,
            trigger: "auto",
            summary: compacted.summary,
            preTokens: compacted.preTokens,
            postTokens: compacted.postTokens,
            preservedFromIndex: compacted.preservedFromIndex,
            checkpoint,
          };
          // Plan 7.3 事件顺序：context_compacted 之后发布 estimated 投影，下一完整 usage 后再切回 measured/projected。
          const compactUsageEvent = contextUsageUpdatedEvent();
          if (compactUsageEvent) yield compactUsageEvent;
        } catch (error) {
          const message = error instanceof Error ? error.message : "auto compact 失败";
          const checkpoint: AgentCheckpoint = {
            turnId,
            status: "failed",
            stepCount,
            messages,
            pendingCalls,
            completedCallIds: [...completedCallIds],
            consumedInputIds: [...consumedInputIds],
            ...mutationGateSnapshot(),
            ...usageAnchorSnapshot(),
            ...runtimeBudgetSnapshot(),
            ...contextUsageSnapshot(),
            ...toolGuardrailSnapshot(),
            ...todoSnapshotSnapshot(),
            ...checkpointContext(context.contextSnapshot, activeSkills),
          };
          yield { type: "context_compact_failed", turnId, trigger: "auto", error: message };
          yield { type: "turn_failed", turnId, checkpoint, error: message };
          return;
        }
      }
      // before_sample：锚点后新增的 steer/工具结果已进入下一次预测，三态口径与 auto compact 一致。
      projectContextUsageSnapshot();
      // before_sample 是 Turn 内首帧 usage 事件的发布点；后续同值由去重状态拦截。
      const sampleUsageEvent = contextUsageUpdatedEvent();
      if (sampleUsageEvent) yield sampleUsageEvent;
      yield { type: "reasoning_summary", turnId, stepId, summary: "正在思考" };
      injectedSinceSample = false;
      let sampled: AgentSampleResult | undefined;
      let streamedContent = "";
      // 输出截断或空响应恢复时扩大输出预算，避免模型把预算耗尽在隐藏推理上后仍无法发起工具调用。
      const recoveryMaxTokens = outputRecoveryAttempts > 0 || emptyReplyRetries > 0
        ? DEFAULT_OUTPUT_RECOVERY_MAX_TOKENS
        : undefined;

      // ── 采样段：捕获 AgentSampleError 并进入有界恢复 ──
      try {
        const sampleMessages = context.chat?.projectEvidenceMessages(messages) ?? messages;
        const answerAvailable = context.chat?.retrievalMode === "rag" && context.chat.hasAnswerEvidence();
        const forceAnswer = answerAvailable && (hasAnswerMarker(answerFinalizeMarker) || hasAnswerMarker(answerCorrectionMarker));
        const sampleTools = forceAnswer ? [CHAT_RAG_ANSWER_TOOL] : answerAvailable ? [...visibleTools, CHAT_RAG_ANSWER_TOOL] : visibleTools;
        const sampleOptions = forceAnswer ? { ...context.modelSampleOptions, toolChoice: { name: CHAT_RAG_ANSWER_TOOL.function.name } } : context.modelSampleOptions;
        for await (const event of streamModelSample(context.modelSampler, sampleMessages, sampleTools, currentSignal, recoveryMaxTokens, sampleOptions)) {
          if ("delta" in event) {
            streamedContent += event.delta;
            if (context.chat?.retrievalMode !== "rag") yield { type: "answer_delta", turnId, stepId, delta: event.delta };
          } else {
            sampled = event.sampled;
          }
        }
      } catch (sampleError) {
        // 用户取消优先级最高
        if (currentSignal.aborted) {
          const checkpoint: AgentCheckpoint = { turnId, status: "interrupted", stepCount, messages, pendingCalls, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
          yield { type: "turn_interrupted", turnId, checkpoint, error: "用户已取消当前任务" };
          return;
        }
        if (!(sampleError instanceof AgentSampleError)) throw sampleError;

        const code = sampleError.code;
        if (code === "CONTEXT_OVERFLOW") {
          const checkpoint: AgentCheckpoint = { turnId, status: "failed", stepCount, messages, pendingCalls, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
          yield { type: "context_overflow", turnId, stepId, checkpoint };
          return;
        }
        // 4xx 配置/协议/模型错误不会因追加“输出截断”提示而恢复，必须立即保留准确的安全诊断。
        if (code === "PROVIDER_REQUEST_REJECTED") {
          if (streamedContent) yield { type: "answer_discard", turnId, stepId };
          const checkpoint: AgentCheckpoint = { turnId, status: "failed", stepCount, messages, pendingCalls, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
          yield { type: "turn_failed", turnId, checkpoint, error: sampleError.message };
          return;
        }
        const transientProviderError = isTransientProviderError(code);
        const maxAttempts = transientProviderError ? MAX_PROVIDER_RECOVERY_ATTEMPTS
          : code === "TOOL_CALL_INVALID_JSON" ? MAX_INVALID_JSON_RETRIES
          : code === "EMPTY_RESPONSE" ? MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS
          : MAX_OUTPUT_RECOVERY_ATTEMPTS;
        const attempts = transientProviderError ? providerRecoveryAttempts
          : code === "TOOL_CALL_INVALID_JSON" ? invalidJsonRetries
          : code === "EMPTY_RESPONSE" ? emptyReplyRetries
          : outputRecoveryAttempts;

        if (attempts >= maxAttempts) {
          if (streamedContent) yield { type: "answer_discard", turnId, stepId };
          const checkpoint: AgentCheckpoint = { turnId, status: "failed", stepCount, messages, pendingCalls, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
          yield { type: "turn_failed", turnId, checkpoint, error: getRecoveryLimitMessage(code) };
          return;
        }

        if (transientProviderError) {
          providerRecoveryAttempts++;
        } else if (code === "TOOL_CALL_INVALID_JSON") {
          invalidJsonRetries++;
        } else if (code === "EMPTY_RESPONSE") {
          emptyReplyRetries++;
        } else {
          outputRecoveryAttempts++;
        }
        const currentAttempts = transientProviderError ? providerRecoveryAttempts
          : code === "TOOL_CALL_INVALID_JSON" ? invalidJsonRetries
          : code === "EMPTY_RESPONSE" ? emptyReplyRetries
          : outputRecoveryAttempts;

        if (streamedContent) yield { type: "answer_reset", turnId, stepId };
        yield { type: "model_recovery", turnId, stepId, reason: code, attempt: currentAttempts, maxAttempts };
        if (!transientProviderError) {
          pushMessage(createAgentTextMessage("system", code === "EMPTY_RESPONSE" ? EMPTY_RESPONSE_RECOVERY_MESSAGE : RECOVERY_META_MESSAGE), "system");
        }
        stepCount++;
        continue;
      }

      if (!sampled) throw new Error("Agent 模型采样未返回结果");
      recordSampleUsage(sampled);
      if (context.chat?.retrievalMode === "rag") {
        // 任何模型事实（含工具前叙述与推理摘要）都不得先流出再撤回。
        const submissions = sampled.toolCalls.filter(function isAnswer(call) { return call.name === CHAT_RAG_ANSWER_TOOL.function.name; });
        const forced = context.chat.hasAnswerEvidence() && (hasAnswerMarker(answerFinalizeMarker) || hasAnswerMarker(answerCorrectionMarker));
        if (!sampled.toolCalls.length && context.chat.hasAnswerEvidence() && !forced) {
          pushMessage(createAgentTextMessage("system", `${answerFinalizeMarker}\n${CHAT_RAG_ANSWER_CORRECTION_MESSAGE}`), "system");
          yield { type: "reasoning_summary", turnId, stepId, summary: "正在整理有依据的答案" };
          stepCount++;
          continue;
        }
        // 提交必须独占本次调用；混合调用和强制收尾中返回其他工具均不得执行。
        const finalizing = !sampled.toolCalls.length || submissions.length > 0 || forced;
        const submission = submissions.length === 1 && sampled.toolCalls.length === 1 ? submissions[0].input : undefined;
        const content = finalizing ? await context.chat.guardAnswer(submission, currentSignal) : "";
        const correction = context.chat.takeAnswerCorrection();
        if (correction && !currentSignal.aborted && !hasAnswerMarker(answerCorrectionMarker)) {
          pushMessage(createAgentTextMessage("system", `${answerCorrectionMarker}\n${correction}`), "system");
          yield { type: "reasoning_summary", turnId, stepId, summary: "正在重新核对引用原文" };
          stepCount++;
          continue;
        }
        sampled = { ...sampled, content, ...(finalizing ? { toolCalls: [], finishReason: "stop", usage: undefined } : {}), reasoningSummary: "正在核验本地知识证据", reasoningContent: undefined, adapterReplayState: undefined };
        streamedContent = "";
        if (currentSignal.aborted) {
          yield { type: "turn_interrupted", turnId, error: "用户已取消当前任务", checkpoint: { turnId, status: "interrupted", stepCount, messages, completedCallIds: [...completedCallIds], ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot() } };
          return;
        }
      }
      // Provider adapters 自动生成的工具名清单会与工具卡重复；保留其他安全摘要原文。
      const displayReasoningSummary = sampled.toolCalls.length > 0 && sampled.reasoningSummary.startsWith("模型请求调用 ")
        ? "正在思考"
        : sampled.reasoningSummary;
      if (displayReasoningSummary !== lastYieldedReasoningSummary) {
        lastYieldedReasoningSummary = displayReasoningSummary;
        yield { type: "reasoning_summary", turnId, stepId, summary: displayReasoningSummary };
      }
      if (!sampled.toolCalls.length) {
        for await (const inputEvent of drainSteer("after_sample")) yield inputEvent;
        if (!sampled.content.trim()) {
          if (emptyReplyRetries < 1) {
            emptyReplyRetries++;
            yield { type: "model_recovery", turnId, stepId, reason: "EMPTY_RESPONSE", attempt: emptyReplyRetries, maxAttempts: 1 };
            pushMessage(createAgentTextMessage("system", EMPTY_RESPONSE_RECOVERY_MESSAGE), "system");
            stepCount++;
            continue;
          }
          const checkpoint: AgentCheckpoint = { turnId, status: "failed", stepCount, messages, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
          yield { type: "turn_failed", turnId, checkpoint, error: "模型连续返回空响应，未执行工具或产生可显示答复" };
          return;
        }
        const remainingContent = sampled.content.slice(streamedContent.length);
        if (remainingContent) yield { type: "answer_delta", turnId, stepId, delta: remainingContent };
        await context.inputInbox?.waitForInput?.({ turnId, timeoutMs: 25 });
        for await (const inputEvent of drainSteer("before_complete")) yield inputEvent;
        if (injectedSinceSample) {
          if (streamedContent) yield { type: "answer_reset", turnId, stepId };
          stepCount++;
          continue;
        }
        const completionDecision = completionPolicy.evaluate({
          state: { required: mutationRequired, strong: mutationStrong, changedPaths, verifiedPaths, recoveryAttempts: mutationGateRecoveryAttempts },
        });
        if (completionDecision.action === "pause") {
          verificationOnly = true;
          if (streamedContent) yield { type: "answer_discard", turnId, stepId };
          pushMessage(createAgentTextMessage("system", completionDecision.message), "system");
          const checkpoint: AgentCheckpoint = { turnId, status: "interrupted_recoverable", interruptionReason: "write_verification", stepCount, messages, completedCallIds: [...completedCallIds], consumedInputIds: [...consumedInputIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
          yield { type: "turn_interrupted", turnId, checkpoint, error: completionDecision.reason };
          return;
        }
        if (completionDecision.action === "fail") {
          if (streamedContent) yield { type: "answer_discard", turnId, stepId };
          const checkpoint: AgentCheckpoint = { turnId, status: "failed", stepCount, messages, completedCallIds: [...completedCallIds], consumedInputIds: [...consumedInputIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
          yield { type: "turn_failed", turnId, checkpoint, error: completionDecision.reason };
          return;
        }
        if (completionDecision.action === "retry") {
          if (streamedContent) yield { type: "answer_discard", turnId, stepId };
          mutationGateRecoveryAttempts++;
          pushMessage(createAgentTextMessage("system", completionDecision.message), "system");
          stepCount++;
          continue;
        }
        pushMessage(toAssistantMessage(sampled), "conversation");
        const completedMessages = [...messages];
        updateUsageAnchor(sampled, completedMessages.length, completedMessages);
        // 终态消息包含最后的 assistant 回复：以完整消息列表刷新 measured 投影。
        projectContextUsageSnapshot(completedMessages);
        // Plan 12.2：measured 事件先于 terminal 边界对外发布。
        const completionUsageEvent = contextUsageUpdatedEvent();
        if (completionUsageEvent) yield completionUsageEvent;
        const checkpoint: AgentCheckpoint = { turnId, status: "completed", stepCount, messages: completedMessages, completedCallIds: [...completedCallIds], consumedInputIds: [...consumedInputIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
        yield { type: "turn_completed", turnId, checkpoint };
        return;
      }
      const remainingProcessContent = sampled.content.startsWith(streamedContent)
        ? sampled.content.slice(streamedContent.length)
        : "";
      if (context.chat?.retrievalMode !== "rag" && remainingProcessContent) yield { type: "answer_delta", turnId, stepId, delta: remainingProcessContent };
      if (context.chat?.retrievalMode !== "rag" && (streamedContent || remainingProcessContent)) yield { type: "answer_reset", turnId, stepId };
      // 思考模式工具调用续接只保存在 assistant reasoning block，不进入任何对外事件/DTO。
      const sampledMessage = toAssistantMessage(sampled);
      pushMessage(sampledMessage, "conversation");
      const sampledToolCalls = getAgentToolCalls(sampledMessage);
      if (yield* rejectInvalidCalls(sampledToolCalls, stepId)) return;
      updateUsageAnchor(sampled, messages.length);
      // 完整 Provider usage 到达：立即以最新锚点刷新为 measured 投影，先于工具边界对外发布。
      projectContextUsageSnapshot();
      const measuredUsageEvent = contextUsageUpdatedEvent();
      if (measuredUsageEvent) yield measuredUsageEvent;
      const interactiveCalls = sampledToolCalls.filter(function isInteractiveCall(call) { return call.name === "ask_user_question"; });
      if (interactiveCalls.length > 0 && (interactiveCalls.length !== 1 || sampledToolCalls.length !== 1)) {
        for (const call of sampledToolCalls) {
          const result = createInteractiveToolConflictResult(call);
          pushMessage(toToolMessage(call, result), "conversation");
          projectContextUsageSnapshot();
          const conflictUsageEvent = contextUsageUpdatedEvent();
          if (conflictUsageEvent) yield conflictUsageEvent;
          const display = buildToolDisplayInfo(call.name, call.input, undefined, result.error.code);
          yield { type: "tool_result", turnId, stepId, callId: call.id, toolName: call.name, result, retryCount: 0, ...display };
        }
        pushMessage(createAgentTextMessage("system", "ask_user_question 是唯一的交互工具调用。请只调用该工具一次，或在不需要澄清时继续正常回答。"), "system");
        pendingCalls = undefined;
        await persistSafeToolBatchCheckpoint();
        stepCount++;
        continue;
      }
      for (const call of sampledToolCalls) {
        const startDisplay = buildToolDisplayInfo(call.name, call.input);
        yield { type: "tool_started", turnId, stepId, callId: call.id, toolName: call.name, ...startDisplay };
      }

      for (let index = 0; index < sampledToolCalls.length;) {
        const batch: AgentToolCall[] = [];
        if (context.toolRegistry.get(sampledToolCalls[index].name).metadata.effect === "none") {
          while (index < sampledToolCalls.length && context.toolRegistry.get(sampledToolCalls[index].name).metadata.effect === "none") batch.push(sampledToolCalls[index++]);
        } else {
          batch.push(sampledToolCalls[index++]);
        }
        // 完成通知与进度共用一个队列；结果不等整批返回，checkpoint 仍保留完整批次边界。
        const progressQueue: Array<{ kind: "progress"; callId: string; tail: string } | { kind: "result"; item: ScheduledToolResult }> = [];
        const batchMessageStart = messages.length;
        const batchContributionStart = messageContributions.length;
        const insertedResultIndexes = new Set<number>();
        let progressWaiter = new Promise<void>(() => undefined);
        let wakeProgress: () => void = () => undefined;
        function armProgressWaiter(): void {
          progressWaiter = new Promise<void>((resolve) => { wakeProgress = resolve; });
        }
        armProgressWaiter();
        const resultsPromise = scheduler.executeCalls(batch, {
          signal: currentSignal,
          maxRetries: context.maxToolRetries,
          onProgress: function queueProgress(callId, tail) { progressQueue.push({ kind: "progress", callId, tail }); wakeProgress(); armProgressWaiter(); },
          onResult: function queueResult(item) { progressQueue.push({ kind: "result", item }); wakeProgress(); armProgressWaiter(); },
        });
        let results: ScheduledToolResult[] | undefined;
        while (results === undefined || progressQueue.length > 0) {
          if (progressQueue.length > 0) {
            for (const progressItem of progressQueue.splice(0)) {
              if (progressItem.kind === "progress") {
                const progressCall = batch.find((call) => call.id === progressItem.callId);
                yield { type: "tool_progress", turnId, stepId, callId: progressItem.callId, toolName: progressCall?.name ?? "tool", tail: progressItem.tail };
                continue;
              }
              const item = progressItem.item;
              // 等待交互不是模型结果；整批结束后由既有暂停分支处理，不能抛弃同批活动调用。
              if (item.result.status === "question_required" || item.result.status === "approval_required") continue;
              const resultIndex = batch.findIndex(function matchesCall(call) { return call.id === item.call.id; });
              const precedingResults = [...insertedResultIndexes].filter(function precedes(index) { return index < resultIndex; }).length;
              const insertionIndex = batchMessageStart + precedingResults;
              const message = toToolMessage(item.call, item.result);
              // 仅在当前 usage anchor 覆盖前缀之后插入；账本与 canonical 顺序同步，晚完成的前项不会卡住快结果计量。
              messages.splice(insertionIndex, 0, message);
              messageContributions.splice(batchContributionStart + precedingResults, 0, [{ kind: "conversation", weight: estimateMessageTokens([message]) }]);
              insertedResultIndexes.add(resultIndex);
              recordMutationToolResult(item.call, item.result);
              if (item.call.name === "skill" && item.result.status === "success") {
                const output = item.result.output as { skillId?: string; contentHash?: string };
                if (typeof output.skillId === "string" && typeof output.contentHash === "string" && !activeSkills.some((skill) => skill.skillId === output.skillId)) activeSkills.push({ skillId: output.skillId, contentHash: output.contentHash });
              }
              completedCallIds.add(item.call.id);
              projectContextUsageSnapshot();
              const toolUsageEvent = contextUsageUpdatedEvent();
              if (toolUsageEvent) yield toolUsageEvent;
              const resultErrorCode = item.result.status === "error" ? item.result.error.code : undefined;
              const resultDisplay = buildToolDisplayInfo(item.call.name, item.call.input, "output" in item.result ? item.result.output : undefined, resultErrorCode);
              yield { type: "tool_result", turnId, stepId, callId: item.call.id, toolName: item.call.name, result: item.result, retryCount: item.retryCount, ...resultDisplay };
            }
            continue;
          }
          const progressOutcome = await Promise.race([resultsPromise.then((value) => ({ kind: "done" as const, value })), progressWaiter.then(() => ({ kind: "wake" as const }))]);
          if (progressOutcome.kind === "done") results = progressOutcome.value;
        }
        let deniedInBatch = false;
        let deniedErrorCode: string | undefined;
        let guardrailAction: "reminder" | "strong" | "pause" | undefined;
        for (const item of results) {
          if (item.result.status === "question_required") {
            pendingUserQuestion = { callId: item.call.id, requestId: item.result.request.requestId, questions: item.result.request.questions };
            const checkpoint: AgentCheckpoint = { turnId, status: "awaiting_user_input", stepCount, messages, pendingCalls: [item.call], pendingUserQuestion, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
            yield { type: "question_required", turnId, stepId, callId: item.call.id, requestId: item.result.request.requestId, questions: item.result.request.questions };
            yield { type: "turn_paused", turnId, checkpoint };
            return;
          }
          if (item.result.status === "approval_required") {
            applyWebFetchRedirect(item.call, item.result, messages);
            const remainingCalls = sampledToolCalls.filter(function isUncompleted(call) { return !completedCallIds.has(call.id); });
            const checkpoint: AgentCheckpoint = { turnId, status: "awaiting_approval", stepCount, messages, pendingCalls: remainingCalls, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
            yield { type: "approval_required", turnId, stepId, callId: item.call.id, toolName: item.call.name, result: item.result };
            yield { type: "turn_paused", turnId, checkpoint };
            return;
          }
          completedCallIds.add(item.call.id);
          const todoOutput = item.call.name === "todo_write" && item.result.status === "success"
            ? item.result.output as TodoWriteResult
            : undefined;
          const todoProgressed = todoOutput ? hasTodoProgress(todoSnapshot, todoOutput.todos) : false;
          const mutationProgressed = item.result.status === "success"
            && context.toolRegistry.get(item.call.name).metadata.effect !== "none";
          // Todo 只有实际推进才打断重复计数；重复提交同一快照继续参与护栏计数。
          const observedGuardrailAction = todoProgressed ? undefined : observeToolProgress(item.call, item.result);
          if (observedGuardrailAction && (!guardrailAction || getToolGuardrailPriority(observedGuardrailAction) > getToolGuardrailPriority(guardrailAction))) guardrailAction = observedGuardrailAction;
          // todo_write 仅在成功终态后落 todo_updated；失败、拒绝或取消不替换当前列表。
          if (todoOutput) {
            todoSnapshot = { todoChainId, todos: todoOutput.todos, counts: todoOutput.counts };
            if (todoProgressed) {
              resetToolGuardrail();
              guardrailAction = undefined;
            }
            yield { type: "todo_updated", turnId, todoChainId, todos: todoOutput.todos, counts: todoOutput.counts };
          }
          if (mutationProgressed) guardrailAction = undefined;
          if (item.result.status === "denied") {
            deniedInBatch = true;
            deniedErrorCode ??= item.result.error.code;
          }
        }
        pendingCalls = sampledToolCalls.slice(index);
        if (deniedInBatch && !verificationContinuation) {
          for (const skippedCall of sampledToolCalls.slice(index)) {
            const skippedResult = createSyntheticToolErrorResult(skippedCall, "TOOL_NOT_EXECUTED_AFTER_DENIAL", "前序工具调用被拒绝，后续同批工具未执行");
            pushMessage(toToolMessage(skippedCall, skippedResult), "conversation");
            projectContextUsageSnapshot();
            const skippedUsageEvent = contextUsageUpdatedEvent();
            if (skippedUsageEvent) yield skippedUsageEvent;
            completedCallIds.add(skippedCall.id);
            const skippedDisplay = buildToolDisplayInfo(skippedCall.name, skippedCall.input, undefined, skippedResult.error.code);
            yield { type: "tool_result", turnId, stepId, callId: skippedCall.id, toolName: skippedCall.name, result: skippedResult, retryCount: 0, ...skippedDisplay };
          }
          pendingCalls = undefined;
          await persistSafeToolBatchCheckpoint();
          const deniedMessage = getDeniedTerminalMessage(deniedErrorCode);
          yield { type: "answer_delta", turnId, stepId, delta: deniedMessage };
          const checkpoint: AgentCheckpoint = { turnId, status: "failed", stepCount, messages: [...messages, createAgentTextMessage("assistant", deniedMessage)], completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
          yield { type: "turn_failed", turnId, error: deniedMessage, errorCode: isSandboxAvailabilityFailureCode(deniedErrorCode ?? "") ? deniedErrorCode : undefined, checkpoint };
          return;
        }
        if (guardrailAction) {
          const guardrailMessage = getToolGuardrailMessage(guardrailAction);
          pushMessage(createAgentTextMessage("system", guardrailMessage), "system");
          yield { type: "reasoning_summary", turnId, stepId, summary: guardrailMessage };
          if (guardrailAction === "pause") {
            stepCount++;
            await persistSafeToolBatchCheckpoint(pendingCalls);
            const checkpoint: AgentCheckpoint = { turnId, status: "interrupted_recoverable", interruptionReason: "repeated_tool_calls", stepCount, messages, pendingCalls, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
            yield { type: "turn_interrupted", turnId, checkpoint, error: guardrailMessage, termination: { reason: "repeated_tool_calls" } };
            return;
          }
        }
        await persistSafeToolBatchCheckpoint(pendingCalls);
      }
      for await (const inputEvent of drainSteer("after_tools")) yield inputEvent;
      stepCount++;
    }
    if (maxSteps !== undefined) {
      const checkpoint: AgentCheckpoint = { turnId, status: "limit_reached", stepCount, messages, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
      yield { type: "turn_limit_reached", turnId, checkpoint, termination: { reason: "turn_limit_reached" } };
    }
  } catch (error) {
    if (currentSignal.aborted || (error instanceof Error && error.name === "AbortError")) {
      const checkpoint: AgentCheckpoint = { turnId, status: "interrupted", stepCount, messages, pendingCalls, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
      yield { type: "turn_interrupted", turnId, checkpoint, error: "用户已取消当前任务" };
      return;
    }
    const checkpoint: AgentCheckpoint = { turnId, status: "failed", stepCount, messages, pendingCalls, completedCallIds: [...completedCallIds], ...mutationGateSnapshot(), ...usageAnchorSnapshot(), ...runtimeBudgetSnapshot(), ...contextUsageSnapshot(), ...toolGuardrailSnapshot(), ...todoSnapshotSnapshot(), ...checkpointContext(context.contextSnapshot, activeSkills) };
    yield { type: "turn_failed", turnId, checkpoint, error: error instanceof Error ? error.message : "Agent Loop 执行失败" };
  }
}
