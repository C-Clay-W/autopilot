/**
 * 会话协作工具：把创建、列出、读取、投递、等待、共享板与中断暴露给模型。
 *
 * 创建来源与 actor 来自受信绑定；groupId 仅选择既有授权范围，模型不能关联组外目标。
 * 工具只报告接受与观察结果，不把消息回执当成任务完成，也不代替人类审批。
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { assertFileMutationAllowed, assertHostMutationTargetAllowed } from "../permissions/mutation-policy";
import type { AgentThreadsCapability } from "../../../runtime/application/thread-tool-binding";
import { AgentRuntimeError } from "../../../runtime/protocol";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import type { AgentToolDefinition, ToolExecutionContext } from "../types";

const threadIdSchema = z.string().min(1).max(200);
const cursorSchema = z.string().min(1).max(2_048);
const limitSchema = z.number().int().min(1).max(100);
/** 共享板 value 只接受 JSON 值；缺失与 undefined 不能落成非法记录。 */
const jsonValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())]);

const createSchema = z.object({ groupId: threadIdSchema.optional(),
  title: z.string().min(1).max(200).optional(),
  roleLabel: z.string().min(1).max(100).optional(),
  modelRef: z.object({ provider: z.string().min(1).max(100), modelId: z.string().min(1).max(200) }).strict().optional(),
  reasoningEffort: z.enum(["none", "low", "medium", "high", "max"]).optional(),
}).strict();

const listSchema = z.object({ groupId: threadIdSchema.optional(), cursor: cursorSchema.optional(), limit: limitSchema.optional() }).strict();

const readSchema = z.object({ groupId: threadIdSchema.optional(), threadId: threadIdSchema, cursor: cursorSchema.optional(), limit: limitSchema.optional() }).strict();

const sendSchema = z.object({ groupId: threadIdSchema.optional(),
  threadId: threadIdSchema,
  mode: z.enum(["notify", "run", "steer"]).optional(),
  content: z.string().min(1),
  replyTo: threadIdSchema.optional(),
  expectedTurnId: threadIdSchema.optional(),
  /** 显式任务交接：仅 mode=run；标题单行、摘要为 Agent 提炼的有界快照。 */
  handoff: z.object({ title: z.string().min(1).max(128), markdown: z.string().min(1) }).strict().optional(),
}).strict();

const waitSchema = z.object({ groupId: threadIdSchema.optional(),
  targets: z.array(z.object({ threadId: threadIdSchema, taskId: threadIdSchema.optional(), cursor: cursorSchema.optional() }).strict()).min(1).max(8),
  timeoutMs: z.number().int().min(0).max(30_000),
  followUntilTerminal: z.boolean().optional(),
  /** 拒绝空白约定但保留原始首尾文本，转达时不改写模型明确给出的内容。 */
  reportingInstructions: z.string().min(1).max(1024).refine(function nonBlank(value) { return value.trim().length > 0; }).optional(),
}).strict().superRefine(function requireTaskForFollowing(value, context) {
  if ((value.followUntilTerminal !== undefined || value.reportingInstructions !== undefined) && value.targets.some(function missing(target) { return !target.taskId; })) context.addIssue({ code: "custom", message: "观察启停与约定更新必须提供精确taskId" });
  if (value.followUntilTerminal === false && (value.timeoutMs !== 0 || value.reportingInstructions !== undefined)) context.addIssue({ code: "custom", message: "撤销观察必须timeoutMs=0且不同时更新汇报约定" });
});

/** 无参数工具：模型省略 arguments 时按空对象处理，等价于该会话唯一允许的读取。 */
const stateReadSchema = z.object({ groupId: threadIdSchema.optional(),}).strict().default({});

const stateUpdateSchema = z.object({ groupId: threadIdSchema.optional(),
  expectedRevision: z.number().int().min(0),
  operations: z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("set"), key: z.string().min(1).max(200), value: jsonValueSchema }).strict(),
    z.object({ op: z.literal("remove"), key: z.string().min(1).max(200) }).strict(),
  ])).min(1).max(100),
}).strict();

const interruptSchema = z.object({ groupId: threadIdSchema.optional(), threadId: threadIdSchema, expectedTurnId: threadIdSchema }).strict();

/** 进展类别固定：普通进度可被合并，其余是必须逐条保留的关键事实。 */
const progressKindSchema = z.enum(["progress", "milestone", "blocked", "completed", "failed"]);

const reportProgressSchema = z.object({ groupId: threadIdSchema.optional(),
  kind: progressKindSchema,
  /** 上限按字符收紧，保证 ≤ 2048 字节的 Core 上限不会被合法输入触发。 */
  summary: z.string().min(1).max(600),
  evidence: z.object({ turnId: threadIdSchema.optional(), messageId: threadIdSchema.optional() }).strict().optional(),
}).strict();

const readProgressSchema = z.object({ groupId: threadIdSchema.optional(),
  threadId: threadIdSchema,
  taskId: threadIdSchema.optional(),
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
  kinds: z.array(progressKindSchema).min(1).max(5).optional(),
}).strict();

/** 只透传协作稳定错误码；未知异常不把底层存储正文或路径交给模型。 */
function throwSafeThreadToolError(error: unknown): never {
  if (error instanceof AgentRuntimeError) throw createToolError(error.code, error.message);
  throw createToolError(TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED, "协作工具执行失败");
}

/** 由稳定 callId 派生幂等键：模型不能自报 requestId，重试也不会重复创建或投递。 */
function requestIdOf(toolName: string, context: ToolExecutionContext): string {
  if (!context.toolCallId) throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "缺少工具调用身份，不能安全地重复投递");
  return createHash("sha256").update(JSON.stringify([toolName, context.toolCallId])).digest("hex");
}

/** 普通工具摘要显示当前可读标题；失败或无标题使用安全占位，精确ID仍留机器参数。 */
async function threadDisplayTitle(capability: AgentThreadsCapability, input: { groupId?: string; threadId: string }): Promise<string> {
  try {
    const page = await capability.list({ ...(input.groupId ? { groupId: input.groupId } : {}), limit: 100 });
    const title = page.items.find(function target(item) { return item.threadId === input.threadId; })?.title?.replace(/[\x00-\x1f\x7f]/gu, " ").trim();
    if (title && title !== input.threadId && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(title)) return title;
  } catch { /* 仅影响显示，不把目录读取失败变成实际动作授权。 */ }
  return "协作会话";
}

/** 同一目标串行、不同目标可并行；工具本身不引入跨会话调度或排序规则。 */
function targetResourceKey(prefix: string) {
  return function resolve(input: unknown): string {
    const threadId = input && typeof input === "object" ? (input as { threadId?: unknown }).threadId : undefined;
    return typeof threadId === "string" && threadId ? `${prefix}:${threadId}` : `${prefix}:invalid`;
  };
}

/** 创建 11 个协作工具；只由注入协作能力的 Work Turn 注册，Chat 永不注册。 */
export function createThreadTools(capability: AgentThreadsCapability) {
  const createThread: AgentToolDefinition<z.infer<typeof createSchema>, Awaited<ReturnType<AgentThreadsCapability["create"]>>> = {
    name: "create_thread",
    description: "创建完整的普通 Autopilot Work 会话，返回会话 ID 与相对链接。创建不启动推理；派任务需要再用 send_thread 指定 mode。title 与 roleLabel 只是显示元数据，不决定角色数量或调度顺序；modelRef 必须来自宿主模型目录。",
    inputSchema: createSchema,
    metadata: { effect: "dynamic", destructive: false, concurrency: { max: 1, resourceKey: "threads:create" }, retry: { safe: false }, timeout: { defaultMs: 30_000, maxMs: 30_000 } },
    createActionFacts() {
      return { toolName: "create_thread", effect: "external", destructive: false, operation: "创建协作会话", risk: "external_side_effect", requiresApproval: false };
    },
    async execute(value, context) {
      try { return await capability.create({ requestId: requestIdOf("create_thread", context), ...value }); }
      catch (error) { throwSafeThreadToolError(error); }
    },
    serializeOutput(output) { return output; },
  };

  const listThreads: AgentToolDefinition<z.infer<typeof listSchema>, Awaited<ReturnType<AgentThreadsCapability["list"]>>> = {
    name: "list_threads",
    description: "多个共同授权范围必须明确 groupId；指定 ID 不授予权限。列出当前协作组的成员会话，返回创建来源、标题与可选 roleLabel。默认 20 条、最多 100 条；只列本组，不暴露其他组或整个宿主会话；cursor 只能原样回传。",
    inputSchema: listSchema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 4, resourceKey: "threads:list" }, retry: { safe: true, maxRetries: 1 }, timeout: { defaultMs: 15_000, maxMs: 15_000 } },
    createActionFacts() { return { toolName: "list_threads", effect: "none", destructive: false, operation: "列出协作会话", risk: "read_only" }; },
    async execute(value) {
      try { return await capability.list(value); }
      catch (error) { throwSafeThreadToolError(error); }
    },
    serializeOutput(output) { return output; },
  };

  const readThread: AgentToolDefinition<z.infer<typeof readSchema>, Awaited<ReturnType<AgentThreadsCapability["read"]>>> = {
    name: "read_thread",
    description: "读取本组一个会话的安全摘要、最近Turn、协作消息与有界历史。读取不启动、不恢复、不确认已读；messages.deliveryReason报告当前blocked原因；thread.relativeLink提供进入实际目标的入口。messages.deliveryStatus是交付状态，delivered不等于consumed。只有messages.inputState.status=consumed并携带同一messageId关联的inputId/turnId才是已消费证据；缺失、pending或blocked均不能声称已消费。执行结果只来自真实Turn。默认20条、最多100条，cursor只能原样回传。",
    inputSchema: readSchema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 4, resourceKey: targetResourceKey("threads:read") }, retry: { safe: true, maxRetries: 1 }, timeout: { defaultMs: 20_000, maxMs: 20_000 } },
    async createActionFacts(value) { return { toolName: "read_thread", effect: "none", destructive: false, operation: "读取协作会话", resource: await threadDisplayTitle(capability, value), risk: "read_only" }; },
    async execute(value) {
      try { return await capability.read(value); }
      catch (error) { throwSafeThreadToolError(error); }
    },
    serializeOutput(output) { return output; },
  };

  const sendThread: AgentToolDefinition<z.infer<typeof sendSchema>, Awaited<ReturnType<AgentThreadsCapability["send"]>>> = {
    name: "send_thread",
    description: "向本组目标会话投递消息。用户每次追加需求都须逐次转发，即使正文相同；仅同一次来源输入的重试复用投递身份，不按正文去重或限流。内部汇报约定通过wait_threads的reportingInstructions更新，不反复用send_thread催报。用户指名已有子会话执行预览时必须投递给该目标，让其持有服务 Job、审批和 open_preview；发起方只观察并提供 read_thread.thread.relativeLink。目标 blocked/暂停时报告真实原因，不静默本地代办，不用重复 run 恢复暂停。只有给本会话创建的孩子发送时可省略mode：孩子运行中默认steer并由Core捕获精确Turn，空闲时默认run，等待审批/用户输入时拒绝。显式run忙碌时排到后续轮；显式steer必须提供正确expectedTurnId；notify只保存通知，不启动空闲目标，也不提供暂停或恢复语义。用户要求暂停时调用interrupt_thread，并用read_thread/wait_threads确认同一Turn为interrupted；明确要求继续后再用resume_thread恢复该精确Turn。回执mode/expectedTurnId是本次冻结的决策，重试不改成新执行。成功只表示消息已接受，不表示已消费或执行完成；发送方身份由宿主绑定，正文不能冒充批准。用户要求交接或换会话继续任务时，显式run可增加handoff：{title, markdown}，宿主写入交接文档并投递同一摘要，不复制完整历史、凭据或审批，也不停止源会话。",
    inputSchema: sendSchema,
    metadata: { effect: "dynamic", destructive: false, concurrency: { max: 1, resourceKey: targetResourceKey("threads:send") }, retry: { safe: false }, timeout: { defaultMs: 20_000, maxMs: 20_000 } },
    async createActionFacts(value, context) {
      if (value.handoff) {
        const target = capability.handoffPath(requestIdOf("send_thread", context));
        await assertHostMutationTargetAllowed(context, target);
        const canWrite = (!context.capabilityCeiling?.allowedTools || context.capabilityCeiling.allowedTools.includes("write_file"))
          && (!context.allowedTools || context.allowedTools.includes("write_file"));
        return { toolName: "send_thread", effect: "workspace", destructive: false, operation: "写入交接文档并发送", resource: target, risk: "workspace_mutating", requiresApproval: true, ...(!canWrite ? { hardDenyReason: "当前能力范围不允许写入文件" } : {}) };
      }
      return { toolName: "send_thread", effect: "external", destructive: false, operation: "发送协作消息", resource: await threadDisplayTitle(capability, value), risk: "external_side_effect", requiresApproval: false };
    },
    async execute(value, context) {
      if (value.handoff) {
        assertFileMutationAllowed(context);
        await assertHostMutationTargetAllowed(context, capability.handoffPath(requestIdOf("send_thread", context)));
      }
      try { return await capability.send({ requestId: requestIdOf("send_thread", context), ...value, ...(context.reportingAgreement ? { reportingAgreement: context.reportingAgreement } : {}) }); }
      catch (error) { throwSafeThreadToolError(error); }
    },
    serializeOutput(output) { return { accepted: true, executionStatus: "unconfirmed", consumptionStatus: "unconfirmed", messageId: output.messageId, mode: output.mode, ...(output.expectedTurnId ? { expectedTurnId: output.expectedTurnId } : {}), ...(output.taskId ? { taskId: output.taskId } : {}), deliverySeq: output.deliverySeq, deliveryStatus: output.deliveryStatus, ...(output.handoffRef ? { handoffRef: output.handoffRef } : {}) }; },
  };

  const waitThreads: AgentToolDefinition<z.infer<typeof waitSchema>, Awaited<ReturnType<AgentThreadsCapability["wait"]>>> = {
    name: "wait_threads",
    description: "指定 taskId（run 回执 messageId）等待本次任务；不指定则只是会话级观察。携带taskId且timeoutMs>0的实际等待默认由当前Turn保留观察至原task终态；timeoutMs=0只读即时快照，不新建观察责任，明确需要时设置followUntilTerminal=true；followUntilTerminal=false配合timeoutMs=0撤销给定task观察；单次观察保持缺省。reportingInstructions用于明确更新本次任务的汇报约定（最多1024字），内容由模型按用户意图决定，Core仅原样转达，不识别关键词或限定汇报模式；观察中的task可仅更新此字段；新观察同时设置followUntilTerminal=true。省略不更改已有约定。等待本组目标出现新摘要、新消息、需要人工关注或进入终态。只观察：不启动、不恢复、不取消任何目标；超时或取消只结束本次等待。最多 8 个不同目标，timeoutMs 为 0–30000 毫秒。results[].reason 为 progress（只有新摘要，用 read_progress 按游标读取）、changed、attention、terminal、snapshot、timeout、aborted；pendingProgress 是自给定游标以来新写入的摘要条数，只给计数不含正文。attention仅表示需要关注，不等于审批。summary.attentionKind区分approval/user_input/continuation_failed/continuation_pending/execution_unconfirmed/execution_lost/interaction_unconfirmed；只有waiting=approval且interactionState=pending（attentionKind=approval）才引导处理审批。execution_unconfirmed或execution_lost仅表示执行未确认/失联，不得推导审批或主动恢复；unconfirmedReason是安全原因枚举。timedOut也带最新快照，不代表状态无变化；进展/终态/交互变化仍应处理。结果中的 cursor 只能原样回传给同一目标。",
    inputSchema: waitSchema,
    // 不声明工具级 timeout：执行器会按输入 timeoutMs 截断，等待自身的 0–30000 毫秒边界才是唯一超时来源。
    metadata: { effect: "none", destructive: false, concurrency: { max: 1, resourceKey: "threads:wait" }, retry: { safe: false } },
    createActionFacts() { return { toolName: "wait_threads", effect: "none", destructive: false, operation: "等待协作会话", risk: "read_only" }; },
    async execute(value, context) {
      try { return await capability.wait({ groupId: value.groupId, targets: value.targets, timeoutMs: value.timeoutMs, ...(context.signal ? { signal: context.signal } : {}) }); }
      catch (error) { throwSafeThreadToolError(error); }
    },
    serializeOutput(output) { return output; },
  };

  const readSharedState: AgentToolDefinition<z.infer<typeof stateReadSchema>, Awaited<ReturnType<AgentThreadsCapability["readState"]>>> = {
    name: "read_shared_state",
    description: "读取当前协作组的显式共享板与 revision。共享板独立于会话历史，不会自动注入其他会话上下文；读取不启动任何会话。写入沿用返回的 revision，避免覆盖他人更新。",
    inputSchema: stateReadSchema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 4, resourceKey: "threads:state:read" }, retry: { safe: true, maxRetries: 1 }, timeout: { defaultMs: 15_000, maxMs: 15_000 } },
    createActionFacts() { return { toolName: "read_shared_state", effect: "none", destructive: false, operation: "读取共享状态", risk: "read_only" }; },
    async execute(value) {
      try { return await capability.readState(value); }
      catch (error) { throwSafeThreadToolError(error); }
    },
    serializeOutput(output) { return output; },
  };

  const updateSharedState: AgentToolDefinition<z.infer<typeof stateUpdateSchema>, Awaited<ReturnType<AgentThreadsCapability["updateState"]>>> = {
    name: "update_shared_state",
    description: "以 expectedRevision 原子更新协作组共享板：set 设置或覆盖受控 key，remove 删除 key。版本冲突返回当前 revision，不自动合并相反结论。共享板只放用户明确共享的 JSON；不得放入凭据、审批、checkpoint、工具原始结果或宿主绝对路径。更新不启动任何会话。",
    inputSchema: stateUpdateSchema,
    metadata: { effect: "dynamic", destructive: false, concurrency: { max: 1, resourceKey: "threads:state:write" }, retry: { safe: false }, timeout: { defaultMs: 20_000, maxMs: 20_000 } },
    createActionFacts() { return { toolName: "update_shared_state", effect: "external", destructive: false, operation: "更新共享状态", risk: "external_side_effect", requiresApproval: false }; },
    async execute(value, context) {
      try { return await capability.updateState({ requestId: requestIdOf("update_shared_state", context), ...value }); }
      catch (error) { throwSafeThreadToolError(error); }
    },
    serializeOutput(output) { return output; },
  };

  const interruptThread: AgentToolDefinition<z.infer<typeof interruptSchema>, Awaited<ReturnType<AgentThreadsCapability["interrupt"]>>> = {
    name: "interrupt_thread",
    description: "请求中断本组某个会话的当前活动 Turn，必须提供该 Turn 的 expectedTurnId。返回接受只表示请求已持久化给实际持有执行的宿主，不代表目标已经停止；实际结束仍以 Turn 状态为准。目标处于审批或用户输入等待时同样可以中断，收尾由持有执行的宿主完成。",
    inputSchema: interruptSchema,
    metadata: { effect: "dynamic", destructive: false, concurrency: { max: 1, resourceKey: targetResourceKey("threads:interrupt") }, retry: { safe: false }, timeout: { defaultMs: 20_000, maxMs: 20_000 } },
    async createActionFacts(value) { return { toolName: "interrupt_thread", effect: "external", destructive: false, operation: "请求中断协作会话", resource: await threadDisplayTitle(capability, value), risk: "external_side_effect", requiresApproval: false }; },
    async execute(value, context) {
      try { return await capability.interrupt({ requestId: requestIdOf("interrupt_thread", context), ...value }); }
      catch (error) { throwSafeThreadToolError(error); }
    },
    serializeOutput(output) { return output; },
  };

  const reportProgress: AgentToolDefinition<z.infer<typeof reportProgressSchema>, Awaited<ReturnType<AgentThreadsCapability["reportProgress"]>>> = {
    name: "report_progress",
    description: "回报当前真实 run 任务的一条有界摘要；任务由当前 Turn 与持久交付自动绑定，普通独立 Turn 不能归入旧任务。summary 只写结论、当前状态与下一步，最多 600 字符；不要粘贴工具日志、命令输出或逐条推理。kind 选择：progress 为普通进度（父会话读取时会与相邻普通进度合并，容量压力下可被淘汰），milestone 为必须保留的关键结论，blocked 为阻塞或需人工关注，completed/failed 为模型自报结论，持久 Turn 状态才是执行终态事实。evidence 只能引用当前 Turn 的 turnId 或当前任务的 run messageId。回报不启动、不恢复任何会话，也不代替 send_thread 的显式通信。",
    inputSchema: reportProgressSchema,
    metadata: { effect: "dynamic", destructive: false, concurrency: { max: 1, resourceKey: "threads:progress:report" }, retry: { safe: false }, timeout: { defaultMs: 15_000, maxMs: 15_000 } },
    createActionFacts() { return { toolName: "report_progress", effect: "external", destructive: false, operation: "回报进展摘要", risk: "external_side_effect", requiresApproval: false }; },
    async execute(value, context) {
      try { return await capability.reportProgress({ requestId: requestIdOf("report_progress", context), ...value }); }
      catch (error) { throwSafeThreadToolError(error); }
    },
    serializeOutput(output) { return output; },
  };

  const readProgress: AgentToolDefinition<z.infer<typeof readProgressSchema>, Awaited<ReturnType<AgentThreadsCapability["readProgress"]>>> = {
    name: "read_progress",
    description: "按 taskId（run 回执的 messageId）读取本次委派进展；省略 taskId 是显式会话级观察，不能推断某次任务完成。不含子会话历史、工具调用或原始输出。连续普通进度已合并为一条，mergedCount 表示代表条数；关键条目逐条保留。cursor 只能原样回传同一目标，重复回传不会重复返回已读条目；有下一页时用 nextCursor 续读；compacted 表示游标之前被容量淘汰的普通进度条数。kinds 可按类别过滤（被过滤条目仍算已读）。等待游标与进度游标分开维护，不能互换。读取不启动、不恢复目标；需要消息或历史时改用 read_thread。",
    inputSchema: readProgressSchema,
    metadata: { effect: "none", destructive: false, concurrency: { max: 4, resourceKey: targetResourceKey("threads:progress") }, retry: { safe: true, maxRetries: 1 }, timeout: { defaultMs: 15_000, maxMs: 15_000 } },
    async createActionFacts(value) { return { toolName: "read_progress", effect: "none", destructive: false, operation: "读取进展摘要", resource: await threadDisplayTitle(capability, value), risk: "read_only" }; },
    async execute(value) {
      try { return await capability.readProgress(value); }
      catch (error) { throwSafeThreadToolError(error); }
    },
    serializeOutput(output) { return output; },
  };

  const resumeThread: AgentToolDefinition<z.infer<typeof interruptSchema>, Awaited<ReturnType<AgentThreadsCapability["resume"]>>> = {
    name: "resume_thread",
    description: "用户明确要求恢复暂停目标时使用；必须提供已有 threadId 与精确 expectedTurnId。先取得用户确认，再由原 Runner 继续同一 checkpoint/FrozenRunConfig；不创建消息或新任务，同一暂停 checkpoint 重复请求幂等。等待审批/回答不能用本工具跳过，请进入目标会话处理。accepted 只表示控制已接受，用 read_thread/wait_threads 核对实际启动和阻塞；recoveryAction=open_target_continue 表示无法确认已恢复，请进入目标会话用已有继续入口（CLI 切入目标后 /resume），不要反复发送。run 仍表示新任务，不得用反复 run 冒充恢复。",
    inputSchema: interruptSchema,
    metadata: { effect: "dynamic", destructive: false, concurrency: { max: 1, resourceKey: targetResourceKey("threads:resume") }, retry: { safe: false }, timeout: { defaultMs: 20_000, maxMs: 20_000 } },
    /** 恢复用户暂停必须确认，精确目标参与输入哈希，不能复用其他 Turn 的批准。 */
    async createActionFacts(value) { return { stableConstraint: await capability.resumeConstraint(value), toolName: "resume_thread", effect: "external", destructive: false, operation: "恢复已暂停会话", resource: await threadDisplayTitle(capability, value), risk: "external_side_effect", requiresApproval: true, approval: { reason: "确认恢复这个会话的暂停任务；原工具审批仍需在目标会话处理", preview: { threadId: value.threadId, expectedTurnId: value.expectedTurnId } } }; },
    /** 仅在既有 ToolExecutor 审批链放行后提交持久控制。 */
    async execute(value, context) {
      try { return await capability.resume({ requestId: requestIdOf("resume_thread", context), ...value }); }
      catch (error) { throwSafeThreadToolError(error); }
    },
    serializeOutput(output) { return output; },
  };

  return { resumeThread, createThread, listThreads, readThread, sendThread, waitThreads, readSharedState, updateSharedState, reportProgress, readProgress, interruptThread };
}
