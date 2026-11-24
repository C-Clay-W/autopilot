// 外观与通知设置复用宿主完整偏好和本地 shadcn 控件，保存期间保留草稿。
import { useState } from "react";
import type { UiPreferences } from "./ui-preferences";
import type { Workspace, WorkspaceCommand } from "./workspace";
import { Card } from "./components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Checkbox } from "./components/ui/checkbox";

/** 偏好由宿主保存并返回，失败时撤销草稿，下一次显示仍为权威值。 */
export function UiSettings({ ui, command }: { ui: UiPreferences; command(value: WorkspaceCommand): Promise<Workspace | undefined> }) {
  const [draft, setDraft] = useState<UiPreferences | null>(null);
  const [saved, setSaved] = useState(false);
  const value = draft ?? ui;
  /** 完整有限偏好沿既有串行命令提交，不在 renderer 维护持久副本。 */
  async function save(patch: Partial<UiPreferences>) {
    const next = { ...ui, ...patch }; setDraft(next); setSaved(false);
    try { const res = await command({ type: "uiPreference", ui: next }); setSaved(!!res && !res.notice?.startsWith("布局保存失败")); }
    finally { setDraft(null); }
  }
  /** 选择器保持统一的名称与禁用语义。 */
  function choice(label: string, selected: string, options: [string, string][], change: (value: string) => void) {
    return <label className="flex flex-wrap items-center justify-between gap-3"><span>{label}</span><Select value={selected} disabled={!!draft} onValueChange={change}><SelectTrigger className="w-48" aria-label={label}><SelectValue /></SelectTrigger><SelectContent>{options.map(function option([id, title]) { return <SelectItem key={id} value={id}>{title}</SelectItem>; })}</SelectContent></Select></label>;
  }
  return <><section aria-label="外观与显示设置" className="mt-8"><h2 className="text-lg font-semibold">外观与显示</h2><Card className="mt-4 space-y-5 p-6">{choice("主题模式", value.theme, [["light", "浅色"], ["dark", "暗黑"], ["system", "自适应"]], function theme(theme) { void save({ theme: theme as UiPreferences["theme"] }); })}</Card></section>
    <section aria-label="通知提醒设置" className="mt-8"><h2 className="text-lg font-semibold">通知提醒</h2><Card className="mt-4 space-y-5 p-6">
      {choice("通知位置", value.notificationPosition, [["bottom-right", "右下角"], ["center", "居中"]], function position(notificationPosition) { void save({ notificationPosition: notificationPosition as UiPreferences["notificationPosition"] }); })}
      {choice("确认位置", value.confirmationPosition, [["center", "居中"], ["bottom-right", "右下角"]], function position(confirmationPosition) { void save({ confirmationPosition: confirmationPosition as UiPreferences["confirmationPosition"] }); })}
      {choice("普通通知停留时间", String(value.duration), [["3", "3 秒"], ["5", "5 秒"], ["10", "10 秒"]], function duration(seconds) { void save({ duration: Number(seconds) as UiPreferences["duration"] }); })}
      <label className="flex items-center gap-3"><Checkbox checked={value.doNotDisturb} disabled={!!draft} onCheckedChange={function toggle(checked) { void save({ doNotDisturb: checked === true }); }} />当前任务免打扰</label>
      <label className="flex items-center gap-3"><Checkbox checked={value.pauseOnHover} disabled={!!draft} onCheckedChange={function toggle(checked) { void save({ pauseOnHover: checked === true }); }} />悬停或键盘焦点进入时暂停倒计时</label>
      <label className="flex flex-wrap items-center justify-between gap-3"><span>通知声音</span><Select value="mute"><SelectTrigger className="w-48" aria-label="通知声音"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="mute">静音</SelectItem><SelectItem value="pending" disabled>待开发</SelectItem></SelectContent></Select></label>
      <p role="status" className="text-xs text-muted">{draft ? "正在保存…" : saved ? "已保存" : "设置立即保存；审批与关闭确认始终等待手动处理。"}</p>
    </Card></section></>;
}
