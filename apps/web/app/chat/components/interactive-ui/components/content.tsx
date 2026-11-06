/** Intelligent UI 的文本、说明、清单、时间线和步骤展示组件。 */
"use client";

import { Children, useId, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { InteractiveUiProps } from "../context";
import { useSafeBinding } from "./inputs";

const tones: Record<string, string> = { ink: "text-ink", muted: "text-muted", accent: "text-accent", error: "text-error" };
const sizes: Record<string, string> = { xs: "text-xs", sm: "text-sm", md: "text-base", lg: "text-lg" };

/** 错误说明始终使用固定文本，不显示异常或模型属性。 */
export function UiNodeFallback() {
  return <p role="status" className="border-l-2 border-error px-3 py-2 text-sm text-error">此部分暂时无法显示，请参考文字说明。</p>;
}

/** 普通文字只作为文本节点渲染，不解析 HTML 或链接。 */
function Text({ element }: InteractiveUiProps) {
  return <p className={`whitespace-pre-wrap break-words ${sizes[String(element.props.size)]} ${tones[String(element.props.tone)]}`}>{String(element.props.value)}</p>;
}

/** 计算失败时显示局部说明；不显示 NaN、Infinity 或溢出值。 */
function Metric({ element }: InteractiveUiProps) {
  const { label, value, unit, tone } = element.props;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) >= 1e15) return <UiNodeFallback />;
  return <dl className="min-w-0 border-l-2 border-accent pl-3"><dt className="text-xs text-muted">{String(label)}</dt><dd className={`mt-1 break-words text-xl font-semibold tabular-nums ${tones[String(tone ?? "ink")]}`}>{new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value)}{unit && <span className="ml-1 text-xs font-normal">{String(unit)}</span>}</dd></dl>;
}

/** Tabs 以数组索引对应 panels，方向键和 Home/End 在当前 tablist 内移动。 */
function Tabs({ element, slots }: InteractiveUiProps) {
  const items = element.props.items as Array<{ key: string; label: string }>;
  const panels = Children.toArray(slots?.items);
  const [active, setActive] = useState(0);
  const id = useId();

  /** 点击只更新当前文档实例的面板索引。 */
  function choose(event: MouseEvent<HTMLButtonElement>) {
    setActive(Number(event.currentTarget.dataset.index));
  }

  /** 方向键循环切换，Home/End 定位首尾并保留焦点在 tablist。 */
  function move(event: KeyboardEvent<HTMLButtonElement>) {
    const index = Number(event.currentTarget.dataset.index);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowRight" ? (index + 1) % items.length : event.key === "ArrowLeft" ? (index + items.length - 1) % items.length : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
    (event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus();
  }

  return <section className="min-w-0"><div role="tablist" aria-label="内容选项" className="flex flex-wrap border-b-2 border-ink">{items.map(function tab(item, index) { return <button key={item.key} id={`${id}-tab-${index}`} type="button" role="tab" aria-selected={index === active} aria-controls={`${id}-panel-${index}`} tabIndex={index === active ? 0 : -1} data-index={index} onClick={choose} onKeyDown={move} className={`border-ink px-3 py-2 text-xs focus-visible:outline-2 focus-visible:outline-accent ${index === active ? "bg-ink text-ink-on-dark" : "text-ink hover:bg-ink/10"}`}>{item.label}</button>; })}</div>{items.map(function panel(item, index) { return <div key={item.key} id={`${id}-panel-${index}`} role="tabpanel" aria-labelledby={`${id}-tab-${index}`} hidden={index !== active} tabIndex={0} className="py-3 focus-visible:outline-2 focus-visible:outline-accent">{panels[index]}</div>; })}</section>;
}

/** 原生 details/summary 保留键盘展开语义；状态仅属于当前挂载实例。 */
function Disclosure({ element, slots }: InteractiveUiProps) {
  return <details open={Boolean(element.props.defaultOpen)} className="min-w-0 border-t-2 border-ink py-2"><summary className="cursor-pointer text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent">{String(element.props.summary)}</summary><div className="pt-3">{slots?.content}</div></details>;
}

/** 有序或无序输出短清单，标题和说明仍作为普通文本。 */
function ItemList({ element }: InteractiveUiProps) {
  const items = element.props.items as Array<{ title: string; description?: string }>;
  const ordered = element.props.ordered === true;
  const List = ordered ? "ol" : "ul";
  return <List className={`min-w-0 space-y-3 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>{items.map(function item(entry, index) { return <li key={index} className="break-words">{entry.title}{entry.description && <p className="mt-1 text-sm text-muted">{entry.description}</p>}</li>; })}</List>;
}

/** 按文档给定顺序展示标注、标题与说明，不推断日期或执行状态。 */
function Timeline({ element }: InteractiveUiProps) {
  const items = element.props.items as Array<{ label: string; title: string; description?: string }>;
  return <ol className="min-w-0 space-y-4">{items.map(function entry(item, index) { return <li key={index} className="min-w-0 border-l-2 border-ink pl-3"><p className="text-xs text-muted">{item.label}</p><h4 className="mt-1 break-words text-sm font-semibold">{item.title}</h4>{item.description && <p className="mt-1 break-words text-sm text-muted">{item.description}</p>}</li>; })}</ol>;
}

/** 使用受 Core 整数范围约束的块内 state 切换讲解步骤。 */
function Steps(props: InteractiveUiProps) {
  const items = props.element.props.items as Array<{ title: string; description?: string }>;
  const { value, update } = useSafeBinding(props);
  const active = Number(value);
  const current = items[active];

  /** 仅更新已验证的步骤索引，不表示 Agent 任务完成。 */
  function choose(index: number) {
    update(index);
  }

  return <section className="min-w-0 space-y-3" aria-label="步骤讲解"><p className="text-xs text-muted" aria-live="polite">第 {active + 1} 步，共 {items.length} 步</p><ol className="flex min-w-0 flex-wrap gap-2" aria-label="选择讲解步骤">{items.map(function step(item, index) { return <li key={index}><button type="button" aria-current={index === active ? "step" : undefined} aria-label={`第 ${index + 1} 步：${item.title}`} onClick={function selectStep() { choose(index); }} className={`border-2 border-ink px-3 py-2 text-left text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${index === active ? "bg-accent text-ink-on-dark" : "bg-card text-ink hover:bg-ink/10"}`}>{index + 1}. {item.title}</button></li>; })}</ol><div className="min-w-0 border-t-2 border-ink pt-3"><h4 className="break-words text-sm font-semibold">{current.title}</h4>{current.description && <p className="mt-1 break-words text-sm text-muted">{current.description}</p>}</div><div className="flex gap-2"><button type="button" disabled={active === 0} onClick={function previous() { choose(active - 1); }} className="border-2 border-ink px-3 py-1.5 text-xs text-ink hover:bg-ink/10 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-ink/10 disabled:text-muted">上一步</button><button type="button" disabled={active === items.length - 1} onClick={function next() { choose(active + 1); }} className="border-2 border-ink px-3 py-1.5 text-xs text-ink hover:bg-ink/10 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-ink/10 disabled:text-muted">下一步</button></div></section>;
}

export { Disclosure, ItemList, Metric, Steps, Tabs, Text, Timeline };
