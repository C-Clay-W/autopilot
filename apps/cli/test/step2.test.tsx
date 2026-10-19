/** Talk-Plan0805 Step2 测试：状态栏、权限 Session 默认值与三态 TUI picker。 */

import { createElement } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { createCliController } from "../src/controller.js";
import { createInitialCliProjection } from "../src/event-projector.js";
import { parseSlashAction } from "../src/parser.js";
import { CliTuiApp, createCliTuiStore } from "../src/tui.js";
import type { AgentEvent } from "@autopilot-agent/core";
import type { CliController, CliControllerResult } from "../src/controller.js";
import type { CliAction, CliPermissionMode, CliPermissionOption, CliProjection, CliPublicEvent, CliRuntime, CliStatusView } from "../src/types.js";
import { createPlainRenderer } from "../src/renderer.js";

/** 将固定事件转换为异步事件流，避免测试依赖 Kernel private 类型。 */
async function* eventStream(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const event of events) yield event;
}

/** 创建可记录 Session 默认配置更新的 Runtime double。 */
function createPermissionRuntime(initialMode: CliPermissionMode, frozenMode?: CliPermissionMode): { runtime: CliRuntime; session: { id: string; defaultRunConfig?: Record<string, unknown> }; saved: unknown[] } {
  const session = {
    id: "session-step2",
    projectId: "project-step2",
    persistenceMode: "durable" as const,
    status: "idle" as const,
    defaultRunConfig: {
      modelRef: { provider: "deepseek", modelId: "deepseek-v4-flash" },
      reasoningProfile: { effort: "high" as const },
      permissionMode: initialMode,
    },
    createdAt: 1,
    updatedAt: 1,
  };
  const saved: unknown[] = [];
  const runtime = {
    sessions: {
      get: async function getSession() { return session; },
      setDefaultRunConfig: async function setDefaultRunConfig(_id: string, config: Record<string, unknown>) {
        saved.push(config);
        session.defaultRunConfig = config as typeof session.defaultRunConfig;
        return session;
      },
    },
    turns: {
      getFrozenRunConfig: async function getFrozenRunConfig() {
        if (!frozenMode) return null;
        return {
          sessionId: session.id,
          turnId: "turn-step2",
          modelRef: { provider: "deepseek", modelId: "deepseek-v4-flash" },
          reasoningProfile: { effort: "high" as const },
          permissionMode: frozenMode,
        };
      },
    },
  } as unknown as CliRuntime;
  return { runtime, session, saved };
}

/** 创建 TUI picker 用的最小 Controller double。 */
function createPermissionTuiController(calls: CliAction[]): CliController {
  const projection = createInitialCliProjection();
  let mode: CliPermissionMode = "ask";
  let modelId = "deepseek-v4-flash";
  let effort = "high";
  let listener: ((event: CliPublicEvent, nextProjection: CliProjection) => void) | undefined;

  /** 生成权限 picker 的三态安全选项。 */
  function options(): CliPermissionOption[] {
    return [
      { mode: "ask", label: "询问", description: "逐次询问。", selected: mode === "ask" },
      { mode: "auto_approve", label: "为我审批", description: "非破坏性操作自动通过。", selected: mode === "auto_approve" },
      { mode: "full_access", label: "完全访问", description: "仍遵守安全边界。", selected: mode === "full_access" },
    ];
  }

  /** 返回状态栏所需的脱敏配置。 */
  function statusView(): CliStatusView {
    return {
      model: `deepseek/${modelId}`,
      effort,
      permissionMode: mode,
      workspaceRoot: "C:/workspace/demo",
      source: "session_default",
    };
  }

  /** 返回不写 Runtime 的 TUI 测试结果。 */
  function result(lines: string[] = [], extras: Partial<CliControllerResult> = {}): CliControllerResult {
    return { kind: "ok", exitCode: 0, lines, projection, ...extras };
  }

  return {
    async dispatch(action: CliAction): Promise<CliControllerResult> {
      calls.push(action);
      if (action.type === "open_permissions") return result([], { permissionOptions: options(), statusView: statusView() });
      if (action.type === "set_permission_mode") {
        mode = action.mode;
        return result([`permission: ${mode}`], { statusView: statusView() });
      }
      if (action.type === "open_model_picker") {
        return result([], {
          modelOptions: [
            { provider: "deepseek", modelId: "deepseek-v4-flash", selected: modelId === "deepseek-v4-flash" },
            { provider: "deepseek", modelId: "deepseek-v4-pro", selected: modelId === "deepseek-v4-pro" },
          ],
          statusView: statusView(),
        });
      }
      if (action.type === "set_model") {
        modelId = action.modelId;
        return result([`model: ${modelId}`], { statusView: statusView() });
      }
      if (action.type === "open_effort_picker") {
        const values = modelId === "deepseek-v4-pro" ? ["none", "high", "max"] : ["none", "low", "high", "max"];
        return result([], { effortOptions: values.map(function toOption(value) { return { effort: value, selected: value === effort }; }), statusView: statusView() });
      }
      if (action.type === "set_effort") {
        effort = action.effort;
        return result([`effort: ${effort}`], { statusView: statusView() });
      }
      return result();
    },
    async consume(): Promise<CliControllerResult> { return result(); },
    async resume(): Promise<CliControllerResult> { return result(); },
    getProjection(): CliProjection { return projection; },
    getStatusView: async function getStatusView() { return statusView(); },
    setSession(): void {},
    setEventListener(nextListener): void { listener = nextListener; },
  };
}

/** 创建 ask 命令审批菜单使用的 Controller double。 */
function createApprovalTuiController(calls: CliAction[], projection: CliProjection): CliController {
  /** 返回当前审批投影，不接触真实 Runtime。 */
  function result(): CliControllerResult {
    return { kind: "ok", exitCode: 0, lines: [], projection };
  }

  return {
    async dispatch(action: CliAction): Promise<CliControllerResult> {
      calls.push(action);
      if (action.type === "approve") {
        projection.pendingApproval = undefined;
        projection.status = "running";
      }
      return result();
    },
    async consume(): Promise<CliControllerResult> { return result(); },
    async resume(): Promise<CliControllerResult> { return result(); },
    getProjection(): CliProjection { return projection; },
    getStatusView: async function getStatusView() {
      return { model: "deepseek/deepseek-v4-flash", effort: "high", permissionMode: "ask", workspaceRoot: "C:/workspace/demo", source: "turn_frozen" };
    },
    setSession(): void {},
    setEventListener(): void {},
  };
}

describe("Talk-Plan0805 Step2", function step2Suite() {
  it("权限命令只更新 Session 默认配置并保留 model/effort", async function updatesSessionDefaultOnly() {
    const { runtime, session, saved } = createPermissionRuntime("ask");
    const controller = createCliController({
      runtime,
      renderer: createPlainRenderer("text"),
      sessionId: session.id,
      workspaceRoot: "C:/workspace/demo",
    });

    await expect(controller.dispatch({ type: "set_permission_mode", mode: "auto_approve" })).resolves.toMatchObject({
      kind: "ok",
      lines: ["permission: 为我审批 (auto_approve)；下一个 Turn 生效"],
      statusView: { permissionMode: "auto_approve", source: "session_default" },
    });
    expect(saved).toEqual([{
      modelRef: { provider: "deepseek", modelId: "deepseek-v4-flash" },
      reasoningProfile: { effort: "high" },
      permissionMode: "auto_approve",
    }]);
  });

  it("活动 Turn 的 frozen permission 不被新 Session 默认覆盖", async function keepsFrozenPermission() {
    const { runtime, session } = createPermissionRuntime("ask", "ask");
    const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: session.id, workspaceRoot: "C:/workspace/demo" });
    await controller.consume(eventStream([{ type: "turn_started", turnId: "turn-step2", stepCount: 0 } as AgentEvent]));

    const result = await controller.dispatch({ type: "set_permission_mode", mode: "full_access" });
    expect(result.statusView).toMatchObject({ permissionMode: "ask", source: "turn_frozen", nextPermissionMode: "full_access" });
    expect(session.defaultRunConfig?.permissionMode).toBe("full_access");
  });

  it("idle 状态栏读取 Composition Root 的热更新安全默认值", async function projectsRuntimeStatusDefaults() {
    const runtime = {
      sessions: {
        get: async function getSession() {
          return {
            id: "session-runtime-default",
            projectId: "project-step2",
            persistenceMode: "durable" as const,
            status: "idle" as const,
            createdAt: 1,
            updatedAt: 1,
          };
        },
      },
    } as unknown as CliRuntime;
    const controller = createCliController({
      runtime,
      renderer: createPlainRenderer("text"),
      sessionId: "session-runtime-default",
      workspaceRoot: "C:/workspace/demo",
      getRuntimeStatusDefaults: function getRuntimeStatusDefaults() {
        return {
          modelRef: { provider: "deepseek", modelId: "deepseek-v4-pro" },
          reasoningProfile: { effort: "max" },
          permissionMode: "ask",
        };
      },
    });

    await expect(controller.getStatusView?.()).resolves.toMatchObject({
      model: "deepseek/deepseek-v4-pro",
      effort: "max",
      permissionMode: "ask",
      source: "runtime_default",
    });
  });

  it("/permissions picker 展示状态栏并通过方向键保存三态模式", async function rendersPermissionPicker() {
    const calls: CliAction[] = [];
    const controller = createPermissionTuiController(calls);
    const store = createCliTuiStore();
    const result = render(createElement(CliTuiApp, {
      store,
      controller,
      closeWhenIdle: false,
      useColor: false,
      screenReader: true,
      reducedMotion: true,
      onResult: function onResult(controllerResult: CliControllerResult): void { store.syncProjection(controllerResult.projection); },
      onRequestInterrupt: function onRequestInterrupt(): void {},
      onRequestCancel: function onRequestCancel(): void {},
      onEof: function onEof(): void {},
      onAppExit: function onAppExit(_code: number): void {},
    }));
    await new Promise<void>(function waitForStatus(resolve) { setTimeout(resolve, 20); });
    expect(result.lastFrame() ?? "").toContain("model: deepseek/deepseek-v4-flash");
    expect(result.lastFrame() ?? "").toContain("permission: 询问 (ask)");

    result.stdin.write("/permissions");
    result.stdin.write("\r");
    async function waitForPickerFrame(fragment: string): Promise<void> {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((result.lastFrame() ?? "").includes(fragment)) return;
        await new Promise<void>(function waitForRender(resolve) { setTimeout(resolve, 25); });
      }
      throw new Error(`permission picker did not render: ${fragment}`);
    }
    await waitForPickerFrame("Permissions");
    result.stdin.write("\u001b[B");
    await waitForPickerFrame("› [off] 为我审批");
    result.stdin.write("\u001b[B");
    await waitForPickerFrame("› [off] 完全访问");
    result.stdin.write(" ");
    await waitForPickerFrame("› [on] 完全访问");
    result.stdin.write("\r");
    await new Promise<void>(function waitForSave(resolve) { setTimeout(resolve, 30); });
    expect(calls).toEqual([{ type: "open_permissions" }, { type: "set_permission_mode", mode: "full_access" }]);
    expect(result.lastFrame() ?? "").toContain("permission: 完全访问 (full_access)");
    result.unmount();
  });

  it("ask 命令审批使用上下键选择并以回车确认", async function selectsCommandApprovalWithArrows() {
    const calls: CliAction[] = [];
    const projection = createInitialCliProjection();
    projection.turnId = "turn-command-approval";
    projection.status = "waiting_approval";
    projection.pendingApproval = { approvalId: "approval-command", toolName: "run_command", reason: "执行命令需要审批", risk: "command" };
    const controller = createApprovalTuiController(calls, projection);
    const store = createCliTuiStore();
    store.acceptEvent({ type: "turn_started", seq: 1, turnId: projection.turnId, stepCount: 1 }, projection);
    store.acceptEvent({ type: "approval_required", seq: 2, turnId: projection.turnId, approvalId: "approval-command", toolName: "run_command", reason: "执行命令需要审批", risk: "command" }, projection);
    const rendered = render(createElement(CliTuiApp, {
      store,
      controller,
      closeWhenIdle: false,
      useColor: false,
      screenReader: true,
      reducedMotion: true,
      onResult: function onResult(controllerResult: CliControllerResult): void { store.syncProjection(controllerResult.projection); },
      onRequestInterrupt: function onRequestInterrupt(): void {},
      onRequestCancel: function onRequestCancel(): void {},
      onEof: function onEof(): void {},
      onAppExit: function onAppExit(_code: number): void {},
    }));
    await new Promise<void>(function waitForApprovalFrame(resolve) { setTimeout(resolve, 20); });
    expect(rendered.lastFrame() ?? "").toContain("› 允许本次（已选择）");
    expect(rendered.lastFrame() ?? "").not.toContain("本次会话允许");
    expect(rendered.lastFrame() ?? "").not.toContain("此工作区允许");

    rendered.stdin.write("\u001b[B");
    await new Promise<void>(function waitForRejectSelection(resolve) { setTimeout(resolve, 20); });
    expect(rendered.lastFrame() ?? "").toContain("› 拒绝（已选择）");
    rendered.stdin.write("\r");
    await new Promise<void>(function waitForApprovalSubmit(resolve) { setTimeout(resolve, 30); });
    expect(calls).toEqual([{ type: "approve", decision: "deny" }]);
    rendered.unmount();
  });

  it("输入普通斜线显示命令目录，状态栏位于输入框之后", async function rendersSlashCommandMenu() {
    const calls: CliAction[] = [];
    const controller = createPermissionTuiController(calls);
    const store = createCliTuiStore();
    const result = render(createElement(CliTuiApp, {
      store,
      controller,
      closeWhenIdle: false,
      useColor: false,
      screenReader: true,
      reducedMotion: true,
      onResult: function onResult(controllerResult: CliControllerResult): void { store.syncProjection(controllerResult.projection); },
      onRequestInterrupt: function onRequestInterrupt(): void {},
      onRequestCancel: function onRequestCancel(): void {},
      onEof: function onEof(): void {},
      onAppExit: function onAppExit(_code: number): void {},
    }));
    await new Promise<void>(function waitForInitialFrame(resolve) { setTimeout(resolve, 20); });
    result.stdin.write("/");
    await new Promise<void>(function waitForCommands(resolve) { setTimeout(resolve, 20); });
    const frame = result.lastFrame() ?? "";
    expect(frame).toContain("Commands");
    expect(frame).toContain("/exit");
    expect(frame).toContain("/permissions");
    expect(frame.indexOf("prompt")).toBeLessThan(frame.indexOf("Ready"));
    result.stdin.write("\u001b");
    await new Promise<void>(function waitForCommandMenuClose(resolve) { setTimeout(resolve, 20); });
    expect(result.lastFrame() ?? "").not.toContain("Commands");

    result.stdin.write("abc");
    result.stdin.write("\u001b[A");
    result.stdin.write("\u001b[B");
    await new Promise<void>(function waitForCursorFrame(resolve) { setTimeout(resolve, 20); });
    expect((result.lastFrame() ?? "").match(/abc/g)?.length).toBe(1);
    result.unmount();
  });

  it("/effort 为主命令，/reasoning 保持同一真实切换 action 的兼容别名", function keepsReasoningAlias() {
    expect(parseSlashAction("/effort")).toEqual({ kind: "action", action: { type: "open_effort_picker" } });
    expect(parseSlashAction("/effort low")).toEqual({ kind: "action", action: { type: "set_effort", effort: "low" } });
    expect(parseSlashAction("/reasoning high")).toEqual({ kind: "action", action: { type: "set_effort", effort: "high" } });
  });

  it("模型与 effort picker 仅派发下一 Turn 的选择，Pro 不展示 Low", async function rendersRunConfigPickers() {
    const calls: CliAction[] = [];
    const controller = createPermissionTuiController(calls);
    const store = createCliTuiStore();
    const result = render(createElement(CliTuiApp, {
      store,
      controller,
      closeWhenIdle: false,
      useColor: false,
      screenReader: true,
      reducedMotion: true,
      onResult: function onResult(controllerResult: CliControllerResult): void { store.syncProjection(controllerResult.projection); },
      onRequestInterrupt: function onRequestInterrupt(): void {},
      onRequestCancel: function onRequestCancel(): void {},
      onEof: function onEof(): void {},
      onAppExit: function onAppExit(_code: number): void {},
    }));
    result.stdin.write("/model");
    result.stdin.write("\r");
    await new Promise<void>(function waitForPicker(resolve) { setTimeout(resolve, 20); });
    expect(result.lastFrame() ?? "").toContain("Models");
    expect(result.lastFrame() ?? "").toContain("deepseek/deepseek-v4-pro");
    result.stdin.write("\u001b[B");
    result.stdin.write(" ");
    await new Promise<void>(function waitForModelSelection(resolve) { setTimeout(resolve, 20); });
    expect(result.lastFrame() ?? "").toContain("› [on] deepseek/deepseek-v4-pro");
    result.stdin.write("\r");
    await new Promise<void>(function waitForModelSave(resolve) { setTimeout(resolve, 30); });
    result.stdin.write("/effort");
    result.stdin.write("\r");
    await new Promise<void>(function waitForEffortPicker(resolve) { setTimeout(resolve, 30); });
    const frame = result.lastFrame() ?? "";
    expect(frame).toContain("Thinking effort");
    expect(frame).toContain("max");
    expect(frame).not.toContain("[off] low");
    result.stdin.write("\u001b[B");
    result.stdin.write(" ");
    await new Promise<void>(function waitForEffortSelection(resolve) { setTimeout(resolve, 20); });
    expect(result.lastFrame() ?? "").toContain("› [on] max");
    result.stdin.write("\r");
    await new Promise<void>(function waitForEffortSave(resolve) { setTimeout(resolve, 30); });
    expect(calls).toEqual([
      { type: "open_model_picker" },
      { type: "set_model", provider: "deepseek", modelId: "deepseek-v4-pro" },
      { type: "open_effort_picker" },
      { type: "set_effort", effort: "max" },
    ]);
    result.unmount();
  });

});
