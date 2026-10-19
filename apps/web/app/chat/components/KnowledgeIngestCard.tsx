/**
 * KnowledgeIngestCard.tsx —— 用用户可理解的语言展示知识库入库结果。
 */

/** 单个上传文件在入库结束后的安全展示信息。 */
export interface KnowledgeIngestItem {
  name: string;
  status: "completed" | "partial" | "failed";
  contentCount?: number;
  failedPages?: number[];
  error?: string;
}

/** 根据文件终态返回面向用户的简短状态文案。 */
function getItemStatusLabel(item: KnowledgeIngestItem): string {
  if (item.status === "completed") return "已就绪";
  if (item.status === "partial") return "部分完成";
  return "未完成";
}

/** 根据文件终态返回辅助说明，隐藏资源 ID、向量表等内部实现细节。 */
function getItemDetail(item: KnowledgeIngestItem): string {
  if (item.status === "failed") return item.error || "请重新上传后再试";
  if (item.status === "partial" && item.failedPages?.length) return `${item.failedPages.length} 页未能处理，可重新上传后再试`;
  if (typeof item.contentCount === "number") return `已整理 ${item.contentCount} 个内容片段`;
  return "现在可以直接提问";
}

/** 渲染与现有黑边视觉体系一致的知识库结果卡片。 */
export default function KnowledgeIngestCard({ items, workspaceName, readOnly = false }: { items: KnowledgeIngestItem[]; workspaceName: string; readOnly?: boolean }) {
  const completedCount = items.filter(function isCompleted(item) { return item.status === "completed"; }).length;
  const hasPartial = items.some(function isPartial(item) { return item.status === "partial"; });
  const failedCount = items.filter(function isFailed(item) { return item.status === "failed"; }).length;
  const allFailed = failedCount === items.length;
  const title = readOnly ? "历史知识记录（仅查看）" : allFailed ? "未能加入知识库" : failedCount || hasPartial ? "部分内容已加入知识库" : "已加入知识库";
  const description = readOnly ? "以下为已保存的处理记录，Work 不再使用这些知识。" : allFailed
    ? "文件没有完成处理，请根据下方提示重新上传。"
    : failedCount || hasPartial
      ? `${completedCount} 个文件已就绪，其余内容请根据下方提示处理。`
      : "文件已经处理完成，现在可以直接提问。";

  return (
    <section className="w-full min-w-[min(32rem,72vw)] border-2 border-ink bg-card shadow-[4px_4px_0_var(--ink)]" aria-live="polite">
      <div className="flex items-start gap-3 border-b-2 border-ink px-4 py-3">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center border-2 border-ink text-base font-bold ${allFailed ? "bg-error text-ink-on-dark" : "bg-success text-ink-on-dark"}`} aria-hidden="true">
          {allFailed ? "×" : "✓"}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold leading-6">{title}</h3>
          <p className="mt-0.5 text-xs leading-5 text-muted">{description}</p>
        </div>
      </div>

      <div className="divide-y-2 divide-ink/15">
        {items.map(function renderItem(item, index) {
          const statusClass = item.status === "failed" ? "text-error" : item.status === "partial" ? "text-accent" : "text-success";
          return (
            <div key={`${item.name}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-4 py-3">
              <p className="truncate text-sm font-semibold" title={item.name}>{item.name}</p>
              <span className={`text-xs font-bold ${statusClass}`}>{getItemStatusLabel(item)}</span>
              <p className="col-span-2 text-xs leading-5 text-muted">{readOnly ? "历史处理结果，不代表当前任务可查询此资料。" : getItemDetail(item)}</p>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 border-t-2 border-ink bg-ink/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-5 text-muted">
          {readOnly ? `原「${workspaceName}」知识数据保留在原处，未迁移或删除。` : "已保存到 Chat 私有知识库，可从左侧资源目录管理。"}
        </p>
      </div>
    </section>
  );
}
