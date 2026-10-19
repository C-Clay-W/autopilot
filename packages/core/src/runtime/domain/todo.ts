/**
 * runtime/domain/todo.ts — Session 任务链 Todo 领域模型。
 *
 * Todo 只描述模型的计划状态：整表替换、三态、最多一个 in_progress。
 * completed 不证明文件已修改或测试已通过；对外事件只携带受限文本与状态，
 * 不含 reasoning、路径或 raw tool payload。
 */

/** Todo 三态；blocked 等真实阻塞语义由 Turn/工具状态表达，不进入首版。 */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** 单个待办项；content 用于静态展示，activeForm 用于执行中活动文案。 */
export interface TodoItem {
  content: string;
  activeForm: string;
  status: TodoStatus;
}

/** 整表替换后的三态计数；由 Core 本地计算，不信任模型自报。 */
export interface TodoCounts {
  pending: number;
  inProgress: number;
  completed: number;
}

/** 当前任务链最近一次成功写入的 Todo 快照；供 checkpoint 与跨 Turn 连续上下文恢复。 */
export interface TodoSnapshot {
  todoChainId: string;
  todos: TodoItem[];
  counts: TodoCounts;
}

/** todo_write 成功后的规范化结果；携带完整列表供模型继续维护同一任务链。 */
export interface TodoWriteResult {
  todos: TodoItem[];
  counts: TodoCounts;
  /** 本次调用附带的任务文件集合声明；仅作为 transcript 事实留存，授权以审批与集合 grant 为准。 */
  fileTargets?: Array<{ path: string; operation: "create" | "edit" }>;
}
