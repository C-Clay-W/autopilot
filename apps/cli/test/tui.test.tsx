/** Ink TUI Step 5.4 契约测试：stdin 只驱动 Action，Static 与安全事件不重复。 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { CliTuiApp, createCliTuiStore, parseTuiControlAction, resolveTuiDeleteDirection } from "../src/tui.js";
import { createInitialCliProjection } from "../src/event-projector.js";
import type { CliController, CliControllerResult } from "../src/controller.js";
import type { CliAction, CliProjection, CliPublicEvent } from "../src/types.js";

/** 创建不访问文件系统和 Runtime Store 的 TUI Controller double。 */
function createController(calls: CliAction[]): CliController {
  let listener: ((event: CliPublicEvent, projection: CliProjection) => void) | undefined;
  const projection = createInitialCliProjection();
  let selectedSkill: string | undefined;

  function result(kind: CliControllerResult["kind"] = "ok"): CliControllerResult {
    return { kind, exitCode: 0, lines: [], projection };
  }

  return {
    async dispatch(action: CliAction): Promise<CliControllerResult> {
      calls.push(action);
      if (action.type === "list_skills") {
        return {
          ...result(),
          skillOptions: [
            { qualifiedName: "repo:review", displayName: "代码审查", description: "检查当前变更", selected: selectedSkill === "repo:review" },
            { qualifiedName: "user:release", displayName: "发布", description: "准备发布说明", selected: selectedSkill === "user:release" },
          ],
        };
      }
      if (action.type === "toggle_skill") {
        selectedSkill = selectedSkill === action.skill ? undefined : action.skill;
        return {
          ...result(),
          skillOptions: [
            { qualifiedName: "repo:review", displayName: "代码审查", description: "检查当前变更", selected: selectedSkill === "repo:review" },
            { qualifiedName: "user:release", displayName: "发布", description: "准备发布说明", selected: selectedSkill === "user:release" },
          ],
        };
      }
      if (action.type === "submit_prompt") {
        const wasRunning = projection.status === "running";
        projection.turnId = "turn-1";
        projection.status = "running";
        listener?.({ type: "turn_started", seq: 1, turnId: "turn-1", stepCount: 0 }, projection);
        if (action.content === "stay-running") return result();
        if (wasRunning) {
          return { ...result(), submittedInput: { inputId: `input-${action.delivery ?? "steer"}`, delivery: action.delivery ?? "steer" } };
        }
        const answer = action.content === "markdown"
          ? "# 标题\n\n- **重点** 与 `code`\n\n```ts\nconst answer = 42;\n```\n\n| 名称 | 值 |\n| --- | --- |\n| 状态 | [完成](https://example.com) |"
            : action.content === "multiline-table"
              ? "| 文件 | 说明 |\n| --- | --- |\n| index.html | Agent 宣传页，包含很长的说明内容、多个字段和 app/page.tsx 路径，用于验证普通 inline TUI 的多行表格边框。 |\n| test-0803-poker-promo-retry.html | 第二行也包含足够长的内容，确保每一行都保留左右边框并与表头列对齐。 |"
            : action.content === "loose-table"
              ? "常用变体：\n| 序号 | 安装方式 | 命令\n1 | npm 安装 | npm install -g yarn\n5 | 官方安装 | curl -o- -L https://example.com/install.sh | bash"
              : "hello";
        if (action.content === "diff") {
          listener?.({ type: "tool_result", seq: 2, turnId: "turn-1", toolName: "edit_file", status: "success", summary: "Edited src/app.ts (1 changes)", diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new" }, projection);
        } else {
        listener?.({ type: "answer_delta", seq: 2, turnId: "turn-1", delta: answer }, projection);
        }
        projection.status = "completed";
        listener?.({ type: "status", seq: 3, turnId: "turn-1", status: "completed" }, projection);
      }
      return result(action.type === "exit" ? "exit" : "ok");
    },
    async consume(): Promise<CliControllerResult> {
      return result();
    },
    async resume(): Promise<CliControllerResult> {
      return result();
    },
    getProjection(): CliProjection {
      return projection;
    },
    setSession(): void {},
    setEventListener(nextListener): void {
      listener = nextListener;
    },
  };
}

/** 生成最小的审批投影，确保 UI 只从安全字段绘制审批卡。 */
function createApprovalProjection(): CliProjection {
  const projection = createInitialCliProjection();
  projection.turnId = "turn-approval";
  projection.status = "waiting_approval";
  projection.pendingApproval = {
    approvalId: "approval-1",
    toolName: "edit_file",
    reason: "workspace write requires confirmation",
    risk: "write",
  };
  return projection;
}

/** 渲染 TUI 测试组件并把 Controller 结果同步回 Store。 */
function renderTui(controller: CliController, store = createCliTuiStore()): { stdin: { write(value: string): void }; unmount: () => void; lastFrame: () => string | undefined; calls: CliAction[]; results: CliControllerResult[]; exits: number[]; interrupts: number; cancels: number; store: ReturnType<typeof createCliTuiStore> } {
  const calls: CliAction[] = [];
  const results: CliControllerResult[] = [];
  const exits: number[] = [];
  let interrupts = 0;
  let cancels = 0;
  controller.setEventListener(function receiveEvent(event, projection): void {
    store.acceptEvent(event, projection);
  });
  const result = render(
    <CliTuiApp
      store={store}
      controller={controller}
      closeWhenIdle={false}
      useColor={false}
      screenReader={true}
      onResult={function onResult(controllerResult): void { results.push(controllerResult); store.syncProjection(controllerResult.projection); }}
      onRequestInterrupt={function onRequestInterrupt(): void { interrupts += 1; }}
      onRequestCancel={function onRequestCancel(): void { cancels += 1; }}
      onEof={function onEof(): void { exits.push(0); store.requestExit(0); }}
      onAppExit={function onAppExit(code): void { exits.push(code); }}
    />,
  );
  return { stdin: result.stdin, unmount: result.unmount, lastFrame: result.lastFrame, calls, results, exits, interrupts, cancels, store };
}

describe("Ink TUI", function inkTuiSuite() {
  it("dispatch 异常只显示通用错误并按显式开关记录脱敏分类", async function recordsSafeDispatchFailure() {
    const originalDiagnostics = process.env.AUTOPILOT_PERF_DIAGNOSTICS;
    const diagnosticKey = Symbol.for("autopilot.performanceDiagnostics");
    const diagnosticTarget = globalThis as typeof globalThis & Record<symbol, Array<Record<string, unknown>> | undefined>;
    const beforeCount = diagnosticTarget[diagnosticKey]?.length ?? 0;
    process.env.AUTOPILOT_PERF_DIAGNOSTICS = "1";
    const calls: CliAction[] = [];
    const controller = createController(calls);
    controller.dispatch = async function failDispatch() { throw new Error("api_key=secret C:/private/provider-prompt.txt"); };
    const rendered = renderTui(controller);

    try {
      rendered.stdin.write("hello");
      rendered.stdin.write("\r");
      await new Promise<void>(function waitForDispatchError(resolve) { setTimeout(resolve, 30); });

      expect(rendered.results.at(-1)?.message).toBe("CLI_RUNTIME_ERROR");
      const records = (diagnosticTarget[diagnosticKey] ?? []).slice(beforeCount)
        .filter(function isRuntimeError(record) { return record.point === "tui_runtime_error"; });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        point: "tui_runtime_error",
        eventType: "dispatch",
        errorCategory: "unknown",
        errorCode: "CLI_RUNTIME_ERROR",
      });
      expect(JSON.stringify(records)).not.toMatch(/secret|private|provider-prompt/iu);
    } finally {
      rendered.unmount();
      if (originalDiagnostics === undefined) delete process.env.AUTOPILOT_PERF_DIAGNOSTICS;
      else process.env.AUTOPILOT_PERF_DIAGNOSTICS = originalDiagnostics;
      process.env.AUTOPILOT_PERF_DIAGNOSTICS_FILE = "";
    }
  });

  it("stdin prompt dispatches submit_prompt and aggregates completed turn once", async function dispatchesPrompt() {
    const calls: CliAction[] = [];
    const controller = createController(calls);
    const store = createCliTuiStore();
    const rendered = renderTui(controller, store);

    rendered.stdin.write("hello");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForInkFrame(resolve) { setTimeout(resolve, 20); });

    expect(calls).toEqual([{ type: "submit_prompt", content: "hello" }]);
    expect(store.getSnapshot().transcript.filter(function isTurn(item) { return item.kind === "turn"; })).toHaveLength(1);
    expect(store.getSnapshot().liveEvents).toHaveLength(3);
    expect(store.getSnapshot().liveEvents).toContainEqual({ type: "status", seq: 3, turnId: "turn-1", status: "completed" });
    expect(rendered.lastFrame() ?? "").not.toContain("Esc interrupt");
    rendered.unmount();
  });

  it("slash command is parsed before Controller dispatch", async function dispatchesSlashAction() {
    const calls: CliAction[] = [];
    const controller = createController(calls);
    const rendered = renderTui(controller);

    rendered.stdin.write("/compact");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForInkFrame(resolve) { setTimeout(resolve, 20); });

    expect(calls).toEqual([{ type: "compact" }]);
    rendered.unmount();
  });

  it("运行中保持可输入：普通 prompt 是引导，/queue 是排队并以同一等待态显示", async function acceptsGuidanceAndQueueWhileRunning() {
    const calls: CliAction[] = [];
    const rendered = renderTui(createController(calls));

    rendered.stdin.write("stay-running");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForRunning(resolve) { setTimeout(resolve, 20); });
    rendered.stdin.write("先检查改动");
    rendered.stdin.write("\r");
    rendered.stdin.write("/queue 然后执行测试");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForInputs(resolve) { setTimeout(resolve, 30); });

    expect(calls).toEqual([
      { type: "submit_prompt", content: "stay-running" },
      { type: "submit_prompt", content: "先检查改动" },
      { type: "submit_prompt", content: "然后执行测试", delivery: "queue" },
    ]);
    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("先检查改动");
    expect(frame).toContain("然后执行测试");
    expect(frame).toContain("[引导] 等待当前步骤结束");
    expect(frame).toContain("[排队] 等待当前步骤结束");
    expect(frame).toContain("Esc interrupt");
    expect(frame).toContain("Enter 引导");
    rendered.unmount();
  });

  it("input_consumed 清除等待态并保留唯一普通用户正文", function settlesPendingPromptOnce() {
    const store = createCliTuiStore();
    store.addPendingPrompt("请继续检查", { inputId: "input-1", delivery: "steer" });
    const projection = createInitialCliProjection();
    projection.turnId = "turn-1";
    projection.status = "running";

    store.acceptEvent({ type: "input_consumed", seq: 1, turnId: "turn-1", inputId: "input-1" }, projection);
    store.acceptEvent({ type: "input_consumed", seq: 1, turnId: "turn-1", inputId: "input-1" }, projection);

    expect(store.getSnapshot().pendingInputs).toEqual([]);
    expect(store.getSnapshot().transcript.filter(function isPrompt(item) { return item.kind === "prompt"; })).toHaveLength(0);
    expect(store.getSnapshot().liveEvents).toContainEqual(expect.objectContaining({
      type: "tui_input_consumed",
      turnId: "turn-1",
      inputId: "input-1",
      content: "请继续检查",
      delivery: "steer",
    }));
  });

  it("消费事件先于投递回调时仍外显一次正文且不恢复等待态", function displaysLateConfirmedInputOnce() {
    const store = createCliTuiStore();
    const projection = createInitialCliProjection();
    projection.turnId = "turn-1";
    projection.status = "running";
    store.acceptEvent({ type: "input_consumed", seq: 1, turnId: "turn-1", inputId: "input-1" }, projection);
    store.addPendingPrompt("继续检查", { inputId: "input-1", delivery: "steer" });
    store.addPendingPrompt("继续检查", { inputId: "input-1", delivery: "steer" });
    expect(store.getSnapshot().pendingInputs).toEqual([]);
    expect(store.getSnapshot().transcript.filter(function isPrompt(item) { return item.kind === "prompt"; })).toHaveLength(0);
  });

  it("终态先于投递回调时将用户正文留在对应历史 Turn 内", function ordersLateConfirmedInputBeforeTurn() {
    const store = createCliTuiStore();
    const projection = createInitialCliProjection();
    projection.turnId = "turn-1";
    projection.status = "running";
    store.acceptEvent({ type: "input_consumed", seq: 1, turnId: "turn-1", inputId: "input-1" }, projection);
    projection.status = "completed";
    store.acceptEvent({ type: "status", seq: 2, turnId: "turn-1", status: "completed" }, projection);
    store.addPendingPrompt("继续检查", { inputId: "input-1", delivery: "steer" });
    expect(store.getSnapshot().transcript.map(function getKind(item) { return item.kind; })).toEqual(["turn"]);
  });

  it("提交审批后将等待卡替换为审批已提交结果", function settlesApprovalCard() {
    const store = createCliTuiStore();
    store.syncProjection(createApprovalProjection());
    store.acceptEvent({
      type: "approval_required",
      seq: 1,
      turnId: "turn-approval",
      approvalId: "approval-1",
      toolName: "edit_file",
      reason: "需要审批",
    }, createApprovalProjection());
    store.recordApprovalSubmission("allow_workspace");

    expect(store.getSnapshot().pendingApproval).toBeUndefined();
    expect(store.getSnapshot().liveEvents).toContainEqual({
      type: "tui_approval_submitted",
      seq: Number.MAX_SAFE_INTEGER,
      turnId: "turn-approval",
      approvalId: "approval-1",
      decision: "allow_workspace",
    });

    const staleProjection = createApprovalProjection();
    store.syncProjection(staleProjection);
    store.acceptEvent({
      type: "tool_started",
      seq: 2,
      turnId: "turn-approval",
      toolName: "edit_file",
      summary: "Writing fixture.txt",
    }, staleProjection);

    expect(store.getSnapshot().pendingApproval).toBeUndefined();
  });

  it("/skill 打开可搜索 picker，空格切换 Skill，回车只保存并关闭", async function togglesSkillFromPicker() {
    const calls: CliAction[] = [];
    const rendered = renderTui(createController(calls));

    rendered.stdin.write("/skill");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForPicker(resolve) { setTimeout(resolve, 20); });
    const openedFrame = rendered.lastFrame() ?? "";
    expect(openedFrame).toContain("Skills");
    expect(openedFrame).toContain("Search:");
    expect(openedFrame).toContain("代码审查 · repo:review");
    expect(openedFrame).toContain("发布 · user:release");

    expect(openedFrame).toContain("[off] 代码审查 · repo:review");

    rendered.stdin.write(" ");
    await new Promise<void>(function waitForToggle(resolve) { setTimeout(resolve, 20); });
    expect(rendered.lastFrame() ?? "").toContain("[on] 代码审查 · repo:review");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForSelection(resolve) { setTimeout(resolve, 20); });

    expect(calls).toEqual([
      { type: "list_skills" },
      { type: "toggle_skill", skill: "repo:review" },
    ]);
    expect(rendered.lastFrame() ?? "").not.toContain("Search:");
    rendered.unmount();
  });

  it("回答区将常用 Markdown 显示为终端结构而非原始标记", async function rendersMarkdown() {
    const calls: CliAction[] = [];
    const rendered = renderTui(createController(calls));

    rendered.stdin.write("markdown");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForInkFrame(resolve) { setTimeout(resolve, 20); });

    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("标题");
    expect(frame).not.toContain("# 标题");
    expect(frame).toContain("重点 与 code");
    expect(frame).not.toContain("**重点**");
    expect(frame).toContain("code · ts");
    expect(frame).toContain("const answer = 42;");
    expect(frame).toContain("┌");
    expect(frame).toContain("┼");
    expect(frame).toContain("┘");
    expect(frame).toContain("完成 (https://example.com)");
    rendered.unmount();
  });

  it("模型漏掉分隔行时仍将有表头的竖线分列文本渲染为表格", async function rendersLooseMarkdownTable() {
    const calls: CliAction[] = [];
    const rendered = renderTui(createController(calls));

    rendered.stdin.write("loose-table");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForInkFrame(resolve) { setTimeout(resolve, 20); });

    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("┌");
    expect(frame).toContain("│");
    expect(frame).toContain("┘");
    expect(frame).not.toContain("| 序号 | 安装方式 | 命令");
    rendered.unmount();
  });

  it("普通 inline TUI 的长表格按单元格换行且每个视觉行保留左右边框", async function rendersMultilineInlineTable() {
    const calls: CliAction[] = [];
    const rendered = renderTui(createController(calls));

    rendered.stdin.write("multiline-table");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForInkFrame(resolve) { setTimeout(resolve, 20); });

    const frame = rendered.lastFrame() ?? "";
    const tableLines = frame.split("\n").filter(function selectTableLines(line): boolean {
      return line.includes("│") && !line.includes("›");
    });
    expect(frame).toContain("index.html");
    expect(frame).toContain("Agent 宣传页");
    expect(tableLines.length).toBeGreaterThanOrEqual(5);
    expect(tableLines.every(function keepsTableBorder(line): boolean { return line.trimEnd().endsWith("│"); })).toBe(true);
    expect(frame).not.toContain("| 文件 | 说明 |");
    rendered.unmount();
  });

  it("流式表格在至少收到一行数据前保留原文，完成后一次性对齐", async function defersStreamingTableLayout() {
    const store = createCliTuiStore();
    const projection = createInitialCliProjection();
    projection.turnId = "turn-streaming-table";
    projection.status = "running";
    store.acceptEvent({ type: "turn_started", seq: 1, turnId: "turn-streaming-table", stepCount: 0 }, projection);
    store.acceptEvent({ type: "answer_delta", seq: 2, turnId: "turn-streaming-table", delta: "| Name | Version |\n| --- | --- |\n" }, projection);
    const rendered = renderTui(createController([]), store);
    await new Promise<void>(function waitForPartialTableFrame(resolve) { setTimeout(resolve, 20); });
    expect(rendered.lastFrame() ?? "").toContain("| Name | Version |");
    expect(rendered.lastFrame() ?? "").not.toContain("┬");

    store.acceptEvent({ type: "answer_delta", seq: 3, turnId: "turn-streaming-table", delta: "| cli | 1.0.0 |" }, projection);
    projection.status = "completed";
    store.acceptEvent({ type: "status", seq: 4, turnId: "turn-streaming-table", status: "completed" }, projection);
    await new Promise<void>(function waitForCompleteTableFrame(resolve) { setTimeout(resolve, 20); });
    expect(rendered.lastFrame() ?? "").toContain("┌");
    expect(rendered.lastFrame() ?? "").toContain("│ Name");
    expect(rendered.lastFrame() ?? "").toContain("┘");
    rendered.unmount();
  });

  it("成功 edit_file 在终端显示最终 unified diff，并区分新增和删除行", async function rendersFinalEditDiff() {
    const calls: CliAction[] = [];
    const rendered = renderTui(createController(calls));

    rendered.stdin.write("diff");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForInkFrame(resolve) { setTimeout(resolve, 20); });

    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("Edited src/app.ts (1 changes)");
    expect(frame).toContain("(+1, -1)");
    expect(frame).toContain("--- a/src/app.ts");
    expect(frame).toContain("-old");
    expect(frame).toContain("+new");
    rendered.unmount();
  });

  it("approval picker uses arrows and Enter to dispatch the four-field-safe decision only", async function dispatchesApproval() {
    const calls: CliAction[] = [];
    const controller = createController(calls);
    const store = createCliTuiStore();
    store.syncProjection(createApprovalProjection());
    const rendered = renderTui(controller, store);

    rendered.stdin.write("\u001b[B");
    rendered.stdin.write("\u001b[B");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForInkFrame(resolve) { setTimeout(resolve, 20); });

    expect(calls).toEqual([{ type: "approve", decision: "allow_workspace" }]);
    rendered.unmount();
  });

  it("Ctrl+C 与 Esc 同时兼容 Ink 键对象和原始终端控制字符", function parsesTerminalControlActions() {
    expect(parseTuiControlAction("c", { ctrl: true } as never)).toBe("interrupt");
    expect(parseTuiControlAction("\u0003", {} as never)).toBe("interrupt");
    expect(parseTuiControlAction("", { escape: true } as never)).toBe("cancel");
    expect(parseTuiControlAction("\u001b", {} as never)).toBe("cancel");
    expect(parseTuiControlAction("\u0004", {} as never)).toBe("eof");
  });

  it("Backspace 与 Delete 根据终端原始字符和 Ink 键标记保持方向不同", function separatesDeleteDirections() {
    expect(resolveTuiDeleteDirection("", { delete: true } as never, "\u007f")).toBe("backspace");
    expect(resolveTuiDeleteDirection("", { backspace: true } as never)).toBe("backspace");
    expect(resolveTuiDeleteDirection("", { delete: true } as never, "\u001b[3~")).toBe("delete");
  });

  it("输入框显示光标并支持左右键在 Unicode grapheme 之间插入", async function editsInputAtCursor() {
    const calls: CliAction[] = [];
    const rendered = renderTui(createController(calls));

    rendered.stdin.write("a👩🏽‍💻中");
    rendered.stdin.write("\u001b[D");
    rendered.stdin.write("b");
    await new Promise<void>(function waitForInkFrame(resolve) { setTimeout(resolve, 20); });

    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("a👩🏽‍💻b▏中");
    rendered.unmount();
  });

  it("长 prompt 按视觉软换行上下移动，且左右插入不会重排文本", async function movesAcrossSoftWrappedLines() {
    const calls: CliAction[] = [];
    const rendered = renderTui(createController(calls));
    const input = Array.from({ length: 190 }, function buildCharacter(_, index) { return String.fromCharCode(97 + (index % 26)); }).join("");

    rendered.stdin.write(input);
    await new Promise<void>(function waitForInputFrame(resolve) { setTimeout(resolve, 20); });
    rendered.stdin.write("\u001b[A");
    await new Promise<void>(function waitForUpFrame(resolve) { setTimeout(resolve, 20); });
    rendered.stdin.write("X");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForSubmit(resolve) { setTimeout(resolve, 30); });
    expect(calls).toEqual([{ type: "submit_prompt", content: input.slice(0, 93) + "X" + input.slice(93) }]);
    rendered.unmount();
  });

  it("上下键保持目标视觉列，并按中文显示宽度选择 grapheme 边界", async function keepsVerticalColumnForWideText() {
    const calls: CliAction[] = [];
    const rendered = renderTui(createController(calls));
    const input = "甲".repeat(47) + "\n" + "乙".repeat(10) + "\n" + "丙".repeat(47);

    rendered.stdin.write(input);
    await new Promise<void>(function waitForInputFrame(resolve) { setTimeout(resolve, 20); });
    rendered.stdin.write("\u001b[A");
    await new Promise<void>(function waitForFirstUpFrame(resolve) { setTimeout(resolve, 20); });
    rendered.stdin.write("\u001b[A");
    await new Promise<void>(function waitForSecondUpFrame(resolve) { setTimeout(resolve, 20); });
    rendered.stdin.write("X");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForSubmit(resolve) { setTimeout(resolve, 30); });

    expect(calls).toEqual([{ type: "submit_prompt", content: "甲".repeat(46) + "X甲\n" + "乙".repeat(10) + "\n" + "丙".repeat(47) }]);
    rendered.unmount();
  });

  it("Shift+Enter 插入真实换行，普通 Enter 仍提交", async function insertsNewlineWithShiftEnter() {
    const calls: CliAction[] = [];
    const rendered = renderTui(createController(calls));

    rendered.stdin.write("第一行");
    rendered.stdin.write("\u001b[13;2u");
    rendered.stdin.write("第二行");
    rendered.stdin.write("\u001b[27;2;13~");
    rendered.stdin.write("第三行");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForSubmit(resolve) { setTimeout(resolve, 30); });

    expect(calls).toEqual([{ type: "submit_prompt", content: "第一行\n第二行\n第三行" }]);
    rendered.unmount();
  });

  it("反斜线加 Enter 将续行标记替换为换行", async function insertsNewlineWithBackslashEnter() {
    const calls: CliAction[] = [];
    const rendered = renderTui(createController(calls));

    rendered.stdin.write("第一行\\");
    rendered.stdin.write("\r");
    rendered.stdin.write("第二行");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForSubmit(resolve) { setTimeout(resolve, 30); });

    expect(calls).toEqual([{ type: "submit_prompt", content: "第一行\n第二行" }]);
    rendered.unmount();
  });

  it("一次性粘贴的 CR 与 CRLF 会归一为换行，不覆盖文本也不提前提交", async function normalizesPastedLineEndings() {
    const calls: CliAction[] = [];
    const rendered = renderTui(createController(calls));

    rendered.stdin.write("第一行\r\n第二行\r第三行");
    await new Promise<void>(function waitForPasteFrame(resolve) { setTimeout(resolve, 20); });

    expect(rendered.lastFrame() ?? "").toContain("第一行");
    expect(rendered.lastFrame() ?? "").toContain("第二行");
    expect(rendered.lastFrame() ?? "").toContain("第三行");
    expect(calls).toEqual([]);
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForSubmit(resolve) { setTimeout(resolve, 30); });
    expect(calls).toEqual([{ type: "submit_prompt", content: "第一行\n第二行\n第三行" }]);
    rendered.unmount();
  });

  it("bracketed paste 中拆开的回车只换行，结束后普通 Enter 才提交", async function keepsBracketedPasteTogether() {
    const calls: CliAction[] = [];
    const rendered = renderTui(createController(calls));

    rendered.stdin.write("\u001b[200~");
    rendered.stdin.write("第一行");
    rendered.stdin.write("\r");
    rendered.stdin.write("\n");
    rendered.stdin.write("第二行");
    rendered.stdin.write("\r");
    rendered.stdin.write("第三行");
    rendered.stdin.write("\u001b[201~");
    await new Promise<void>(function waitForPasteFrame(resolve) { setTimeout(resolve, 20); });

    expect(calls).toEqual([]);
    expect(rendered.lastFrame() ?? "").toContain("第一行");
    expect(rendered.lastFrame() ?? "").toContain("第二行");
    expect(rendered.lastFrame() ?? "").toContain("第三行");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForSubmit(resolve) { setTimeout(resolve, 30); });
    expect(calls).toEqual([{ type: "submit_prompt", content: "第一行\n第二行\n第三行" }]);
    rendered.unmount();
  });

  it("Ctrl+D follows the normal EOF exit path", async function delegatesEof() {
    const calls: CliAction[] = [];
    const controller = createController(calls);
    const rendered = renderTui(controller);

    rendered.stdin.write("\u0004");
    await new Promise<void>(function waitForInkFrame(resolve) { setTimeout(resolve, 20); });

    expect(rendered.exits).toContain(0);
    expect(calls).toEqual([]);
    rendered.unmount();
  });

  it("duplicate event sequence does not duplicate Static transcript", function deduplicatesStaticTranscript() {
    const store = createCliTuiStore();
    const projection = createInitialCliProjection();
    projection.turnId = "turn-1";
    projection.status = "running";
    store.acceptEvent({ type: "turn_started", seq: 1, turnId: "turn-1", stepCount: 0 }, projection);
    store.acceptEvent({ type: "answer_delta", seq: 2, turnId: "turn-1", delta: "a" }, projection);
    store.acceptEvent({ type: "answer_delta", seq: 2, turnId: "turn-1", delta: "a" }, projection);
    projection.status = "completed";
    store.acceptEvent({ type: "status", seq: 3, turnId: "turn-1", status: "completed" }, projection);

    const turns = store.getSnapshot().transcript.filter(function isTurn(item) { return item.kind === "turn"; });
    expect(turns).toHaveLength(1);
    expect((turns[0] as Extract<typeof turns[number], { kind: "turn" }>).events).toHaveLength(3);
  });

  it("无色模式不输出 ANSI 控制码且保留可读标签", function rendersNoColorWithoutAnsi() {
    const calls: CliAction[] = [];
    const rendered = renderTui(createController(calls));

    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("Ready");
    expect(frame).toContain("/exit to quit");
    expect(frame).not.toContain("\u001b[");
    rendered.unmount();
  });
});
