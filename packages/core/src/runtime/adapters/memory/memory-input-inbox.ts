/**
 * runtime/adapters/memory/memory-input-inbox.ts — 内存版持续输入收件箱
 */

import { randomUUID } from "node:crypto";
import type {
  InputInbox,
  DrainInboxQuery,
} from "../../ports/input-inbox";
import type {
  ClaimNextInboxInput,
  ConsumeInboxInput,
  InboxInput,
  ListInboxInput,
  PostInboxInput,
} from "../../domain/input-inbox";

export class MemoryInputInbox implements InputInbox {
  private inputs = new Map<string, InboxInput>();

  async post(input: PostInboxInput): Promise<InboxInput> {
    if (input.clientMessageId) {
      const existing = [...this.inputs.values()].find((candidate) => candidate.sessionId === input.sessionId && candidate.clientMessageId === input.clientMessageId);
      if (existing) return existing;
    }
    const now = new Date().toISOString();
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
      createdAt: now,
    };
    this.inputs.set(inboxInput.inputId, inboxInput);
    return inboxInput;
  }

  async claimNext(input: ClaimNextInboxInput): Promise<InboxInput | null> {
    const pending = [...this.inputs.values()].filter((candidate) => candidate.sessionId === input.sessionId && candidate.status === "pending");
    const next = pending.find((candidate) => candidate.delivery === "steer") ?? pending.find((candidate) => candidate.delivery === "queue");
    if (!next) return null;
    next.status = "claimed";
    return next;
  }

  async consume(input: ConsumeInboxInput): Promise<boolean> {
    const target = this.inputs.get(input.inputId);
    if (!target || target.sessionId !== input.sessionId || target.status !== "claimed") return false;
    target.status = "consumed";
    target.turnId = input.turnId;
    return true;
  }

  async list(input: ListInboxInput): Promise<InboxInput[]> {
    return [...this.inputs.values()]
      .filter((candidate) => candidate.sessionId === input.sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((candidate) => ({
        ...candidate,
        attachments: [...candidate.attachments],
        selectedSkills: [...candidate.selectedSkills],
      }));
  }

  async drain(query: DrainInboxQuery): Promise<InboxInput[]> {
    const result: InboxInput[] = [];
    for (const input of this.inputs.values()) {
      if (input.sessionId !== query.sessionId) continue;
      if (input.status !== "pending") continue;
      // steer 输入必须绑定到当前 turn；queue 输入不绑定 turn，任何同 session drain 都可消费。
      if (input.delivery === "steer" && input.turnId !== query.turnId) continue;
      // 投递级别过滤：maxDelivery=steer 时只消费 steer；maxDelivery=queue 时消费 steer 和 queue。
      if (input.delivery === "queue" && query.maxDelivery === "steer") continue;
      input.status = "claimed";
      result.push(input);
    }
    return result;
  }

  async cancel(inputId: string): Promise<boolean> {
    const input = this.inputs.get(inputId);
    if (!input || (input.status !== "pending" && input.status !== "claimed")) return false;
    input.status = "cancelled";
    return true;
  }

  async deleteBySession(sessionId: string): Promise<void> {
    for (const [inputId, input] of this.inputs) {
      if (input.sessionId === sessionId) this.inputs.delete(inputId);
    }
  }
}
