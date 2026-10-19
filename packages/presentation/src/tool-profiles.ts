/** 工具展示 Profile：仅定义分类、文案键和可确定分组资格，不参与权限或调度。 */
import type { ToolCategory } from "./model.js";

export interface ToolPresentationProfile {
  key: string;
  category: ToolCategory;
  runningTitleKey: string;
  completedTitleKey: string;
  explorationGroup: boolean;
}

const PROFILES: Record<string, ToolPresentationProfile> = {
  read_file: { key: "read_file", category: "read", runningTitleKey: "tool.read.running", completedTitleKey: "tool.read.completed", explorationGroup: true },
  glob_files: { key: "glob_files", category: "search", runningTitleKey: "tool.search.running", completedTitleKey: "tool.search.completed", explorationGroup: true },
  grep_files: { key: "grep_files", category: "search", runningTitleKey: "tool.search.running", completedTitleKey: "tool.search.completed", explorationGroup: true },
  rag_search: { key: "rag_search", category: "search", runningTitleKey: "tool.search.running", completedTitleKey: "tool.search.completed", explorationGroup: true },
  web_search: { key: "web_search", category: "external", runningTitleKey: "tool.web_search.running", completedTitleKey: "tool.web_search.completed", explorationGroup: false },
  web_fetch: { key: "web_fetch", category: "external", runningTitleKey: "tool.web_fetch.running", completedTitleKey: "tool.web_fetch.completed", explorationGroup: false },
  write_file: { key: "write_file", category: "write", runningTitleKey: "tool.write.running", completedTitleKey: "tool.write.completed", explorationGroup: false },
  edit_file: { key: "edit_file", category: "edit", runningTitleKey: "tool.edit.running", completedTitleKey: "tool.edit.completed", explorationGroup: false },
  run_command: { key: "run_command", category: "command", runningTitleKey: "tool.command.running", completedTitleKey: "tool.command.completed", explorationGroup: false },
  start_background_job: { key: "start_background_job", category: "process", runningTitleKey: "tool.job.start.running", completedTitleKey: "tool.job.start.completed", explorationGroup: false },
  list_background_jobs: { key: "list_background_jobs", category: "process", runningTitleKey: "tool.job.list.running", completedTitleKey: "tool.job.list.completed", explorationGroup: false },
  read_background_job: { key: "read_background_job", category: "process", runningTitleKey: "tool.job.read.running", completedTitleKey: "tool.job.read.completed", explorationGroup: false },
  stop_background_job: { key: "stop_background_job", category: "process", runningTitleKey: "tool.job.stop.running", completedTitleKey: "tool.job.stop.completed", explorationGroup: false },
};

const MCP_PROFILE: ToolPresentationProfile = { key: "mcp", category: "external", runningTitleKey: "tool.external.running", completedTitleKey: "tool.external.completed", explorationGroup: false };
const UNKNOWN_PROFILE: ToolPresentationProfile = { key: "unknown", category: "other", runningTitleKey: "tool.other.running", completedTitleKey: "tool.other.completed", explorationGroup: false };

/** 根据稳定工具名返回展示 Profile；未知 MCP 只按 namespace 使用外部工具回退。 */
export function getToolPresentationProfile(toolName: string): ToolPresentationProfile {
  return PROFILES[toolName] ?? (toolName.startsWith("mcp__") ? MCP_PROFILE : UNKNOWN_PROFILE);
}
