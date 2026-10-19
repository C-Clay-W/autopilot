/** 四 picker（skill/permission/model/effort）及审批/slash 菜单焦点的状态与处理函数。 */

import { useRef, useState } from "react";
import type { Key } from "ink";
import type {
  CliAction,
  CliEffortOption,
  CliModelOption,
  CliPermissionOption,
  CliSkillSummary,
} from "../../types.js";
import { splitTuiInputGraphemes } from "../input/graphemes.js";
import { parseTuiControlAction, resolveTuiDeleteDirection } from "../input/keys.js";
import { filterTuiSkills } from "../pickers/skill.js";

/** usePickers 的输入依赖；dispatchAction 与 rawInputSequenceRef 由 app.tsx 注入。 */
export interface UsePickersInput {
  dispatchAction: (action: CliAction, prompt?: string, preserveSkillPickerQuery?: boolean) => Promise<void>;
  rawInputSequenceRef: { current: string };
}

/** 管理四个 picker 与审批/slash 菜单焦点；对外暴露 state、setter 与统一分发入口。 */
export function usePickers(input: UsePickersInput) {
  const { dispatchAction, rawInputSequenceRef } = input;
  const [skillPickerSkills, setSkillPickerSkills] = useState<CliSkillSummary[] | undefined>(undefined);
  const [skillPickerQuery, setSkillPickerQuery] = useState("");
  const [skillPickerIndex, setSkillPickerIndex] = useState(0);
  const [permissionPickerOptions, setPermissionPickerOptions] = useState<CliPermissionOption[] | undefined>(undefined);
  const [permissionPickerIndex, setPermissionPickerIndex] = useState(0);
  const [modelPickerOptions, setModelPickerOptions] = useState<CliModelOption[] | undefined>(undefined);
  const [modelPickerIndex, setModelPickerIndex] = useState(0);
  const [effortPickerOptions, setEffortPickerOptions] = useState<CliEffortOption[] | undefined>(undefined);
  const [effortPickerIndex, setEffortPickerIndex] = useState(0);
  const [approvalPickerIndex, setApprovalPickerIndex] = useState(0);
  const [slashCommandIndex, setSlashCommandIndex] = useState(0);
  const [fileMentionIndex, setFileMentionIndex] = useState(0);
  /** Esc 关闭 @ 菜单时记录的完整输入；输入变化后菜单可复活（CC dismissedForInput 模式）。 */
  const [fileMentionDismissedInput, setFileMentionDismissedInput] = useState<string | undefined>(undefined);
  const skillPickerQueryRef = useRef("");
  const skillPickerIndexRef = useRef(0);
  const permissionPickerIndexRef = useRef(0);
  const permissionPickerOptionsRef = useRef<CliPermissionOption[] | undefined>(undefined);
  const modelPickerIndexRef = useRef(0);
  const modelPickerOptionsRef = useRef<CliModelOption[] | undefined>(undefined);
  const effortPickerIndexRef = useRef(0);
  const effortPickerOptionsRef = useRef<CliEffortOption[] | undefined>(undefined);
  const approvalPickerIndexRef = useRef(0);
  const slashCommandIndexRef = useRef(0);
  const fileMentionIndexRef = useRef(0);

  /** 更新 picker 搜索词并回到筛选结果首项。 */
  function updateSkillPickerQuery(query: string): void {
    skillPickerQueryRef.current = query;
    setSkillPickerQuery(query);
    updateSkillPickerIndex(0);
  }

  /** 同步保存 picker 当前行，保证连续方向键和回车不会读取旧 React 状态。 */
  function updateSkillPickerIndex(index: number): void {
    skillPickerIndexRef.current = index;
    setSkillPickerIndex(index);
  }

  /** 关闭 picker 并恢复普通单行 prompt。 */
  function closeSkillPicker(): void {
    setSkillPickerSkills(undefined);
    updateSkillPickerQuery("");
  }

  /** 关闭权限 picker 并恢复普通 prompt。 */
  function closePermissionPicker(): void {
    permissionPickerOptionsRef.current = undefined;
    setPermissionPickerOptions(undefined);
    updatePermissionPickerIndex(0);
  }

  /** 关闭模型 picker 并恢复普通单行 prompt。 */
  function closeModelPicker(): void {
    modelPickerOptionsRef.current = undefined;
    setModelPickerOptions(undefined);
    updateModelPickerIndex(0);
  }

  /** 同步保存模型 picker 当前焦点，避免连续方向键读取旧 React 状态。 */
  function updateModelPickerIndex(index: number): void {
    modelPickerIndexRef.current = index;
    setModelPickerIndex(index);
  }

  /** 关闭 effort picker 并恢复普通单行 prompt。 */
  function closeEffortPicker(): void {
    effortPickerOptionsRef.current = undefined;
    setEffortPickerOptions(undefined);
    updateEffortPickerIndex(0);
  }

  /** 同步保存 effort picker 当前焦点，避免连续方向键读取旧 React 状态。 */
  function updateEffortPickerIndex(index: number): void {
    effortPickerIndexRef.current = index;
    setEffortPickerIndex(index);
  }

  /** 同步保存权限 picker 当前焦点，避免连续方向键读取旧 React 状态。 */
  function updatePermissionPickerIndex(index: number): void {
    permissionPickerIndexRef.current = index;
    setPermissionPickerIndex(index);
  }

  /** 同步保存审批菜单当前焦点，保证连续方向键和回车读取同一选择。 */
  function updateApprovalPickerIndex(index: number): void {
    approvalPickerIndexRef.current = index;
    setApprovalPickerIndex(index);
  }

  /** 同步保存 slash 菜单当前焦点，避免连续方向键读取旧 React 状态。 */
  function updateSlashCommandIndex(index: number): void {
    slashCommandIndexRef.current = index;
    setSlashCommandIndex(index);
  }

  /** 同步保存 @ 菜单当前焦点，避免连续方向键读取旧 React 状态。 */
  function updateFileMentionIndex(index: number): void {
    fileMentionIndexRef.current = index;
    setFileMentionIndex(index);
  }

  /** 在 Skill picker 内处理搜索、方向键、空格开关、确认和取消。 */
  function handleSkillPickerInput(value: string, key: Key, controlAction: ReturnType<typeof parseTuiControlAction>): void {
    if (controlAction === "cancel") {
      closeSkillPicker();
      return;
    }
    const skills = skillPickerSkills ?? [];
    const filteredSkills = filterTuiSkills(skills, skillPickerQueryRef.current);
    if (key.upArrow) {
      updateSkillPickerIndex(Math.max(0, skillPickerIndexRef.current - 1));
      return;
    }
    if (key.downArrow) {
      updateSkillPickerIndex(Math.min(Math.max(0, filteredSkills.length - 1), skillPickerIndexRef.current + 1));
      return;
    }
    if (key.return) {
      closeSkillPicker();
      return;
    }
    if (value === " ") {
      const selectedSkill = filteredSkills[skillPickerIndexRef.current];
      if (selectedSkill) void dispatchAction({ type: "toggle_skill", skill: selectedSkill.qualifiedName }, undefined, true);
      return;
    }
    const deleteDirection = resolveTuiDeleteDirection(value, key, rawInputSequenceRef.current);
    if (deleteDirection) {
      updateSkillPickerQuery(splitTuiInputGraphemes(skillPickerQueryRef.current).slice(0, -1).join(""));
      return;
    }
    if (value === "/" && !skillPickerQueryRef.current) return;
    if (value && !key.ctrl && !key.meta) updateSkillPickerQuery(skillPickerQueryRef.current + value);
  }

  /** 在权限 picker 内移动焦点，回车提交 Session 默认权限，Esc 只关闭界面。 */
  function handlePermissionPickerInput(value: string, key: Key, controlAction: ReturnType<typeof parseTuiControlAction>): void {
    if (controlAction === "cancel") {
      closePermissionPicker();
      return;
    }
    const options = permissionPickerOptionsRef.current ?? permissionPickerOptions ?? [];
    if (key.upArrow) {
      updatePermissionPickerIndex(Math.max(0, permissionPickerIndexRef.current - 1));
      return;
    }
    if (key.downArrow) {
      updatePermissionPickerIndex(Math.min(Math.max(0, options.length - 1), permissionPickerIndexRef.current + 1));
      return;
    }
    if (value === " ") {
      const focused = options[permissionPickerIndexRef.current];
      if (!focused || focused.selected) return;
      const nextOptions = options.map(function selectPermission(option) {
        return { ...option, selected: option.mode === focused.mode };
      });
      permissionPickerOptionsRef.current = nextOptions;
      setPermissionPickerOptions(nextOptions);
      return;
    }
    if (key.return) {
      const selected = options.find(function findEnabledPermission(option) { return option.selected; });
      closePermissionPicker();
      if (selected) void dispatchAction({ type: "set_permission_mode", mode: selected.mode });
    }
  }

  /** 在模型 picker 内移动焦点，空格选择模型，回车只更新下一 Turn 的 Session 默认模型。 */
  function handleModelPickerInput(value: string, key: Key, controlAction: ReturnType<typeof parseTuiControlAction>): void {
    if (controlAction === "cancel") {
      closeModelPicker();
      return;
    }
    const options = modelPickerOptionsRef.current ?? modelPickerOptions ?? [];
    if (key.upArrow) {
      updateModelPickerIndex(Math.max(0, modelPickerIndexRef.current - 1));
      return;
    }
    if (key.downArrow) {
      updateModelPickerIndex(Math.min(Math.max(0, options.length - 1), modelPickerIndexRef.current + 1));
      return;
    }
    if (value === " ") {
      const focused = options[modelPickerIndexRef.current];
      if (!focused || focused.selected) return;
      const nextOptions = options.map(function selectModel(option) {
        return { ...option, selected: option.provider === focused.provider && option.modelId === focused.modelId };
      });
      modelPickerOptionsRef.current = nextOptions;
      setModelPickerOptions(nextOptions);
      return;
    }
    if (key.return) {
      const selected = options.find(function findEnabledModel(option) { return option.selected; });
      closeModelPicker();
      if (selected) void dispatchAction({ type: "set_model", provider: selected.provider, modelId: selected.modelId });
    }
  }

  /** 在 effort picker 内移动焦点，空格选择推理强度，回车只更新下一 Turn 的 Session 默认推理强度。 */
  function handleEffortPickerInput(value: string, key: Key, controlAction: ReturnType<typeof parseTuiControlAction>): void {
    if (controlAction === "cancel") {
      closeEffortPicker();
      return;
    }
    const options = effortPickerOptionsRef.current ?? effortPickerOptions ?? [];
    if (key.upArrow) {
      updateEffortPickerIndex(Math.max(0, effortPickerIndexRef.current - 1));
      return;
    }
    if (key.downArrow) {
      updateEffortPickerIndex(Math.min(Math.max(0, options.length - 1), effortPickerIndexRef.current + 1));
      return;
    }
    if (value === " ") {
      const focused = options[effortPickerIndexRef.current];
      if (!focused || focused.selected) return;
      const nextOptions = options.map(function selectEffort(option) {
        return { ...option, selected: option.effort === focused.effort };
      });
      effortPickerOptionsRef.current = nextOptions;
      setEffortPickerOptions(nextOptions);
      return;
    }
    if (key.return) {
      const selected = options.find(function findEnabledEffort(option) { return option.selected; });
      closeEffortPicker();
      if (selected) void dispatchAction({ type: "set_effort", effort: selected.effort });
    }
  }

  const isPickerActive = permissionPickerOptions !== undefined || modelPickerOptions !== undefined || effortPickerOptions !== undefined || skillPickerSkills !== undefined;

  /** 按激活的 picker 分发按键；无激活 picker 时由 handleInput 继续处理普通输入。 */
  function dispatchPickerInput(value: string, key: Key, controlAction: ReturnType<typeof parseTuiControlAction>): void {
    if (permissionPickerOptions) {
      handlePermissionPickerInput(value, key, controlAction);
      return;
    }
    if (modelPickerOptions) {
      handleModelPickerInput(value, key, controlAction);
      return;
    }
    if (effortPickerOptions) {
      handleEffortPickerInput(value, key, controlAction);
      return;
    }
    if (skillPickerSkills) {
      handleSkillPickerInput(value, key, controlAction);
      return;
    }
  }

  return {
    skillPickerSkills,
    skillPickerQuery,
    skillPickerIndex,
    permissionPickerOptions,
    permissionPickerIndex,
    modelPickerOptions,
    modelPickerIndex,
    effortPickerOptions,
    effortPickerIndex,
    approvalPickerIndex,
    slashCommandIndex,
    fileMentionIndex,
    fileMentionDismissedInput,
    setSkillPickerSkills,
    setPermissionPickerOptions,
    setModelPickerOptions,
    setEffortPickerOptions,
    updateSkillPickerQuery,
    updatePermissionPickerIndex,
    updateModelPickerIndex,
    updateEffortPickerIndex,
    updateApprovalPickerIndex,
    updateSlashCommandIndex,
    updateFileMentionIndex,
    setFileMentionDismissedInput,
    isPickerActive,
    dispatchPickerInput,
    approvalPickerIndexRef,
    slashCommandIndexRef,
    fileMentionIndexRef,
    permissionPickerOptionsRef,
    modelPickerOptionsRef,
    effortPickerOptionsRef,
  };
}
