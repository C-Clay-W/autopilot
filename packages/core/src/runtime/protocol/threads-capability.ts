/**
 * runtime/protocol/threads-capability.ts — 会话协作工具能力的宿主协议
 *
 * 受信 Work 宿主按 Turn 注入当前工作区、状态根、Project、已授权工具与模型目录；
 * Core 只据此把当前 Turn 绑定到可信协作来源，不实现持久化、调度或页面行为。
 */

import type { ModelRef } from "../domain/model-ref";
import type { ThreadHandoffWriter } from "../ports/thread-handoff";

/** 宿主注入的协作范围；只存在于进程内，不进入 Session、FrozenRunConfig 或公开 DTO。 */
export interface ThreadsCapability {
  /** 宿主工作区的不透明标识；必须与启用协作组时使用的值一致。 */
  workspaceId: string;
  /** 受信宿主的稳定执行档位；具名宿主拒绝未消歧旧任务，浏览器/模型不能指定。 */
  executionHost?: string;
  /** 由真实状态根确定的稳定身份，用于跨重启的游标与幂等域。 */
  stateRootId: string;
  /** 当前 Turn 所属 Project；必须与组成员所属组一致。 */
  projectId: string;
  /** 人类已授权且经宿主收窄的可用工具目录；普通会话能力不由通信组持久裁剪。 */
  allowedTools: readonly string[];
  /** 宿主提供的合法模型目录；创建子会话只能在此选择。 */
  modelCatalog: readonly ModelRef[];
  /** 可信宿主人类 principal；线程 Actor 建立根组时单独作为 owner 记录。 */
  humanPrincipalId?: string;
  /** 旧宿主提示字段，不再作为普通会话创建资格；不进入冻结配置。 */
  allowRootGroupBootstrap?: boolean;
  /** 子会话提交后唤醒 Web Runner；进程内回调，不持久化。 */
  onThreadCreated?: () => void;
  /** 仅受信宿主提供的进程内交接写入能力。 */
  handoff?: ThreadHandoffWriter;
}
