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
  imageStore?: import("../ports/session-image-store").SessionImageStore,
): import("../../internal/agent-runtime").AgentInputInboxCapability {
  return {
    async drain({ maxDelivery, boundary }) {
      const inputs = await inbox.drain({ sessionId, turnId, maxDelivery, boundary });
      const injected: import("../../internal/agent-runtime").AgentInjectedInput[] = [];
      for (const item of inputs) {
        if (item.status !== "pending" && item.status !== "claimed") continue;
        // drain 先领取输入；在交给 Kernel 前立即绑定到当前 turn，避免成功消费后仍停留在 claimed。
        const images: NonNullable<import("../../internal/agent-runtime").AgentInjectedInput["images"]> = [];
        let totalBytes = 0;
        if (item.attachments.length > 10) throw new Error("图片数量超过上限");
        for (const attachment of item.attachments) {
          if (!imageStore) throw new Error("会话图片不可用");
          const loaded = await imageStore.read({ sessionId, id: attachment.id });
          if (attachment.sha256 && (loaded.image.sha256 !== attachment.sha256 || loaded.image.width !== attachment.width || loaded.image.height !== attachment.height || loaded.image.bytes !== attachment.bytes)) throw new Error("会话图片校验失败");
          totalBytes += loaded.bytes.byteLength;
          if (totalBytes > 20 * 1024 * 1024) throw new Error("图片总大小超过上限");
          images.push({ type: "image-ref", id: loaded.image.id, sha256: loaded.image.sha256, width: loaded.image.width, height: loaded.image.height });
        }
        if (await inbox.consume({ sessionId, inputId: item.inputId, turnId })) {
          // 来源原样交给 Kernel 呈现，不能因共享 user 载体而丢掉“另一会话消息”身份。
          injected.push({ inputId: item.inputId, content: item.content, ...(item.origin ? { origin: item.origin } : {}), ...(images.length ? { images } : {}) });
        }
      }
      return injected;
    },
    // Port缺失等待能力时不公开立即完成的伪等待，避免协作wait被反复取消而空转。
    ...(inbox.waitForInput ? {
      /** 只桥接Port真实提供的事件等待，不创建第二个轮询器。 */
      async waitForInput({ timeoutMs }: { turnId: string; timeoutMs: number }): Promise<void> {
        await inbox.waitForInput!({ sessionId, turnId, timeoutMs });
      },
    } : {}),
  };
}
