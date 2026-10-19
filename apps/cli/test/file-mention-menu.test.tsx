/**
 * @文件提及 TUI 菜单契约测试：@ 触发与空查询候选、输入收窄、≤5 行滚动、Tab/Enter 插入、
 * Esc 仅关闭且 prompt 保留、token 变化复活与 slash 菜单回归（G1-G4、G10 相关）。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CliTuiApp, createCliTuiStore } from "../src/tui.js";
import { resetFileMentionIndexCache } from "../src/tui/hooks/use-file-mention-index.js";
import { createInitialCliProjection } from "../src/event-projector.js";
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
  options: { workspaceRoot?: string; initial?: CliTuiInitialOperation } = {},
): { stdin: { write(value: string): void }; unmount: () => void; lastFrame: () => string | undefined } {
  const result = render(
    <CliTuiApp
      store={createCliTuiStore()}
      controller={createController(calls)}
      closeWhenIdle={false}
      useColor={false}
      screenReader={true}
      workspaceRoot={options.workspaceRoot ?? "/workspace/demo"}
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

afterEach(function resetIndexCache() {
  resetFileMentionIndexCache();
});

describe("TuiFileMentionMenu", function fileMentionMenuSuite() {
  it("输入 @ 弹出候选菜单：空查询返回一层目录与文件，含键位提示行与计数", async function opensMenuOnAt() {
    const calls: CliAction[] = [];
    const rendered = renderMentionTui(calls);
    rendered.stdin.write("看看 @");
    await waitForFrame();

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
    await waitForFrame();

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
    await waitForFrame();
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
    await waitForFrame();
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
    await waitForFrame();
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
    await waitForFrame();
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

  it("Tab 与 Enter 均插入当前选中候选", async function tabAlsoInserts() {
    const calls: CliAction[] = [];
    const rendered = renderMentionTui(calls);
    rendered.stdin.write("@ma");
    await waitForFrame();
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
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "mention-submit-"));
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
