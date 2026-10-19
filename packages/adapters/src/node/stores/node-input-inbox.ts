/**
 * Node InputInbox：在显式 stateRoot/inbox 下原子维护 pending → claimed → consumed 生命周期。
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type {
  ClaimNextInboxInput,
  ConsumeInboxInput,
  DrainInboxInput,
  InboxInput,
  InputInbox,
  ListInboxInput,
  PostInboxInput,
} from "@autopilot-agent/core";
import { atomicReplace, readJsonLines, safeFilePath, withFileLock } from "../file-utils";
import { ensureNodeStateRoot, getNodeStatePaths } from "../state-root";
import type { NodeStoreOptions } from "../types";

/** 创建基于共享状态根的 InputInbox。 */
export function createNodeInputInbox(options: NodeStoreOptions): InputInbox {
  const paths = getNodeStatePaths(options.stateRoot);

  /** 确保存储目录存在并校验状态 schema。 */
  function ensureDir(): void {
    const state = ensureNodeStateRoot(paths.root);
    fs.mkdirSync(state.inboxDir, { recursive: true });
  }

  /** 返回指定 Session inbox 文件的安全路径。 */
  function filePath(sessionId: string): string {
    return safeFilePath(paths.inboxDir, sessionId, ".jsonl");
  }

  /** 读取指定 Session 的 inbox 记录。 */
  function readInbox(sessionId: string): InboxInput[] {
    return readJsonLines<InboxInput>(filePath(sessionId)).values;
  }

  /** 原子替换指定 Session 的 inbox 文件。 */
  function writeInbox(sessionId: string, inputs: InboxInput[]): void {
    const content = inputs.map((input) => JSON.stringify(input)).join("\n") + (inputs.length ? "\n" : "");
    atomicReplace(filePath(sessionId), content);
  }

  /** 按 steer 优先、同类 FIFO 选择一条 pending 输入。 */
  function selectNext(inputs: InboxInput[]): InboxInput | undefined {
    const pending = inputs.filter((candidate) => candidate.status === "pending");
    return pending.find((candidate) => candidate.delivery === "steer") ?? pending.find((candidate) => candidate.delivery === "queue");
  }

  return {
    async post(input: PostInboxInput): Promise<InboxInput> {
      ensureDir();
      return withFileLock(filePath(input.sessionId), () => {
        const inputs = readInbox(input.sessionId);
        if (input.clientMessageId) {
          const existing = inputs.find((candidate) => candidate.clientMessageId === input.clientMessageId);
          if (existing) return existing;
        }
        const inboxInput: InboxInput = {
          inputId: randomUUID(),
          sessionId: input.sessionId,
          turnId: input.turnId,
          delivery: input.delivery,
          status: "pending",
          content: input.content,
          clientMessageId: input.clientMessageId,
          attachments: input.attachments ?? [],
          selectedSkills: input.selectedSkills ?? [],
          createdAt: new Date().toISOString(),
        };
        inputs.push(inboxInput);
        writeInbox(input.sessionId, inputs);
        return inboxInput;
      });
    },

    async claimNext(input: ClaimNextInboxInput): Promise<InboxInput | null> {
      ensureDir();
      return withFileLock(filePath(input.sessionId), () => {
        const inputs = readInbox(input.sessionId);
        const next = selectNext(inputs);
        if (!next) return null;
        next.status = "claimed";
        writeInbox(input.sessionId, inputs);
        return next;
      });
    },

    async consume(input: ConsumeInboxInput): Promise<boolean> {
      ensureDir();
      return withFileLock(filePath(input.sessionId), () => {
        const inputs = readInbox(input.sessionId);
        const target = inputs.find((candidate) => candidate.inputId === input.inputId);
        if (!target || target.status !== "claimed") return false;
        target.status = "consumed";
        target.turnId = input.turnId;
        writeInbox(input.sessionId, inputs);
        return true;
      });
    },

    async list(input: ListInboxInput): Promise<InboxInput[]> {
      ensureDir();
      return withFileLock(filePath(input.sessionId), () => readInbox(input.sessionId).sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
    },

    async drain(query: DrainInboxInput): Promise<InboxInput[]> {
      ensureDir();
      return withFileLock(filePath(query.sessionId), () => {
        const inputs = readInbox(query.sessionId);
        const result: InboxInput[] = [];
        for (const input of inputs) {
          if (input.status !== "pending") continue;
          if (input.delivery === "steer" && input.turnId !== query.turnId) continue;
          if (input.delivery === "queue" && query.maxDelivery === "steer") continue;
          input.status = "claimed";
          result.push(input);
        }
        writeInbox(query.sessionId, inputs);
        return result;
      });
    },

    async cancel(inputId: string): Promise<boolean> {
      ensureDir();
      const files = fs.readdirSync(paths.inboxDir).filter((file) => file.endsWith(".jsonl"));
      for (const file of files) {
        const sessionId = file.slice(0, -6);
        const cancelled = await withFileLock(filePath(sessionId), () => {
          const inputs = readInbox(sessionId);
          const target = inputs.find((input) => input.inputId === inputId);
          if (!target || (target.status !== "pending" && target.status !== "claimed")) return false;
          target.status = "cancelled";
          writeInbox(sessionId, inputs);
          return true;
        });
        if (cancelled) return true;
      }
      return false;
    },

    async deleteBySession(sessionId: string): Promise<void> {
      ensureDir();
      const target = filePath(sessionId);
      await withFileLock(target, () => {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      });
    },

    async waitForInput(_query: { sessionId: string; turnId: string; timeoutMs: number }): Promise<void> {
      // 文件 Adapter 无推送通道，Runtime 在安全边界主动 drain。
    },
  };
}
