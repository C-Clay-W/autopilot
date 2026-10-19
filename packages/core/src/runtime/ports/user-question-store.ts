/**
 * runtime/ports/user-question-store.ts — 用户澄清问题的 durable 存储契约。
 */

import type { StoredUserQuestion, UserQuestionAnswer } from "../domain/user-question";

/** 按三重归属读取问题请求。 */
export interface GetUserQuestionInput {
  sessionId: string;
  turnId: string;
  requestId: string;
}

/** 原子保存答案的输入。 */
export interface SaveUserQuestionAnswerInput extends GetUserQuestionInput {
  answer: UserQuestionAnswer;
  answeredAt: string;
}

/** 原子提交答案的稳定结果。 */
export type SaveUserQuestionAnswerResult = "saved" | "same" | "conflict" | "not_found";

/** 绑定 session/turn/request 的问题持久化端口。 */
export interface UserQuestionStore {
  /** 原子保存新问题；同一三重归属已存在时返回 false，绝不覆盖旧请求。 */
  saveRequest(record: StoredUserQuestion): Promise<boolean>;

  /** 读取问题与私有答案。 */
  getRequest(input: GetUserQuestionInput): Promise<StoredUserQuestion | null>;

  /** 原子保存答案；相同答案幂等，不同答案冲突。 */
  saveAnswer(input: SaveUserQuestionAnswerInput): Promise<SaveUserQuestionAnswerResult>;

  /** 删除指定 Session 的全部问题与答案。 */
  deleteBySession(sessionId: string): Promise<void>;
}
