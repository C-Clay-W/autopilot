/** 编排主控与被指派的文档复核者通过受管 IPC 使用原浏览器审批。 */
import { randomUUID } from "node:crypto";
import { parseBrowserOperation, type BrowserBinding } from "@autopilot-agent/core";
import { readBrowserAuthorization, type BrowserAccess, type BrowserPrincipal } from "./browser-access";
import { isReviewDocument, resolveReviewDocument } from "./browser-document";
import type { EvidenceReference, OrchestrationRun } from "./orchestration-store";

interface BrowserTurn {
  id: string;
  turnId: string;
  principal: BrowserPrincipal;
  generation: string;
  owner?: string;
  assignmentId?: string;
  calls: Set<string>;
  pages: Map<string, EvidenceReference>;
  observations: Map<string, EvidenceReference>;
}
interface BrowserTerminal {
  runId: string;
  principalId: string;
  turns: Map<string, BrowserTurn>;
}

/** 凭据只在主进程与受信 Worker 的私有 IPC 闭包中使用。 */
export class OrchestrationBrowser {
  private terminals = new Map<string, BrowserTerminal>();
  constructor(private access: BrowserAccess) {}

  /** 当前终端确认连接后才可以装配本 Run 的原生 browser 工具。 */
  connect(workspaceId: string, runId: string): void {
    this.disconnect(workspaceId);
    this.terminals.set(workspaceId, { runId, principalId: randomUUID(), turns: new Map() });
  }

  /** 切换、断开或退出撤销属于旧终端的审批、在途动作和页面占用。 */
  disconnect(workspaceId: string): void {
    const terminal = this.terminals.get(workspaceId);
    if (!terminal) return;
    this.terminals.delete(workspaceId);
    for (const turn of terminal.turns.values()) this.release(turn);
  }

  /** Worker 退出或换代时撤销旧执行段，保留仍附着的客户端。 */
  revokeRun(runId: string, generation: string): void {
    for (const terminal of this.terminals.values()) if (terminal.runId === runId) {
      for (const [sessionId, turn] of terminal.turns) if (turn.generation === generation) {
        terminal.turns.delete(sessionId); this.release(turn);
      }
    }
  }

  /** 只给已附着主控或明确指派的文档复核者创建独立执行段。 */
  register(run: OrchestrationRun, binding: BrowserBinding, generation: string, label: string, owner = run.controller.execution?.owner): string | undefined {
    const terminal = this.terminals.get(run.workspaceId);
    if (terminal?.runId !== run.id) return undefined;
    const controller = run.controller.execution?.sessionId === binding.sessionId;
    const assignment = controller ? undefined : this.reviewAssignment(run, binding, generation, owner);
    if (controller ? run.controller.execution!.generation !== generation || run.controller.execution!.owner !== owner : !assignment) return undefined;
    const current = terminal.turns.get(binding.sessionId);
    if (current?.generation === generation && current.owner === owner && current.turnId === binding.turnId && current.assignmentId === assignment?.id) return current.id;
    if (current) this.release(current);
    const id = randomUUID();
    terminal.turns.set(binding.sessionId, { id, turnId: binding.turnId, generation, owner, assignmentId: assignment?.id, calls: new Set(), pages: new Map(), observations: new Map(),
      principal: {
        id: assignment ? id : terminal.principalId, kind: "ap", label: assignment ? `Autopilot · ${assignment.id}` : "Autopilot",
        workspace: label, workspaceRoot: run.checkout, desktopWorkspaceId: run.workspaceId,
        ...(assignment ? { review: { documents: assignment.verification!.evidence } } : {}),
      },
    });
    return id;
  }

  /** 通过最新账本断定谁有复核能力，不根据模型提交的动作或页地址授予。 */
  private reviewAssignment(run: OrchestrationRun, binding: BrowserBinding, generation: string, owner: string | undefined) {
    return run.assignments?.find(function current(item) {
      return !run.controlOnly && !run.navigationRemoved && !item.takeover && !item.checkoutYielded && !item.local.handoff
        && item.verification?.browser === true && item.verification.evidence.some(function document(e) { return isReviewDocument(e.artifact, e.contentVersion); })
        && (item.state === "active" || item.state === "submitted" && item.submission === "start")
        && run.steps.some(function selected(step) { return step.id === item.stepId && step.currentAssignmentId === item.id; })
        && item.execution?.sessionId === binding.sessionId && item.execution.turnId === binding.turnId
        && item.execution.hostId === run.hostId && item.execution.generation === generation && item.execution.owner === owner;
    });
  }

  /** 只执行已绑定的原生单动作，由 BrowserAccess 继续核查精确文件与审批。 */
  async request(run: OrchestrationRun, binding: BrowserBinding, generation: string, input: unknown, signal: AbortSignal, owner = run.controller.execution?.owner): Promise<unknown> {
    const value = input as { key?: string; callId?: string; operation?: unknown; authorization?: unknown } | null;
    const turn = this.find(run, binding, generation, owner, value?.key);
    if (!turn || signal.aborted) throw new Error("BROWSER_TURN_UNAVAILABLE");
    if (!value?.callId || typeof value.callId !== "string" || value.callId.length > 256 || Object.keys(value).some(function extra(key) { return !["key", "callId", "operation", "authorization"].includes(key); })) throw new Error("BROWSER_CALL_INVALID");
    let operation = parseBrowserOperation(value.operation);
    if (turn.calls.has(value.callId)) throw new Error("BROWSER_CALL_REPLAY");
    turn.calls.add(value.callId);
    let document: EvidenceReference | undefined;
    if (turn.assignmentId) {
      if (operation.type === "document") {
        const selection = await resolveReviewDocument(operation.path, run.checkout, run.assignments.find(function same(item) { return item.id === turn.assignmentId; })!.verification!.evidence);
        operation = { type: "document", path: selection.file };
        document = selection.evidence;
      } else if (operation.type !== "list" && (!("pageId" in operation) || !turn.pages.has(operation.pageId)
        || !["snapshot", "screenshot", "wait", "click", "fill", "select-option", "check", "scroll", "dialog", "close", "release"].includes(operation.type))) {
        throw new Error("BROWSER_REVIEW_SCOPE_DENIED");
      }
    }
    if (signal.aborted || this.find(run, binding, generation, owner, turn.id) !== turn) throw new Error("BROWSER_TURN_UNAVAILABLE");
    this.access.begin(turn.principal, turn.id);
    const output = await this.access.request(turn.principal.id, turn.id, operation, signal, readBrowserAuthorization(value.authorization));
    if (document && typeof (output as { id?: unknown } | null)?.id === "string") turn.pages.set((output as { id: string }).id, document);
    if (turn.assignmentId && (operation.type === "snapshot" || operation.type === "screenshot")) {
      const observed = turn.pages.get(operation.pageId)!;
      turn.observations.set(observed.id, { ...observed, method: "browser." + operation.type, result: "当前受管回合读取已批准同版本页面", source: "agent" });
    }
    if (operation.type === "close") turn.pages.delete(operation.pageId);
    return output;
  }

  /** 只返回此委派当前受管回合真正读取过的浏览器证据。 */
  observations(run: OrchestrationRun, binding: BrowserBinding, generation: string, owner: string): EvidenceReference[] | undefined {
    const turn = this.terminals.get(run.workspaceId)?.turns.get(binding.sessionId);
    if (turn?.assignmentId && this.find(run, binding, generation, owner, turn.id)) return [...turn.observations.values()];
  }

  /** 原执行段的迟到结束只释放自己的浏览器授权。 */
  end(run: OrchestrationRun, binding: BrowserBinding, generation: string, key: unknown, owner = run.controller.execution?.owner): void {
    const turn = this.find(run, binding, generation, owner, key, true);
    if (!turn) return;
    this.terminals.get(run.workspaceId)?.turns.delete(binding.sessionId);
    this.release(turn);
  }

  /** 人类接管以及已不拥有执行权的委派立即撤销原浏览器凭据。 */
  reconcile(run: OrchestrationRun, generation: string, owner: string): void {
    const terminal = this.terminals.get(run.workspaceId);
    if (terminal?.runId !== run.id) return;
    for (const [sessionId, turn] of terminal.turns) if (turn.assignmentId
      && !this.reviewAssignment(run, { sessionId, turnId: turn.turnId }, generation, owner)) {
      terminal.turns.delete(sessionId);
      this.release(turn);
    }
  }

  /** 核对当前终端、Worker 代次及原 Session/Turn 执行段。 */
  private find(run: OrchestrationRun, binding: BrowserBinding, generation: string, owner: string | undefined, key: unknown, ending = false): BrowserTurn | undefined {
    const terminal = this.terminals.get(run.workspaceId);
    const turn = terminal?.runId === run.id ? terminal.turns.get(binding.sessionId) : undefined;
    if (turn && turn.id === key && turn.generation === generation && turn.owner === owner && turn.turnId === binding.turnId
      && (ending || (turn.assignmentId ? this.reviewAssignment(run, binding, generation, owner)?.id === turn.assignmentId
        : run.controller.execution?.sessionId === binding.sessionId && run.controller.execution.generation === generation && run.controller.execution.owner === owner))) return turn;
  }

  /** 先同步撤销授权，异步清理浏览器占用沿用原 BrowserAccess。 */
  private release(turn: BrowserTurn): void {
    void this.access.end(turn.principal.id, turn.id).catch(function failed() { console.error("Managed browser turn cleanup failed"); });
  }
}
