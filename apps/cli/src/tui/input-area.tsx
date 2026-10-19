/** TUI 输入子树：隔离 prompt、光标与 picker 状态，避免普通按键重建完整时间线。 */

import { memo, useEffect, useLayoutEffect, type ReactNode } from "react";
import { useInput, type Key } from "ink";
import type { CliAction, CliEffortOption, CliModelOption, CliPermissionOption, CliSkillSummary, CliSlashCommand } from "../types.js";
import { getSlashCommandSuggestions } from "../parser.js";
import { usePickers } from "./hooks/use-pickers.js";
import { usePromptInput } from "./hooks/use-prompt-input.js";
import type { FileMentionIndex } from "./hooks/use-file-mention-index.js";
import { extractFileMentionToken, filterFileMentionCandidates } from "./input/file-mention.js";
import { createTuiPromptLayout } from "./input/prompt-layout.js";
import { recordTuiPerformanceDiagnostic } from "./performance-diagnostics.js";
import { TuiEffortPicker } from "./pickers/effort.js";
import { TuiFileMentionMenu, TUI_FILE_MENTION_VISIBLE_ROWS } from "./pickers/file-mention.js";
import { TuiModelPicker } from "./pickers/model.js";
import { TuiPermissionPicker } from "./pickers/permission.js";
import { TuiSkillPicker } from "./pickers/skill.js";
import { TuiSlashCommandMenu } from "./pickers/slash.js";
import { TuiPromptInput } from "./prompt-input.js";
import type { CliTuiStore } from "./types.js";

/** 输入区与父级之间共享的稳定 ref；普通按键不需要把输入正文写回父级。 */
export interface TuiInputDerivedState {
  slashCommandSuggestions: CliSlashCommand[];
  fileMentionSuggestions: string[];
  handleTuiViewportKey: (key: Key) => boolean;
}

/** React ref 形状；输入子树与父级共享同一份派生值容器。 */
export type TuiInputDerivedRef = { current: TuiInputDerivedState };

/** 输入区布局高度；只有跨视觉行或 picker 状态变化时才需要通知父级。 */
export interface TuiInputLayout {
  promptHeight: number;
  pickerHeight: number;
}

type TuiDispatchAction = (action: CliAction, prompt?: string, preserveSkillPickerQuery?: boolean) => Promise<void>;

/** 根据当前 picker 估算固定区高度，供备用屏计算可用视口高度。 */
function getTuiPickerHeight(input: {
  permissions?: CliPermissionOption[];
  models?: CliModelOption[];
  efforts?: CliEffortOption[];
  skills?: CliSkillSummary[];
  slashCommands: CliSlashCommand[];
  fileMentionCandidates: string[];
}): number {
  if (input.permissions) return input.permissions.length + 6;
  if (input.models) return input.models.length + 5;
  if (input.efforts) return input.efforts.length + 5;
  if (input.skills) return Math.min(8, input.skills.length) + 8;
  if (input.slashCommands.length > 0) return input.slashCommands.length + 5;
  if (input.fileMentionCandidates.length > 0) return Math.min(TUI_FILE_MENTION_VISIBLE_ROWS, input.fileMentionCandidates.length) + 5;
  return 0;
}

/** 将 prompt 状态、输入分发和 picker 展示隔离到独立子树。 */
export const TuiInputArea = memo(function TuiInputArea(props: {
  store: CliTuiStore;
  columns: number;
  busy: { current: boolean };
  keepOpenAfterCancel: { current: boolean };
  lastSubmittedPromptRef: { current: string | undefined };
  rawInputSequenceRef: { current: string };
  dispatchAction: TuiDispatchAction;
  onEof: () => void;
  onRequestInterrupt: () => void;
  onRequestCancel: () => void;
  isRawModeSupported: boolean;
  isInputActive: boolean;
  showInput: boolean;
  useColor: boolean;
  screenReader: boolean;
  pickers: ReturnType<typeof usePickers>;
  derivedRef: TuiInputDerivedRef;
  fileMentionIndex?: FileMentionIndex;
  onLayoutChange?(layout: TuiInputLayout): void;
}): ReactNode {
  const pickers = props.pickers;
  const { input, cursorIndex, handleInput } = usePromptInput({
    store: props.store,
    columns: props.columns,
    busy: props.busy,
    keepOpenAfterCancel: props.keepOpenAfterCancel,
    lastSubmittedPromptRef: props.lastSubmittedPromptRef,
    rawInputSequenceRef: props.rawInputSequenceRef,
    dispatchAction: props.dispatchAction,
    onEof: props.onEof,
    onRequestInterrupt: props.onRequestInterrupt,
    onRequestCancel: props.onRequestCancel,
    isPickerActive: pickers.isPickerActive,
    dispatchPickerInput: pickers.dispatchPickerInput,
    approvalPickerIndexRef: pickers.approvalPickerIndexRef,
    updateApprovalPickerIndex: pickers.updateApprovalPickerIndex,
    slashCommandIndexRef: pickers.slashCommandIndexRef,
    updateSlashCommandIndex: pickers.updateSlashCommandIndex,
    fileMentionIndexRef: pickers.fileMentionIndexRef,
    updateFileMentionIndex: pickers.updateFileMentionIndex,
    setFileMentionDismissedInput: pickers.setFileMentionDismissedInput,
    derivedRef: props.derivedRef,
  });

  const slashCommandSuggestions = getSlashCommandSuggestions(input);
  props.derivedRef.current.slashCommandSuggestions = slashCommandSuggestions;
  // @ 菜单派生：索引就绪且未被 Esc 关闭时，按当前 token 的四档评分过滤候选池。
  const fileMentionToken = props.fileMentionIndex?.ready ? extractFileMentionToken(input, cursorIndex) : null;
  const fileMentionSuggestions = fileMentionToken && pickers.fileMentionDismissedInput !== input
    ? filterFileMentionCandidates(props.fileMentionIndex?.entries ?? [], fileMentionToken.query)
    : [];
  props.derivedRef.current.fileMentionSuggestions = fileMentionSuggestions;
  const promptHeight = props.showInput ? createTuiPromptLayout(input, cursorIndex, Math.max(1, props.columns - 4)).lines.length + 3 : 0;
  const pickerHeight = props.showInput
    ? getTuiPickerHeight({ permissions: pickers.permissionPickerOptions, models: pickers.modelPickerOptions, efforts: pickers.effortPickerOptions, skills: pickers.skillPickerSkills, slashCommands: slashCommandSuggestions, fileMentionCandidates: fileMentionSuggestions })
    : 0;

  useLayoutEffect(function notifyInputLayoutChange() {
    props.onLayoutChange?.({ promptHeight, pickerHeight });
  }, [pickerHeight, promptHeight, props.onLayoutChange]);

  useLayoutEffect(function recordInputFrameCommit() {
    if (props.showInput) {
      // 诊断只记录输入帧提交时刻，不记录 prompt 正文。
      recordTuiPerformanceDiagnostic("input_frame_committed", "prompt");
    }
  }, [input, cursorIndex, props.showInput]);

  useEffect(function resetSlashCommandSelection() {
    pickers.updateSlashCommandIndex(0);
  }, [slashCommandSuggestions.map(function getCommandName(command) { return command.name; }).join("\u0000")]);

  useEffect(function resetFileMentionSelection() {
    pickers.updateFileMentionIndex(0);
  }, [fileMentionSuggestions.join("\u0000")]);

  useInput(handleInput, { isActive: props.isRawModeSupported && props.isInputActive });

  if (!props.showInput) return null;
  return <>
    <TuiPromptInput input={input} cursorIndex={cursorIndex} columns={props.columns} useColor={props.useColor} screenReader={props.screenReader} busy={props.busy.current} />
    {pickers.permissionPickerOptions ? (
      <TuiPermissionPicker options={pickers.permissionPickerOptions} selectedIndex={pickers.permissionPickerIndex} useColor={props.useColor} screenReader={props.screenReader} />
    ) : pickers.modelPickerOptions ? (
      <TuiModelPicker options={pickers.modelPickerOptions} selectedIndex={pickers.modelPickerIndex} useColor={props.useColor} screenReader={props.screenReader} />
    ) : pickers.effortPickerOptions ? (
      <TuiEffortPicker options={pickers.effortPickerOptions} selectedIndex={pickers.effortPickerIndex} useColor={props.useColor} screenReader={props.screenReader} />
    ) : pickers.skillPickerSkills ? (
      <TuiSkillPicker skills={pickers.skillPickerSkills} query={pickers.skillPickerQuery} selectedIndex={pickers.skillPickerIndex} useColor={props.useColor} screenReader={props.screenReader} />
    ) : slashCommandSuggestions.length > 0 ? (
      <TuiSlashCommandMenu commands={slashCommandSuggestions} selectedIndex={pickers.slashCommandIndex} useColor={props.useColor} screenReader={props.screenReader} />
    ) : fileMentionSuggestions.length > 0 ? (
      <TuiFileMentionMenu candidates={fileMentionSuggestions} selectedIndex={pickers.fileMentionIndex} useColor={props.useColor} screenReader={props.screenReader} />
    ) : null}
  </>;
});
