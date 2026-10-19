/**
 * CLI 首次 Trust 确认对话框。
 *
 * 只在信任建立前渲染 canonical 工作区与 Yes/No 选择；不读取任何工作区配置、
 * 不初始化 Provider，也不创建 Runtime/Project/Session。授权只通过用户显式确认。
 */

import { useRef, useState, type ReactNode } from "react";
import { Box, Text, render, useInput, type Key } from "ink";
import { TUI_ACCENT_COLOR } from "../design-tokens.js";
import { parseTuiControlAction } from "./input/keys.js";
import { createRoutedTuiStdin, createTuiTerminalLifecycle } from "./lifecycle.js";
import { resolveNoColor, resolveScreenReader } from "./render-mode.js";

/** Trust 对话框固定选项；Yes 是唯一授权动作。 */
export const TRUST_DIALOG_OPTIONS = [
  { value: "grant", label: "是，我信任此工作区" },
  { value: "decline", label: "否，退出" },
] as const;

/** 将按键归一为 Trust 对话框的焦点移动或确认/取消动作。 */
export function resolveTrustDialogNavigation(
  input: string,
  key: Key,
  current: number,
): { next: number; action?: "confirm" | "cancel" } {
  const control = parseTuiControlAction(input, key);
  if (control === "interrupt" || control === "cancel") return { next: current, action: "cancel" };
  if (key.upArrow) return { next: Math.max(0, current - 1) };
  if (key.downArrow) return { next: Math.min(TRUST_DIALOG_OPTIONS.length - 1, current + 1) };
  if (key.return) return { next: current, action: "confirm" };
  return { next: current };
}

/** 渲染首次 Trust 确认卡；直角单线、warning 语义，路径只在交互 TTY 显示。 */
export function TuiTrustDialog(props: { workspaceRoot: string; selectedIndex: number; useColor: boolean; screenReader: boolean }): ReactNode {
  const selectedIndex = Math.max(0, Math.min(props.selectedIndex, TRUST_DIALOG_OPTIONS.length - 1));
  return (
    <Box borderStyle="single" borderColor={props.useColor ? TUI_ACCENT_COLOR : undefined} paddingX={1} flexDirection="column">
      <Text bold color={props.useColor ? TUI_ACCENT_COLOR : undefined}>访问工作区</Text>
      <Text>{props.workspaceRoot}</Text>
      <Text>仅当这是你创建或信任的项目时继续。</Text>
      <Text>Agent 将能够在此工作区内读取、编辑和执行文件。</Text>
      {TRUST_DIALOG_OPTIONS.map(function renderTrustOption(option, index): ReactNode {
        const selected = index === selectedIndex;
        return <Text key={option.value} inverse={selected && props.useColor}>{selected ? "›" : " "} {option.label}{selected && props.screenReader ? "（已选择）" : ""}</Text>;
      })}
      <Text dimColor={props.useColor}>↑/↓ 选择 · Enter 确认 · Esc/Ctrl+C 退出</Text>
    </Box>
  );
}

/** Trust 对话框的信号来源；与 main.ts 的 CliSignalSource 结构兼容。 */
export interface CliTrustDialogSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}

/** 首次 Trust 对话框的运行选项。 */
export interface CliTrustDialogOptions {
  workspaceRoot: string;
  streams: { stdout: { write(chunk: string): void; isTTY?: boolean; columns?: number }; stdin: NodeJS.ReadStream };
  env?: NodeJS.ProcessEnv;
  signalSource?: CliTrustDialogSignalSource;
}

/** 首次 Trust 决策；granted 表示用户显式授权。 */
export type CliTrustDecision = "granted" | "declined";

/** 在交互 TTY 渲染首次 Trust 对话框并等待用户决定。 */
export function runCliTrustDialog(options: CliTrustDialogOptions): Promise<CliTrustDecision> {
  return new Promise(function runTrustDialog(resolve) {
    const env = options.env ?? process.env;
    const noColor = resolveNoColor(env);
    const screenReader = resolveScreenReader(env);
    const routedStdin = createRoutedTuiStdin(options.streams.stdin);
    const terminalLifecycle = createTuiTerminalLifecycle(options.streams.stdout, "inline");
    let decision: CliTrustDecision = "declined";
    let settled = false;
    let instance: ReturnType<typeof render> | undefined;

    /** 把真实 TTY 的按键数据原样转发给 Ink 专用输入流；Trust 对话框不参与鼠标路由。 */
    function forwardTrustInput(chunk: Buffer | string): void {
      routedStdin.write(chunk);
    }
    /** stdin 到达 EOF 时结束 Ink 输入流。 */
    function finishTrustInput(): void {
      routedStdin.end();
    }
    /** 移除真实 stdin 转发监听并结束 Ink 输入流，所有退出路径只清理一次。 */
    function detachTrustInput(): void {
      options.streams.stdin.removeListener("data", forwardTrustInput);
      options.streams.stdin.removeListener("end", finishTrustInput);
      routedStdin.end();
    }
    options.streams.stdin.on("data", forwardTrustInput);
    options.streams.stdin.once("end", finishTrustInput);

    /** 记录最终决定并请求 Ink 卸载；终端恢复在 waitUntilExit 后统一执行。 */
    function settle(next: CliTrustDecision): void {
      if (settled) return;
      settled = true;
      decision = next;
      // Inline 模式下 unmount 会保留最后一帧；先清理，避免 Trust 卡片残留在后续 TUI 上方。
      instance?.clear();
      instance?.unmount();
    }

    function handleSigint(): void { settle("declined"); }
    function handleSigterm(): void { settle("declined"); }
    options.signalSource?.on("SIGINT", handleSigint);
    options.signalSource?.on("SIGTERM", handleSigterm);

    /** 对话框主体：焦点与决策只在本组件内完成，不接触 Runtime。 */
    function TrustDialogApp(): ReactNode {
      const [selectedIndex, setSelectedIndex] = useState(0);
      const selectedIndexRef = useRef(0);
      function updateSelectedIndex(next: number): void {
        selectedIndexRef.current = next;
        setSelectedIndex(next);
      }
      useInput(function handleTrustInput(input: string, key: Key): void {
        const navigation = resolveTrustDialogNavigation(input, key, selectedIndexRef.current);
        if (navigation.action === "confirm") settle(selectedIndexRef.current === 0 ? "granted" : "declined");
        else if (navigation.action === "cancel") settle("declined");
        else if (navigation.next !== selectedIndexRef.current) updateSelectedIndex(navigation.next);
      });
      return <TuiTrustDialog workspaceRoot={options.workspaceRoot} selectedIndex={selectedIndex} useColor={!noColor && !screenReader} screenReader={screenReader} />;
    }

    try {
      terminalLifecycle.enter();
      instance = render(<TrustDialogApp />, {
        stdout: options.streams.stdout as unknown as NodeJS.WriteStream,
        stdin: routedStdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: true,
        incrementalRendering: false,
        isScreenReaderEnabled: screenReader,
      });
    } catch {
      terminalLifecycle.restore();
      detachTrustInput();
      options.signalSource?.removeListener("SIGINT", handleSigint);
      options.signalSource?.removeListener("SIGTERM", handleSigterm);
      resolve("declined");
      return;
    }

    void instance.waitUntilExit().then(function finishTrustDialog(): void {
      terminalLifecycle.restore();
      detachTrustInput();
      options.signalSource?.removeListener("SIGINT", handleSigint);
      options.signalSource?.removeListener("SIGTERM", handleSigterm);
      resolve(decision);
    });
  });
}
