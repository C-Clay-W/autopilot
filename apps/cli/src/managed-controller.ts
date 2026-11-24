/** 受管主控的 CLI Controller 适配：复用原投影和问答，仅将人类动作交回唯一 Desktop Runtime。 */
import { randomUUID } from "node:crypto";
import type { AgentEventEnvelope, TurnExecutionView } from "@autopilot-agent/core";
import { createCliController, questionLines, type CliController, type CliControllerResult } from "./controller.js";
import { CLI_SLASH_COMMANDS, getSlashCommandSuggestions, parseSlashAction } from "./parser.js";
import type { CliAction, CliProjection, CliQueuedInputStartedListener } from "./types.js";
import { ORCHESTRATION_TEMPLATE_COMMAND, parseOrchestrationTemplate } from "./orchestration-templates.js";

/** 编排命令目录同时驱动解析和补全；内部引导命令只保留认证入口。 */
const managedSlashCommands = [
  { name: "/approval", usage: "/approval status|resume", description: "核查原审批恢复，或仅继续原任务" },
  { name: "/status", usage: "/status", description: "查看编排和主控执行状态" },
  { name: "/recover", usage: "/recover", description: "核查旧编排执行" },
  { name: "/reconnect", usage: "/reconnect [accept]", description: "按核查结果重新连接旧执行" },
  { name: "/pause", usage: "/pause", description: "暂停新派工" },
  { name: "/dispatch", usage: "/dispatch", description: "恢复自动派工" },
  { name: "/agent", usage: "/agent <委派ID> status", description: "查看委派状态与控制帮助" },
  { name: "/batch", usage: "/batch approve|deny", description: "处理待确认的扩员批次" },
  { name: "/finish", usage: "/finish run|step", description: "有序收尾当前编排范围" },
  { name: ORCHESTRATION_TEMPLATE_COMMAND, usage: "/ap-orchestration <流程>", description: "使用 Desktop 设置中的编排模板" },
  { name: "/help", usage: "/help", description: "查看编排主控命令" },
];
const managedSlashDirectory = [...CLI_SLASH_COMMANDS, ...managedSlashCommands];

export interface ManagedCliSnapshot {
  sessionId?: string; runId?: string; workspaceRoot?: string; status: string; cancelToken?: string; checkoutNotice?: string;
  task?: { id: string; content: string };
  receiptNotice?: string;
  approvalStatus?: string;
  queueStarts?: { inputId: string; turnId: string }[];
  queueRejections?: { inputId: string; message: string }[];
  inspection?: { turnId?: string; status: string; execution: string; recoverable: boolean; interaction?: { state: string; question?: NonNullable<TurnExecutionView["interaction"]>["question"] } };
  pendingApproval?: { turnId: string; approval: NonNullable<CliProjection["pendingApproval"]> };
  page?: { items: AgentEventEnvelope[]; cursor?: string; nextCursor?: string };
}
export type ManagedCliRequest = (operation: "read" | "input" | "cli" | "cancel" | "ready", extra?: Record<string, unknown>) => Promise<unknown>;
/** TUI/Presentation 和问题选择沿用普通 AP；不提供创建 Runtime、切自由 Session 的能力。 */
export function createManagedCliController(request: ManagedCliRequest, notice: (text: string) => void, role: "controller" | "executor" = "controller"): CliController & { update(snapshot: ManagedCliSnapshot): void } {
  let sessionId: string | undefined;
  let questionId: string | undefined;
  let cancelToken: string | undefined;
  let checkoutNotice: string | undefined;
  let approvalStatus: string | undefined;
  let receiptNotice: string | undefined;
  let executorApproval: ManagedCliSnapshot["pendingApproval"];
  const submittedApprovals = new Set<string>();
  let queuedInputListener: CliQueuedInputStartedListener | undefined;
  /** 受管动作携带独立请求身份；传输失败不自动换身份重发。 */
  async function send(text: string): Promise<string> { const value = await request("input", { text, requestId: randomUUID(), executionToken: cancelToken }); return typeof value === "string" ? value : "操作已提交"; }
  const observer = createCliController({ renderer: { format: "text", render: function noPlainOutput() { return ""; } } });
  /** 受管审批键绑定宿主精确快照，不接受历史 tool 事件作为活跃审批。 */
  function approvalKey(approval: NonNullable<ManagedCliSnapshot["pendingApproval"]>) {
    return JSON.stringify([sessionId, cancelToken, approval.turnId, approval.approval.approvalId]);
  }
  /** 主控与执行者只显示当前宿主请求冻结的选项，旧 transcript 不复活已决审批。 */
  function executorProjection(projection: CliProjection): CliProjection {
    const current = executorApproval && !submittedApprovals.has(approvalKey(executorApproval)) ? executorApproval : undefined;
    if (!current) return { ...projection, pendingApproval: undefined };
    return { ...projection, turnId: current.turnId, status: "waiting_approval", pendingApproval: current.approval };
  }
  /** 普通主控投影沿用原观察器。 */
  function getProjection() { return executorProjection(observer.getProjection()); }
  /** 所有结果沿原 TUI Store 归约，保留可编辑输入与完整时间线。 */
  function result(lines: string[], error = false): CliControllerResult { return { kind: error ? "error" : "ok", exitCode: error ? 1 : 0, lines, projection: getProjection() }; }
  /** 固定受管命令使用同一输入框；普通指令仍使用既有 AP 解析。 */
  function parseInput(text: string) {
    const name = text.trimStart().split(/\s/u, 1)[0];
    if (name === ORCHESTRATION_TEMPLATE_COMMAND) return role === "controller" && parseOrchestrationTemplate(text)
      ? { kind: "action" as const, action: { type: "submit_prompt" as const, content: text } }
      : { kind: "error" as const, message: "请在主控终端使用设置中复制的完整模板首行。" };
    if (managedSlashCommands.some(function matches(command) { return command.name === name; }) || ["/allow", "/deny", "/answer"].includes(name)) return { kind: "action" as const, action: { type: "submit_prompt" as const, content: text.trimStart() } };
    return parseSlashAction(text);
  }
  /** 任务/追加直接交原 Run；问答复用原 Controller，审批使用原卡片及精确身份。 */
  async function dispatch(action: CliAction): Promise<CliControllerResult> {
    try {
      if (action.type === "submit_prompt") {
        if (action.delivery === "queue" && !sessionId) return { ...result([], true), message: "CLI_QUEUE_REQUIRES_ACTIVE_TURN" };
        if ((action.delivery === "queue" || !action.content.startsWith("/") || role === "controller" && parseOrchestrationTemplate(action.content)) && sessionId) {
          const submittedQuestion = questionId;
          const response = await request("cli", { action: { ...action, images: action.images?.map(function encode(image) { return { ...image, bytes: Buffer.from(image.bytes).toString("base64") }; }) }, requestId: randomUUID(), executionToken: cancelToken, questionId: submittedQuestion }) as Omit<CliControllerResult, "projection">;
          return { ...response, projection: getProjection() };
        }
        const response = await send(action.content);
        const command = action.content.trim();
        if ((command === "/help" || command === "/agent") && response.includes("\n")) {
          return { ...result([]), infoReport: response };
        }
        return { ...result([response]), ...(!action.content.startsWith("/") ? { hostRecordedPrompt: action.content } : {}) };
      }
      if (action.type === "resume") return result([await send("/resume")]);
      if (action.type === "cancel_turn") {
        const turnId = observer.getProjection().turnId;
        if (!cancelToken || !turnId) return result(["当前没有已核实的 Turn 可停止。"], true);
        const cancelled = await request("cancel", { requestId: randomUUID(), executionToken: cancelToken, turnId }) as { message: string; error?: boolean };
        return result([cancelled.message], cancelled.error);
      }
      if (action.type === "exit") return { ...result([]), kind: "exit" };
      if (action.type === "approve") {
        const approval = executorApproval;
        if (!approval || !sessionId || !cancelToken || !approval.approval.allowedDecisions?.includes(action.decision)) return result(["当前审批已变化，请核查原决定。"], true);
        const expected = { sessionId, turnId: approval.turnId, approvalId: approval.approval.approvalId };
        if (action.expected && (action.expected.sessionId !== expected.sessionId || action.expected.turnId !== expected.turnId || action.expected.approvalId !== expected.approvalId)) return result(["当前审批已变化，请核查原决定。"], true);
        const key = approvalKey(approval);
        if (submittedApprovals.has(key)) return result(["该审批已提交，请核查原决定。"], true);
        submittedApprovals.add(key);
        const response = await request("cli", { action: { ...action, expected }, requestId: randomUUID(), executionToken: cancelToken }) as Omit<CliControllerResult, "projection">;
        // 回包可能晚于新审批或恢复快照；只有当前仍是本请求时才采用即时反馈。
        if (executorApproval && approvalKey(executorApproval) === key && response.kind === "ok") approvalStatus = response.lines[0];
        return { ...response, projection: getProjection() };
      }
      if (role === "executor") return result(["请在此会话的图形控件处理审批与问答。"], true);
      const response = await request("cli", { action, requestId: randomUUID(), executionToken: cancelToken }) as Omit<CliControllerResult, "projection">;
      return { ...response, projection: getProjection() };
    } catch (error) { return result([error instanceof Error ? error.message : "主控操作失败，原请求状态待核查。"], true); }
  }
  return {
    getHostApprovalStatus() { return approvalStatus; },
    ...observer, parseInput, dispatch, getProjection, resolveFileMentionsInHost: true, hostApprovalFeedback: true,
    /** 实时与回放均使用受管快照投影，历史工具事件不能复活审批。 */
    setEventListener: function listen(listener) { observer.setEventListener(listener && function emit(event, projection) { listener(event, executorProjection(projection)); }); },
    /** 普通 AP 的菜单仍使用原目录，编排入口再加宿主支持项。 */
    suggestSlashCommands: function suggest(input) { return getSlashCommandSuggestions(input, role === "executor" ? managedSlashDirectory.filter(function supported(c) { return ["/resume", "/exit", "/finish", "/approval"].includes(c.name); }) : managedSlashDirectory); },
    /** 复用普通 TUI 的队列投影。 */
    setQueuedInputListener: function setListener(listener) { queuedInputListener = listener; },
    /** 状态直接读取原生Controller的Session/frozen/default视图。 */
    getStatusView: async function getStatusView() { return request("cli") as ReturnType<NonNullable<CliController["getStatusView"]>>; },
    /** 继续同一受管Turn，不能退回本地Runtime。 */
    resume: function resume() { return dispatch({ type: "resume" }); },
    /** 按原Session/事件游标复用Controller投影，同步原生问题与当前Turn。 */
    update(value) {
      const previousKey = executorApproval && approvalKey(executorApproval);
      if (value.sessionId && value.sessionId !== sessionId) { sessionId = value.sessionId; observer.setSession(sessionId); }
      cancelToken = value.cancelToken;
      executorApproval = undefined;
      if (value.pendingApproval && sessionId && cancelToken) {
        const { turnId, approval } = value.pendingApproval;
        const allowed = (approval.allowedDecisions ?? approval.display?.allowedDecisions ?? ["allow_once", "deny"]).filter(function supported(decision): decision is Extract<CliAction, { type: "approve" }>["decision"] { return ["allow_once", "allow_session", "allow_workspace", "deny"].includes(decision); });
        const scope = role === "executor" ? "本执行者会话" : "本主控会话";
        if (allowed.length) executorApproval = { turnId, approval: { ...approval, reason: `${approval.reason}\n授权对象：${scope}${allowed.includes("allow_workspace") ? " / 本工作区" : ""}；约束：${approval.constraint ?? approval.display?.resource ?? "当前操作"}`, allowedDecisions: allowed } };
      }
      if (value.checkoutNotice && value.checkoutNotice !== checkoutNotice) notice(value.checkoutNotice);
      checkoutNotice = value.checkoutNotice;
      const currentKey = executorApproval && approvalKey(executorApproval);
      if (!currentKey || currentKey !== previousKey || !submittedApprovals.has(currentKey)) {
        approvalStatus = value.inspection?.status === "waiting_approval" && !executorApproval ? value.approvalStatus ?? "审批状态待核查" : undefined;
      }
      const latestNotice = [value.receiptNotice, value.approvalStatus].filter(Boolean).join("\n");
      if (latestNotice && latestNotice !== receiptNotice) notice(latestNotice);
      receiptNotice = latestNotice;
      for (const started of value.queueStarts ?? []) queuedInputListener?.({ ...started, content: "", delivery: "queue" });
      observer.observe?.(value.page?.items ?? []);
      const question = value.inspection?.interaction?.question;
      if (question && value.inspection?.interaction?.state === "pending" && value.inspection.turnId) {
        observer.syncObservedInteraction?.({ turnId: value.inspection.turnId, status: "waiting_user_input", requestId: question.requestId });
        if (questionId !== question.requestId) { questionId = question.requestId; notice(questionLines(question).join("\n")); }
      } else questionId = undefined;
    },
  };
}
