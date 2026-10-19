/**
 * runtime/adapters/memory/memory-user-question-store.ts — Question Store 的内存测试实现。
 */

import type {
  GetUserQuestionInput,
  SaveUserQuestionAnswerInput,
  SaveUserQuestionAnswerResult,
  UserQuestionStore,
} from "../../ports/user-question-store";
import type { StoredUserQuestion } from "../../domain/user-question";

/** 用三重归属键实现 exactly-once 语义的内存问题 Store。 */
export class MemoryUserQuestionStore implements UserQuestionStore {
  private readonly records = new Map<string, StoredUserQuestion>();

  /** 保存首次问题请求，不覆盖已存在记录。 */
  async saveRequest(record: StoredUserQuestion): Promise<boolean> {
    const key = this.getKey({ sessionId: record.sessionId, turnId: record.turnId, requestId: record.request.requestId });
    if (this.records.has(key)) return false;
    this.records.set(key, structuredClone(record));
    return true;
  }

  /** 读取问题记录的隔离副本。 */
  async getRequest(input: GetUserQuestionInput): Promise<StoredUserQuestion | null> {
    const record = this.records.get(this.getKey(input));
    return record ? structuredClone(record) : null;
  }

  /** 原子写入答案，并区分幂等重试与冲突答案。 */
  async saveAnswer(input: SaveUserQuestionAnswerInput): Promise<SaveUserQuestionAnswerResult> {
    const key = this.getKey(input);
    const record = this.records.get(key);
    if (!record) return "not_found";
    if (record.answer) return JSON.stringify(record.answer) === JSON.stringify(input.answer) ? "same" : "conflict";
    this.records.set(key, { ...record, answer: structuredClone(input.answer), answeredAt: input.answeredAt });
    return "saved";
  }

  /** 删除 Session 下的全部问题记录。 */
  async deleteBySession(sessionId: string): Promise<void> {
    for (const [key, record] of this.records) {
      if (record.sessionId === sessionId) this.records.delete(key);
    }
  }

  /** 生成不含用户答案正文的稳定内存索引键。 */
  private getKey(input: GetUserQuestionInput): string {
    return `${input.sessionId}:${input.turnId}:${input.requestId}`;
  }
}
