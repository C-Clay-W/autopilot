/** Chat 私有知识管理页：用户主动上传、预览与删除，独立于 Workspace 和模型工具权限。 */
"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { uploadChatKnowledge } from "@/lib/knowledge-ingest-client";
import KnowledgeIngestProgress, { getKnowledgeIngestProcessStep } from "../components/KnowledgeIngestProgress";
import type { ProcessStep } from "../components/process-step";
import Popconfirm from "../components/Popconfirm";

/** 管理面只保存服务端安全展示字段。 */
interface Resource { resourceId: string; displayName: string; type: string; status: string; recordCount: number; pageCount?: number; failedPages?: number[]; }
const statusText: Record<string, string> = { completed: "已入库", partial: "部分入库", running: "处理中", queued: "等待中", failed: "失败", cancelled: "已取消", deleting: "删除中" };

/** 请求安全资源列表；状态写入由调用处的异步回调完成。 */
async function readResourceList(signal?: AbortSignal): Promise<Resource[]> {
  const response = await fetch("/api/chat/knowledge", { cache: "no-store", signal });
  if (!response.ok) throw new Error("知识列表读取失败，请刷新重试");
  return (await response.json() as { resources: Resource[] }).resources;
}

/** 使用共享进度与确认框管理正式资源，不改变任何 Chat 会话身份。 */
export default function ChatKnowledgePage() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [steps, setSteps] = useState<ProcessStep[]>([]);
  const [pendingDelete, setPendingDelete] = useState<Resource | null>(null);
  const operation = useRef<AbortController | null>(null);
  /** 所有列表读取使用 no-store，失败明确展示，不能用空数组冒充空库。 */
  async function refresh(signal?: AbortSignal): Promise<void> {
    setResources(await readResourceList(signal));
  }
  useEffect(function loadResources() {
    const controller = new AbortController();
    void readResourceList(controller.signal).then(function loaded(items) { if (!controller.signal.aborted) setResources(items); }).catch(function failed() { if (!controller.signal.aborted) setMessage("知识列表读取失败，请刷新重试"); }).finally(function ready() { if (!controller.signal.aborted) setLoading(false); });
    return function stop() { controller.abort(); operation.current?.abort(); };
  }, []);
  /** 顺序上传所选文件，取消会传至服务端，所有终态后刷新真实 manifest。 */
  async function upload(files: File[]): Promise<void> {
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setMessage("");
    try {
      for (const file of files) {
        setSteps([{ stage: "upload", message: `正在上传 ${file.name}` }]);
        const terminal = await uploadChatKnowledge(file, function progress(event) { setSteps([getKnowledgeIngestProcessStep(event)]); }, undefined, controller.signal);
        if (terminal.status === "failed" || terminal.status === "cancelled") throw new Error(terminal.message);
      }
      setMessage("上传完成；部分入库资源的失败页见下方列表。");
    } catch (error) { setMessage(controller.signal.aborted ? "入库已取消" : error instanceof Error ? error.message : "入库失败"); }
    finally {
      setBusy(false); setSteps([]); operation.current = null;
      await refresh().catch(function failed() { setMessage("操作已结束，列表读取失败，请刷新确认资源状态"); });
    }
  }
  /** 删除只由显式确认触发，失败保留资源并允许重试。 */
  async function remove(resource: Resource): Promise<void> {
    setPendingDelete(null); setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/chat/knowledge/${resource.resourceId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("删除未完成，请重试");
      await refresh(); setMessage("资源已删除，已有检索引用不再可用。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "删除失败"); }
    finally { setBusy(false); }
  }
  return <main className="h-full overflow-auto bg-bg p-4 text-ink sm:p-8"><div className="mx-auto max-w-4xl">
    <Link href="/chat" className="text-sm text-accent underline">← 返回 Chat</Link>
    <h1 className="mt-6 border-b-[3px] border-ink pb-3 text-2xl font-bold">私有知识库</h1>
    <p className="mt-4 text-sm leading-relaxed">开启 Chat 的 RAG 后才会查询这些资料。上传资料长期保留，不受临时附件 30 天清理或删除来源会话影响。</p>
    <p className="mt-2 text-xs text-muted">解析、向量化及视觉分析可能按受信配置将当前资料发送给模型服务；RAG 不调用公开联网搜索。回答目前采用资料摘录，知识不足会明确提示。</p>
    <div className="my-6 flex flex-wrap items-center gap-3 border-2 border-ink p-4">
      <label className="text-sm font-bold">上传资料<input aria-label="上传知识资料" type="file" multiple disabled={busy || loading} accept=".txt,.md,.docx,.pdf,.xls,.xlsx,.png,.jpg,.jpeg,.webp" className="mt-2 block max-w-full text-xs" onChange={function selected(event) { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) void upload(files); }} /></label>
      <span className="text-xs text-muted">文档最多 50 MiB，图片最多 20 MiB；支持 TXT、MD、DOCX、PDF、Excel、PNG、JPEG、WebP。</span>
      {steps.length > 0 && <button type="button" onClick={function cancel() { operation.current?.abort(); }} className="border-2 border-ink px-3 py-1 text-sm">取消入库</button>}
    </div>
    {steps.length > 0 && <KnowledgeIngestProgress steps={steps} />}
    {message && <p role="status" className="my-4 border-l-4 border-accent pl-3 text-sm">{message}</p>}
    <div className="flex items-center justify-between"><h2 className="text-lg font-bold">知识资源</h2><button type="button" disabled={busy} className="border-2 border-ink px-3 py-1 text-xs disabled:opacity-50" onClick={function reload() { setLoading(true); void refresh().catch(function failed() { setMessage("知识列表读取失败，请重试"); }).finally(function done() { setLoading(false); }); }}>刷新</button></div>
    {loading ? <p role="status" className="mt-4">正在读取…</p> : !resources.length ? <p className="mt-4 text-sm text-muted">{message.includes("读取失败") ? "暂时无法确认资源状态。" : "还没有知识资源。上传资料后，可在新的 RAG 对话中提问。"}</p> : <ul className="mt-4 divide-y-2 divide-ink border-2 border-ink">{resources.map(function resource(item) { return <li key={item.resourceId} className="flex flex-wrap items-start justify-between gap-3 p-4"><div className="min-w-0 flex-1"><h3 className="break-words font-semibold">{item.displayName}</h3><p className="mt-1 text-xs text-muted">{item.type.toUpperCase()} · {statusText[item.status] ?? "状态未知"} · {item.recordCount} 条记录{item.failedPages?.length ? ` · 失败页：${item.failedPages.join("、")}` : ""}</p></div><div className="relative flex gap-3 text-xs">{["completed", "partial"].includes(item.status) && <a href={`/api/chat/knowledge/${item.resourceId}/preview`} target="_blank" rel="noopener noreferrer" className="text-accent underline">预览{item.type === "pdf" ? "首页" : ""} ↗</a>}<button type="button" disabled={busy} className="underline disabled:opacity-50" onClick={function confirmDelete() { setPendingDelete(item); }}>删除</button><Popconfirm open={pendingDelete?.resourceId === item.resourceId} title="删除知识资源" description="将删除该资源及其检索索引，所有 RAG 对话都将无法再查询它。" confirmText="删除资源" cancelText="取消" onCancel={function cancel() { setPendingDelete(null); }} onConfirm={function confirm() { void remove(item); }} /></div></li>; })}</ul>}
  </div></main>;
}
