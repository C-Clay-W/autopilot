/**
 * 工具明细 fixture：携带 Core 已生成的 read/glob/grep display.detail，并保留一条无 detail 的旧事件。
 *
 * raw 字段刻意带哨兵值，用于验证 reducer 不回读它们。
 */
import type { AgentEventEnvelope, ToolDisplayDetail, ToolDisplayFacts } from "@autopilot-agent/core";
import type { PresentationInput } from "../src/input.js";

export const READ_DETAIL: ToolDisplayDetail = {
  kind: "read_file",
  path: "agent/API-Design.md",
  startLine: 205,
  endLine: 245,
  totalLines: 912,
  returnedLines: 41,
  truncated: true,
};

export const GLOB_DETAIL: ToolDisplayDetail = {
  kind: "glob_files",
  paths: ["apps/web/app/chat/components/ToolCard.tsx", "packages/presentation/src/model.ts"],
  shownCount: 2,
  totalCount: 2,
  executionTruncated: false,
};

/** 执行已截断且完整总数不可证明；totalCount 必须缺席，不得由 shownCount 推断。 */
export const GLOB_TRUNCATED_DETAIL: ToolDisplayDetail = {
  kind: "glob_files",
  paths: ["packages/core/src/index.ts", "packages/core/src/internal/tools/types.ts"],
  shownCount: 2,
  executionTruncated: true,
};

export const GREP_CONTENT_DETAIL: ToolDisplayDetail = {
  kind: "grep_content",
  files: [
    { path: "packages/core/src/internal/tools/types.ts", matchedLineCount: 3, lineNumbers: [41, 46, 52] },
    { path: "packages/presentation/src/model.ts", matchedLineCount: 2, lineNumbers: [19, 36] },
  ],
  shownMatchedLineCount: 5,
  totalMatchedLineCount: 5,
  executionTruncated: false,
};

export const GREP_PATHS_DETAIL: ToolDisplayDetail = {
  kind: "grep_paths",
  paths: ["packages/core/src/internal/tools/tool-executor.ts"],
  shownCount: 1,
  totalCount: 1,
  executionTruncated: false,
};

export const GREP_COUNTS_DETAIL: ToolDisplayDetail = {
  kind: "grep_counts",
  files: [{ path: "packages/core/src/internal/tools/types.ts", count: 7 }],
  shownFileCount: 1,
  totalFileCount: 1,
  executionTruncated: false,
};

/** 用固定时间和序号创建可排序的 Runtime 信封。 */
function runtimeEvent(seq: number, event: AgentEventEnvelope["event"]): PresentationInput {
  return { kind: "runtime_event", envelope: { seq, sessionId: "session-detail", turnId: "turn-detail", timestamp: `2026-08-25T09:00:${String(seq).padStart(2, "0")}.000Z`, event } };
}

/** 构造一次成功探索的 tool_result 信封；display 携带 Stage 0 冻结的专用明细。 */
function toolResult(seq: number, callId: string, toolName: string, display: ToolDisplayFacts): PresentationInput {
  return runtimeEvent(seq, {
    type: "tool_result",
    turnId: "turn-detail",
    stepId: "step-1",
    callId,
    toolName,
    retryCount: 0,
    summary: `RAW_TOOL_RESULT_SUMMARY_${callId}_MUST_NOT_RENDER`,
    result: {
      status: "success",
      callId,
      toolName,
      output: `RAW_TOOL_OUTPUT_${callId}_MUST_NOT_RENDER`,
      meta: { durationMs: 12, inputHash: "hash" },
      display,
    },
  });
}

/** 创建 Stage 0 的 Live/History 同构输入；最后一条刻意缺少 detail，代表旧 transcript。 */
export function createToolDetailFixture(): PresentationInput[] {
  const readDisplay: ToolDisplayFacts = { titleKey: "tool.read.completed", target: "agent/API-Design.md", summary: "检查展示协议", detail: READ_DETAIL };
  const globDisplay: ToolDisplayFacts = { titleKey: "tool.search.completed", summary: "发现 2 个路径", detail: GLOB_DETAIL };
  const globTruncatedDisplay: ToolDisplayFacts = { titleKey: "tool.search.completed", summary: "显示 2 个路径，结果已截断", detail: GLOB_TRUNCATED_DETAIL };
  const grepContentDisplay: ToolDisplayFacts = { titleKey: "tool.search.completed", summary: "命中 5 行", detail: GREP_CONTENT_DETAIL };
  const grepPathsDisplay: ToolDisplayFacts = { titleKey: "tool.search.completed", summary: "命中 1 个文件", detail: GREP_PATHS_DETAIL };
  const grepCountsDisplay: ToolDisplayFacts = { titleKey: "tool.search.completed", summary: "命中 1 个文件", detail: GREP_COUNTS_DETAIL };
  const legacyDisplay: ToolDisplayFacts = { titleKey: "tool.read.completed", target: "agent/Design.md", summary: "read" };

  return [
    runtimeEvent(0, { type: "turn_started", turnId: "turn-detail", stepCount: 0 }),
    runtimeEvent(1, { type: "tool_started", turnId: "turn-detail", stepId: "step-1", callId: "call-read-1", toolName: "read_file", summary: "RAW_TOOL_START_MUST_NOT_RENDER" }),
    toolResult(2, "call-read-1", "read_file", readDisplay),
    toolResult(3, "call-glob-found", "glob_files", globDisplay),
    toolResult(4, "call-glob-truncated", "glob_files", globTruncatedDisplay),
    toolResult(5, "call-grep-content", "grep_files", grepContentDisplay),
    toolResult(6, "call-grep-paths", "grep_files", grepPathsDisplay),
    toolResult(7, "call-grep-counts", "grep_files", grepCountsDisplay),
    toolResult(8, "call-read-legacy", "read_file", legacyDisplay),
    runtimeEvent(9, { type: "turn_completed", turnId: "turn-detail", checkpoint: {} }),
  ];
}
