/** Shared Presentation fixture：覆盖 Runtime 安全事件、continue replay 与 Host 安全快照。 */
import type { AgentEventEnvelope } from "@autopilot-agent/core";
import type { PresentationInput } from "../src/input.js";

/** 用固定时间和序号创建可排序的 Runtime 信封。 */
function runtimeEvent(seq: number, event: AgentEventEnvelope["event"], turnId = "turn-primary"): PresentationInput {
  return { kind: "runtime_event", envelope: { seq, sessionId: "session-fixture", turnId, timestamp: `2026-08-24T06:00:${String(seq).padStart(2, "0")}.000Z`, event } };
}

/** 创建 Stage 1 的共享输入矩阵；raw 字段刻意包含哨兵值以验证 reducer 不读取它们。 */
export function createPresentationFixture(): PresentationInput[] {
  const approval = {
    approvalId: "approval-edit-1",
    callId: "call-edit-1",
    toolName: "edit_file",
    normalizedInputHash: "hash",
    reason: "RAW_APPROVAL_REASON_MUST_NOT_RENDER",
    risk: "write" as const,
    preview: { command: "RAW_APPROVAL_PREVIEW_MUST_NOT_RENDER" },
    expiresAt: "2026-08-24T07:00:00.000Z",
    allowedDecisions: ["allow_once", "allow_session", "allow_workspace", "deny"] as const,
    display: { operation: "edit", effect: "workspace" as const, destructive: false, resource: "apps/web/page.tsx", actionPreview: "edit apps/web/page.tsx", allowedDecisions: ["allow_once", "deny"] as const },
  };
  return [
    runtimeEvent(0, { type: "turn_started", turnId: "turn-primary", stepCount: 0 }),
    runtimeEvent(1, { type: "reasoning_summary", turnId: "turn-primary", stepId: "step-1", summary: "检查展示链路" }),
    runtimeEvent(2, { type: "reasoning_delta", turnId: "turn-primary", stepId: "step-1", delta: "RAW_REASONING_DELTA_MUST_NOT_RENDER" }),
    runtimeEvent(3, { type: "tool_started", turnId: "turn-primary", stepId: "step-1", callId: "call-read-1", toolName: "read_file", summary: "RAW_TOOL_START_SUMMARY_MUST_NOT_RENDER" }),
    runtimeEvent(4, { type: "tool_result", turnId: "turn-primary", stepId: "step-1", callId: "call-read-1", toolName: "read_file", retryCount: 0, summary: "RAW_TOOL_RESULT_SUMMARY_MUST_NOT_RENDER", result: { status: "success", callId: "call-read-1", toolName: "read_file", output: "RAW_TOOL_OUTPUT_MUST_NOT_RENDER", meta: { durationMs: 12, inputHash: "hash" }, display: { titleKey: "tool.read.completed", target: "packages/core/src/index.ts", summary: "318 lines", metrics: { lines: 318 } } } }),
    runtimeEvent(5, { type: "tool_started", turnId: "turn-primary", stepId: "step-1", callId: "call-read-2", toolName: "read_file", summary: "RAW_TOOL_START_2_MUST_NOT_RENDER" }),
    runtimeEvent(6, { type: "tool_result", turnId: "turn-primary", stepId: "step-1", callId: "call-read-2", toolName: "read_file", retryCount: 0, summary: "RAW_TOOL_RESULT_2_MUST_NOT_RENDER", result: { status: "success", callId: "call-read-2", toolName: "read_file", output: "RAW_TOOL_OUTPUT_2_MUST_NOT_RENDER", meta: { durationMs: 9, inputHash: "hash" }, display: { titleKey: "tool.read.completed", target: "apps/web/page.tsx", summary: "214 lines" } } }),
    runtimeEvent(7, { type: "tool_started", turnId: "turn-primary", stepId: "step-2", callId: "call-edit-1", toolName: "edit_file", summary: "RAW_EDIT_START_MUST_NOT_RENDER" }),
    runtimeEvent(8, { type: "approval_required", turnId: "turn-primary", stepId: "step-2", callId: "call-edit-1", toolName: "edit_file", result: { status: "approval_required", callId: "call-edit-1", toolName: "edit_file", approval, display: { titleKey: "tool.edit.running", target: "apps/web/page.tsx" } } }),
    runtimeEvent(9, { type: "tool_result", turnId: "turn-primary", stepId: "step-2", callId: "call-edit-1", toolName: "edit_file", retryCount: 0, summary: "RAW_EDIT_RESULT_MUST_NOT_RENDER", result: { status: "success", callId: "call-edit-1", toolName: "edit_file", output: "RAW_EDIT_OUTPUT_MUST_NOT_RENDER", meta: { durationMs: 20, inputHash: "hash" }, display: { titleKey: "tool.edit.completed", target: "apps/web/page.tsx", summary: "按 callId 更新", diff: { text: "@@ -1 +1 @@", files: 1, added: 12, removed: 9 } } } }),
    runtimeEvent(10, { type: "tool_started", turnId: "turn-primary", stepId: "step-3", callId: "call-command-ok", toolName: "run_command", summary: "RAW_COMMAND_MUST_NOT_RENDER" }),
    runtimeEvent(11, { type: "tool_result", turnId: "turn-primary", stepId: "step-3", callId: "call-command-ok", toolName: "run_command", retryCount: 0, summary: "RAW_COMMAND_RESULT_MUST_NOT_RENDER", result: { status: "success", callId: "call-command-ok", toolName: "run_command", output: "RAW_STDOUT_MUST_NOT_RENDER", meta: { durationMs: 50, inputHash: "hash", exitCode: 0 }, display: { titleKey: "tool.command.completed", target: "npm test", summary: "Exit 0", metrics: { exitCode: 0 } } } }),
    runtimeEvent(12, { type: "tool_result", turnId: "turn-primary", stepId: "step-4", callId: "call-command-failed", toolName: "run_command", retryCount: 0, summary: "RAW_FAILED_STDERR_MUST_NOT_RENDER", result: { status: "error", callId: "call-command-failed", toolName: "run_command", error: { code: "COMMAND_FAILED", message: "RAW_PROVIDER_ERROR_MUST_NOT_RENDER" }, meta: { durationMs: 10, inputHash: "hash", exitCode: 1 }, display: { titleKey: "tool.command.completed", target: "npm test", summary: "Exit 1" } } }),
    runtimeEvent(13, { type: "tool_result", turnId: "turn-primary", stepId: "step-5", callId: "call-command-timeout", toolName: "run_command", retryCount: 0, summary: "RAW_TIMEOUT_MUST_NOT_RENDER", result: { status: "timeout", callId: "call-command-timeout", toolName: "run_command", error: { code: "TOOL_TIMEOUT", message: "RAW_TIMEOUT_DETAIL_MUST_NOT_RENDER" }, meta: { durationMs: 1000, inputHash: "hash" }, interruption: { phase: "executing", normalizedInputHash: "hash", sideEffectState: "unknown", safeToRetry: false, reason: "RAW_INTERRUPTION_REASON_MUST_NOT_RENDER" }, display: { titleKey: "tool.command.completed", target: "npm test", summary: "请求超时" } } }),
    runtimeEvent(14, { type: "tool_result", turnId: "turn-primary", stepId: "step-6", callId: "call-mcp-1", toolName: "mcp__remote__lookup", retryCount: 0, summary: "RAW_MCP_STDERR_MUST_NOT_RENDER", result: { status: "success", callId: "call-mcp-1", toolName: "mcp__remote__lookup", output: "RAW_MCP_INPUT_OUTPUT_MUST_NOT_RENDER", meta: { durationMs: 30, inputHash: "hash" }, display: { titleKey: "tool.external.completed", summary: "完成外部查询" } } }),
    runtimeEvent(15, { type: "context_compact_started", turnId: "turn-primary", trigger: "auto" }),
    runtimeEvent(16, { type: "context_compacted", turnId: "turn-primary", trigger: "auto", summary: "已保留最近执行摘要", preTokens: 9000, postTokens: 3000, preservedFromIndex: 4 }),
    runtimeEvent(17, { type: "context_compact_failed", turnId: "turn-primary", trigger: "reactive", error: "RAW_COMPACT_ERROR_MUST_NOT_RENDER" }),
    runtimeEvent(18, { type: "undo_completed", turnId: "turn-primary", transactionId: "undo-1", restoredPaths: ["apps/web/page.tsx"], compensatedPaths: [], conflicts: [] }),
    runtimeEvent(19, { type: "undo_failed", turnId: "turn-primary", transactionId: "undo-2", restoredPaths: [], compensatedPaths: ["apps/web/page.tsx"], conflicts: ["apps/web/page.tsx"] }),
    runtimeEvent(20, { type: "answer_delta", turnId: "turn-primary", stepId: "step-answer", delta: "已统一 ToolCall 身份。" }),
    runtimeEvent(21, { type: "turn_completed", turnId: "turn-primary", checkpoint: {} }),
    runtimeEvent(0, { type: "turn_started", turnId: "turn-failed", stepCount: 0 }, "turn-failed"),
    runtimeEvent(1, { type: "turn_failed", turnId: "turn-failed", checkpoint: {}, error: "RAW_TURN_ERROR_MUST_NOT_RENDER" }, "turn-failed"),
    runtimeEvent(0, { type: "turn_started", turnId: "turn-interrupted", stepCount: 0 }, "turn-interrupted"),
    runtimeEvent(1, { type: "turn_interrupted", turnId: "turn-interrupted", checkpoint: {} }, "turn-interrupted"),
    runtimeEvent(0, { type: "turn_started", turnId: "turn-limit", stepCount: 0 }, "turn-limit"),
    runtimeEvent(1, { type: "turn_limit_reached", turnId: "turn-limit", checkpoint: {} }, "turn-limit"),
    { kind: "host_event", event: { kind: "transport", state: "reconnecting" } },
    // Host Job 与 Runtime 信封同 Session；跨 Session 的 Job 事件会被 reducer 安全拒绝。
    { kind: "host_event", event: { kind: "job", job: { jobId: "job-1", sessionId: "session-fixture", revision: 1, state: "interrupted", controlState: "terminal", canStop: false, updatedAt: 1, finishedAt: 1, title: "后台任务", summary: "进程状态无法重新附着。" } } },
    { kind: "host_event", event: { kind: "capability", id: "evidence-1", scope: "evidence", state: "available", summary: "2 个来源" } },
    { kind: "host_event", event: { kind: "undo", transactionId: "undo-preview-1", state: "preview", paths: ["apps/web/page.tsx"] } },
  ];
}
