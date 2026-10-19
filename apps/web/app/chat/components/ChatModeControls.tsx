/** 产品与检索控件：手动激活 Tabs，检索仅由单一枚举驱动，持久身份切换创建空白对话。 */
"use client";
import { useState, useId } from "react";
import type { ChatRetrievalMode } from "@autopilot-agent/core";
import { toggleChatRetrieval, type ProductMode } from "../conversation-target";
import Popconfirm from "./Popconfirm";

/** 方向键仅移动焦点，原生按钮的 Enter/Space 才激活产品。 */
export function ProductModeTabs({ mode, onChange }: { mode: ProductMode; onChange(mode: ProductMode): void }) {
  return <div role="tablist" aria-label="对话模式" className="flex shrink-0 gap-1" onKeyDown={function moveFocus(event) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]"));
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
  }}>{(["chat", "work"] as const).map(function tab(value) {
    return <button key={value} id={`mode-tab-${value}`} role="tab" aria-selected={mode === value} aria-controls="conversation-panel" tabIndex={mode === value ? 0 : -1} type="button" onClick={function activate() { onChange(value); }} className={`border-2 border-ink px-3 py-1 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent ${mode === value ? "bg-ink text-ink-on-dark" : "hover:bg-ink/10"}`}>{value === "chat" ? "Chat" : "Work"}</button>;
  })}</div>;
}

/** 有持久会话或在途首次上传时，来源切换明确进入空白会话；不修改旧身份。 */
export function ChatRetrievalControls({ mode, persisted, onChange }: { mode: ChatRetrievalMode; persisted: boolean; onChange(mode: ChatRetrievalMode): void }) {
  const statusId = useId();
  const [pending, setPending] = useState<ChatRetrievalMode | null>(null);
  return <div className="relative">
    <div className="flex flex-wrap gap-2">{(["web", "rag"] as const).map(function source(value) {
      return <button type="button" key={value} aria-pressed={mode === value} aria-describedby={statusId} onClick={function toggle() {
        const next = toggleChatRetrieval(mode, value);
        if (persisted) setPending(next); else onChange(next);
      }} className={`border-2 border-ink px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60 ${mode === value ? "bg-ink text-ink-on-dark" : "bg-card"}`}>{value === "web" ? "联网" : "RAG"} {mode === value ? "开" : "关"}</button>;
    })}</div>
    <p id={statusId} className="mt-1 text-xs text-muted">{mode === "web" ? "联网仅访问公开网页；搜索需配置可用凭据，否则仅可读取已知公开链接。" : "联网与 RAG 互斥；RAG 仅依据私有资料，资料不足会明确提示。"}</p>
    <Popconfirm open={pending !== null} title="将开始新的对话" description="原对话、附件和正在进行的回答会保留，新对话不会复制这些内容。" confirmText="开始新对话" cancelText="取消" onConfirm={function confirm() { if (pending !== null) onChange(pending); setPending(null); }} onCancel={function cancel() { setPending(null); }} />
  </div>;
}
