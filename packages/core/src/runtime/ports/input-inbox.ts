/**
 * runtime/ports/input-inbox.ts — 持续输入收件箱端口
 *
 * Phase 4 新增：把 Web `agent_input` durable inbox 提升为跨端 Port。
 * 支持 steer（绑定当前 running turn）与 queue（等待下一条 start/continue）两种投递语义。
 */

import type {
  InboxInput,
  InboxDelivery,
  InboxBoundary,
  PostInboxInput,
  ClaimNextInboxInput,
  ConsumeInboxInput,
  ListInboxInput,
} from "../domain/input-inbox";

/** 查询收件箱输入的条件。 */
export interface DrainInboxQuery {
  sessionId: string;
  turnId: string;
  /** 最大投递语义；drain 只返回小于等于该级别的输入。 */
  maxDelivery: InboxDelivery;
  /** 当前安全边界。 */
  boundary: InboxBoundary;
}

/** 持续输入收件箱端口。 */
export interface InputInbox {
  /** 投递一条新输入；返回生成的 InboxInput。 */
  post(input: PostInboxInput): Promise<InboxInput>;

  /** 按 steer 优先、同类 FIFO 领取一条待启动输入；领取后状态为 claimed。 */
  claimNext(input: ClaimNextInboxInput): Promise<InboxInput | null>;

  /** 仅允许将 claimed 输入绑定到实际 turn 并标记为 consumed。 */
  consume(input: ConsumeInboxInput): Promise<boolean>;

  /** 只读列出指定 Session 的输入，不改变输入状态。 */
  list(input: ListInboxInput): Promise<InboxInput[]>;

  /**
   * 领取并返回符合条件的 pending 输入。
   * 调用方领取后应负责将输入状态更新为 claimed / consumed。
   */
  drain(query: DrainInboxQuery): Promise<InboxInput[]>;

  /** 取消一条尚未消费的 pending/claimed 输入；claimed 仅用于启动失败回收。 */
  cancel(inputId: string): Promise<boolean>;

  /** 删除指定 Session 的全部 inbox 输入。 */
  deleteBySession(sessionId: string): Promise<void>;

  /**
   * 可选：等待同一 turn 的新输入到达。
   * 没有实现时 Runtime 应在安全边界主动 drain。
   */
  waitForInput?(input: { sessionId: string; turnId: string; timeoutMs: number }): Promise<void>;
}
