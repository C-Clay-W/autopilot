/** 审批菜单：根据待审批工具收窄选项，并以 CC 风格上下选择、回车确认。 */

import { type ReactNode } from "react";
import { Box, Text } from "ink";
import type { CliAction, CliProjection } from "../types.js";
import { TUI_ACCENT_COLOR } from "../design-tokens.js";
import { getTuiToolLabel } from "./format.js";

/** TTY 审批菜单只保存公开决定与可见标签，不携带冻结工具输入。 */
export interface CliTuiApprovalOption {
  decision: Extract<CliAction, { type: "approve" }>["decision"];
  label: string;
}

/** 根据待审批工具收窄菜单；旧记录缺少冻结范围时保持最保守的单次/拒绝。 */
export function createTuiApprovalOptions(pendingApproval: NonNullable<CliProjection["pendingApproval"]>): CliTuiApprovalOption[] {
  if (pendingApproval.allowedDecisions) {
    // run_command 的工作区级授权展示为"记住此命令"（精确命令约束，与 Web 审批卡同一文案）；
    // todo_write 的单次批准即任务文件集合批准，与 Web 审批卡同一文案。
    const labels: Record<CliTuiApprovalOption["decision"], string> = {
      allow_once: pendingApproval.toolName === "todo_write"
        ? pendingApproval.constraint === "task-ext-files:v1" ? "批准本任务外部文件修改" : "批准本任务文件修改"
        : "允许本次",
      allow_session: "本次会话允许",
      allow_workspace: pendingApproval.toolName === "run_command" ? "记住此命令" : "此工作区允许",
      deny: "拒绝",
    };
    return pendingApproval.allowedDecisions.map(function createFrozenOption(decision) { return { decision, label: labels[decision] }; });
  }
  if (pendingApproval.toolName === "run_command") {
    return [
      { decision: "allow_once", label: "允许本次" },
      { decision: "deny", label: "拒绝" },
    ];
  }
  return [
    { decision: "allow_once", label: "允许本次" },
    { decision: "allow_session", label: "本次会话允许" },
    { decision: "allow_workspace", label: "此工作区允许" },
    { decision: "deny", label: "拒绝" },
  ];
}

/** 以 CC 风格上下选择、回车确认渲染当前审批菜单。 */
export function TuiApprovalPrompt(props: { pendingApproval: NonNullable<CliProjection["pendingApproval"]>; selectedIndex: number; useColor: boolean; screenReader: boolean }): ReactNode {
  const options = createTuiApprovalOptions(props.pendingApproval);
  const selectedIndex = Math.max(0, Math.min(props.selectedIndex, options.length - 1));
  return (
    <Box borderStyle="single" borderColor={props.useColor ? TUI_ACCENT_COLOR : undefined} paddingX={1} flexDirection="column">
      <Text bold color={props.useColor ? TUI_ACCENT_COLOR : undefined}>需要你的确认</Text>
      <Text>操作：{props.pendingApproval.display?.operation ?? getTuiToolLabel(props.pendingApproval.toolName)}</Text>
      <Text>原因：{props.pendingApproval.reason}</Text>
      {props.pendingApproval.display?.resource ? <Text>影响：{props.pendingApproval.display.resource}</Text> : null}
      {props.pendingApproval.display?.cwd ? <Text>工作目录：{props.pendingApproval.display.cwd}</Text> : null}
      {props.pendingApproval.display?.effect === "external" && props.pendingApproval.display?.unknownScope ? (
        <Text color={props.useColor ? TUI_ACCENT_COLOR : undefined}>⚠ 修改范围无法精确限定：该命令未声明精确外部目标，请审查完整命令后再决定</Text>
      ) : null}
      {props.pendingApproval.display?.effect === "external" && !props.pendingApproval.display?.unknownScope ? (
        <Text color={props.useColor ? TUI_ACCENT_COLOR : undefined}>⚠ 外部路径：目标位于工作区之外，授权仅覆盖上述精确目标</Text>
      ) : null}
      {props.pendingApproval.toolName === "run_command" && options.some(function hasWorkspaceOption(option) { return option.decision === "allow_workspace"; }) ? (
        <Text dimColor={props.useColor}>选择“记住此命令”会记住本条命令（程序、参数与工作目录完全一致），此后在本工作区自动放行；参数或目录不同的命令仍会重新询问</Text>
      ) : null}
      {props.pendingApproval.constraint === "task-ext-files:v1" ? (
        <Text color={props.useColor ? TUI_ACCENT_COLOR : undefined}>⚠ 外部路径：目标位于工作区之外，与工作区文件集合分开单独批准；授权仅覆盖清单内精确文件，不含父目录或递归权限</Text>
      ) : null}
      {props.pendingApproval.toolName === "todo_write" && props.pendingApproval.constraint !== "task-ext-files:v1" && options.some(function hasOnceOption(option) { return option.decision === "allow_once"; }) ? (
        <Text dimColor={props.useColor}>批准后，本任务内对清单内文件的对应修改将自动放行；清单外的新文件仍会逐次询问；授权仅覆盖当前任务</Text>
      ) : null}
      {props.pendingApproval.constraint === "task-ext-files:v1" && options.some(function hasOnceOption(option) { return option.decision === "allow_once"; }) ? (
        <Text dimColor={props.useColor}>批准后，本任务内对清单内精确文件的对应修改将自动放行；清单外目标仍逐次询问；授权仅覆盖当前任务，新目录或新文件不会因此获得授权</Text>
      ) : null}
      {props.pendingApproval.constraint === "no-sandbox-exec:v1" ? (
        <Text color={props.useColor ? "yellow" : undefined}>沙箱启动失败：本次将无沙箱隔离直接执行上述命令；批准仅对本次调用有效，拒绝则任务停止</Text>
      ) : null}
      {props.pendingApproval.display?.effect === "external" && props.pendingApproval.toolName !== "run_command" && options.some(function hasWorkspaceOption(option) { return option.decision === "allow_workspace"; }) ? (
        <Text dimColor={props.useColor}>选择“此工作区允许”将把该规则写入工作区 .autopilot/settings.local.json</Text>
      ) : null}
      {options.map(function renderApprovalOption(option, index): ReactNode {
        const selected = index === selectedIndex;
        return <Text key={option.decision} inverse={selected && props.useColor}>{selected ? "›" : " "} {option.label}{selected && props.screenReader ? "（已选择）" : ""}</Text>;
      })}
      <Text dimColor={props.useColor}>↑/↓ 选择 · Enter 确认</Text>
    </Box>
  );
}
