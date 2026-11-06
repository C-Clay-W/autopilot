/** 每份文档的独立局部状态与错误边界；无持久草稿、网络动作或第二套会话控制器。 */
"use client";

import { Component, useMemo, useState, type ReactNode } from "react";
import { JSONUIProvider, Renderer, type Spec } from "@json-render/react";
import { projectUiDocument, type UiDocument } from "@autopilot-agent/core/ui";
import type { UiDocumentItem } from "@autopilot-agent/presentation";
import { computedFunctions } from "./computed-functions";
import { UiContinuationContext, UiDocumentContext, UiNodeFallback, UiResetContext, uiRegistry } from "./registry";
import type { UiContinuation } from "./continue-chat";

/** 客户端在引擎消费前复用 Core 边界，拒绝未知版本与未知节点。 */
export function readRenderableDocument(value: unknown): UiDocument | undefined {
  try { return projectUiDocument(value); } catch { return undefined; }
}

/** 块级异常只替换当前块，不影响同轮文字或其他 UI 块。 */
export class UiBlockBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  /** 隐藏异常细节并进入文字退路。 */
  static getDerivedStateFromError() { return { failed: true }; }
  /** 保留其他时间线节点，当前实例重挂载后才复位。 */
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** 已知安全文档挂载一个库 StateProvider，key 为 sessionId/turnId/uiId 的完整实例身份。 */
function UiDocumentRenderer({ document }: { document: UiDocument }) {
  return <UiDocumentContext.Provider value={document}><JSONUIProvider registry={uiRegistry} initialState={{ ...document.spec.state }} functions={computedFunctions}><Renderer spec={document.spec as Spec} registry={uiRegistry} fallback={UiNodeFallback} /></JSONUIProvider></UiDocumentContext.Provider>;
}

/** 始终显示初值重放规则；旧版本和非法文档只渲染普通文字。 */
export default function InteractiveUIBlock({ item, continuation }: { item: UiDocumentItem; continuation?: UiContinuation }) {
  const document = useMemo(function validateDocument() { return readRenderableDocument(item.document); }, [item.document]);
  const [resetEpoch, setResetEpoch] = useState(0);
  const identity = JSON.stringify([item.sessionId, item.turnId, item.uiId]);
  const fallback = <p role="status" className="whitespace-pre-wrap break-words text-sm text-muted">{item.fallbackText}</p>;
  /** 每次只递增当前块的挂载身份，重置其所有局部控件状态。 */
  function resetBlock() { setResetEpoch(function nextEpoch(epoch) { return epoch + 1; }); }
  return <section className="my-3 min-w-0 border-2 border-ink bg-card p-3 text-ink" aria-label={item.title}><header className="mb-4 border-b-2 border-ink pb-2"><h3 className="break-words text-sm font-semibold">{item.title}</h3><p className="mt-1 text-xs text-muted">可在本地调整；刷新后恢复初始值。</p></header><UiContinuationContext.Provider value={{ target: { sessionId: item.sessionId, turnId: item.turnId, uiId: item.uiId }, action: continuation }}><UiResetContext.Provider value={resetBlock}><UiBlockBoundary key={identity} fallback={fallback}>{document ? <UiDocumentRenderer key={`${identity}:${resetEpoch}`} document={document} /> : fallback}</UiBlockBoundary></UiResetContext.Provider></UiContinuationContext.Provider></section>;
}
