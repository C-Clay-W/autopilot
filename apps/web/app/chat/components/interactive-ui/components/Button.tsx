/** Intelligent UI 的继续与当前块重置按钮，只调用既有会话动作或局部回调。 */
"use client";

import { useContext, useId, useRef, useState } from "react";
import { useStateStore } from "@json-render/react";
import { buildContinueChatContent } from "../continue-chat";
import { UiContinuationContext, UiDocumentContext, UiResetContext, type InteractiveUiProps } from "../context";

/** 继续按钮读取当前块的有限字段，交给原有单一发送链。 */
function Button({ element }: InteractiveUiProps) {
  const id = useId();
  const document = useContext(UiDocumentContext);
  const continuation = useContext(UiContinuationContext);
  const reset = useContext(UiResetContext);
  const store = useStateStore();
  const locked = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const action = element.props.action;
  const isReset = action === "reset_state";
  const disabled = isReset ? !reset : !document || !continuation?.action || continuation.action.disabled || submitting;

  /** 同步锁防止重复提交；不写文档、不自动执行或重试。 */
  async function continueChat() {
    if (disabled || isReset || locked.current || !document || !continuation?.action) return;
    locked.current = true;
    setSubmitting(true);
    setFailed(false);
    try {
      const content = buildContinueChatContent(document, element.props.fields as Array<{ label: string; statePath: string }>, store.getSnapshot());
      await continuation.action.onContinue({ ...continuation.target, content });
    } catch {
      setFailed(true);
    } finally {
      locked.current = false;
      setSubmitting(false);
    }
  }

  /** 只请求重挂当前块的 Provider 子树，恢复初始 state 和组件局部状态。 */
  function resetBlock() {
    if (!disabled && isReset) reset?.();
  }

  if (isReset) {
    return <div><button type="button" disabled={disabled} onClick={resetBlock} aria-describedby={id} className="border-2 border-ink bg-card px-3 py-2 text-xs text-ink hover:bg-ink/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-ink/10 disabled:text-muted">{String(element.props.text)}</button><p id={id} className="mt-1 text-xs text-muted">{disabled ? "当前块无法重置。" : "恢复本块初始值，不会发送消息。"}</p></div>;
  }

  return <div><button type="button" disabled={disabled} onClick={continueChat} aria-describedby={id} className="border-2 border-ink bg-ink px-3 py-2 text-xs text-ink-on-dark hover:bg-ink-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-ink/10 disabled:text-muted">{submitting ? "正在继续…" : String(element.props.text)}</button><p id={id} className="mt-1 text-xs text-muted">{failed ? "继续分析未能提交，请先查看会话状态。" : disabled ? "当前无法发送；仍可调整参数并查看结果。" : "发送当前选项为一条新消息，继续同一会话。"}</p></div>;
}

export default Button;
