/**
 * Node UserQuestionStore：在显式 stateRoot/questions 下原子持久化问题与私有答案。
 */

import fs from "node:fs";
import type {
  StoredUserQuestion,
  UserQuestionStore,
} from "@autopilot-agent/core";
import type {
  GetUserQuestionInput,
  SaveUserQuestionAnswerInput,
  SaveUserQuestionAnswerResult,
} from "@autopilot-agent/core";
import { atomicReplace, readJsonLines, withFileLock } from "../file-utils";
import { ensureNodeStateRoot, getNodeStatePaths } from "../state-root";
import type { NodeStoreOptions } from "../types";

/** 创建按 session 隔离、带文件锁的用户问题 Store。 */
export function createNodeUserQuestionStore(options: NodeStoreOptions): UserQuestionStore {
  const paths = getNodeStatePaths(options.stateRoot);
  const recordsFile = `${paths.questionsDir}/requests.jsonl`;

  /** 确保状态根和 questions 目录已存在。 */
  function ensureDir(): void {
    const state = ensureNodeStateRoot(paths.root);
    fs.mkdirSync(state.questionsDir, { recursive: true });
  }

  /** 以统一顺序比较已归一化答案。 */
  function answersEqual(left: StoredUserQuestion["answer"], right: SaveUserQuestionAnswerInput["answer"]): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  /** 用同一锁保护读取、创建和答案替换，避免跨进程重复提交竞争。 */
  return {
    async saveRequest(record: StoredUserQuestion): Promise<boolean> {
      ensureDir();
      return withFileLock(recordsFile, () => {
        const records = readJsonLines<StoredUserQuestion>(recordsFile).values;
        if (records.some((candidate) => matches(candidate, { sessionId: record.sessionId, turnId: record.turnId, requestId: record.request.requestId }))) return false;
        records.push(record);
        replaceRecords(records);
        return true;
      });
    },

    async getRequest(input: GetUserQuestionInput): Promise<StoredUserQuestion | null> {
      ensureDir();
      return withFileLock(recordsFile, () => {
        const records = readJsonLines<StoredUserQuestion>(recordsFile).values;
        return records.find((candidate) => matches(candidate, input)) ?? null;
      });
    },

    async saveAnswer(input: SaveUserQuestionAnswerInput): Promise<SaveUserQuestionAnswerResult> {
      ensureDir();
      return withFileLock(recordsFile, () => {
        const records = readJsonLines<StoredUserQuestion>(recordsFile).values;
        const index = records.findIndex((candidate) => matches(candidate, input));
        if (index < 0) return "not_found";
        const record = records[index];
        if (record.answer) return answersEqual(record.answer, input.answer) ? "same" : "conflict";
        records[index] = { ...record, answer: input.answer, answeredAt: input.answeredAt };
        replaceRecords(records);
        return "saved";
      });
    },

    async deleteBySession(sessionId: string): Promise<void> {
      ensureDir();
      await withFileLock(recordsFile, () => {
        const records = readJsonLines<StoredUserQuestion>(recordsFile).values;
        replaceRecords(records.filter((record) => record.sessionId !== sessionId));
      });
    },
  };

  /** 原子替换完整记录集合，避免 JSONL 局部追加无法表达答案更新。 */
  function replaceRecords(records: StoredUserQuestion[]): void {
    atomicReplace(recordsFile, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
  }
}

/** 判断记录是否属于同一 Session、Turn 和 request。 */
function matches(record: StoredUserQuestion, input: GetUserQuestionInput): boolean {
  return record.sessionId === input.sessionId && record.turnId === input.turnId && record.request.requestId === input.requestId;
}
