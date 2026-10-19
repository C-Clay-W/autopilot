/**
 * Agent Todo 任务链卡片：只消费共享 Presentation 的安全 Todo 快照，同一任务链跨多次更新保持单卡。
 */
"use client";

import { useState } from "react";
import type { TodoItem } from "@autopilot-agent/core";
import { selectTodoSnapshot, type AgentPresentationState, type TodoSnapshotItem } from "@autopilot-agent/presentation";

interface TodoListCardProps {
  item: TodoSnapshotItem;
}

/** 将 Todo 状态转换为读屏可识别的中文文字，避免 glyph 或颜色成为唯一状态载体。 */
function getTodoStatusLabel(status: TodoItem["status"]): string {
  if (status === "in_progress") return "进行中";
  if (status === "completed") return "已完成";
  return "待处理";
}

/** 将 Todo 状态映射为显式 glyph：完成勾选、进行中实心方块、待处理空心方块。 */
function getTodoStatusGlyph(status: TodoItem["status"]): string {
  if (status === "in_progress") return "■";
  if (status === "completed") return "✓";
  return "□";
}

/** 返回 Todo 正文的降级样式：完成弱化并加删除线、进行中加粗、待处理保持正文。 */
function getTodoContentClass(status: TodoItem["status"]): string {
  if (status === "in_progress") return "min-w-0 flex-1 break-words font-bold text-ink";
  if (status === "completed") return "min-w-0 flex-1 break-words text-muted line-through";
  return "min-w-0 flex-1 break-words text-ink";
}

/** 渲染 Todo 完整清单行；导出仅供测试直接校验展开态结构与降级样式。 */
export function TodoListRows({ todos }: { todos: TodoItem[] }) {
  return (
    <ul className="mt-2 border-t border-ink/20 pt-1">
      {todos.map(function renderTodoRow(todo, index) {
        return (
          <li key={`${index}-${todo.content}`} className="flex items-start gap-2 py-0.5">
            <span className={`w-4 shrink-0 text-center ${todo.status === "in_progress" ? "text-accent" : "text-muted"}`} aria-hidden="true">{getTodoStatusGlyph(todo.status)}</span>
            <span className="sr-only">{getTodoStatusLabel(todo.status)}</span>
            <span className={getTodoContentClass(todo.status)}>{todo.content}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** 渲染 Session 任务链当前 Todo 单卡；空表代表模型显式清空，不渲染任何节点。 */
export default function TodoListCard({ item }: TodoListCardProps) {
  const [expanded, setExpanded] = useState(false);
  if (item.todos.length === 0) return null;
  const contentId = `todo-body-${item.id}`;
  const completed = item.counts.completed;
  const total = item.todos.length;
  const activeTodo = item.todos.find(function findActiveTodo(todo) { return todo.status === "in_progress"; });
  const statusMessage = activeTodo ? `已完成 ${completed}/${total}，正在：${activeTodo.activeForm}` : `已完成 ${completed}/${total}`;

  /** 切换 Todo 清单的局部展开视图，不改变共享 Presentation 状态。 */
  function toggleExpanded(): void {
    setExpanded(!expanded);
  }

  return (
    <section className="mt-3 border-2 border-ink bg-card px-3 py-2 text-xs" aria-label="Todo">
      <button type="button" onClick={toggleExpanded} aria-expanded={expanded} aria-controls={contentId} className="flex w-full items-center gap-2 py-0.5 text-left hover:bg-ink/10">
        <span className="shrink-0 font-semibold text-ink">Todo</span>
        <span className="shrink-0 text-muted" title={`已完成 ${completed}/${total}`}>{completed}/{total}</span>
        {activeTodo ? <span className="min-w-0 flex-1 truncate font-semibold text-accent" title={activeTodo.activeForm}>{activeTodo.activeForm}</span> : null}
        <span className={`shrink-0 text-muted text-[1.3em]${activeTodo ? "" : " ml-auto"}`} aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </button>
      <p role="status" aria-live="polite" className="sr-only">{statusMessage}</p>
      {expanded ? <div id={contentId}><TodoListRows todos={item.todos} /></div> : null}
    </section>
  );
}

/** 从当前 Session 展示事实取唯一 Todo 卡；只在 Work 输入区显示。 */
export function CurrentWorkTodo({ presentation, isChat }: { presentation: AgentPresentationState; isChat: boolean }) {
  const item = isChat ? undefined : selectTodoSnapshot(presentation);
  return item ? <TodoListCard item={item} /> : null;
}
