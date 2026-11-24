// 统一浏览器审批仅保存临时授权；调用身份与回合由原生生命周期适配器提供。
import { randomUUID } from "node:crypto";
import { isPublicBrowserRead, isPublicBrowserUrl, type BrowserOperation, type BrowserRequestAuthorization } from "@autopilot-agent/core";
import type { BrowserPreferences } from "./browser-contract";

export interface BrowserPrincipal { id: string; kind: "ap" | "third-party"; label: string; workspace: string; workspaceRoot?: string; desktopWorkspaceId?: string; review?: { documents: readonly { artifact: string; contentVersion: string }[] } }
export interface BrowserApproval { id: string; pageId?: string; caller: string; workspace: string; operation: string; target: string; value?: string; defaultChoice: "once" | "always"; modal: boolean; singleUse?: true }
interface Turn { principal: BrowserPrincipal; id: string; active: boolean; always: boolean; abort: AbortController; manualPages: Set<string>; documents: Set<string> }
interface Pending { display: BrowserApproval; turn: Turn; operation: BrowserOperation; resolve(choice: "once" | "always" | "deny"): void }
export interface BrowserAccessHost {
  preferences(): BrowserPreferences;
  prepare?(principal: BrowserPrincipal, operation: BrowserOperation): Promise<BrowserOperation>;
  target(operation: BrowserOperation, principal?: BrowserPrincipal): { pageId?: string; url: string; approvedLocal?: true };
  execute(principal: BrowserPrincipal, turnId: string, operation: BrowserOperation, signal: AbortSignal): Promise<unknown>;
  release(principal: BrowserPrincipal, turnId: string): Promise<void>;
}

/** 新版原生请求可携带 Core 授权事实，旧连接缺失字段时仍用原策略。 */
export function readBrowserAuthorization(input: unknown): BrowserRequestAuthorization | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const value = input as Record<string, unknown>;
  if (value.mode !== "ask" && value.mode !== "auto_approve" && value.mode !== "full_access" || value.approvedOnce !== undefined && value.approvedOnce !== true ||
    Object.keys(value).some(function unknownField(key) { return key !== "mode" && key !== "approvedOnce"; })) return;
  return { mode: value.mode, ...(value.approvedOnce ? { approvedOnce: true } : {}) };
}

/** 展示影响审批判断的动作参数，输入正文仅显示长度避免泄露。 */
function approvalValue(action: BrowserOperation): string | undefined {
  switch (action.type) {
    case "wait": return `等待加载 · 最多 ${action.timeout} 毫秒`;
    case "cancel-download": return `取消下载 · ${action.id}`;
    case "press": return `按键：${action.key}`;
    case "scroll": return `滚动：${action.direction} · ${action.amount} 像素`;
    case "check": return `${action.ref} · ${action.checked ? "勾选" : "取消勾选"}`;
    case "dialog": return `${action.accept ? "确认" : "取消"} · 输入 ${action.text.length} 个字符（内容隐藏）`;
    case "fill": return `${action.ref} · 输入 ${action.value.length} 个字符（内容隐藏）`;
    case "select-option": return `${action.ref} · 选项：${action.value}`;
    case "click": return action.ref;
    default: return undefined;
  }
}

/** 本回合 always 与单步许可分离，审批等待不获取页面执行位。 */
export class BrowserAccess {
  private turns = new Map<string, Turn>();
  private pending = new Map<string, Pending>();
  private policyRevision = 0;
  constructor(private host: BrowserAccessHost) {}
  /** 只由宿主保存的原生身份登记回合，不能从普通浏览器命令自报开始。 */
  begin(principal: BrowserPrincipal, turnId: string): void {
    const key = JSON.stringify([principal.id, turnId]);
    const previous = this.turns.get(key);
    if (previous) { if (!previous.active) { previous.active = true; previous.abort = new AbortController(); } return; }
    this.turns.set(key, { principal: { ...principal }, id: turnId, active: true, always: false, abort: new AbortController(), manualPages: new Set(), documents: new Set() });
  }
  /** renderer 只看到固定描述，不接触可重放的动作对象或回合凭据。 */
  snapshot(): BrowserApproval[] { return [...this.pending.values()].map(function copy(item) { return { ...item.display }; }); }
  /** 迟到/重复批准不可复活已经撤销的请求。 */
  answer(id: string, choice: "once" | "always" | "deny"): void { const item = this.pending.get(id); if (!item || !item.turn.active || choice === "always" && item.display.singleUse) throw new Error("浏览器请求已失效或需要单次确认。"); this.pending.delete(id); item.resolve(choice); }
  /** 权限收紧撤销所有回合放行和未执行审批，不撤回已发生动作。 */
  tighten(): void { this.policyRevision++; for (const turn of this.turns.values()) { turn.always = false; turn.documents.clear(); } for (const item of this.pending.values()) item.resolve("deny"); this.pending.clear(); }
  /** 手动接管只撤销目标页的未执行许可；其他页面继续原有授权。 */
  revokePage(pageId: string): void {
    for (const turn of this.turns.values()) turn.manualPages.add(pageId);
    for (const [id, item] of this.pending) if (item.display.pageId === pageId) { this.pending.delete(id); item.resolve("deny"); }
  }
  /** 原生终态先阻止新请求并取消在途调用，再释放该回合占用。 */
  async end(principalId: string, turnId: string): Promise<void> {
    const key = JSON.stringify([principalId, turnId]); const turn = this.turns.get(key);
    if (!turn) return;
    turn.active = false; turn.always = false; turn.abort.abort();
    for (const [id, item] of this.pending) if (item.turn === turn) { this.pending.delete(id); item.resolve("deny"); }
    try { await this.host.release(turn.principal, turnId); }
    finally { if (this.turns.get(key) === turn && !turn.active) this.turns.delete(key); }
  }
  /** Codex Stop可能被其他hook续接：冻结全部执行能力，但保留同一原生turn的授权选择。 */
  async suspend(principalId: string, turnId: string): Promise<void> {
    const turn = this.turns.get(JSON.stringify([principalId, turnId]));
    if (!turn) return;
    turn.active = false; turn.abort.abort();
    for (const [id, item] of this.pending) if (item.turn === turn) { this.pending.delete(id); item.resolve("deny"); }
    await this.host.release(turn.principal, turnId);
  }
  /** 窗口关闭/宿主退出撤销全部临时授权，再让网页宿主销毁临时环境。 */
  async clear(): Promise<void> { await Promise.all([...this.turns.values()].map(function end(this: BrowserAccess, turn: Turn) { return this.end(turn.principal.id, turn.id); }.bind(this))); }
  /** 每次调用持有独立取消信号；批准后重新检查文档代次与同页占用。 */
  async request(principalId: string, turnId: string, operation: BrowserOperation, signal: AbortSignal, authorization?: BrowserRequestAuthorization): Promise<unknown> {
    const turn = this.turns.get(JSON.stringify([principalId, turnId]));
    if (signal.aborted) throw new Error("BROWSER_CANCELLED");
    if (!turn?.active) throw new Error("BROWSER_TURN_UNAVAILABLE");
    const action = this.host.prepare ? await this.host.prepare(turn.principal, structuredClone(operation)) : structuredClone(operation);
    if (!turn.active || signal.aborted) throw new Error("BROWSER_CANCELLED");
    const policyRevision = this.policyRevision;
    const target = this.host.target(action, turn.principal);
    const abort = new AbortController();
    /** 任一原生取消源均同步撤销本次调用，不依靠超时猜测终态。 */
    function cancel() { abort.abort(); }
    signal.addEventListener("abort", cancel, { once: true }); turn.abort.signal.addEventListener("abort", cancel, { once: true });
    let approvalId: string | undefined;
    try {
      const preference = this.host.preferences().permission;
      const manuallyRevoked = target.pageId !== undefined && turn.manualPages.has(target.pageId);
      const ap = turn.principal.kind === "ap";
      const mode = ap ? authorization?.mode : undefined;
      const approvedInCore = mode !== undefined && authorization?.approvedOnce === true && action.type !== "document";
      const singleUse = ap && (action.type === "document" || action.type === "cancel-download"
        || action.type !== "list" && !isPublicBrowserUrl(target.url) && !target.approvedLocal);
      const followsMode = preference === "follow_ap" && (mode === "full_access" || mode === "auto_approve" && isPublicBrowserRead(action, target.url));
      const allowed = !manuallyRevoked && (singleUse ? approvedInCore : action.type === "document" ? turn.documents.has(action.path)
        : turn.always || approvedInCore || followsMode || ap && (preference === "always" || mode === undefined && action.type === "open"));
      if (!allowed) {
        approvalId = randomUUID();
        const id = approvalId; const self = this;
        const choice = await new Promise<"once" | "always" | "deny">(function approval(resolve) {
          self.pending.set(id, { turn: turn!, operation: action, resolve, display: { id, pageId: target.pageId, caller: turn!.principal.label, workspace: turn!.principal.workspace, operation: action.type, target: target.url, value: approvalValue(action), defaultChoice: preference === "always" && !singleUse ? "always" : "once", modal: turn!.principal.kind === "third-party" && action.type === "open", ...(singleUse ? { singleUse: true } : {}) } });
          /** 原生工具取消时立即结束等待，不保留可批准的悬空卡片。 */
          function dismissed() { self.pending.delete(id); resolve("deny"); }
          abort.signal.addEventListener("abort", dismissed, { once: true });
          const item = self.pending.get(id)!;
          item.resolve = function settled(choice) { abort.signal.removeEventListener("abort", dismissed); resolve(choice); };
          if (abort.signal.aborted) dismissed();
        });
        if (!turn.active || abort.signal.aborted) throw new Error("BROWSER_CANCELLED");
        if (choice === "deny" || policyRevision !== this.policyRevision) throw new Error("BROWSER_DENIED");
        if (choice === "always") { turn.always = true; turn.manualPages.clear(); if (action.type === "document") turn.documents.add(action.path); }
      } else if (turn.principal.kind === "ap" && preference === "always") turn.always = true;
      if (!turn.active || abort.signal.aborted) throw new Error("BROWSER_CANCELLED");
      this.host.target(action, turn.principal);
      return await this.host.execute(turn.principal, turn.id, action, abort.signal);
    } finally {
      if (approvalId) this.pending.delete(approvalId);
      signal.removeEventListener("abort", cancel); turn.abort.signal.removeEventListener("abort", cancel);
    }
  }
}
