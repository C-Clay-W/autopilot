/**
 * runtime/application/input-inbox-service.ts — 持续输入收件箱用例编排
 *
 * Phase 4 新增：管理 steer / queue 输入的生命周期。
 */

import type { InputInbox } from "../ports/input-inbox";
import type {
  ClaimNextInboxInput,
  ConsumeInboxInput,
  DrainInboxInput,
  InboxInput,
  ListInboxInput,
  PostInboxInput,
} from "../domain/input-inbox";

/** InputInboxService 接口。 */
export interface InputInboxService {
  /** 投递一条输入；steer 时绑定 turn，queue 时不绑定。 */
  post(input: PostInboxInput): Promise<InboxInput>;

  /** 按 steer 优先、同类 FIFO 领取一条待启动输入。 */
  claimNext(input: ClaimNextInboxInput): Promise<InboxInput | null>;

  /** 将已领取输入绑定到实际 turn 并标记为 consumed。 */
  consume(input: ConsumeInboxInput): Promise<boolean>;

  /** 只读列出指定 Session 的输入，不改变输入状态。 */
  list(input: ListInboxInput): Promise<InboxInput[]>;

  /** 领取符合边界的 steer / queue 输入。 */
  drain(input: DrainInboxInput): Promise<InboxInput[]>;

  /** 取消一条尚未消费的 pending/claimed 输入。 */
  cancel(inputId: string): Promise<boolean>;
}

/** 创建 InputInboxService 实例。 */
export function createInputInboxService(inbox: InputInbox): InputInboxService {
  return {
    post,
    claimNext,
    consume,
    list,
    drain,
    cancel,
  };

  async function post(input: PostInboxInput): Promise<InboxInput> {
    return inbox.post(input);
  }

  async function cancel(inputId: string): Promise<boolean> {
    return inbox.cancel(inputId);
  }

  async function claimNext(input: ClaimNextInboxInput): Promise<InboxInput | null> {
    return inbox.claimNext(input);
  }

  async function consume(input: ConsumeInboxInput): Promise<boolean> {
    return inbox.consume(input);
  }

  async function list(input: ListInboxInput): Promise<InboxInput[]> {
    return inbox.list(input);
  }

  async function drain(input: DrainInboxInput): Promise<InboxInput[]> {
    return inbox.drain(input);
  }
}

/** 把 InputInbox Port 适配为 Kernel 所需的 AgentInputInboxCapability。 */
export function createAgentInputInboxCapability(
  inbox: InputInbox,
  sessionId: string,
  turnId: string,
): import("../../internal/agent-runtime").AgentInputInboxCapability {
  return {
    async drain({ maxDelivery, boundary }) {
      const inputs = await inbox.drain({ sessionId, turnId, maxDelivery, boundary });
      const injected: Array<{ inputId: string; content: string }> = [];
      for (const item of inputs) {
        if (item.status !== "pending" && item.status !== "claimed") continue;
        // drain 先领取输入；在交给 Kernel 前立即绑定到当前 turn，避免成功消费后仍停留在 claimed。
        if (await inbox.consume({ sessionId, inputId: item.inputId, turnId })) {
          injected.push({ inputId: item.inputId, content: item.content });
        }
      }
      return injected;
    },
    async waitForInput({ timeoutMs }) {
      if (inbox.waitForInput) {
        await inbox.waitForInput({ sessionId, turnId, timeoutMs });
      }
    },
  };
}
