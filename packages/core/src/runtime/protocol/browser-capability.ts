// Desktop 浏览器独立宿主能力：Core 绑定真实会话/回合，网页与审批由宿主拥有。
export type BrowserOperation =
  | { type: "list" }
  | { type: "downloads"; pageId: string; revision: number }
  | { type: "cancel-download"; pageId: string; revision: number; id: string }
  | { type: "wait"; pageId: string; revision: number; condition: "load"; timeout: number }
  | { type: "open"; url: string }
  | { type: "document"; path: string }
  | { type: "navigate"; pageId: string; url: string; revision: number }
  | { type: "select" | "close" | "release" | "back" | "forward" | "reload" | "snapshot" | "screenshot"; pageId: string; revision: number }
  | { type: "click"; pageId: string; revision: number; ref: string }
  | { type: "fill" | "select-option"; pageId: string; revision: number; ref: string; value: string }
  | { type: "press"; pageId: string; revision: number; key: string }
  | { type: "scroll"; pageId: string; revision: number; direction: "up" | "down" | "left" | "right"; amount: number }
  | { type: "check"; pageId: string; revision: number; ref: string; checked: boolean }
  | { type: "dialog"; pageId: string; revision: number; accept: boolean; text: string };
export interface BrowserBinding { sessionId: string; turnId: string }
/** 由可信执行上下文产生的本次动作授权，不属于模型提供的浏览器操作参数。 */
export interface BrowserRequestAuthorization { mode: "ask" | "auto_approve" | "full_access"; approvedOnce?: true }
export interface BrowserCapability {
  /** 仅由支持按精确路径确认的宿主声明，document 审批由该宿主办理。 */
  confirmsDocument?: true;
  /** 宿主确认实际网页及动作，Core 不为同一动作再显示通用审批。 */
  managesApprovals?: true;
  /** 模型不能提供身份；callId及signal来自本次工具执行上下文。 */
  request(binding: BrowserBinding, callId: string, operation: BrowserOperation, signal?: AbortSignal, authorization?: BrowserRequestAuthorization): Promise<unknown>;
  /** 真实回合终止时撤销该回合权限与在途动作，不影响其他回合。 */
  endTurn(binding: BrowserBinding): Promise<void>;
}
