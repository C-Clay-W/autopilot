/**
 * todo_write 工具：模型提交当前任务链的完整 Todo 列表，整表替换上一快照。
 *
 * 只写 Session 内部结构化状态，不修改工作区或外部系统，因此自动允许。
 * Schema 严格校验条数、唯一性、长度与唯一 in_progress；失败不产生任何事件。
 * 携带 fileTargets 时转为"任务文件集合审批"：一次展示 N 个待修改文件，
 * 用户批准后由 ApprovalService 保存 Turn 级集合授权，本 Turn 内 write_file/edit_file
 * 对清单成员按声明操作自动放行；清单外目标与外部路径仍走既有逐次审批。
 * 携带 externalFileTargets 时转为"外部文件集合审批"（2.4 第 4 项）：与工作区集合分卡、
 * 独立一次批准；成员由 Core 在声明期 canonical 化冻结，只覆盖精确文件，不授予父目录或递归权限。
 */

import { z } from "zod";
import {
  TASK_EXTERNAL_FILE_SET_CONSTRAINT,
  TASK_FILE_SET_CONSTRAINT,
  type TaskFileTarget,
} from "../../../runtime/domain/approval";
import type { TodoCounts, TodoWriteResult } from "../../../runtime/domain/todo";
import { createToolError, TOOL_ERROR_CODES } from "../tool-error";
import { resolveFileTarget } from "../permissions/path-access-policy";
import type { AgentToolDefinition, ToolExecutionContext } from "../types";

/** 整表替换的条数上限；控制单次提交的预算。 */
const MAX_TODO_ITEMS = 20;

/** 任务文件集合声明单次上限；控制一张审批卡的可审阅规模。 */
const MAX_TASK_FILE_TARGETS = 50;

/** 判断 Todo 文案是否包含不应进入公开 Runtime 事件的绝对路径或凭据片段。 */
function isUnsafeTodoText(value: string): boolean {
  return /(?:^|[\s(])(?:[a-z]:[\\/]|\\\\|\/(?:users|home|var|etc|tmp|private|root)(?:[\\/]|$)|(?:api[_-]?key|authorization|bearer\s+|password|secret|token)\s*[:=])/i.test(value);
}

/**
 * 校验任务文件集合声明路径：必须是规范的工作区相对路径。
 * 拒绝反斜杠、绝对前缀、盘符与 `.`/`..` 段，防止声明即携带路径穿越或外部目标；
 * 逃逸与外部判定仍由 write/edit 执行期的 canonical 复核兜底，这里只做声明格式门禁。
 */
function isSafeTaskFilePath(value: string): boolean {
  if (value.includes("\\") || value.startsWith("/")) return false;
  if (/^[a-z]:/i.test(value)) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * 校验外部文件集合声明路径：必须是绝对文件系统路径（Windows 盘符或 POSIX 根）。
 * 拒绝 UNC/网络路径、NUL、备用数据流与 `..` 段；canonical 化与工作区内判定由
 * facts 阶段 resolveFileTarget 复核，这里只做声明格式门禁。
 */
function isAbsoluteExternalTaskFilePath(value: string): boolean {
  if (!value || value.includes("\0")) return false;
  if (/^(\\\\|\/\/)/u.test(value)) return false;
  if (/^([a-z]:[\\/])/iu.test(value)) {
    // 盘符路径第二个冒号即 NTFS 备用数据流（ADS），与文件工具同一拒绝规则。
    return !/:/u.test(value.slice(2));
  }
  if (!value.startsWith("/")) return false;
  if (/:/u.test(value)) return false;
  // POSIX 绝对路径以前导 / 开头：跳过首个空段后再逐段校验。
  const segments = value.slice(1).split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** 单项限制 content/activeForm 长度并拒绝未知字段。 */
const todoItemSchema = z.object({
  content: z.string().trim().min(1).max(200).refine(function rejectsUnsafeContent(value) { return !isUnsafeTodoText(value); }, "Todo content 不能包含绝对路径或凭据"),
  activeForm: z.string().trim().min(1).max(120).refine(function rejectsUnsafeActiveForm(value) { return !isUnsafeTodoText(value); }, "Todo activeForm 不能包含绝对路径或凭据"),
  status: z.enum(["pending", "in_progress", "completed"]),
}).strict();

/** 任务文件集合的单个目标声明；path 与 operation 缺一不可。 */
const taskFileTargetSchema = z.object({
  path: z.string().trim().min(1).max(512).refine(isSafeTaskFilePath, "fileTargets.path 必须是不含 ..、反斜杠或绝对前缀的工作区相对路径"),
  operation: z.enum(["create", "edit"]),
}).strict();

/** 外部文件集合的单个目标声明；path 必须是绝对文件系统路径，canonical 身份由 facts 阶段冻结。 */
const externalTaskFileTargetSchema = z.object({
  path: z.string().trim().min(1).max(512).refine(isAbsoluteExternalTaskFilePath, "externalFileTargets.path 必须是不含 ..、UNC 或备用数据流语法的绝对路径"),
  operation: z.enum(["create", "edit"]),
}).strict();

/** 完整列表限制 0–20 项；清空只允许显式提交 todos: []。 */
const inputSchema = z.object({
  todos: z.array(todoItemSchema).max(MAX_TODO_ITEMS),
  fileTargets: z.array(taskFileTargetSchema).min(1).max(MAX_TASK_FILE_TARGETS).optional(),
  externalFileTargets: z.array(externalTaskFileTargetSchema).min(1).max(MAX_TASK_FILE_TARGETS).optional(),
}).strict().superRefine(function validateTodoList(input, context) {
  const contents = new Set<string>();
  for (const todo of input.todos) {
    if (contents.has(todo.content)) context.addIssue({ code: "custom", message: "todo content 必须唯一" });
    contents.add(todo.content);
  }
  const activeCount = input.todos.filter(function isActive(todo) { return todo.status === "in_progress"; }).length;
  const hasUnfinished = input.todos.some(function isUnfinished(todo) { return todo.status !== "completed"; });
  if (hasUnfinished && activeCount !== 1) {
    context.addIssue({ code: "custom", message: "存在未完成项时必须恰好一项 in_progress" });
  }
  // 同一 path + operation 重复声明没有意义；集合授权在批准时按清单合并，重复项会放大歧义。
  const seenTargets = new Set<string>();
  for (const target of input.fileTargets ?? []) {
    const key = `${target.operation}:${target.path}`;
    if (seenTargets.has(key)) context.addIssue({ code: "custom", message: "fileTargets 存在重复的 path 与 operation 声明" });
    seenTargets.add(key);
  }
  const seenExternalTargets = new Set<string>();
  for (const target of input.externalFileTargets ?? []) {
    const key = `${target.operation}:${target.path}`;
    if (seenExternalTargets.has(key)) context.addIssue({ code: "custom", message: "externalFileTargets 存在重复的 path 与 operation 声明" });
    seenExternalTargets.add(key);
  }
});

type TodoWriteInput = z.infer<typeof inputSchema>;

/** 计算整表替换后的三态计数。 */
function countTodos(todos: TodoWriteInput["todos"]): TodoCounts {
  return {
    pending: todos.filter(function isPending(todo) { return todo.status === "pending"; }).length,
    inProgress: todos.filter(function isActive(todo) { return todo.status === "in_progress"; }).length,
    completed: todos.filter(function isCompleted(todo) { return todo.status === "completed"; }).length,
  };
}

/** 创建整表替换的 Todo 工具；所有宿主的 root Agent 均可注册。 */
export function createTodoWriteTool(): AgentToolDefinition<TodoWriteInput, TodoWriteResult> {
  return {
    name: "todo_write",
    description: `提交当前任务链的完整 Todo 列表，整表替换上一快照（最多 ${MAX_TODO_ITEMS} 项；清空时提交 todos: []）。复杂多阶段、多子任务、跨多个文件/层或需要验证收口的任务应主动使用；只读多阶段也适用。仅单一平凡步骤、简单问答或纯对话跳过；难以判断时使用。进入新阶段前把对应项标为 in_progress；每完成一项立即标 completed；发现新工作时立即提交包含新增项的完整列表，不要批量延迟更新。每项包含 content（静态展示）、activeForm（执行中活动文案）和 status；存在未完成项时必须恰好一项 in_progress；所有 content 唯一。Todo 只描述计划状态：验证失败、实施不完整或存在未解决错误时不得把对应项标为 completed，必要时保持 in_progress 并在正文说明。修改多个工作区文件前，可在同一调用中附带 fileTargets 声明完整清单（path 为工作区相对路径，operation 为 create 表示 write_file 写入/新建、edit 表示 edit_file 编辑）：用户一次批准后，本任务内对清单内文件的对应修改不再逐个弹审批；新增加的文件需要再次声明增量清单。已知要修改多个工作区外文件时，改用 externalFileTargets 声明绝对路径清单，用户单独一次批准后本任务内对清单内精确文件的对应修改自动放行；两类清单不能混在一次调用，需分两次提交。只改一两个文件或仅只读时不要使用 fileTargets/externalFileTargets。`,
    inputSchema,
    metadata: {
      effect: "none",
      destructive: false,
      concurrency: { max: 1, resourceKey: "todo:write" },
      retry: { safe: false },
    },
    /** 无声明时保持只读自动允许；有声明时冻结集合审批事实，集合内容只来自本地 canonical 化。 */
    async createActionFacts(input, context?) {
      const fileTargets = input.fileTargets;
      const externalFileTargets = input.externalFileTargets;
      if (!fileTargets?.length && !externalFileTargets?.length) {
        return { toolName: "todo_write", effect: "none", destructive: false, operation: "todo_write" };
      }
      // 工作区集合与外部集合是两张独立审批卡（2.4 第 4 项）；混在一次声明会模糊授权范围，直接拒绝。
      if (fileTargets?.length && externalFileTargets?.length) {
        throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "工作区与外部文件集合需分别声明：请分两次 todo_write 提交 fileTargets 与 externalFileTargets");
      }
      if (externalFileTargets?.length) {
        const canonicalTargets = new Map<string, TaskFileTarget>();
        for (const target of externalFileTargets) {
          const resolved = await resolveFileTarget(context?.workspaceRoot, target.path);
          // 声明为"外部文件集合"却解析进工作区属于通道误用：改用 fileTargets 走工作区集合审批。
          if (!resolved.isExternal) {
            throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, `externalFileTargets 包含工作区内路径 ${resolved.canonicalTarget}，请改用 fileTargets 声明`);
          }
          const key = `${target.operation}:${resolved.canonicalTarget}`;
          if (canonicalTargets.has(key)) {
            throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, `externalFileTargets 存在指向同一文件的重复声明：${resolved.canonicalTarget}`);
          }
          canonicalTargets.set(key, { path: resolved.canonicalTarget, operation: target.operation });
        }
        const frozen = [...canonicalTargets.values()];
        return {
          toolName: "todo_write",
          effect: "none",
          destructive: false,
          operation: "批量外部文件修改",
          resource: `${frozen.length} 个工作区外文件`,
          risk: "external_side_effect",
          requiresApproval: true,
          stableConstraint: TASK_EXTERNAL_FILE_SET_CONSTRAINT,
          taskFileSet: frozen,
          approval: {
            reason: "本次任务声明了要修改的工作区外文件清单，需要单独一次批准",
            preview: { fileCount: frozen.length, files: frozen, scope: "external" },
          },
        };
      }
      return {
        toolName: "todo_write",
        effect: "none",
        destructive: false,
        operation: "批量文件修改",
        resource: `${fileTargets!.length} 个文件`,
        risk: "workspace_mutating",
        requiresApproval: true,
        stableConstraint: TASK_FILE_SET_CONSTRAINT,
        taskFileSet: fileTargets!.map((entry) => ({ ...entry })) satisfies TaskFileTarget[],
        approval: {
          reason: "本次任务声明了要修改的文件清单，需要一次批准",
          preview: { fileCount: fileTargets!.length, files: fileTargets },
        },
      };
    },
    /** 归一化并计数；约束校验已由 Schema 完成。 */
    async execute(input) {
      return { todos: input.todos, counts: countTodos(input.todos), ...(input.fileTargets?.length ? { fileTargets: input.fileTargets } : {}) };
    },
    /** 返回 counts 与当前规范化列表，供模型继续维护同一任务链。 */
    serializeOutput(output) {
      return { todos: output.todos, counts: output.counts, ...(output.fileTargets?.length ? { fileTargets: output.fileTargets } : {}) };
    },
  };
}
