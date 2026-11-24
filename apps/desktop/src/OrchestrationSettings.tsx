/** 编排分类设置只暴露已有行为，修改仅影响新 Run 的冻结快照。 */
import { useState } from "react";
import type { OrchestrationView, OrchestrationUiCommand } from "./orchestration-contract";
import { Card } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./components/ui/select";
import { ORCHESTRATION_TEMPLATES, orchestrationTemplateHeader } from "../../cli/src/orchestration-templates";
import { notifyDesktop } from "./desktop-notifications";

export const orchestrationCategory = "编排";
export const orchestrationCategories = [orchestrationCategory, "职责与 Skill", "自动化与恢复", "执行器与版本", "工作区与资源"];
/** 设置仍在应用主进程持久化，既有 Run 不静默改变策略或预算。 */
export function OrchestrationSettings({ category, view, command }: { category: string; view: OrchestrationView; command: (value: OrchestrationUiCommand) => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  /** 即时保存受限偏好，失败由统一通知展示。 */
  async function save(value: OrchestrationView["preferences"]) { setBusy(true); try { await command({ type: "preferences", value }); } finally { setBusy(false); } }
  /** 只复制固定首行和换行，设置页无法提交任务。 */
  async function copy(label: typeof ORCHESTRATION_TEMPLATES[number]["label"]) {
    try {
      const res = await window.autopilotDesktop.copyTerminalText(orchestrationTemplateHeader(label) + "\n");
      console.log(res);
      notifyDesktop("已复制模板", "粘贴到主控终端并补充任务正文后发送。", "info");
    }
    catch { notifyDesktop("复制模板失败", "请重新复制。", "error"); }
  }
  return <Card className="mt-6 space-y-5 p-6"><h2 className="font-semibold">{category}</h2><p className="text-xs text-muted">派工策略随新 Run 冻结，终端布局设置用于后续新开的执行者。</p>
    {category === orchestrationCategory && <>
      <p>默认主控：Autopilot · 固定身份贯穿 Run</p><label className="flex items-center gap-2 text-sm"><Checkbox checked={view.preferences.automaticDispatch} disabled={busy} onCheckedChange={function change(value) { void save({ ...view.preferences, automaticDispatch: value === true }); }} />已授权目标内自动派发 1–2 个执行者（3+ 始终先确认）</label>
      <label className="flex flex-wrap items-center justify-between gap-2 text-sm">新执行者终端<Select value={view.preferences.executorLayout ?? "tab"} disabled={busy} onValueChange={function change(value) { void save({ ...view.preferences, executorLayout: value === "split" ? "split" : "tab" }); }}><SelectTrigger className="w-48" aria-label="新执行者终端"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="tab">在新 Tab 打开</SelectItem><SelectItem value="split">当前 Tab 分屏</SelectItem></SelectContent></Select></label>
      <div className="grid gap-3 sm:grid-cols-2">{ORCHESTRATION_TEMPLATES.map(function card(item) {
        return <Card key={item.id} className="space-y-2 p-3"><h3 className="font-semibold">{item.label}</h3><p className="text-sm text-muted">{item.description}</p><Button size="sm" variant="outline" aria-label={`复制${item.label}模板`} onClick={function choose() { void copy(item.label); }}>复制模板</Button></Card>;
      })}</div>
    </>}
    {category === "职责与 Skill" && <><Select value={view.preferences.responsibility} disabled={busy} onValueChange={function change(value) { void save({ ...view.preferences, responsibility: value as "local" | "controller" }); }}><SelectTrigger aria-label="职责优先级"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="local">执行者已有 Skill / 项目规则优先</SelectItem><SelectItem value="controller">主控调配优先</SelectItem></SelectContent></Select><p className="text-sm text-muted">用户明确要求、权限与资源规则始终生效。Skill 多 Agent 需求交主控安排平级委派；受管会话持续禁用 Thread。</p></>}
    {category === "自动化与恢复" && <><label className="flex items-center justify-between gap-4">自动修复 / 改派上限<Input className="w-24" aria-label="自动修复上限" type="number" min={0} max={20} value={view.preferences.repairLimit} disabled={busy} onChange={function change(event) { const n = Number(event.target.value); if (Number.isInteger(n) && n >= 0 && n <= 20) void save({ ...view.preferences, repairLimit: n }); }} /></label><p className="text-sm text-muted">默认 2 轮，同 Step 修复与改派共用；Skill 更严上限优先。重启只显示概览，核查后显式继续，不自动复活旧进程。</p></>}
    {category === "执行器与版本" && <p>受管执行器：AP · Core 0.4.0 · H1 协议 1 · H2 持久对账。第三方 CLI 仅在自由 Parallel 中使用。</p>}
    {category === "工作区与资源" && <><p>同 Checkout 单执行者独占，不启用 Worktree。read 仅表达意图，也占用目录。</p>{view.runs.map(function run(r) { return <p key={r.id} className="text-sm">{r.checkoutLabel}：{r.assignments.filter(function occupied(a) { return a.occupied; }).map(function id(a) { return a.id; }).join("、") || "无登记占用"}{r.needsRecovery ? " · 待核查" : ""}</p>; })}<p className="text-xs text-muted">自由 Parallel、外部编辑器及其他宿主不受此内部租约约束。</p></>}
  </Card>;
}
