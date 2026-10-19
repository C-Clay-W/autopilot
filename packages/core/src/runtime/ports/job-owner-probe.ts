/** Job owner 存活探测 Port：只返回三态线索，不授予进程控制权。 */

import type { JobOwner, JobOwnerLiveness } from "../domain";

/** Adapter 只能探测宿主进程是否存在，Runtime 身份仍由 Core 判定。 */
export interface JobOwnerProbe {
  /** 探测 owner 的宿主进程；权限不足、PID 复用风险或异常一律返回 unknown。 */
  probe(owner: JobOwner): Promise<JobOwnerLiveness>;
}
