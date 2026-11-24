// 新安装的一次主题选择使用普通页面卡片，跳过沿用自适应且宿主保存成功后结束。
import { useState } from "react";
import type { UiPreferences, ThemeMode } from "./ui-preferences";
import type { Workspace, WorkspaceCommand } from "./workspace";
import { Card } from "./components/ui/card";
import { Button } from "./components/ui/button";
/** 仅宿主明确的新安装状态显示，不根据组件本地缓存识别用户。 */
export function ThemeWelcome({ ui, command }: { ui: UiPreferences; command(value: WorkspaceCommand): Promise<Workspace | undefined> }) {
  const [saving, setSaving] = useState(false);
  /** 完成与跳过共享原子偏好保存，失败继续保留选择入口。 */
  async function choose(theme: ThemeMode) { setSaving(true); try { await command({ type: "uiPreference", ui: { ...ui, theme, onboardingComplete: true } }); } finally { setSaving(false); } }
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-bg p-6"><Card className="w-full max-w-xl space-y-6 p-8"><h1 className="text-xl font-semibold">选择你的外观</h1><p className="text-muted">稍后可以在设置中修改。</p><div className="flex flex-wrap gap-3">{([['light', '浅色'], ['dark', '暗黑'], ['system', '自适应']] as const).map(function option([mode, title]) { return <Button key={mode} variant="outline" disabled={saving} onClick={function select() { void choose(mode); }}>{title}</Button>; })}</div><Button variant="ghost" disabled={saving} onClick={function skip() { void choose("system"); }}>跳过，使用自适应</Button></Card></div>;
}
