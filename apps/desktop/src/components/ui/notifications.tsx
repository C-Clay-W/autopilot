// Desktop 全局右下角通知浮层复用主题与按钮，最新消息排列在最下方。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { displayNotification, notificationInteraction, setNotificationPause, disposeNotificationTimers } from "../../notification-timers";
import { notificationsAt } from "../../notification-layout";
import type { NotificationPosition, UiPreferences } from "../../ui-preferences";
import { X } from "lucide-react";
import { Button } from "./button";
import { notificationSnapshot, notifyDesktop, putNotification, removeNotification, subscribeNotifications, type DesktopNotification } from "../../desktop-notifications";

/** 状态提示只在文字变化时投递，轮询不会复活已关闭的提示。 */
export function useDesktopNotice(title: string, message?: string, tone: DesktopNotification["tone"] = "error"): void {
  /** 仅有实际消息时写入通知队列。 */
  function publish() { if (message) notifyDesktop(title, message, tone); }
  useEffect(publish, [title, message, tone]);
}

/** 受控确认随宿主请求存在，关闭交给原审批通道处理。 */
export function DesktopConfirmation({ id, ...notification }: DesktopNotification) {
  /** 内容变化只更新同一卡片，不更改其到达顺序。 */
  function update() { putNotification({ id, ...notification }); }
  useEffect(update, [id, notification.title, notification.content, notification.onDismiss, notification.busy, notification.group, notification.lifecycle]);
  /** 请求撤销或回答完成后移除对应卡片。 */
  function observeLifetime() { return function dispose() { removeNotification(id); }; }
  useEffect(observeLifetime, [id]);
  return null;
}

/** Portal 进入同源通知子窗口，在原生网页上方显示且保留原 React 回调。 */
export function DesktopNotifications({ ui }: { ui: UiPreferences }) {
  const notifications = useSyncExternalStore(subscribeNotifications, notificationSnapshot);
  /** 交互开关更新只改变余额运行状态，不重新创建卡片时长。 */
  function updatePause() { setNotificationPause(ui.pauseOnHover); }
  useEffect(updatePause, [ui.pauseOnHover]);
  /** 整个工作台卸载后不留通知计时器。 */
  function timerLifetime() { return disposeNotificationTimers; }
  useEffect(timerLifetime, []);
  return <>{(["center", "bottom-right"] as const).map(function position(position) { return <NotificationWindow key={position} position={position} duration={ui.duration} notifications={notificationsAt(notifications, ui, position)} />; })}</>;
}

/** 每个实际位置只开一个窗口，同位置队列继续按到达顺序显示。 */
function NotificationWindow({ position, notifications, duration }: { position: NotificationPosition; notifications: DesktopNotification[]; duration: UiPreferences["duration"] }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const visible = notifications.length > 0;
  const order = notifications.map(function identity(item) { return item.id; }).join(",");
  /** 只在通知存在时创建浮层，并同步现有主题，避免维护第二套卡片实现。 */
  function openWindow() {
    if (!visible) return;
    const popup = window.open("about:blank", `desktop-notifications-${position}`, "popup,width=400,height=1");
    if (!popup) { console.error("Desktop notification window unavailable"); return; }
    const target = popup.document;
    target.documentElement.lang = document.documentElement.lang;
    target.body.className = "desktop-notifications-window";
    target.title = "Desktop 通知";
    /** 同步打包与开发期样式，资源链接使用主页面的绝对地址。 */
    function copyStyles() {
      target.head.querySelectorAll("style, link[rel=stylesheet]").forEach(function remove(node) { node.remove(); });
      document.head.querySelectorAll("style, link[rel=stylesheet]").forEach(function appendStyle(node) {
        const copy = node.cloneNode(true) as HTMLElement;
        if (node instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = node.href;
        target.head.appendChild(copy);
      });
    }
    /** 根主题属性和 stylesheet 分开同步，Portal 不保留旧主题。 */
    function copyTheme() { target.documentElement.dataset.theme = document.documentElement.dataset.theme; }
    copyTheme();
    const theme = new MutationObserver(copyTheme);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    copyStyles();
    const styles = new MutationObserver(copyStyles);
    styles.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
    setContainer(target.body);
    /** 队列清空或主视图卸载时回收附属窗口。 */
    return function dispose() { styles.disconnect(); theme.disconnect(); setContainer(null); popup.close(); };
  }
  useEffect(openWindow, [visible]);
  /** 仅向宿主提交卡片高度，窗口位置与可用范围由主进程决定。 */
  function observeSize() {
    if (!container || !viewport.current) return;
    const element = viewport.current;
    let stopped = false;
    /** 只给实际进入可视滚动范围的普通卡片起钟，排队和不可见卡片不消耗时长。 */
    function markVisible() {
      const visibleBounds = element.getBoundingClientRect();
      element.querySelectorAll<HTMLElement>("[data-notification-id]").forEach(function inspectCard(card) {
        const bounds = card.getBoundingClientRect();
        if (bounds.height > 0 && bounds.bottom > visibleBounds.top && bounds.top < visibleBounds.bottom) {
          displayNotification(card.dataset.notificationId!, duration);
          notificationInteraction(card.dataset.notificationId!, "hovered", card.matches(":hover"));
          notificationInteraction(card.dataset.notificationId!, "focused", card.contains(card.ownerDocument.activeElement));
        }
      });
    }
    /** 内容增加与主窗口缩放共用同一有界尺寸更新。 */
    async function resize() {
      const height = Math.max(1, Math.min(32768, element.scrollHeight, window.innerHeight - 16));
      try { const res = await window.autopilotDesktop.setNotificationHeight(position, Math.ceil(height)); console.log(res); if (res && !stopped) markVisible(); }
      catch (error) { console.error("Desktop notification layout failed", error); }
    }
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener("resize", resize);
    element.addEventListener("scroll", resize);
    const unsubscribe = window.autopilotDesktop.onAppearance(resize);
    resize();
    /** 内容变化重新测量，保留已有滚动位置。 */
    return function dispose() { stopped = true; observer.disconnect(); window.removeEventListener("resize", resize); element.removeEventListener("scroll", resize); unsubscribe(); };
  }
  useEffect(observeSize, [container, notifications, duration]);
  /** 新消息到达时保持队尾可见，内容更新不抢滚动位置。 */
  function revealLatest() { if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }
  useEffect(revealLatest, [order, container]);
  if (!visible || !container) return null;
  return createPortal(<div ref={viewport} data-desktop-notifications className="flex max-h-screen w-full flex-col gap-3 overflow-y-auto p-2 font-sans text-sm text-ink" aria-label="Desktop 通知">
    {notifications.map(function card(item) { return <NotificationCard key={item.id} item={item} />; })}
  </div>, container);
}

/** 卡片 DOM 可随位置移动，业务身份与计时余额独立保留。 */
function NotificationCard({ item }: { item: DesktopNotification }) {
  /** 移位或卸载时清除旧窗口交互状态，不重建计时余额。 */
  function interactionLifetime() { return function dispose() { notificationInteraction(item.id, "hovered", false); notificationInteraction(item.id, "focused", false); }; }
  useEffect(interactionLifetime, [item.id]);
      /** 确认卡由宿主决定何时消失，普通通知立即关闭。 */
      function dismiss() { if (item.onDismiss) item.onDismiss(); else removeNotification(item.id); }
      return <section data-notification-id={item.id} role={item.lifecycle === "user" ? "dialog" : item.tone === "error" ? "alert" : "status"} aria-label={item.title} onMouseEnter={function enter() { notificationInteraction(item.id, "hovered", true); }} onMouseLeave={function leave() { notificationInteraction(item.id, "hovered", false); }} onFocus={function focus() { notificationInteraction(item.id, "focused", true); }} onBlur={function blur(event) { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) notificationInteraction(item.id, "focused", false); }} aria-busy={item.busy || undefined} className="relative shrink-0 rounded-lg border border-input-border bg-surface p-4 shadow-md" onKeyDown={function escape(event) { if (event.key === "Escape" && !event.nativeEvent.isComposing && !item.busy) { event.stopPropagation(); dismiss(); } }}>
        <div className="mb-3 flex items-start justify-between gap-3"><h2 className={`font-semibold ${item.tone === "error" ? "text-error" : item.tone === "success" ? "text-success" : "text-ink"}`}>{item.title}</h2><Button variant="ghost" size="icon" className="-mr-1 -mt-1 shrink-0" aria-label={`关闭${item.title}`} disabled={item.busy} onClick={dismiss}><X /></Button></div>
        {item.message && <p className="whitespace-pre-wrap break-words text-sm text-muted">{item.message}</p>}
        {item.content}
      </section>;
}
