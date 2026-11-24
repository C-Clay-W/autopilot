// 浏览器审批展示宿主冻结的动作和范围，任何取消都明确拒绝请求。
import { useRef, useState } from "react";
import type { BrowserApproval } from "./browser-access";
import { Button } from "./components/ui/button";
import { DesktopConfirmation } from "./components/ui/notifications";

const labels: Record<string, string> = { list: "查看标签列表", open: "打开网页", document: "打开本地文档", navigate: "跳转网页", select: "切换网页", close: "关闭网页", release: "释放页面占用", back: "后退", forward: "前进", reload: "刷新", snapshot: "读取页面", screenshot: "截取页面", click: "点击元素", fill: "填写内容", press: "按键", scroll: "滚动", "select-option": "选择选项", check: "更改勾选", dialog: "回答网页对话框", wait: "等待网页加载", downloads: "查看下载", "cancel-download": "取消下载" };

/** 同一请求只提交一次答案，宿主仍负责迟到与撤销检查。 */
export function BrowserApprovalCard({ request }: { request: BrowserApproval }) {
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 固定回答接口不允许修改审批中的动作参数。 */
  async function answer(choice: "once" | "always" | "deny") {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { const res = await window.autopilotDesktop.browser.answerApproval(request.id, choice); console.log(res); }
    catch { setError("请求已失效或提交失败，请查看最新状态。"); busyRef.current = false; setBusy(false); }
  }
  const content = <div className="space-y-3"><p className="text-xs text-muted">{request.caller} · {request.workspace}</p><p className="font-semibold">{labels[request.operation] ?? request.operation}</p><p className="break-all text-xs">{request.target}</p>{request.value && <p className="break-all text-sm">{request.value}</p>}<p className="text-xs text-muted">{request.singleUse ? "仅批准这一次操作。" : "仅本次批准一个动作。本回合允许同一智能体继续操作，回合结束后失效。"}</p>{error && <p role="alert" className="text-xs text-error">{error}</p>}<div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={function deny() { void answer("deny"); }}>拒绝</Button><Button variant={request.defaultChoice === "once" ? "default" : "outline"} disabled={busy} onClick={function once() { void answer("once"); }}>仅本次</Button>{!request.singleUse && <Button variant={request.defaultChoice === "always" ? "default" : "outline"} disabled={busy} onClick={function always() { void answer("always"); }}>本回合允许</Button>}</div></div>;
  return <DesktopConfirmation group="notification" lifecycle="user" id={`browser-approval:${request.id}`} title="浏览器操作待确认" busy={busy} onDismiss={function deny() { void answer("deny"); }} content={content} />;
}
