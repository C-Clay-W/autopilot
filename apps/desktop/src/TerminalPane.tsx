// xterm 视图只绑定已有 PTY；可见尺寸合并更新，隐藏页面继续有界消费输出。
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ManagedExecutorIcon, Pane } from "./workspace";
import { ContextMenu } from "./components/ui/context-menu";
import { DropdownMenuItem } from "./components/ui/dropdown-menu";
import { terminalCopyAction, terminalNativePaste } from "./terminal-copy";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { useDesktopNotice } from "./components/ui/notifications";
import { TooltipButton } from "./components/ui/tooltip";
import { Anchor, Bot, Bug, Compass, Feather, Flame, Gem, Leaf, Maximize2, Minimize2, Puzzle, Rocket, RotateCw, Shield, TerminalSquare, X, Zap } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

type TerminalIo = Pick<import("./contract").DesktopBridge, "readTerminal" | "writeTerminal" | "resizeTerminal" | "prepareTerminalResize">;
export type ManagedTerminalActivity = "running" | "waiting" | "answering" | "unknown" | { label: string };
const executorIcons = { rocket: Rocket, bot: Bot, compass: Compass, feather: Feather, flame: Flame, gem: Gem, leaf: Leaf, puzzle: Puzzle, shield: Shield, zap: Zap, anchor: Anchor, bug: Bug } satisfies Record<ManagedExecutorIcon, typeof Rocket>;
const brandLogo: string = require("./assets/agent-light.svg");
const brandDarkLogo: string = require("./assets/agent-dark.svg");
const activityLabels: Record<Extract<ManagedTerminalActivity, string>, string> = { running: "● 运行中", waiting: "等待审批", answering: "等待回答", unknown: "状态待核查" };
interface Props { io?: TerminalIo; managedRole?: "主控" | "执行者"; executorIcon?: ManagedExecutorIcon; managedActivity?: ManagedTerminalActivity; pane: Pane; focused: boolean; highlighted: boolean; visible: boolean; resizing: boolean; onFocus(): void; onClose(): void; onExpand(): void; onRetry(): void; expanded: boolean }

/** 单窗格持有 xterm 生命周期，所有异步 IO 都捕获固定代次。 */
export function TerminalPane({ io, managedRole, executorIcon, managedActivity, pane, focused, highlighted, visible, resizing, onFocus, onClose, onExpand, onRetry, expanded }: Props) {
  const ExecutorIcon = executorIcons[executorIcon ?? "bot"];
  const activity = managedRole && pane.process === "shell" ? managedActivity : undefined;
  const running = activity === "running";
  const terminalIo = io ?? window.autopilotDesktop;
  const container = useRef<HTMLDivElement>(null);
  const fitHeld = useRef(resizing);
  fitHeld.current = resizing;
  const terminal = useRef<Terminal | null>(null);
  const apRunning = useRef(false);
  apRunning.current = pane.agent === "ap";
  const openCodeRunning = useRef(false);
  // Shell 中手动启动的 OpenCode 也采用原生复制；观察状态更新不重建 xterm。
  openCodeRunning.current = pane.agent === "opencode" || Boolean(pane.agents?.some(function activeOpenCode(agent) { return agent.agent === "opencode" && !agent.exited; }));
  const fitNow = useRef<(() => void) | null>(null);
  const [error, setError] = useState("");
  useDesktopNotice(`终端 ${pane.number} 出错`, pane.error || error);

  /** 本地选区优先；AP/OpenCode 备用屏通过标准按键请求内部复制，不接收 OSC 剪贴板写入。 */
  function copyTerminal() {
    const view = terminal.current;
    const text = view?.getSelection();
    if (text) void window.autopilotDesktop.copyTerminalText(text).then(function copied(res) { console.log(res); setError(""); }).catch(function copyFailed() { setError("复制失败，请检查系统剪贴板后重试。"); });
    else if (view?.buffer.active.type === "alternate" && (pane.agent === "ap" || openCodeRunning.current)) {
      void terminalIo.writeTerminal(pane.id, pane.generation, "\u001b[99;6u").catch(function copyFailed() { setError("复制请求失败，请检查终端连接后重试。"); });
    } else setError("请先选择要复制的终端文字；CLI 鼠标模式下可按住 Shift 划选。");
  }

  /** 挂载视图并串行读取输出，write 回调之后再拉取下一批以限制队列。 */
  function connect() {
    if (!container.current || pane.process === "starting" || pane.process === "failed") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let frame = 0;
    let fitTimer: ReturnType<typeof setTimeout>;
    let resizeInFlight = false;
    let needsFit = false;
    let cursor = 0;
    let lastSize = "";
    let readFailures = 0;
    let resizeFailures = 0;
    let inputQueue = Promise.resolve();
    setError("");
    const tokens = getComputedStyle(document.documentElement);
    // shortcut: xterm 6 的 windowsMode 兼容项让 ConPTY 独占屏幕重排，升级 xterm 时复验此分支。
    const windowsOptions = navigator.platform.startsWith("Win") ? { windowsPty: { backend: "conpty" as const }, windowsMode: true } : {};
    const view = new Terminal({ ...windowsOptions, cols: 100, rows: 28, fontFamily: '"JetBrains Mono", Consolas, monospace', fontSize: 14, scrollback: 5000, cursorBlink: true, allowProposedApi: false, theme: { background: tokens.getPropertyValue("--desktop-terminal-bg").trim(), foreground: tokens.getPropertyValue("--desktop-terminal-fg").trim(), cursor: tokens.getPropertyValue("--desktop-terminal-fg").trim(), selectionBackground: tokens.getPropertyValue("--desktop-terminal-selection").trim() } });
    view.attachCustomKeyEventHandler(function copyKey(event) {
      if (terminalNativePaste(event, apRunning.current)) return false;
      const alternate = view.buffer.active.type === "alternate";
      const action = terminalCopyAction(event, view.hasSelection(), alternate && pane.agent === "ap", alternate && openCodeRunning.current);
      if (!action) return true;
      if (event.type === "keydown") { event.preventDefault(); copyTerminal(); }
      return false;
    });
    const fit = new FitAddon();
    view.loadAddon(fit);
    terminal.current = view;
    const preparedTokens = new Set<string>();
    const parsedWaiters = new Map<string, { resolve(): void; timer: ReturnType<typeof setTimeout> }>();
    const prepared = view.parser.registerOscHandler(777, function preparedFrame(data) {
      const match = /^autopilot-resize;([a-f0-9-]{36})$/.exec(data);
      if (!match) return false;
      const waiter = parsedWaiters.get(match[1]);
      if (waiter) { clearTimeout(waiter.timer); parsedWaiters.delete(match[1]); waiter.resolve(); }
      else { preparedTokens.add(match[1]); if (preparedTokens.size > 8) preparedTokens.delete(preparedTokens.values().next().value!); }
      return true;
    });
    /** 管道确认只表示已写出；本地解析到帧尾标记后才允许改网格。 */
    function waitPrepared(token: string): Promise<void> {
      if (preparedTokens.delete(token)) return Promise.resolve();
      return new Promise(function wait(resolve, reject) {
        const timer = setTimeout(function expired() { parsedWaiters.delete(token); reject(new Error("DESKTOP_RESIZE_UNAVAILABLE")); }, 1500);
        parsedWaiters.set(token, { resolve, timer });
      });
    }
    /** 等容器停止变化后测量最新目标；同一窗格只允许一次 PTY 尺寸提交在途。 */
    function requestFit() {
      clearTimeout(fitTimer);
      cancelAnimationFrame(frame);
      if (disposed || fitHeld.current) return;
      // 连续宽高变化不向 ConPTY 发送中间网格，避免旧帧尚未重绘就再次重排。
      fitTimer = setTimeout(scheduleFit, lastSize ? 200 : 0);
    }
    /** 稳定后才同步本地网格和 PTY，等待旧提交时重新合并最新容器尺寸。 */
    function scheduleFit() {
      frame = requestAnimationFrame(async function resize() {
        frame = 0;
        if (disposed || fitHeld.current || !container.current) return;
        if (resizeInFlight) { requestFit(); return; }
        const measurable = container.current.getClientRects().length && container.current.clientWidth >= 20 && container.current.clientHeight >= 20;
        // xterm 的公开同尺寸 resize 会补测初次在隐藏容器中无效的字符尺寸。
        if (measurable) view.resize(view.cols, view.rows);
        const dimensions = measurable ? fit.proposeDimensions() : lastSize ? undefined : { cols: view.cols, rows: view.rows };
        if (!dimensions || dimensions.cols < 2 || dimensions.rows < 1) return;
        const size = `${dimensions.cols}/${dimensions.rows}`;
        if (lastSize === size && !needsFit || pane.process === "exited") return;
        resizeInFlight = true;
        try {
          const token = await terminalIo.prepareTerminalResize(pane.id, pane.generation, dimensions.cols, dimensions.rows);
          if (disposed) return;
          if (token) await waitPrepared(token);
          if (disposed) return;
          const latest = measurable ? fit.proposeDimensions() : dimensions;
          if (fitHeld.current || !latest || latest.cols !== dimensions.cols || latest.rows !== dimensions.rows) {
            needsFit = true;
            requestFit();
            return;
          }
          if (measurable) fit.fit();
          await terminalIo.resizeTerminal(pane.id, pane.generation, dimensions.cols, dimensions.rows);
          if (!disposed) lastSize = size;
          if (resizeFailures) setError(function recovered(current) { return current.startsWith("终端尺寸同步失败") ? "" : current; });
          resizeFailures = 0;
          needsFit = false;
        } catch (error) { reportIoError("尺寸同步", error); if (++resizeFailures <= 2) requestFit(); }
        finally { resizeInFlight = false; }
      });
    }
    /** IO 失败保留当前画面，并提供固定提示。 */
    function reportIoError(operation: string, cause?: unknown) {
      const code = /\b(?:MANAGED_TERMINAL_(?:STALE|EXITED)|DESKTOP_(?:IPC_DENIED|RESIZE_UNAVAILABLE))\b/.exec(cause instanceof Error ? cause.message : "")?.[0];
      if (!disposed) setError(`终端${operation}失败${code ? `（${code}）` : ""}，请重连终端核查；输入不会自动重发。`);
    }
    /** 每次读取最多一个输出批次，缺口重置解析器并明确提示。 */
    async function consume() {
      try {
        const output = await terminalIo.readTerminal(pane.id, pane.generation, cursor);
        if (disposed) return;
        if (readFailures) setError(function recovered(current) { return current.startsWith("终端读取失败") ? "" : current; });
        readFailures = 0;
        cursor = output.cursor;
        if (output.gap) view.reset();
        const data = (output.gap ? "\r\n[输出超出恢复上限，较早画面已省略]\r\n" : "") + output.data;
        if (data) view.write(data, function consumed() { if (!disposed) timer = setTimeout(consume, 0); });
        else timer = setTimeout(consume, 100);
      } catch (error) { reportIoError("读取", error); if (!disposed && ++readFailures <= 2) timer = setTimeout(consume, 250); }
    }
    const input = view.onData(function sendInput(data) {
      // 粘贴按同一串行队列分批，单个 IPC 载荷保持有界。
      for (let offset = 0; offset < data.length; offset += 65536) {
        const chunk = data.slice(offset, offset + 65536);
        inputQueue = inputQueue.then(function sendChunk() {
          if (!disposed) return terminalIo.writeTerminal(pane.id, pane.generation, chunk);
        }).catch(function inputFailed(error) { reportIoError("输入", error); });
      }
    });
    const observer = new ResizeObserver(requestFit);
    // open 时即使用最终字符度量；隐藏 pane 用初始网格启动，显示后再 fit。
    void document.fonts.load('14px "JetBrains Mono"').then(function openWithFont() {
      if (disposed || !container.current) return;
      view.open(container.current);
      observer.observe(container.current);
      fitNow.current = requestFit;
      requestFit();
      if (focused && container.current.getClientRects().length) view.focus();
    }).catch(function fontFailed(error) { reportIoError("字体初始化", error); });
    void consume();
    /** 卸载只清理视图与订阅，不停止主进程 PTY。 */
    return function disconnect() {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(fitTimer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      prepared.dispose();
      for (const waiter of parsedWaiters.values()) { clearTimeout(waiter.timer); waiter.resolve(); }
      input.dispose();
      view.dispose();
      terminal.current = null;
      fitNow.current = null;
    };
  }
  useEffect(connect, [pane.id, pane.generation, pane.process]);

  /** 导航或总台定位恢复焦点，绝不向终端注入输入。 */
  function focusTerminal() {
    if (visible && !resizing) {
      fitNow.current?.();
      if (focused) terminal.current?.focus();
    }
  }
  useEffect(focusTerminal, [focused, visible, resizing]);

  return <div className="h-full min-h-0 min-w-0 [&>div]:h-full"><ContextMenu label={`终端 ${pane.number} 菜单`} items={<DropdownMenuItem onSelect={copyTerminal}>复制所选文字</DropdownMenuItem>}><section className={`flex h-full ${io ? "min-h-0" : "min-h-64"} min-w-0 flex-col overflow-hidden rounded-md border ${highlighted ? "border-accent ring-2 ring-accent" : focused ? "border-accent" : "border-border"}`} data-desktop-pane-id={pane.id} aria-label={`终端 ${pane.number}`} onFocus={onFocus}>
    <header className={`flex min-h-10 items-center gap-1 border-b border-border px-1 text-sm ${running ? "bg-selected" : "bg-surface"}`}>
      <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start px-2 text-ink" onClick={onFocus}>{managedRole === "主控" ? <><img src={brandLogo} alt="" aria-hidden="true" className="size-4 shrink-0 [:root[data-theme=light]_&]:hidden" /><img src={brandDarkLogo} alt="" aria-hidden="true" className="hidden size-4 shrink-0 [:root[data-theme=light]_&]:block" /></> : managedRole ? <ExecutorIcon aria-hidden="true" /> : <TerminalSquare />}<span className="truncate">{managedRole === "主控" ? "AP主控" : managedRole ?? `终端 ${pane.number}`}</span></Button>
      {(!managedRole || pane.process !== "shell" || activity) && <Badge role={managedRole ? "status" : undefined} variant={pane.process === "failed" ? "error" : running ? "accent" : "outline"} className="max-[600px]:max-w-24 max-[600px]:truncate">{pane.process === "shell" ? activity ? typeof activity === "string" ? activityLabels[activity] : activity.label : "Shell 已启动" : pane.process === "starting" ? "正在启动" : pane.process === "failed" ? "启动失败" : "Shell 已退出"}</Badge>}
      {io ? <TooltipButton label={`重新连接${managedRole ?? ""}终端`} onClick={onRetry}><RotateCw /></TooltipButton> : <><TooltipButton label={expanded ? "还原窗格" : "放大窗格"} onClick={onExpand}>{expanded ? <Minimize2 /> : <Maximize2 />}</TooltipButton>
      <TooltipButton variant="destructive" label={`关闭终端 ${pane.number}`} onClick={onClose}><X /></TooltipButton></>}
    </header>
    {(pane.process === "failed" || pane.process === "exited") && <Button variant="outline" className="m-4 self-start" onClick={onRetry}><RotateCw />{pane.process === "exited" ? "重新创建终端" : "重试此终端"}</Button>}
    {error && <p role="alert" className="shrink-0 px-2 text-xs text-error">{error}</p>}
    <div ref={container} className={`min-h-0 min-w-0 flex-1 p-1 ${io ? "overflow-clip" : "overflow-hidden"}`} />
  </section></ContextMenu></div>;
}
