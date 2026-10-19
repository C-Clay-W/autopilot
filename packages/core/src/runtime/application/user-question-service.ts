/**
 * runtime/application/user-question-service.ts — 结构化澄清问题的可信用例边界。
 */

import { randomUUID } from "node:crypto";
import type {
  StoredUserQuestion,
  UserQuestionAnswer,
  UserQuestionAnswerItem,
  UserQuestionItem,
  UserQuestionRequest,
} from "../domain/user-question";
import type { Clock, CheckpointStore, TurnStore, UserQuestionStore } from "../ports";
import { AgentRuntimeError } from "../protocol";

/** 工具调用创建问题时可提供的受限输入。 */
export interface CreateUserQuestionRequestInput {
  sessionId: string;
  turnId: string;
  questions: UserQuestionItem[];
}

/** 宿主后续提交答案时可提供的受限输入。 */
export interface SubmitUserQuestionAnswerInput {
  sessionId: string;
  turnId: string;
  requestId: string;
  answers: UserQuestionAnswerItem[];
}

/** 供 Kernel 注册工具的最小能力，不授予答案读取或提交权限。 */
export interface AgentUserQuestionCapability {
  request(input: { questions: UserQuestionItem[] }): Promise<UserQuestionRequest>;
}

/** UserQuestionService 的 Runtime 内部接口；仅 Turn 恢复链可读取已提交答案。 */
export interface UserQuestionService {
  request(input: CreateUserQuestionRequestInput): Promise<UserQuestionRequest>;
  submit(input: SubmitUserQuestionAnswerInput): Promise<UserQuestionAnswer>;
  getAnswer(input: { sessionId: string; turnId: string; requestId: string }): Promise<UserQuestionAnswer | null>;
}

/** 宿主可见的问题服务，只允许提交结构化答案。 */
export interface UserQuestionSubmissionService {
  submit(input: SubmitUserQuestionAnswerInput): Promise<UserQuestionAnswer>;
}

/** 创建严格绑定 Session、Turn 与 requestId 的问题服务。 */
export function createUserQuestionService(dependencies: {
  questionStore: UserQuestionStore;
  checkpointStore: CheckpointStore;
  turnStore: TurnStore;
  clock: Clock;
}): UserQuestionService {
  return { request, submit, getAnswer };

  /** 由模型工具创建并持久化首个问题请求。 */
  async function request(input: CreateUserQuestionRequestInput): Promise<UserQuestionRequest> {
    const turn = await dependencies.turnStore.get(input.turnId);
    if (!turn || turn.sessionId !== input.sessionId) {
      throw new AgentRuntimeError("TURN_NOT_FOUND", `Turn ${input.turnId} 不存在`);
    }
    if (turn.status !== "running") {
      throw new AgentRuntimeError("QUESTION_TURN_STATE_INVALID", "只有运行中的 Turn 可以请求用户澄清");
    }
    const request: UserQuestionRequest = { requestId: randomUUID(), questions: normalizeQuestions(input.questions) };
    const saved = await dependencies.questionStore.saveRequest({
      sessionId: input.sessionId,
      turnId: input.turnId,
      request,
      createdAt: dependencies.clock.timestamp(),
    });
    if (!saved) {
      throw new AgentRuntimeError("RUNTIME_ERROR", "生成的 question requestId 已存在，拒绝覆盖既有问题");
    }
    return request;
  }

  /** 校验并原子提交答案；相同重试幂等，不同答案 fail closed。 */
  async function submit(input: SubmitUserQuestionAnswerInput): Promise<UserQuestionAnswer> {
    const turn = await dependencies.turnStore.get(input.turnId);
    if (!turn || turn.sessionId !== input.sessionId) {
      throw new AgentRuntimeError("QUESTION_NOT_FOUND", "问题不存在或不属于当前 Turn");
    }
    const record = await dependencies.questionStore.getRequest(input);
    if (!record) {
      throw new AgentRuntimeError("QUESTION_NOT_FOUND", "问题不存在或不属于当前 Turn");
    }
    const answer = normalizeAnswers(record, input.answers);
    if (record.answer) {
      if (answersEqual(record.answer, answer)) return record.answer;
      throw new AgentRuntimeError("QUESTION_ALREADY_ANSWERED", "该问题已经提交过不同答案");
    }
    const checkpoint = await dependencies.checkpointStore.getLatest(input.sessionId);
    if (!checkpoint || checkpoint.turnId !== input.turnId || checkpoint.status !== "awaiting_user_input") {
      throw new AgentRuntimeError("QUESTION_TURN_STATE_INVALID", "当前 Turn 不在等待用户回答状态");
    }
    const result = await dependencies.questionStore.saveAnswer({ ...input, answer, answeredAt: dependencies.clock.timestamp() });
    if (result === "saved" || result === "same") return answer;
    if (result === "conflict") throw new AgentRuntimeError("QUESTION_ALREADY_ANSWERED", "该问题已经提交过不同答案");
    throw new AgentRuntimeError("QUESTION_NOT_FOUND", "问题不存在或不属于当前 Turn");
  }

  /** 仅供同一 Runtime 后续恢复链读取已提交答案。 */
  async function getAnswer(input: { sessionId: string; turnId: string; requestId: string }): Promise<UserQuestionAnswer | null> {
    const record = await dependencies.questionStore.getRequest(input);
    return record?.answer ?? null;
  }
}

/** 归一化并校验模型提出的问题，拒绝未冻结的多选与伪造 Other 选项。 */
function normalizeQuestions(questions: UserQuestionItem[]): UserQuestionItem[] {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3) {
    throw new AgentRuntimeError("QUESTION_ANSWER_INVALID", "问题数量必须在 1 到 3 之间");
  }
  const questionIds = new Set<string>();
  return questions.map(function normalizeQuestion(question) {
    if (!question || typeof question !== "object") throw new AgentRuntimeError("QUESTION_ANSWER_INVALID", "问题格式不合法");
    const id = readText(question.id, 1, 80, "问题 id");
    if (questionIds.has(id)) throw new AgentRuntimeError("QUESTION_ANSWER_INVALID", "问题 id 必须唯一");
    questionIds.add(id);
    const header = readText(question.header, 1, 12, "问题标题");
    const prompt = readText(question.question, 1, 500, "问题正文");
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4) {
      throw new AgentRuntimeError("QUESTION_ANSWER_INVALID", "每题必须有 2 到 4 个互斥选项");
    }
    const labels = new Set<string>();
    const options = question.options.map(function normalizeOption(option) {
      const label = readText(option?.label, 1, 80, "选项标题");
      if (labels.has(label) || isReservedOtherLabel(label)) throw new AgentRuntimeError("QUESTION_ANSWER_INVALID", "选项标题必须唯一且不能伪造其他补充项");
      labels.add(label);
      return { label, description: readText(option?.description, 1, 200, "选项说明") };
    });
    return { id, header, question: prompt, options };
  });
}

/** 校验并按问题原顺序归一化单选或自定义补充答案。 */
function normalizeAnswers(record: StoredUserQuestion, answers: UserQuestionAnswerItem[]): UserQuestionAnswer {
  if (!Array.isArray(answers) || answers.length !== record.request.questions.length) {
    throw new AgentRuntimeError("QUESTION_ANSWER_INVALID", "必须为每一道问题提交一个答案");
  }
  const inputById = new Map<string, UserQuestionAnswerItem>();
  for (const answer of answers) {
    if (!answer || typeof answer !== "object" || typeof answer.id !== "string" || inputById.has(answer.id)) {
      throw new AgentRuntimeError("QUESTION_ANSWER_INVALID", "答案 id 必须唯一且对应已请求问题");
    }
    inputById.set(answer.id, answer);
  }
  return {
    answers: record.request.questions.map(function normalizeAnswer(question) {
      const answer = inputById.get(question.id);
      if (!answer || !Array.isArray(answer.selected)) throw new AgentRuntimeError("QUESTION_ANSWER_INVALID", "答案不属于当前问题请求");
      const selected = answer.selected.map(function normalizeSelected(label) { return readText(label, 1, 80, "选中项"); });
      const custom = answer.custom === undefined ? undefined : readText(answer.custom, 1, 2000, "补充说明");
      if ((selected.length === 1 && custom === undefined && question.options.some((option) => option.label === selected[0])) || (selected.length === 0 && custom !== undefined)) {
        return custom === undefined ? { id: question.id, selected } : { id: question.id, selected: [], custom };
      }
      throw new AgentRuntimeError("QUESTION_ANSWER_INVALID", "每题只能单选一个已有选项，或填写补充说明");
    }),
  };
}

/** 读取并 trim 受限文本字段，防止空白和越界值穿过 Runtime。 */
function readText(value: unknown, min: number, max: number, field: string): string {
  if (typeof value !== "string") throw new AgentRuntimeError("QUESTION_ANSWER_INVALID", `${field} 必须为字符串`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new AgentRuntimeError("QUESTION_ANSWER_INVALID", `${field} 长度必须在 ${min} 到 ${max} 之间`);
  }
  return normalized;
}

/** 识别由 UI 固定提供的 Other，避免模型把它伪造成普通选项。 */
function isReservedOtherLabel(label: string): boolean {
  const normalized = label.toLowerCase();
  return normalized === "other" || label === "其他" || label === "其他/补充说明";
}

/** 比较已归一化答案，确保重复提交只接受完全相同的内容。 */
function answersEqual(left: UserQuestionAnswer, right: UserQuestionAnswer): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
