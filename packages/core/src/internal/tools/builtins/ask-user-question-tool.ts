/**
 * ask_user_question 工具：模型仅在宿主提供结构化回答 capability 时才能请求用户澄清。
 */

import { z } from "zod";
import type { AgentUserQuestionCapability } from "../../../runtime/application/user-question-service";
import type { AgentToolDefinition } from "../types";

/** 每个选项采用固定 label 与 description，UI 的 Other 由宿主追加而非模型生成。 */
const optionSchema = z.object({
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(200),
}).strict();

/** 单题采用固定单选约束，首版不支持多选。 */
const questionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  header: z.string().trim().min(1).max(12),
  question: z.string().trim().min(1).max(500),
  options: z.array(optionSchema).min(2).max(4),
}).strict().superRefine(function validateUniqueLabels(question, context) {
  const labels = new Set<string>();
  for (const option of question.options) {
    if (labels.has(option.label)) context.addIssue({ code: "custom", message: "每题选项 label 必须唯一" });
    labels.add(option.label);
    if (isReservedOtherLabel(option.label)) context.addIssue({ code: "custom", message: "Other 由 UI 固定提供，模型不得声明" });
  }
});

/** 完整工具输入限制为 1 到 3 道互斥单选题。 */
const inputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(3),
}).strict().superRefine(function validateUniqueQuestionIds(input, context) {
  const ids = new Set<string>();
  for (const question of input.questions) {
    if (ids.has(question.id)) context.addIssue({ code: "custom", message: "问题 id 必须唯一" });
    ids.add(question.id);
  }
});

type AskUserQuestionInput = z.infer<typeof inputSchema>;

/** 创建绑定当前 Runtime Session/Turn 的结构化提问工具。 */
export function createAskUserQuestionTool(capability: AgentUserQuestionCapability): AgentToolDefinition<AskUserQuestionInput, Awaited<ReturnType<AgentUserQuestionCapability["request"]>>> {
  return {
    name: "ask_user_question",
    description: "仅在缺少继续任务所必需的方向性信息时，向用户提出 1 到 3 道单选澄清题。每题提供 2 到 4 个互斥选项；结合当前用户需求、已知会话上下文和已获得的项目环境判断推荐方案，并把推荐方案放在第一个选项。不要自行提供 Other，界面会固定提供补充说明；不要在 label 或 description 中添加“（推荐）”，界面会显示该标记。该工具必须单独调用，不能与任何其他工具并行。",
    inputSchema,
    metadata: {
      effect: "none",
      destructive: false,
      concurrency: { max: 1, resourceKey: "interactive:user-question" },
      retry: { safe: false },
    },
    /** 交互工具不触发权限或授权，问题只会被持久化到当前 Turn。 */
    createActionFacts() {
      return { toolName: "ask_user_question", effect: "none", destructive: false, operation: "ask_user_question" };
    },
    /** 委托可信 capability 创建带归属与 requestId 的 durable 请求。 */
    async execute(input) {
      return capability.request({ questions: input.questions });
    },
    /** 普通模型回灌不会使用该 output；Kernel 会在 question_required 前暂停。 */
    serializeOutput(output) {
      return { requestId: output.requestId, questionCount: output.questions.length };
    },
    /** 将已持久化请求表达为独立交互终态，不伪装成审批或普通成功。 */
    createExecutionResult(_input, output, context) {
      return {
        status: "question_required",
        callId: context.callId,
        toolName: context.toolName,
        request: output,
        meta: context.meta,
      };
    },
  };
}

/** 识别固定 Other 的保留标签，防止模型与 UI 重复声明。 */
function isReservedOtherLabel(label: string): boolean {
  const normalized = label.toLowerCase();
  return normalized === "other" || label === "其他" || label === "其他/补充说明";
}
