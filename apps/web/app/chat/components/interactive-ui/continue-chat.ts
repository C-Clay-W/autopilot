/** 交互块续聊的固定消息模板与实例目标检查；只生成普通用户文本，不发送网络请求。 */
import { projectUiDocument, type UiDocument, type UiScalar } from "@autopilot-agent/core/ui";

export interface UiContinueTarget { sessionId: string; turnId: string; uiId: string }
export interface UiContinueRequest extends UiContinueTarget { content: string }
export interface UiContinuation { disabled: boolean; onContinue(request: UiContinueRequest): Promise<void> }
export interface UiSubmissionState {
  sessionId: string; isChat: boolean; retrieval: string; active: boolean; canWrite: boolean;
  loading: boolean; activeTurnId?: string; stopping: boolean; disconnected: boolean;
}

/** 同一块可跨Turn阅读，但只允许当前可写Chat none/web实例显式开始新Turn。 */
export function canContinueUi(target: UiContinueTarget, current: UiSubmissionState): boolean {
  return Boolean(target.sessionId && target.turnId && target.uiId && target.sessionId === current.sessionId
    && current.isChat && (current.retrieval === "none" || current.retrieval === "web") && current.active && current.canWrite
    && !current.loading && !current.activeTurnId && !current.stopping && !current.disconnected);
}

/** 仅选择已声明的至多六个字段，JSON引用标题/标签/值避免换行改变固定模板结构。 */
export function buildContinueChatContent(document: UiDocument, fields: Array<{ label: string; statePath: string }>, state: Record<string, unknown>): string {
  const safe = projectUiDocument({ ...document, spec: { ...document.spec, state } });
  if (fields.length > 6) throw new Error("继续字段超限");
  const values = fields.map(function field(item) {
    if (typeof item.label !== "string" || item.label.length > 40
      || !Object.prototype.hasOwnProperty.call(document.spec.state ?? {}, item.statePath)
      || !Object.prototype.hasOwnProperty.call(safe.spec.state ?? {}, item.statePath)) throw new Error("继续字段未声明");
    const value: UiScalar = safe.spec.state![item.statePath];
    return `${JSON.stringify(item.label)}=${JSON.stringify(value)}`;
  });
  return [`界面：${JSON.stringify(safe.title)}`, "当前参数：", ...values, "请基于以上选择继续分析。"].join("\n");
}
