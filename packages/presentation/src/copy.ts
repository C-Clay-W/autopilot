/** Presentation 的语义文案键与默认中文文案；Host 可以按自身语言包覆盖。 */

export const presentationCopy = {
  "thinking.active": "正在处理…",
  "tool.read.running": "正在读取",
  "tool.read.completed": "读取",
  "tool.search.running": "正在搜索",
  "tool.search.completed": "搜索",
  "tool.web_search.running": "正在搜索网络",
  "tool.web_search.completed": "网络搜索",
  "tool.web_fetch.running": "正在读取网页",
  "tool.web_fetch.completed": "网页读取",
  "tool.command.running": "正在运行命令",
  "tool.command.completed": "运行命令",
  "tool.write.running": "正在写入",
  "tool.write.completed": "写入文件",
  "tool.edit.running": "正在编辑",
  "tool.edit.completed": "编辑文件",
  "tool.process.running": "正在启动任务",
  "tool.process.completed": "后台任务",
  "tool.job.start.running": "正在启动后台任务",
  "tool.job.start.completed": "后台任务已启动",
  "tool.job.list.running": "正在查看后台任务",
  "tool.job.list.completed": "后台任务列表",
  "tool.job.read.running": "正在读取后台任务",
  "tool.job.read.completed": "后台任务状态",
  "tool.job.stop.running": "正在停止后台任务",
  "tool.job.stop.completed": "后台任务停止结果",
  "tool.external.running": "正在调用外部工具",
  "tool.external.completed": "外部工具",
  "tool.other.running": "正在调用工具",
  "tool.other.completed": "工具调用",
  "approval.required": "需要确认",
  "context.compacted": "上下文已压缩",
  "turn.completed": "完成",
  "turn.failed": "执行失败",
  "turn.interrupted": "已中断",
  "turn.limit_reached": "达到执行上限",
  "transport.disconnected": "连接已断开",
} as const;

/** 兼容已持久化会话中的旧工具展示键，避免把内部命名直接暴露给用户。 */
const legacyToolCopy: Record<string, string> = {
  "tool.read_file": "读取",
  "tool.glob_files": "搜索",
  "tool.grep_files": "搜索",
  "tool.write_file": "写入文件",
  "tool.edit_file": "编辑文件",
  "tool.run_command": "运行命令",
  "tool.start_background_job": "后台任务",
};

export type PresentationCopyKey = keyof typeof presentationCopy;

/** 解析默认中文文案；未知键原样返回，确保技术键可由 Host 后续覆盖。 */
export function getPresentationCopy(key: string): string {
  return presentationCopy[key as PresentationCopyKey] ?? legacyToolCopy[key] ?? key;
}

/** 2.5：判断拒绝类错误码是否为沙箱不可用（环境阻塞）；宿主展示据此区分"已拒绝"与"沙箱不可用，命令未启动"。 */
export function isSandboxUnavailableErrorCode(errorCode: string | undefined): boolean {
  return errorCode === "SANDBOX_UNAVAILABLE" || errorCode === "SANDBOX_NOT_PROVISIONED" || errorCode === "SANDBOX_RUNNER_FAILED";
}
/** 配置页与首次使用界面共用的联网告知；仅描述当前产品的数据流，不参与 Provider 选择。 */
export const WEB_SEARCH_DATA_FLOW_NOTICE = "启用网络搜索即允许将搜索查询发送给所选搜索供应商；搜索答案和来源随后会作为工具结果发送给当前主模型供应商，可能涉及两家供应商。请勿在搜索查询中包含密钥或私有内容。";
