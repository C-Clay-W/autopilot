/** Stage 4 CLI Todo 契约测试：事件投影、Plain 输出、紧凑/展开视图与列宽边界。 */

import type { AgentEvent, TodoItem } from "@autopilot-agent/core";
import { createElement, Fragment } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { createCliEventProjector } from "../src/event-projector.js";
import type { CliController, CliControllerResult } from "../src/controller.js";
import { CliTuiApp, createCliTuiStore } from "../src/tui.js";
import { createPlainRenderer } from "../src/renderer.js";
import { getTuiTodoDisplay, orderTuiTodoItems, truncateTuiTodoText, TuiTodoList } from "../src/tui/todo-list.js";
import { TuiLiveTurn } from "../src/tui/timeline/turn.js";
import { renderTimeline } from "../src/tui/timeline/static-timeline.js";

/** 将 fixture 最小对象视为公开 AgentEvent，避免测试触及 Core 私有实现。 */
function asEvent(value: unknown): AgentEvent {
  return value as AgentEvent;
}

/** 构造三态混合的 Todo 更新事件负载。 */
function createTodoPayload() {
  const todos: TodoItem[] = [
    { content: "梳理现有实现", activeForm: "正在梳理现有实现", status: "completed" },
    { content: "实现 Todo 卡片", activeForm: "正在实现 Todo 卡片", status: "in_progress" },
    { content: "补充回归测试", activeForm: "正在补充回归测试", status: "pending" },
  ];
  return { todos, counts: { pending: 1, inProgress: 1, completed: 1 } };
}

/** 构造含 Todo 更新的共享 Presentation 投影。 */
function createTodoProjection(extraTodoTurn = "turn-todo") {
  const projector = createCliEventProjector({ sessionId: "session-todo", now: function fixedNow() { return new Date("2026-08-28T00:00:00.000Z"); } });
  projector.project(asEvent({ type: "turn_started", turnId: "turn-todo", stepCount: 0 }));
  const payload = createTodoPayload();
  projector.project(asEvent({ type: "todo_updated", turnId: extraTodoTurn, todoChainId: "chain-1", todos: payload.todos, counts: payload.counts }));
  return projector.getProjection();
}

describe("CLI Todo projection", function cliTodoSuite() {
  it("todo_updated 投影为安全事件并进入共享 Presentation 单卡", function projectsTodoEvent() {
    const projection = createTodoProjection();
    const todoEvent = projection.events.find(function isTodoEvent(event): boolean { return event.type === "todo_updated"; });

    expect(todoEvent).toMatchObject({ type: "todo_updated", turnId: "turn-todo", counts: { completed: 1, inProgress: 1, pending: 1 } });
    const todoItems = projection.presentation.items.filter(function isTodoItem(item): boolean { return item.kind === "todo"; });
    expect(todoItems).toHaveLength(1);
    expect(todoItems[0]).toMatchObject({ id: "todo:session-todo", turnId: "turn-todo" });
  });

  it("Plain 输出稳定摘要行，JSONL 保留完整安全事件", function rendersStablePlainAndJsonl() {
    const projection = createTodoProjection();
    const todoEvent = projection.events.find(function isTodoEvent(event): boolean { return event.type === "todo_updated"; });
    if (!todoEvent) throw new Error("todo event missing");

    expect(createPlainRenderer("text").render(todoEvent)).toBe("todo: 1/3 completed · in progress: 正在实现 Todo 卡片");
    const jsonl = createPlainRenderer("jsonl").render(todoEvent);
    expect(jsonl).toContain('"type":"todo_updated"');
    expect(jsonl).toContain("正在实现 Todo 卡片");
  });

  it("动态区紧凑态显示计数与 activeForm，展开后显示三态清单", function rendersCompactAndExpandedViews() {
    const projection = createTodoProjection();
    const todoItem = projection.presentation.items.find(function isTodoItem(item): boolean { return item.kind === "todo"; });
    if (todoItem?.kind !== "todo") throw new Error("todo item missing");

    const compact = getTuiTodoDisplay(todoItem, { expanded: false, screenReader: false, columns: 80 });
    expect(compact?.header).toBe("Todo 1/3 · 正在实现 Todo 卡片");
    expect(compact?.rows).toHaveLength(0);

    const expanded = getTuiTodoDisplay(todoItem, { expanded: true, screenReader: false, columns: 80 });
    expect(expanded?.header).toBe("Todo 1/3");
    expect(expanded?.rows.map(function rowText(row) { return row.text; })).toEqual(["梳理现有实现", "实现 Todo 卡片", "补充回归测试"]);

    const rendered = render(createElement(TuiTodoList, { item: todoItem, expanded: true, useColor: true, screenReader: false, columns: 80, showToggleHint: true }));
    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("Todo 1/3");
    expect(frame).toContain("✓ 梳理现有实现");
    expect(frame).toContain("■ 实现 Todo 卡片");
    expect(frame).toContain("□ 补充回归测试");
    expect(frame).toContain("Ctrl+O 收起");
    rendered.unmount();
  });

  it("screen reader 行前缀中文状态文字，不依赖 glyph 颜色语义", function rendersScreenReaderLabels() {
    const projection = createTodoProjection();
    const todoItem = projection.presentation.items.find(function isTodoItem(item): boolean { return item.kind === "todo"; });
    if (todoItem?.kind !== "todo") throw new Error("todo item missing");

    const display = getTuiTodoDisplay(todoItem, { expanded: true, screenReader: true, columns: 80 });
    expect(display?.rows[0]?.text).toBe("梳理现有实现");
    const rendered = render(createElement(TuiTodoList, { item: todoItem, expanded: true, useColor: false, screenReader: true, columns: 80 }));
    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("[已完成] 梳理现有实现");
    expect(frame).toContain("[进行中] 实现 Todo 卡片");
    expect(frame).toContain("[待处理] 补充回归测试");
    expect(frame).not.toContain("Ctrl+O");
    rendered.unmount();
  });

  it("超过 10 项时按 in_progress → 最近完成 → pending 优先保留并显示隐藏计数", function prioritizesVisibleRows() {
    const todos: TodoItem[] = Array.from({ length: 15 }, function createTodoItem(_value, index): TodoItem {
      const status = index < 10 ? "completed" : index === 10 ? "in_progress" : "pending";
      return { content: `任务${index + 1}`, activeForm: `正在执行任务${index + 1}`, status };
    });
    const item = { id: "todo:session-todo", kind: "todo" as const, turnId: "turn-todo", todos, counts: { pending: 4, inProgress: 1, completed: 10 } };
    const { shown, hidden } = orderTuiTodoItems(todos);

    expect(shown).toHaveLength(9);
    expect(hidden).toBe(6);
    // in_progress 与最近完成优先保留，较早完成与 pending 被隐藏。
    expect(shown[8]).toMatchObject({ status: "in_progress", content: "任务11" });
    expect(shown[0]).toMatchObject({ status: "completed", content: "任务3" });
    expect(shown.map(function rowText(todo) { return todo.content; })).not.toContain("任务1");
    expect(shown.map(function rowText(todo) { return todo.content; })).not.toContain("任务12");

    const display = getTuiTodoDisplay(item, { expanded: true, screenReader: false, columns: 80 });
    expect(display?.rows.at(-1)?.hidden).toBe(true);
    expect(display?.rows).toHaveLength(10);
    expect(display?.rows.at(-1)?.text).toBe("6 hidden");
  });

  it("矮终端按可用高度裁剪且 hidden 摘要计入行数上限", function clipsRowsByTerminalHeight() {
    const todos: TodoItem[] = Array.from({ length: 8 }, function createTodoItem(_value, index): TodoItem {
      return { content: `任务${index + 1}`, activeForm: `正在执行任务${index + 1}`, status: index === 0 ? "in_progress" : "pending" };
    });
    const item = { id: "todo:session-todo", kind: "todo" as const, turnId: "turn-todo", todos, counts: { pending: 7, inProgress: 1, completed: 0 } };

    const display = getTuiTodoDisplay(item, { expanded: true, screenReader: false, columns: 80, rowLimit: 2 });

    expect(display?.rows).toHaveLength(2);
    expect(display?.rows[0]).toMatchObject({ status: "in_progress", text: "任务1" });
    expect(display?.rows[1]).toMatchObject({ hidden: true, text: "7 hidden" });
  });

  it("NO_COLOR 也输出中文状态文字，不让 glyph 成为唯一语义", function rendersNoColorLabels() {
    const projection = createTodoProjection();
    const todoItem = projection.presentation.items.find(function isTodoItem(item): boolean { return item.kind === "todo"; });
    if (todoItem?.kind !== "todo") throw new Error("todo item missing");

    const rendered = render(createElement(TuiTodoList, { item: todoItem, expanded: true, useColor: false, screenReader: false, columns: 80 }));
    const frame = rendered.lastFrame() ?? "";

    expect(frame).toContain("[已完成] 梳理现有实现");
    expect(frame).toContain("[进行中] 实现 Todo 卡片");
    expect(frame).toContain("[待处理] 补充回归测试");
    rendered.unmount();
  });

  it("静态历史保存本轮 Todo，screen reader 在所属轮显示当前清单", async function preservesScreenReaderLabelsInHistory() {
    const projection = createTodoProjection();
    const nodes = renderTimeline(projection.events, false, { presentation: projection.presentation, turnId: "turn-todo" }, 80, true);
    const rendered = render(createElement(Fragment, null, ...nodes));
    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("Todo 1/3");
    rendered.unmount();

    const store = createCliTuiStore();
    for (const event of projection.events) store.acceptEvent(event, projection);
    const result: CliControllerResult = { kind: "ok", exitCode: 0, lines: [], projection };
    const controller: CliController = {
      async dispatch() { return result; }, async consume() { return result; }, async resume() { return result; },
      getProjection() { return projection; }, setSession() {}, setEventListener() {},
    };
    const tui = render(createElement(CliTuiApp, {
      store, controller, closeWhenIdle: false, useColor: false, screenReader: true,
      onResult: function ignoreResult() {}, onRequestInterrupt: function ignoreInterrupt() {},
      onRequestCancel: function ignoreCancel() {}, onEof: function ignoreEof() {}, onAppExit: function ignoreExit() {},
    }));
    expect(tui.lastFrame() ?? "").toContain("Todo 1/3");
    tui.stdin.write("\x0f");
    await new Promise<void>(function nextFrame(resolve) { setTimeout(resolve, 40); });
    const expandedFrame = tui.lastFrame() ?? "";
    expect(expandedFrame).toContain("[已完成] 梳理现有实现");
    expect(expandedFrame).toContain("[进行中] 实现 Todo 卡片");
    expect(expandedFrame).toContain("[待处理] 补充回归测试");
    tui.unmount();
  });

  it("窄列下按 grapheme 截断中文行，不会截出半字", function truncatesByGrapheme() {
    // 中文按显示宽度 2 列计；12 列保留 5 个整字加省略号，共 11 列。
    expect(truncateTuiTodoText("核对需求边界并确认实现方案与验收标准的一致性避免范围漂移", 12)).toBe("核对需求边…");
    const todos: TodoItem[] = [{ content: "核对需求边界并确认实现方案与验收标准的一致性，避免范围漂移到相邻模块", activeForm: "正在核对需求边界", status: "in_progress" }];
    const item = { id: "todo:session-todo", kind: "todo" as const, turnId: "turn-todo", todos, counts: { pending: 0, inProgress: 1, completed: 0 } };
    const display = getTuiTodoDisplay(item, { expanded: false, screenReader: false, columns: 24 });
    expect(display?.header.endsWith("…")).toBe(true);
    expect(display?.header).toContain("Todo 0/1 · ");
  });

  it("连续 todo 更新只替换共享单卡，事件流不产生重复静态行", function replacesSingleCardAcrossUpdates() {
    const projector = createCliEventProjector({ sessionId: "session-todo", now: function fixedNow() { return new Date("2026-08-28T00:00:00.000Z"); } });
    projector.project(asEvent({ type: "turn_started", turnId: "turn-todo", stepCount: 0 }));
    const first = createTodoPayload();
    projector.project(asEvent({ type: "todo_updated", turnId: "turn-todo", todoChainId: "chain-1", todos: first.todos, counts: first.counts }));
    const secondTodos: TodoItem[] = [
      ...first.todos.slice(0, 2).map(function markCompleted(todo): TodoItem { return { ...todo, status: "completed" }; }),
      { content: "补充回归测试", activeForm: "正在补充回归测试", status: "in_progress" },
    ];
    projector.project(asEvent({ type: "todo_updated", turnId: "turn-todo", todoChainId: "chain-1", todos: secondTodos, counts: { pending: 0, inProgress: 1, completed: 2 } }));
    const projection = projector.getProjection();

    expect(projection.events.filter(function isTodoEvent(event): boolean { return event.type === "todo_updated"; })).toHaveLength(2);
    expect(projection.presentation.items.filter(function isTodoItem(item): boolean { return item.kind === "todo"; })).toHaveLength(1);
    const todoItem = projection.presentation.items.find(function isTodoItem(item): boolean { return item.kind === "todo"; });
    expect(todoItem?.kind === "todo" && todoItem.counts.completed).toBe(2);
  });

  it("动态区活动行优先显示 activeForm 稳定文案", function liveTurnShowsActiveForm() {
    const projection = createTodoProjection();
    const rendered = render(createElement(TuiLiveTurn, {
      turnId: "turn-todo",
      events: projection.events,
      presentation: projection.presentation,
      status: "running",
      approvalSelectedIndex: 0,
      useColor: false,
      screenReader: false,
      todoExpanded: false,
      maximumWidth: 80,
      metrics: { startedAt: Date.now() - 5_000 },
    }));
    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("正在实现 Todo 卡片");
    expect(frame).toContain("Todo 1/3");
    expect(frame).toContain("Ctrl+O 展开");
    rendered.unmount();
  });

  it("Todo 卡只归属最近更新的 Turn，其他 Turn 不渲染旧卡", function belongsToLatestTurnOnly() {
    const projection = createTodoProjection("turn-other");
    const rendered = render(createElement(TuiLiveTurn, {
      turnId: "turn-todo",
      events: projection.events,
      presentation: projection.presentation,
      status: "running",
      approvalSelectedIndex: 0,
      useColor: false,
      screenReader: false,
      todoExpanded: true,
      maximumWidth: 80,
    }));
    const frame = rendered.lastFrame() ?? "";
    expect(frame).not.toContain("Todo 1/3");
    rendered.unmount();
  });
});
