/**
 * @文件提及 TUI 菜单契约测试：@ 触发与空查询候选、输入收窄、≤5 行滚动、Tab/Enter 插入、
 * Esc 仅关闭且 prompt 保留、token 变化复活与 slash 菜单回归（G1-G4、G10 相关）。
 */

import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CliTuiApp, createCliTuiStore } from "../src/tui.js";
import { resetFileMentionIndexCache } from "../src/tui/hooks/use-file-mention-index.js";
import { createInitialCliProjection } from "../src/event-projector.js";
import { createManagedCliController } from "../src/managed-controller.js";
import type { CliController, CliControllerResult } from "../src/controller.js";
import type { CliTuiInitialOperation } from "../src/tui/types.js";
import type { CliAction, CliProjection, CliPublicEvent } from "../src/types.js";

const MENTION_FIXTURE_FILES = [
  "apps/cli/src/main.ts",
  "apps/cli/src/ma/notes.md",
  "apps/web/main.tsx",
  "docs/guide.md",
  "docs/main-guide.md",
  "src/index.ts",
  "tools/maintain.py",
  "README.md",
];

vi.mock("@autopilot-agent/core", async function mockCore(importOriginal) {
  const actual = await importOriginal<typeof import("@autopilot-agent/core")>();
  return {
    ...actual,
    listWorkspaceFiles: vi.fn(async function listFixtureFiles() {
      return { files: MENTION_FIXTURE_FILES, truncated: false };
    }),
  };
});

/** 创建不访问文件系统和 Runtime Store 的 TUI Controller double。 */
function createController(calls: CliAction[]): CliController {
  let listener: ((event: CliPublicEvent, projection: CliProjection) => void) | undefined;
  const projection = createInitialCliProjection();
  function result(kind: CliControllerResult["kind"] = "ok"): CliControllerResult {
    return { kind, exitCode: 0, lines: [], projection };
  }
  return {
    async dispatch(action: CliAction): Promise<CliControllerResult> {
      calls.push(action);
      if (action.type === "submit_prompt") {
        projection.turnId = "turn-1";
        projection.status = "completed";
        listener?.({ type: "status", seq: 1, turnId: "turn-1", status: "completed" }, projection);
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

/** 渲染带 @ 索引工作区的 TUI 测试组件；提交注入用例可覆盖 workspaceRoot 与 initial 操作。 */
function renderMentionTui(
  calls: CliAction[],
  options: { workspaceRoot?: string; initial?: CliTuiInitialOperation; controller?: CliController; terminalSizeSource?: EventEmitter & { columns: number; rows: number }; screenReader?: boolean } = {},
): { stdin: { write(value: string): void }; unmount: () => void; lastFrame: () => string | undefined } {
  const result = render(
    <CliTuiApp
      store={createCliTuiStore()}
      controller={options.controller ?? createController(calls)}
      closeWhenIdle={false}
      useColor={false}
      screenReader={options.screenReader ?? true}
      terminalSizeSource={options.terminalSizeSource}
      workspaceRoot={options.workspaceRoot ?? process.cwd()}
      initial={options.initial}
      onResult={function onResult(): void {}}
      onRequestInterrupt={function onRequestInterrupt(): void {}}
      onRequestCancel={function onRequestCancel(): void {}}
      onEof={function onEof(): void {}}
      onAppExit={function onAppExit(): void {}}
    />,
  );
  return { stdin: result.stdin, unmount: result.unmount, lastFrame: result.lastFrame };
}

/** 等待一帧渲染稳定。 */
async function waitForFrame(): Promise<void> {
  await new Promise<void>(function waitFrame(resolve) {
    setTimeout(resolve, 30);
  });
}

/** 候选建立前只保留输入，键盘断言等到菜单实际出现。 */
async function waitForMentionMenu(rendered: ReturnType<typeof renderMentionTui>): Promise<void> {
  await vi.waitFor(function menuIsReady() {
    expect(rendered.lastFrame() ?? "").toContain("enter/tab insert");
  });
}

afterEach(function resetIndexCache() {
  resetFileMentionIndexCache();
});

describe("TuiFileMentionMenu", function fileMentionMenuSuite() {
  it("输入 @ 弹出候选菜单：空查询返回一层目录与文件，含键位提示行与计数", async function opensMenuOnAt() {
    const calls: CliAction[] = [];
    const rendered = renderMentionTui(calls);
    rendered.stdin.write("看看 @");
    await waitForMentionMenu(rendered);

    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("Files");
    expect(frame).toContain("enter/tab insert · esc close · ↑/↓ select");
    expect(frame).toContain("apps/");
    expect(frame).toContain("docs/");
    expect(frame).toContain("file selector");
    // 空查询候选共 12 条，窗口只显示排序前 5 行，README.md 不应在首帧出现。
    expect(frame).not.toContain("README.md");
    rendered.unmount();
  });

  it("输入越完整候选越少", async function narrowsByQuery() {
    const calls: CliAction[] = [];
    const rendered = renderMentionTui(calls);
    rendered.stdin.write("看看 @ma");
    await waitForMentionMenu(rendered);

    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("apps/cli/src/main.ts");
    expect(frame).toContain("docs/main-guide.md");
    expect(frame).toContain("tools/maintain.py");
    rendered.unmount();
  });

  it("候选超过 5 行时连按 ↓ 窗口滚动且选中项始终可见", async function scrollsWindow() {
    const calls: CliAction[] = [];
    const rendered = renderMentionTui(calls);
    rendered.stdin.write("@");
    await waitForMentionMenu(rendered);
    for (let index = 0; index < 5; index += 1) {
      rendered.stdin.write("\u001b[B");
      await waitForFrame();
    }

    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("› docs/guide.md");
    expect(frame).not.toContain("› apps/");
    expect(frame).toContain("6/12 files");
    rendered.unmount();
  });

  it("Enter 插入文件候选（尾随空格）且菜单随 token 结束而消失", async function insertsFileCandidate() {
    const calls: CliAction[] = [];
    const rendered = renderMentionTui(calls);
    rendered.stdin.write("看看 @ma");
    await waitForMentionMenu(rendered);
    rendered.stdin.write("\r");
    await waitForFrame();

    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("看看 @apps/cli/src/main.ts");
    expect(frame).not.toContain("enter/tab insert");
    rendered.unmount();
  });

  it("Enter 插入目录候选（尾随 /）后菜单保留可继续下钻", async function insertsDirectoryCandidate() {
    const calls: CliAction[] = [];
    const rendered = renderMentionTui(calls);
    rendered.stdin.write("@");
    await waitForMentionMenu(rendered);
    rendered.stdin.write("\r");
    await waitForFrame();

    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("@apps/");
    expect(frame).toContain("enter/tab insert");
    rendered.unmount();
  });

  it("Esc 仅关闭菜单且 prompt 保留，输入变化后菜单复活", async function escapeClosesAndKeepsPrompt() {
    const calls: CliAction[] = [];
    const rendered = renderMentionTui(calls);
    rendered.stdin.write("看看 @ma");
    await waitForMentionMenu(rendered);
    rendered.stdin.write("\u001b");
    await waitForFrame();

    let frame = rendered.lastFrame() ?? "";
    expect(frame).not.toContain("enter/tab insert");
    expect(frame).toContain("看看 @ma");

    // 同一输入下菜单不复活；token 变化（继续输入）后复活。
    rendered.stdin.write("i");
    await waitForFrame();
    frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("看看 @mai");
    expect(frame).toContain("enter/tab insert");
    rendered.unmount();
  });

  it("slash 菜单不受 @ 菜单影响", async function slashMenuStillWorks() {
    const calls: CliAction[] = [];
    const rendered = renderMentionTui(calls);
    rendered.stdin.write("/");
    await waitForFrame();

    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("Commands");
    expect(frame).not.toContain("enter/tab insert · esc close · ↑/↓ select");
    rendered.unmount();
  });

  it("编排专属 slash 用原 Tab 和 Enter 补全与提交，普通入口保留公共目录", async function managedSlashKeyboard() {
    const sent: string[] = [];
    const controller = createManagedCliController(async function request(operation, extra) {
      if (operation === "input") { sent.push(String(extra?.text)); return "已提交"; }
      return undefined;
    }, function notice() {});
    const rendered = renderMentionTui([], { controller });
    try {
      rendered.stdin.write("/recov");
      await vi.waitFor(function suggests() { expect(rendered.lastFrame()).toContain("/recover"); });
      rendered.stdin.write("\t");
      await waitForFrame();
      expect(sent).toEqual([]);
      rendered.stdin.write("\r");
      await vi.waitFor(function sentRecover() { expect(sent).toEqual(["/recover"]); });
      await waitForFrame();
      rendered.stdin.write("/disp");
      await vi.waitFor(function suggests() { expect(rendered.lastFrame()).toContain("/dispatch"); });
      rendered.stdin.write("\r");
      await waitForFrame();
      expect(sent).toEqual(["/recover"]);
      rendered.stdin.write("\r");
      await vi.waitFor(function sentDispatch() { expect(sent).toEqual(["/recover", "/dispatch"]); });
    } finally { rendered.unmount(); }
    const normal = renderMentionTui([]);
    try {
      normal.stdin.write("/recov");
      await waitForFrame();
      expect(normal.lastFrame()).not.toContain("Commands");
      expect(normal.lastFrame()).not.toContain("/recover");
    } finally { normal.unmount(); }
  });

  it("矮终端 slash 菜单滚动、回绕和实时 resize 后始终显示当前候选与计数", async function slashViewport() {
    const sent: string[] = [];
    const controller = createManagedCliController(async function request(operation, extra) {
      if (operation === "input") { sent.push(String(extra?.text)); return "已提交"; }
      if (operation === "cli") return { model: "fixture", effort: "low", permissionMode: "ask", source: "runtime_default", workspaceRoot: "fixture" };
      return undefined;
    }, function notice() {});
    const commands = controller.suggestSlashCommands!("/").map(function name(command) { return command.name; });
    const size = Object.assign(new EventEmitter(), { columns: 42, rows: 16 });
    const rendered = renderMentionTui([], { controller, terminalSizeSource: size, screenReader: false });

    /** 校验真实 Ink 帧中的选中行和相对全表的计数。 */
    async function expectSelected(index: number): Promise<void> {
      await vi.waitFor(function selectedIsVisible() {
        expect(rendered.lastFrame()).toContain(`› ${commands[index]}`);
        expect(rendered.lastFrame()).toContain(`${index + 1}/20`);
      });
    }

    try {
      await vi.waitFor(function statusIsReady() { expect(rendered.lastFrame()).toContain("workspace: fixture"); });
      rendered.stdin.write("/");
      await expectSelected(0);
      expect(rendered.lastFrame()).not.toContain("/help");
      expect(rendered.lastFrame()).toContain("workspace: fixture");

      for (let index = 1; index < commands.length; index += 1) {
        rendered.stdin.write("\u001b[B");
        await expectSelected(index);
      }
      rendered.stdin.write("\u001b[B");
      await expectSelected(0);
      rendered.stdin.write("\u001b[A");
      await expectSelected(19);

      size.columns = 29; size.rows = 9; size.emit("resize");
      await vi.waitFor(function shrunk() {
        expect(rendered.lastFrame()).toContain("› /help");
        expect(rendered.lastFrame()).toContain("20/20");
        expect(rendered.lastFrame()).not.toContain("/batch");
        expect(rendered.lastFrame()).toContain("workspace: fixture");
      });
      size.columns = 100; size.rows = 42; size.emit("resize");
      await vi.waitFor(function expanded() {
        expect(rendered.lastFrame()).toContain("/exit");
        expect(rendered.lastFrame()).toContain("核查旧编排执行");
        expect(rendered.lastFrame()).toContain("› /help");
        expect(rendered.lastFrame()).toContain("20/20 commands");
        expect(rendered.lastFrame()).toContain("workspace: fixture");
      });

      rendered.stdin.write("\t");
      await vi.waitFor(function completed() { expect(rendered.lastFrame()).toContain("/help▏"); });
      expect(sent).toEqual([]);
      rendered.stdin.write("\r");
      await vi.waitFor(function sentSelected() { expect(sent).toEqual(["/help"]); });
      rendered.stdin.write("/");
      await expectSelected(0);
      rendered.stdin.write("\u001b");
      await vi.waitFor(function closed() { expect(rendered.lastFrame()).not.toContain("1/20"); });
      expect(sent).toEqual(["/help"]);
    } finally { rendered.unmount(); }
  });

  it("Tab 与 Enter 均插入当前选中候选", async function tabAlsoInserts() {
    const calls: CliAction[] = [];
    const rendered = renderMentionTui(calls);
    rendered.stdin.write("@ma");
    await waitForMentionMenu(rendered);
    rendered.stdin.write("\t");
    await waitForFrame();

    expect(rendered.lastFrame() ?? "").toContain("@apps/cli/src/main.ts");
    rendered.unmount();
  });
});

describe("TuiFileMentionSubmit", function fileMentionSubmitSuite() {
  /** 提交注入用例的真实临时工作区：@sample.txt 存在，@missing.txt 不存在。 */
  const SUBMIT_BODY = "TUI 提交注入测试正文 MENTION_SUBMIT_SENTINEL";
  let workspaceRoot: string;

  beforeAll(async function prepareSubmitWorkspace() {
    workspaceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "mention-submit-")));
    await writeFile(path.join(workspaceRoot, "sample.txt"), `${SUBMIT_BODY}\n`, "utf8");
  });

  afterAll(async function cleanupSubmitWorkspace() {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  /** 等待 dispatch 调用数达到目标（增强与 controller dispatch 都是异步链）。 */
  async function waitForCalls(calls: CliAction[], count: number): Promise<void> {
    for (let attempt = 0; attempt < 20 && calls.length < count; attempt += 1) await waitForFrame();
  }

  /** 提取 controller double 收到的第一条 submit_prompt content。 */
  function submittedContent(calls: CliAction[]): string {
    const submitted = calls.find(function isSubmit(action: CliAction): boolean { return action.type === "submit_prompt"; });
    return submitted && submitted.type === "submit_prompt" ? submitted.content : "";
  }

  it("TUI 提交带 @ 文件的 prompt：dispatch 收到增强 content，时间线只显示原文", async function enrichesSubmittedContent() {
    const calls: CliAction[] = [];
    const rendered = renderMentionTui(calls, { workspaceRoot });
    rendered.stdin.write("看看 @sample.txt");
    await waitForFrame();
    rendered.stdin.write("\r");
    await waitForCalls(calls, 1);
    await waitForFrame();
    const frame = rendered.lastFrame() ?? "";
    rendered.unmount();

    const content = submittedContent(calls);
    expect(content.startsWith("看看 @sample.txt")).toBe(true);
    expect(content).toContain("<system-reminder>");
    expect(content).toContain("--- @sample.txt (1 行) ---");
    expect(content).toContain(SUBMIT_BODY);
    expect(frame).toContain("看看 @sample.txt");
    expect(frame).not.toContain("<system-reminder>");
  });

  it("受管主控提交 @ 文件时只经终端连接传原文", async function sendsOriginalToManagedHost() {
    const controller = createManagedCliController(async function request(operation, extra) {
      expect(operation).toBe("cli");
      if (!extra?.action) return undefined;
      calls.push(extra.action as CliAction);
      return { kind: "ok", exitCode: 0, lines: [] };
    }, function ignoreNotice() {});
    const calls: CliAction[] = [];
    controller.update({ sessionId: "managed-session", status: "idle" });
    const rendered = renderMentionTui(calls, { workspaceRoot, controller });
    rendered.stdin.write("看看 @sample.txt");
    await waitForFrame();
    rendered.stdin.write("\r");
    await waitForCalls(calls, 1);
    rendered.unmount();
    expect(submittedContent(calls)).toBe("看看 @sample.txt");
  });

  it("宿主确认排队输入超限后，不保留等待项或迟到回执", function rejectsOversizedQueuedInput() {
    const store = createCliTuiStore();
    store.rejectPendingPrompt("rejected", "输入超限");
    store.addPendingPrompt("很长的原文", { inputId: "rejected", delivery: "queue" });
    store.rejectPendingPrompt("rejected", "输入超限");
    expect(store.getSnapshot().pendingInputs).toEqual([]);
    expect(store.getSnapshot().transcript.filter(function rejected(item) { return item.kind === "notice" && item.message === "输入超限"; })).toHaveLength(1);
  });

  it("缺失的 @ 路径产生 notice 且 content 保持原文", async function missingMentionShowsNotice() {
    const calls: CliAction[] = [];
    const rendered = renderMentionTui(calls, { workspaceRoot });
    rendered.stdin.write("看看 @missing.txt");
    await waitForFrame();
    rendered.stdin.write("\r");
    await waitForCalls(calls, 1);
    await waitForFrame();
    const frame = rendered.lastFrame() ?? "";
    rendered.unmount();

    expect(submittedContent(calls)).toBe("看看 @missing.txt");
    expect(frame).toContain("@missing.txt 未找到");
  });

  it("/queue 提交同样注入 @ 文件内容", async function queueDeliveryEnriches() {
    const calls: CliAction[] = [];
    const rendered = renderMentionTui(calls, { workspaceRoot });
    rendered.stdin.write("/queue 看看 @sample.txt");
    await waitForFrame();
    rendered.stdin.write("\r");
    await waitForCalls(calls, 1);
    await waitForFrame();
    rendered.unmount();

    const queued = calls.find(function isQueue(action: CliAction): boolean {
      return action.type === "submit_prompt" && action.delivery === "queue";
    });
    expect(queued?.type).toBe("submit_prompt");
    expect(queued && queued.type === "submit_prompt" ? queued.content : "").toContain(SUBMIT_BODY);
  });

  it("initial start 首轮 prompt 同样注入 @ 文件内容", async function initialStartEnriches() {
    const calls: CliAction[] = [];
    const initial: CliTuiInitialOperation = { type: "start", content: "看看 @sample.txt" };
    const rendered = renderMentionTui(calls, { workspaceRoot, initial });
    await waitForCalls(calls, 1);
    await waitForFrame();
    rendered.unmount();

    const content = submittedContent(calls);
    expect(content.startsWith("看看 @sample.txt")).toBe(true);
    expect(content).toContain(SUBMIT_BODY);
  });
});
