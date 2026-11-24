// 浏览器独立设置分类复用固定 preload 方法与已有界面组件。
import { useEffect, useState } from "react";
import type { BrowserPreferences, BrowserIntegrationStatus, BrowserSkillStatus } from "./browser-contract";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { notifyDesktop } from "./desktop-notifications";
import { Checkbox } from "./components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";

/** 偏好保存完成后刷新事实，失败保留上次选择并给出提示。 */
export function BrowserSettings() {
  const [value, setValue] = useState<BrowserPreferences>();
  const [integration, setIntegration] = useState<BrowserIntegrationStatus>();
  const [busy, setBusy] = useState(false);
  /** 挂载读取现有偏好，卸载后不更新组件。 */
  function observe() {
    let disposed = false;
    /** 固定 IPC 只返回偏好，不读取网页私密数据。 */
    async function read() {
      try { const res = await window.autopilotDesktop.browser.settings(); console.log(res); if (!disposed) setValue(res); }
      catch { if (!disposed) notifyDesktop("浏览器设置失败", "浏览器设置读取失败。", "error"); }
    }
    void read();
    void recheck();
    return function dispose() { disposed = true; };
  }
  useEffect(observe, []);
  /** 操作串行，取消目录选择后仍显示已保存值。 */
  async function change(action: "preferences" | "directory" | "clear", next?: BrowserPreferences) {
    setBusy(true);
    try {
      if (action === "preferences" && next) { const res = await window.autopilotDesktop.browser.preferences(next); console.log(res); }
      if (action === "directory") { const res = await window.autopilotDesktop.browser.chooseDownloadDirectory(); console.log(res); }
      if (action === "clear") { const res = await window.autopilotDesktop.browser.clearHistory(); console.log(res); }
      const res = await window.autopilotDesktop.browser.settings(); console.log(res); setValue(res);
      if (action !== "directory") notifyDesktop("浏览器设置", action === "clear" ? "浏览历史已清空。" : "设置已保存。", "success");
    } catch { notifyDesktop("浏览器设置失败", "浏览器设置保存失败，请稍后重试。", "error"); }
    finally { setBusy(false); }
  }
  /** 接入检测只读取文件；真实CLI与平台兼容性由实机验证确认。 */
  async function recheck() {
    try { const res = await window.autopilotDesktop.browser.integration(); console.log(res); setIntegration(res); }
    catch { notifyDesktop("浏览器接入检测失败", "请稍后重试。", "error"); }
  }
  /** 用户点击才安装或更新受管技能，自定义内容始终保留。 */
  async function install(id: BrowserSkillStatus["id"]) {
    setBusy(true);
    try { const res = await window.autopilotDesktop.browser.installSkill(id); console.log(res); await recheck(); notifyDesktop("浏览器技能", "技能安装或更新已完成。", "success"); }
    catch { notifyDesktop("技能安装失败", "请检查目录权限，自定义技能会保留。", "error"); }
    finally { setBusy(false); }
  }
  const states = { missing: "未安装", current: "已安装", update: "可更新", custom: "自定义内容（保留）", unavailable: "无法读取" };
  return <section aria-label="浏览器设置" className="mt-8">
    <h2 className="text-lg font-semibold">浏览器</h2>
    {value && <Card className="mt-4 divide-y divide-border px-6">
      <div className="flex flex-wrap items-center justify-between gap-4 py-5"><div><h3 className="font-semibold">操控权限</h3><p className="mt-2 text-xs text-muted">跟随 AP 权限时，为我审批放行公开网页浏览，完全访问还放行普通交互。打开本地文件和下载仍需确认。</p></div><Select value={value.permission} disabled={busy} onValueChange={function permission(permission) { void change("preferences", { ...value, permission: permission as BrowserPreferences["permission"] }); }}><SelectTrigger className="w-48" aria-label="浏览器操控权限"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="follow_ap">跟随 AP 权限</SelectItem><SelectItem value="once">每次操作确认</SelectItem><SelectItem value="always">允许本回合操作</SelectItem></SelectContent></Select></div>
      <div className="flex flex-wrap items-center justify-between gap-4 py-5"><h3 className="font-semibold">历史保留</h3><div className="flex gap-2"><Select value={String(value.historyDays)} disabled={busy} onValueChange={function history(days) { void change("preferences", { ...value, historyDays: Number(days) as BrowserPreferences["historyDays"] }); }}><SelectTrigger className="w-36" aria-label="历史保留时间"><SelectValue /></SelectTrigger><SelectContent>{[0, 7, 30, 90].map(function option(days) { return <SelectItem key={days} value={String(days)}>{days ? `${days} 天` : "不保存"}</SelectItem>; })}</SelectContent></Select><Button variant="outline" disabled={busy} onClick={function clear() { void change("clear"); }}>清空历史</Button></div></div>
      <div className="space-y-4 py-5"><div className="flex flex-wrap items-center justify-between gap-4"><div className="min-w-0"><h3 className="font-semibold">下载目录</h3><p className="mt-2 break-all text-xs text-muted">{value.downloadDirectory ?? "系统下载目录"}</p></div><Button variant="outline" disabled={busy} onClick={function directory() { void change("directory"); }}>选择目录</Button></div><label className="flex items-center gap-2 text-sm"><Checkbox checked={value.askDownload} disabled={busy} onCheckedChange={function ask(checked) { void change("preferences", { ...value, askDownload: checked === true }); }} />每次下载询问保存目录</label></div>
    </Card>}
    {integration && <Card className="mt-4 space-y-4 p-6"><div className="flex items-center justify-between gap-4"><h3 className="font-semibold">智能体接入</h3><Button variant="outline" disabled={busy} onClick={function check() { void recheck(); }}>重新检测</Button></div><p className="text-xs text-muted">内置驱动 {integration.driver.version} · {integration.driver.available ? "资源校验通过" : integration.driver.reason ?? "资源不可用"}</p><p className="text-xs text-muted">Autopilot 原生接入；第三方需在 Desktop 终端启动并启用原生插件。安装技能后重新启动对应智能体。文件检测不代表实机兼容性验证。</p>{integration.skills.map(function row(skill) { return <div key={skill.id} className="flex items-center justify-between gap-4"><div className="min-w-0"><p className="text-sm">{skill.label} · {states[skill.state]}</p><p className="break-all text-xs text-muted">{skill.path}</p></div>{["missing", "update"].includes(skill.state) && <Button variant="outline" disabled={busy} onClick={function save() { void install(skill.id); }}>{skill.state === "update" ? "更新" : "安装"}</Button>}</div>; })}</Card>}
  </section>;
}
