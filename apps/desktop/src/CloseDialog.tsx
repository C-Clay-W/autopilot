// 所有关闭入口共用全局通知确认卡，回答通道独立于等待确认的工作台命令队列。
import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { CloseConfirmation } from "./contract";
import { DesktopConfirmation } from "./components/ui/notifications";
import { Button } from "./components/ui/button";

/** 只展示宿主请求，默认聚焦取消并在结束后恢复原焦点。 */
export function CloseDialog() {
  const [request, setRequest] = useState<CloseConfirmation | null>(null);
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState("");
  const previousFocus = useRef<HTMLElement | null>(null);
  const answeringId = useRef<string | null>(null);
  const shownId = useRef<string | null>(null);
  const answerVersion = useRef(0);
  const closing = answering || request?.phase === "closing";

  /** 单一串行轮询读取宿主确认/关闭阶段，卸载停止更新。 */
  function observe() {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    /** 回答期间跳过迟到快照，避免重复启用确认按钮。 */
    async function poll() {
      const version = answerVersion.current;
      try {
        const next = await window.autopilotDesktop.getCloseConfirmation();
        if (!stopped && version === answerVersion.current && !answeringId.current) {
          if (next?.id !== shownId.current) {
            if (next) previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            shownId.current = next?.id ?? null;
            setError("");
          }
          setRequest(next);
        }
      } catch { /* 桥接错误由工作台连接提示处理，未决确认仍可重试回答。 */ }
      if (!stopped) timer = setTimeout(poll, 150);
    }
    void poll();
    /** 释放页面轮询，宿主导航/崩溃事件负责取消未决确认。 */
    return function dispose() { stopped = true; clearTimeout(timer); };
  }
  useEffect(observe, []);

  /** 同步身份锁阻止连击，主进程仍校验身份与阶段并决定实际范围。 */
  async function answer(confirmed: boolean) {
    if (!request || closing || answeringId.current) return;
    answeringId.current = request.id;
    answerVersion.current++;
    setAnswering(true);
    try {
      const res = await window.autopilotDesktop.answerCloseConfirmation(request.id, confirmed);
      console.log(res);
      if (res) setRequest(confirmed ? { ...request, phase: "closing" } : null);
    } catch { setError("关闭确认提交失败，请重试。"); }
    finally { answeringId.current = null; setAnswering(false); }
  }

  /** 确认消失后返回发起操作前的焦点，卡片本身使用全局通知布局。 */
  function restoreFocus() {
    if (!request && previousFocus.current?.isConnected) { previousFocus.current.focus(); previousFocus.current = null; }
  }
  useEffect(restoreFocus, [request?.id]);
  if (!request) return null;
  return <DesktopConfirmation group="confirmation" lifecycle="user" id={`close:${request.id}`} title={request.message} busy={closing} onDismiss={function dismiss() { void answer(false); }} content={<>
    <p className="text-sm leading-6 text-muted">{request.detail}</p>
    {error && <p role="alert" className="mt-3 text-sm text-error">{error}</p>}
    <div className="mt-6 flex justify-end gap-2">
      <Button autoFocus variant="outline" disabled={closing} onClick={function dismiss() { void answer(false); }}>取消</Button>
      <Button disabled={closing} onClick={function confirm() { void answer(true); }}>{closing ? <><LoaderCircle className="motion-safe:animate-spin" />正在关闭…</> : request.confirmLabel ?? "结束全部并关闭"}</Button>
    </div>
  </>} />;
}
