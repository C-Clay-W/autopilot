/**
 * Agent Todo 任务链的 CLI 视图：紧凑/展开两种形态共用同一份结构化行数据，
 * Ink 动态区与备用屏视口都从这里取行，避免两套展示实现。
 */

import { type ReactNode } from "react";
import { Text } from "ink";
import stringWidth from "string-width";
import type { TodoItem } from "@autopilot-agent/core";
import { selectTimeline, type AgentPresentationState, type TodoSnapshotItem } from "@autopilot-agent/presentation";
import { TUI_ACCENT_COLOR } from "../design-tokens.js";
import { splitTuiInputGraphemes } from "./input/graphemes.js";

/** 展开态按终端高度最多显示的任务行数；超出部分以隐藏计数提示。 */
const TUI_TODO_EXPANDED_ROW_LIMIT = 10;

/** 展开清单里每行文字可用的最大列数下限，避免极窄终端下行宽为负。 */
const TUI_TODO_MIN_ROW_WIDTH = 12;

/** Todo 行的状态与安全文本；样式由 Ink 或视口 spans 分别映射，hidden 行表示被截断的隐藏计数。 */
export interface TuiTodoDisplayRow {
  status: TodoItem["status"];
  text: string;
  hidden?: boolean;
}

/** Todo 视图的完整展示数据；紧凑态只有 header，展开态附任务行与隐藏计数。 */
export interface TuiTodoDisplay {
  header: string;
  activeForm?: string;
  rows: TuiTodoDisplayRow[];
  hidden: number;
}

/** 取得 Todo 状态的中文文字标签，供 screen reader 与 NO_COLOR 场景朗读。 */
export function getTuiTodoStatusLabel(status: TodoItem["status"]): string {
  if (status === "in_progress") return "进行中";
  if (status === "completed") return "已完成";
  return "待处理";
}

/** 从共享 Presentation 读取当前 Turn 任务链的 in_progress activeForm，作为活动状态的稳定文案。 */
export function getTuiTodoActiveForm(presentation: AgentPresentationState | undefined, turnId: string): string | undefined {
  if (!presentation) return undefined;
  const todoItem = selectTimeline(presentation).find(function findTodoItem(item): boolean {
    return item.kind === "todo" && "turnId" in item && item.turnId === turnId;
  });
  if (todoItem?.kind !== "todo") return undefined;
  return todoItem.todos.find(function findActiveTodo(todo): boolean { return todo.status === "in_progress"; })?.activeForm;
}

/** 取得 Todo 状态的纯文本 glyph，颜色不是唯一状态载体。 */
export function getTuiTodoStatusGlyph(status: TodoItem["status"]): string {
  if (status === "in_progress") return "■";
  if (status === "completed") return "✓";
  return "□";
}

/** 按显示宽度做 grapheme 安全截断，中英文与组合 emoji 不会截出半字。 */
export function truncateTuiTodoText(text: string, maximumWidth: number): string {
  if (stringWidth(text) <= maximumWidth) return text;
  const graphemes = splitTuiInputGraphemes(text);
  let width = 0;
  let output = "";
  for (const grapheme of graphemes) {
    const nextWidth = width + stringWidth(grapheme);
    if (nextWidth > maximumWidth - 1) break;
    width = nextWidth;
    output += grapheme;
  }
  return `${output}…`;
}

/** 按优先级（in_progress → 最近完成 → pending）在行数上限内挑选可见任务，保持原清单顺序展示。 */
export function orderTuiTodoItems(todos: TodoItem[], limit = TUI_TODO_EXPANDED_ROW_LIMIT): { shown: TodoItem[]; hidden: number } {
  if (todos.length <= limit) return { shown: [...todos], hidden: 0 };
  // 超限时为 hidden 摘要预留一行，保证展开态总行数不会超过 limit。
  const taskLimit = Math.max(1, limit - 1);
  const inProgress = todos.filter(function isInProgress(todo): boolean { return todo.status === "in_progress"; });
  const recentCompletedFirst = [...todos].reverse().filter(function isCompleted(todo): boolean { return todo.status === "completed"; });
  const pending = todos.filter(function isPending(todo): boolean { return todo.status === "pending"; });
  const keep = new Set<TodoItem>();
  for (const candidate of [...inProgress, ...recentCompletedFirst, ...pending]) {
    if (keep.size >= taskLimit) break;
    keep.add(candidate);
  }
  const shown = todos.filter(function isKept(todo): boolean { return keep.has(todo); });
  return { shown, hidden: todos.length - shown.length };
}

/** 生成 Todo 视图的共享展示数据；紧凑态一行，展开态为 header + 任务行 + 隐藏计数。 */
export function getTuiTodoDisplay(item: TodoSnapshotItem, options: { expanded: boolean; screenReader: boolean; columns: number; rowLimit?: number }): TuiTodoDisplay | undefined {
  if (item.todos.length === 0) return undefined;
  const total = item.todos.length;
  const completed = item.counts.completed;
  const activeTodo = item.todos.find(function findActiveTodo(todo): boolean { return todo.status === "in_progress"; });
  if (!options.expanded) {
    const headerWidth = Math.max(TUI_TODO_MIN_ROW_WIDTH, options.columns - 2);
    if (!activeTodo) return { header: `Todo ${completed}/${total}`, rows: [], hidden: 0 };
    // activeForm 的可用列数需扣除 'Todo x/y · ' 前缀，保证紧凑行整体不超出终端宽度。
    const prefix = `Todo ${completed}/${total} · `;
    const activeFormWidth = headerWidth - stringWidth(prefix);
    return {
      header: `${prefix}${activeFormWidth > 0 ? truncateTuiTodoText(activeTodo.activeForm, activeFormWidth) : ""}`,
      activeForm: activeTodo.activeForm,
      rows: [],
      hidden: 0,
    };
  }
  const { shown, hidden } = orderTuiTodoItems(item.todos, options.rowLimit ?? TUI_TODO_EXPANDED_ROW_LIMIT);
  const rowWidth = Math.max(TUI_TODO_MIN_ROW_WIDTH, options.columns - 4);
  const rows: TuiTodoDisplayRow[] = shown.map(function createDisplayRow(todo): TuiTodoDisplayRow {
    return { status: todo.status, text: truncateTuiTodoText(todo.content, rowWidth) };
  });
  return {
    header: `Todo ${completed}/${total}`,
    activeForm: activeTodo?.activeForm,
    rows: hidden > 0 ? [...rows, { status: "pending", text: `${hidden} hidden`, hidden: true }] : rows,
    hidden,
  };
}

/** 渲染 Todo 任务链的 Ink 视图；screen reader 时每行前缀中文状态文字。 */
export function TuiTodoList(props: { item: TodoSnapshotItem; expanded: boolean; useColor: boolean; screenReader: boolean; columns: number; rowLimit?: number; showToggleHint?: boolean }): ReactNode {
  const display = getTuiTodoDisplay(props.item, { expanded: props.expanded, screenReader: props.screenReader, columns: props.columns, rowLimit: props.rowLimit });
  if (!display) return null;
  return (
    <>
      <Text bold>{display.header}</Text>
      {display.rows.map(function renderTodoRow(row, index): ReactNode {
        if (row.hidden) return <Text key={`todo-row-${index}`} dimColor={props.useColor}>+{row.text}</Text>;
        const label = props.screenReader || !props.useColor ? `[${getTuiTodoStatusLabel(row.status)}] ` : `${getTuiTodoStatusGlyph(row.status)} `;
        if (row.status === "completed") return <Text key={`todo-row-${index}`} dimColor={props.useColor} strikethrough>{label}{row.text}</Text>;
        if (row.status === "in_progress") return <Text key={`todo-row-${index}`} bold color={props.useColor ? TUI_ACCENT_COLOR : undefined}>{label}{row.text}</Text>;
        return <Text key={`todo-row-${index}`}>{label}{row.text}</Text>;
      })}
      {props.showToggleHint ? <Text dimColor={props.useColor}>Ctrl+O {props.expanded ? "收起" : "展开"}</Text> : null}
    </>
  );
}
