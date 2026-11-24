// 工作区右侧浏览器面板只发送固定动作，原生网页矩形避开 React 弹层与输入法组字。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Copy, Globe, Plus, RefreshCw, X, Square, Hand } from "lucide-react";
import type { BrowserCommand, BrowserSnapshot } from "./browser-contract";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { useDesktopNotice } from "./components/ui/notifications";
import { notifyDesktop } from "./desktop-notifications";
import { TooltipButton } from "./components/ui/tooltip";
import { BrowserApprovalCard } from "./BrowserApprovalCard";
import { LayoutDivider } from "./LayoutView";

const empty: BrowserSnapshot = { pages: [], active: null, expanded: false, downloads: [], history: [] };
interface Props { workspaceId: string; visible: boolean; ratio: number; onRatio(ratio: number): void; onResizing(active: boolean): void }

/** 工作区切换重置观察，原生网页实例与开关状态仍由主进程保留。 */
export function BrowserPane({ workspaceId, visible, ratio, onRatio, onResizing }: Props) {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>(empty);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState("");
  const panel = useRef<HTMLElement | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const focusedAddress = useRef(false);
  const lastAddress = useRef("");
  const current = snapshot.pages.find(function active(page) { return page.id === snapshot.active; });
  const approvals = snapshot.approvals ?? [];
  const pageErrors = useRef(new Map<string, string | undefined>());
  const downloadStates = useRef(new Map<string, string>());
  useDesktopNotice("浏览器操作失败", error);
  useDesktopNotice("浏览器提示", snapshot.notice, "info");
  /** 保留拖动中的宽度，快照刷新只更新浏览器内容。 */
  const bindPanel = useCallback(function bindPanel(element: HTMLElement | null) {
    panel.current = element;
    element?.style.setProperty("--pane-basis", `${ratio * 100}%`);
  }, [ratio]);
  /** 手势只预览浏览器的 CSS 宽度。 */
  function preview(value: number) { panel.current?.style.setProperty("--pane-basis", `${value * 100}%`); }
  /** 跨页面报告新错误，下载只在终态变化时通知一次。 */
  function reportChanges() {
    const errors = new Map<string, string | undefined>();
    for (const page of snapshot.pages) {
      if (page.error && pageErrors.current.get(page.id) !== page.error) notifyDesktop("网页加载失败", page.error, "error");
      errors.set(page.id, page.error);
    }
    pageErrors.current = errors;
    for (const download of snapshot.downloads) {
      if (downloadStates.current.get(download.id) !== download.state) {
        if (download.state === "completed") notifyDesktop("下载已完成", download.name, "success");
        if (download.state === "interrupted") notifyDesktop("下载失败", download.name, "error");
        downloadStates.current.set(download.id, download.state);
      }
    }
  }
  useEffect(reportChanges, [snapshot]);

  /** 只接收宿主事实；一次最多一个快照请求，卸载停止轮询。 */
  function observe() {
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    /** 快照中的 URL 变化不覆盖用户正在编辑的地址。 */
    async function poll() {
      try {
        const res = await window.autopilotDesktop.browser.snapshot(workspaceId);
        console.log(res);
        if (!stopped) {
          setSnapshot(res);
          const page = res.pages.find(function active(page) { return page.id === res.active; });
          const key = `${page?.id}:${page?.url}`;
          if (key !== lastAddress.current && !focusedAddress.current) { lastAddress.current = key; setAddress(page?.url ?? ""); }
        }
      } catch { if (!stopped) setError("浏览器连接不可用，请稍后重试。"); }
      if (!stopped) timer = setTimeout(poll, 300);
    }
    void poll();
    /** React 热刷新只隐藏 View，不关闭网页或终端。 */
    return function dispose() { stopped = true; clearTimeout(timer); void window.autopilotDesktop.browser.bounds({ x: 0, y: 0, width: 0, height: 0, hidden: true }, workspaceId).catch(function ignore() {}); };
  }
  useEffect(observe, []);

  /** 所有业务动作有固定失败反馈，不自动重试写操作。 */
  async function command(value: BrowserCommand) {
    setError("");
    try { const res = await window.autopilotDesktop.browser.command(value, workspaceId); console.log(res); }
    catch (reason) { notifyDesktop("浏览器操作失败", reason instanceof Error ? reason.message : "浏览器操作失败。", "error"); }
  }
  /** 新建默认空白入口，地址输入明确后才加载网站。 */
  function navigate(newPage = false) {
    const value = address.trim(); if (!value) return;
    const url = /^https?:\/\//i.test(value) ? value : `http://${value}`;
    void command(current && !newPage ? { type: "navigate", pageId: current.id, url } : { type: "open", url });
  }
  /** 测量工具栏下方的内容矩形，弹层开启时立即隐藏原生 View。 */
  function observeBounds() {
    let disposed = false; let pending = false; let changed = false;
    let lastBounds = "";
    /** 原生矩形使用 CSS 像素，与 Electron content bounds 相同坐标空间。 */
    async function measure() {
      if (disposed) return;
      if (pending) { changed = true; return; }
      const rect = viewport.current?.getBoundingClientRect();
      const hidden = !rect || rect.width < 1 || rect.height < 1 || composing.current || Boolean(document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]'));
      const bounds = { x: Math.max(0, Math.ceil(rect?.x ?? 0)), y: Math.max(0, Math.ceil(rect?.y ?? 0)), width: Math.max(0, Math.floor(rect?.width ?? 0)), height: Math.max(0, Math.floor(rect?.height ?? 0)), hidden };
      const key = JSON.stringify(bounds); if (key === lastBounds) return;
      pending = true;
      try { const res = await window.autopilotDesktop.browser.bounds(bounds, workspaceId); console.log(res); if (!disposed) lastBounds = key; }
      catch { if (!disposed) setError("浏览器布局更新失败。"); }
      finally { pending = false; if (changed) { changed = false; void measure(); } }
    }
    /** 组字期间不让后台网页干扰当前输入焦点。 */
    function composingStart() { composing.current = true; void measure(); }
    /** 组字结束后重新测量实际可见区域。 */
    function composingEnd() { composing.current = false; void measure(); }
    const resize = new ResizeObserver(function resize() { void measure(); });
    if (viewport.current) resize.observe(viewport.current);
    const mutations = new MutationObserver(function changed() { void measure(); });
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state", "role"] });
    window.addEventListener("resize", measure); document.addEventListener("compositionstart", composingStart, true); document.addEventListener("compositionend", composingEnd, true);
    void measure();
    /** 释放观察器，保留原生页面身份。 */
    return function dispose() { disposed = true; resize.disconnect(); mutations.disconnect(); window.removeEventListener("resize", measure); document.removeEventListener("compositionstart", composingStart, true); document.removeEventListener("compositionend", composingEnd, true); };
  }
  useLayoutEffect(observeBounds, [visible, snapshot.expanded, snapshot.active, Boolean(current?.dialog)]);

  const browser = visible && <aside ref={bindPanel} className={`flex min-w-0 shrink-0 flex-col bg-surface ${snapshot.expanded ? "basis-(--pane-basis)" : "w-12 border-l border-border"}`} aria-label="内置浏览器">
    {approvals.length > 0 && <span role="status" className="px-2 py-1 text-xs text-accent motion-safe:animate-pulse">待确认 {approvals.length}</span>}
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2"><TooltipButton label={snapshot.expanded ? "收起浏览器" : "展开浏览器"} onClick={function toggle() { void command({ type: "expand", expanded: !snapshot.expanded }); }}><Globe /></TooltipButton>{snapshot.expanded && <><span className="mr-auto font-semibold">浏览器</span><TooltipButton label="在新网页打开地址" onClick={function open() { navigate(true); }}><Plus /></TooltipButton></>}</div>
    {snapshot.expanded && <>
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2" aria-label="浏览器标签">
        {snapshot.pages.map(function tab(page) {
          const title = page.title || "新网页";
          return <div key={page.id} className={`flex max-w-56 shrink-0 items-center rounded-md ${page.id === snapshot.active ? "bg-selected" : "bg-surface"} ${approvals.some(function waiting(item) { return item.pageId === page.id; }) ? "ring-1 ring-accent motion-safe:animate-pulse" : ""}`}>
            <Button variant="ghost" size="sm" aria-current={page.id === snapshot.active ? "page" : undefined} title={`${title}\n${page.ownerLabel ?? page.owner} · ${page.workspace}`} className="min-w-0 shrink justify-start overflow-hidden" onClick={function select() { void command({ type: "select", pageId: page.id }); }}>
              <span className="block min-w-0 overflow-hidden pr-3 mask-[linear-gradient(to_right,#000_calc(100%_-_0.75rem),transparent)]">{title}</span>
            </Button>
            <TooltipButton label={`关闭网页 ${title}`} onClick={function close() { void command({ type: "close", pageId: page.id }); }}><X /></TooltipButton>
          </div>;
        })}
      </nav>
      <form className="flex shrink-0 items-center gap-1 border-b border-border p-2" onSubmit={function submit(event) { event.preventDefault(); navigate(); }}>
        <TooltipButton type="button" label="后退" disabled={!current?.back} onClick={function back() { if (current) void command({ type: "back", pageId: current.id }); }}><ArrowLeft /></TooltipButton>
        <TooltipButton type="button" label="前进" disabled={!current?.forward} onClick={function forward() { if (current) void command({ type: "forward", pageId: current.id }); }}><ArrowRight /></TooltipButton>
        <TooltipButton type="button" label={current?.loading ? "停止加载" : "刷新网页"} disabled={!current} onClick={function reload() { if (current) void command({ type: current.loading ? "stop" : "reload", pageId: current.id }); }}>{current?.loading ? <Square /> : <RefreshCw />}</TooltipButton>
        <Input aria-label="网页地址" value={address} placeholder="输入网址或 localhost 地址" className="min-w-0 flex-1" onFocus={function focus() { focusedAddress.current = true; }} onBlur={function blur() { focusedAddress.current = false; }} onChange={function change(event) { setAddress(event.target.value); }} />
        <TooltipButton type="button" label="复制链接" disabled={!current} onClick={function copy() { if (current) void command({ type: "copy", pageId: current.id }); }}><Copy /></TooltipButton>
      </form>
      {current && <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted"><span className="min-w-0 flex-1 truncate">{current.owner === "manual" ? "手动浏览" : current.ownerLabel ?? current.owner} · {current.workspace}{current.occupied ? " · 智能体占用中" : ""}</span><Button size="sm" variant="ghost" onClick={function takeover() { void command({ type: current.paused ? "resume" : "takeover", pageId: current.id }); }}><Hand />{current.paused ? "允许自动操作" : "手动接管"}</Button></div>}
      <div ref={viewport} className="relative min-h-0 flex-1 overflow-auto bg-bg">
        {!current && <div className="space-y-3 p-5"><p className="text-muted">输入网址后按 Enter。关闭 Desktop 后不会恢复网页或登录状态。</p>{snapshot.history.map(function history(item) { return <Button key={item.url} variant="ghost" className="h-auto w-full justify-start text-left" onClick={function open() { void command({ type: "open", url: item.url }); }}><span className="min-w-0"><span className="block truncate">{item.title}</span><span className="block truncate text-xs text-muted">{item.url}</span></span></Button>; })}</div>}
        {current?.dialog && <div className="space-y-4 p-5"><p className="text-xs text-muted break-all">{current.url}</p><p className="whitespace-pre-wrap break-words">{current.dialog.message}</p>{current.dialog.type === "prompt" && <Input aria-label="网页问题回答" value={prompt} placeholder={current.dialog.defaultValue} onChange={function answer(event) { setPrompt(event.target.value); }} />}<div className="flex gap-2"><Button variant="outline" onClick={function reject() { void command({ type: "dialog", pageId: current.id, accept: false, text: "" }); }}>取消</Button><Button onClick={function accept() { void command({ type: "dialog", pageId: current.id, accept: true, text: prompt || current.dialog?.defaultValue || "" }); setPrompt(""); }}>确定</Button></div></div>}
      </div>
      {snapshot.downloads.length > 0 && <div className="max-h-40 shrink-0 space-y-2 overflow-auto border-t border-border p-3 text-xs" aria-label="下载">{snapshot.downloads.map(function download(item) { return <div key={item.id} className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate">{item.name} · {item.state === "completed" ? "已完成" : item.state === "cancelled" ? "已取消" : item.state === "interrupted" ? "下载失败" : `${Math.round(item.received / 1024)} / ${Math.round(item.total / 1024)} KB`}</span>{item.state === "progressing" && <Button size="sm" variant="ghost" onClick={function cancel() { void command({ type: "cancel-download", id: item.id }); }}>取消</Button>}</div>; })}</div>}
    </>}
  </aside>;
  return <>
    {approvals.map(function approval(request) { return <BrowserApprovalCard key={request.id} request={request} />; })}
    {visible && snapshot.expanded && <LayoutDivider row fromEnd ratio={ratio} min={0.35} max={0.65} label="调整浏览器宽度" onPreview={preview} onRatio={onRatio} onResizing={onResizing} />}
    {browser}
  </>;
}
