/** TUI 会话内输入历史状态；纯函数维护草稿、FIFO 队列和上下边界召回语义。 */

/** 会话内输入历史的最小状态。 */
export interface TuiInputHistoryState {
  entries: string[];
  index?: number;
  draft: string;
}

/** 历史导航动作的稳定结果。 */
export interface TuiInputHistoryNavigation {
  state: TuiInputHistoryState;
  input: string;
  changed: boolean;
}

/** 创建空的会话内输入历史。 */
export function createTuiInputHistoryState(): TuiInputHistoryState {
  return { entries: [], draft: "" };
}

/** 成功提交输入后写入 FIFO，并退出历史浏览。 */
export function recordTuiInputHistory(state: TuiInputHistoryState, input: string, maximumEntries = 100): TuiInputHistoryState {
  const limit = Math.max(1, maximumEntries);
  const entries = [...state.entries, input].slice(-limit);
  return { entries, draft: "", index: undefined };
}

/** 判断上下箭头是否位于允许切换历史的视觉行边界。 */
export function canNavigateTuiInputHistory(direction: "up" | "down", cursorLine: number, lineCount: number, browsingHistory: boolean, pickerActive: boolean): boolean {
  if (pickerActive) return false;
  if (direction === "up") return cursorLine <= 0;
  return browsingHistory && cursorLine >= Math.max(0, lineCount - 1);
}

/** 在输入历史中向上或向下移动，并在首次进入时保存草稿。 */
export function navigateTuiInputHistory(state: TuiInputHistoryState, direction: "up" | "down", currentInput: string, enabled = true): TuiInputHistoryNavigation {
  if (!enabled || state.entries.length === 0) return { state, input: currentInput, changed: false };
  if (direction === "up") {
    const index = state.index === undefined ? state.entries.length - 1 : Math.max(0, state.index - 1);
    const nextState = { ...state, index, draft: state.index === undefined ? currentInput : state.draft };
    return { state: nextState, input: nextState.entries[index]!, changed: nextState.entries[index] !== currentInput };
  }
  if (state.index === undefined) return { state, input: currentInput, changed: false };
  if (state.index < state.entries.length - 1) {
    const index = state.index + 1;
    const nextState = { ...state, index };
    return { state: nextState, input: nextState.entries[index]!, changed: nextState.entries[index] !== currentInput };
  }
  const nextState = { ...state, index: undefined };
  return { state: nextState, input: nextState.draft, changed: nextState.draft !== currentInput };
}

/** 普通编辑立即退出历史浏览，并把编辑后的内容作为新的草稿。 */
export function updateTuiInputHistoryDraft(state: TuiInputHistoryState, input: string): TuiInputHistoryState {
  return { ...state, draft: input, index: undefined };
}
