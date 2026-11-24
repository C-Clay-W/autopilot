// 主进程持有关闭确认身份和决策，renderer 只能回答当前请求，不能选择关闭目标。
import { randomUUID } from "node:crypto";
import type { CloseConfirmation } from "./contract";

export class CloseConfirmationHost {
  private current: CloseConfirmation | null = null;
  private resolve?: (confirmed: boolean) => void;

  /** 快照只含固定文案、随机身份及阶段，不携带终端或进程权限。 */
  snapshot(): CloseConfirmation | null { return this.current && { ...this.current }; }

  /** 由宿主串行关闭链路发起，已有请求时拒绝叠加确认。 */
  request(message: string, detail: string, confirmLabel?: string): Promise<boolean> {
    if (this.current) return Promise.resolve(false);
    this.current = { id: randomUUID(), message, detail, ...(confirmLabel ? { confirmLabel } : {}), phase: "confirm" };
    return new Promise<boolean>(function pending(this: CloseConfirmationHost, resolve: (confirmed: boolean) => void) { this.resolve = resolve; }.bind(this));
  }

  /** 回答只消费一次，过期身份和关闭中的重复回答均不执行。 */
  answer(id: string, confirmed: boolean): boolean {
    if (!this.current || this.current.id !== id || this.current.phase !== "confirm") return false;
    const resolve = this.resolve;
    this.resolve = undefined;
    if (confirmed) this.current.phase = "closing";
    else this.current = null;
    resolve?.(confirmed);
    return true;
  }

  /** 视图丢失取消未决确认，已确认的停止继续由主进程完成。 */
  cancel(): void { if (this.current?.phase === "confirm") this.answer(this.current.id, false); }

  /** 宿主完成目标处理后释放弹窗，失败也允许重新确认剩余目标。 */
  finish(): void { this.cancel(); this.current = null; }
}
