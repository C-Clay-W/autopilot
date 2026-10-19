/** TodoListCard 测试：锁定单卡折叠、精简 status 播报、状态降级与长文本边界。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TodoItem } from "@autopilot-agent/core";
import type { TodoSnapshotItem } from "@autopilot-agent/presentation";
import TodoListCard, { TodoListRows } from "@/app/chat/components/TodoListCard";

/** 构造三态混合的安全 Todo 快照。 */
function createTodoSnapshot(): TodoSnapshotItem {
  const todos: TodoItem[] = [
    { content: "梳理现有实现", activeForm: "正在梳理现有实现", status: "completed" },
    { content: "实现 Todo 卡片", activeForm: "正在实现 Todo 卡片", status: "in_progress" },
    { content: "补充回归测试", activeForm: "正在补充回归测试", status: "pending" },
  ];
  return { id: "todo:session-1", kind: "todo", turnId: "turn-1", todos, counts: { pending: 1, inProgress: 1, completed: 1 } };
}

/** 构造 20 项长中文边界列表，覆盖 Stage 3 的项数与文本长度验收。 */
function createLongChineseTodos(): TodoItem[] {
  return Array.from({ length: 20 }, function createLongTodoItem(_, index) {
    const status = index < 8 ? "completed" : index === 8 ? "in_progress" : "pending";
    const content = `第${index + 1}步：核对需求边界并确认实现方案与验收标准的一致性，避免范围漂移`;
    return { content, activeForm: `正在执行第${index + 1}步`, status };
  });
}

/** 从静态标记中截取 status live region 片段，校验播报内容不混入整表。 */
function extractStatusRegion(markup: string): string {
  const start = markup.indexOf('<p role="status"');
  expect(start).toBeGreaterThanOrEqual(0);
  return markup.slice(start, markup.indexOf("</p>", start));
}

describe("TodoListCard", function todoListCardSuite() {
  it("默认折叠显示标题、计数与当前 activeForm，不提前渲染清单行", function rendersCollapsedHeaderOnly() {
    const markup = renderToStaticMarkup(<TodoListCard item={createTodoSnapshot()} />);

    expect(markup).toContain("Todo");
    expect(markup).toContain("1/3");
    expect(markup).toContain("正在实现 Todo 卡片");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="todo-body-todo:session-1"');
    expect(markup).not.toContain("梳理现有实现");
    expect(markup).not.toContain("补充回归测试");
  });

  it("role=status 只播报精简进度与当前项，不重复朗读整表", function announcesCompactStatusOnly() {
    const markup = renderToStaticMarkup(<TodoListCard item={createTodoSnapshot()} />);
    const statusRegion = extractStatusRegion(markup);

    expect(markup).toContain('aria-live="polite"');
    expect(statusRegion).toContain("已完成 1/3，正在：正在实现 Todo 卡片");
    expect(statusRegion).not.toContain("梳理现有实现");
    expect(statusRegion).not.toContain("补充回归测试");
  });

  it("展开清单按状态降级：勾选加删除线、实心方块加粗、空心方块正文", function rendersStatusFallbackRows() {
    const markup = renderToStaticMarkup(<TodoListRows todos={createTodoSnapshot().todos} />);

    expect(markup).toContain("✓");
    expect(markup).toContain("■");
    expect(markup).toContain("□");
    expect(markup).toContain("line-through");
    expect(markup).toContain("font-bold");
    expect(markup).toContain("break-words");
    expect(markup).toContain("已完成");
    expect(markup).toContain("进行中");
    expect(markup).toContain("待处理");
  });

  it("空列表渲染为空节点，模型清空后不再显示旧卡", function rendersNothingWhenCleared() {
    const item = { ...createTodoSnapshot(), todos: [] as TodoItem[], counts: { pending: 0, inProgress: 0, completed: 0 } };
    const markup = renderToStaticMarkup(<TodoListCard item={item} />);

    expect(markup).toBe("");
  });

  it("全部完成时不显示 activeForm，status 只播报最终计数", function rendersCompletedListWithoutActiveForm() {
    const todos: TodoItem[] = [
      { content: "梳理现有实现", activeForm: "正在梳理现有实现", status: "completed" },
      { content: "实现 Todo 卡片", activeForm: "正在实现 Todo 卡片", status: "completed" },
    ];
    const item = { ...createTodoSnapshot(), todos, counts: { pending: 0, inProgress: 0, completed: 2 } };
    const markup = renderToStaticMarkup(<TodoListCard item={item} />);
    const statusRegion = extractStatusRegion(markup);

    expect(markup).toContain("2/2");
    expect(markup).not.toContain("正在梳理现有实现");
    expect(statusRegion).toContain("已完成 2/2");
    expect(statusRegion).not.toContain("正在：");
  });

  it("20 项长中文清单完整渲染且行内换行、头部截断保留完整 title", function rendersTwentyLongChineseItems() {
    const todos = createLongChineseTodos();
    const item = { ...createTodoSnapshot(), todos, counts: { pending: 11, inProgress: 1, completed: 8 } };
    const markup = renderToStaticMarkup(<TodoListCard item={item} />);
    const rowsMarkup = renderToStaticMarkup(<TodoListRows todos={todos} />);

    expect(markup).toContain("8/20");
    expect(markup).toContain('title="正在执行第9步"');
    expect(rowsMarkup.match(/<li /g)?.length).toBe(20);
    expect(rowsMarkup.match(/break-words/g)?.length).toBe(20);
  });
});
