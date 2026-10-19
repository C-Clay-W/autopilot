/**
 * runtime/domain/user-question.ts — 结构化用户澄清问题领域模型。
 *
 * 问题请求与答案均由 Core 绑定到 session、turn 和 request；答案正文只保留在私有 Store，
 * 对外事件只携带可展示的问题与脱敏摘要。
 */

/** 单个互斥选项。 */
export interface UserQuestionOption {
  label: string;
  description: string;
}

/** 一道结构化澄清题。 */
export interface UserQuestionItem {
  id: string;
  header: string;
  question: string;
  options: UserQuestionOption[];
}

/** 用户对单题提交的单选或补充说明。 */
export interface UserQuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

/** 一次工具调用创建的完整问题请求。 */
export interface UserQuestionRequest {
  requestId: string;
  questions: UserQuestionItem[];
}

/** 已通过 Core 校验并按题目顺序归一化的答案。 */
export interface UserQuestionAnswer {
  answers: UserQuestionAnswerItem[];
}

/** 持久化 Store 使用的私有记录，绝不直接交给 Browser 或 Presentation。 */
export interface StoredUserQuestion {
  sessionId: string;
  turnId: string;
  request: UserQuestionRequest;
  createdAt: string;
  answer?: UserQuestionAnswer;
  answeredAt?: string;
}
