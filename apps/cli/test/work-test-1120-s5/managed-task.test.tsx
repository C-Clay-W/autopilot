/** 执行者 TASK 的首屏视觉布局和附着历史去重回归。 */
import { render } from "ink-testing-library";
import { expect, test } from "vitest";
import { createCliTuiStore } from "../../src/tui/store.js";
import { createTuiViewportSourceCache } from "../../src/tui/viewport/sources.js";
import { createTimelineVisualLines } from "../../src/timeline-lines.js";
import { TuiTranscriptItem } from "../../src/tui/transcript.js";
import { createInitialCliProjection } from "../../src/event-projector.js";

test("TASK 独占一行且前后空行，在已有历史前展示完整正文，轮询重放不重复", function task() {
  const store = createCliTuiStore();
  store.acceptEvent({ type: "tool_started", seq: 2, turnId: "current-turn", toolName: "glob_files", summary: "查看工作区文件" }, { ...createInitialCliProjection(), status: "running" });
  const body = "制作页面\r\n交付 \u001b[31mHTML\u001b[0m";
  store.recordTask("dispatch", body);
  store.recordTask("dispatch", body);
  const snapshot = store.getSnapshot();
  expect(snapshot.transcript.map(function key(item) { return item.key; })).toEqual(["task:dispatch"]);
  const lines = createTimelineVisualLines(createTuiViewportSourceCache().getSources(snapshot, undefined, 0, 80), 80);
  const taskLines = lines.filter(function first(line) { return line.itemId === "task:dispatch"; });
  expect(taskLines.map(function text(line) { return line.text; })).toEqual(["", "TASK", "", "制作页面", "交付 HTML"]);
  const toolIndex = lines.findIndex(function tool(line) { return line.itemId === "current-turn:2"; });
  expect(toolIndex).toBeGreaterThan(lines.indexOf(taskLines.at(-1)!));
  const view = render(<TuiTranscriptItem item={snapshot.transcript[0]} columns={80} useColor={false} />);
  try {
    expect(view.lastFrame()?.split("\n").map(function content(line) { return line.trim(); })).toEqual(["", "TASK", "", "制作页面", "交付 HTML"]);
  } finally { view.unmount(); }
});
