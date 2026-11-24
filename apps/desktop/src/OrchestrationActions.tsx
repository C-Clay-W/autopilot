/** 主控操作面板和精确委派控制；沿用宿主身份与 Core 交互卡。 */
import { useRef, useState } from "react";
import { isManagedApprovalDecision, type ManagedApprovalDecision, type OrchestrationRunView, type OrchestrationUiCommand } from "./orchestration-contract";
import { pendingRunApprovals } from "./orchestration-interactions";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./components/ui/select";

/** Run 详情中唯一可提交的图形工具审批区。 */
export function RunApprovals({ run, id, command }: { run: OrchestrationRunView; id: string; command: (value: OrchestrationUiCommand) => Promise<boolean> }) {
  const approvals = pendingRunApprovals(run);
  if (!approvals.length) return null;
  return <section id={id} aria-label="待处理工具审批" tabIndex={-1} className="space-y-2 rounded-md border border-border p-3 text-sm">
    {approvals.map(function card(item) { return <RunApproval key={item.key} id={id + item.key} run={run} item={item} command={command} />; })}
  </section>;
}

/** 同一审批提交一次，保存失败或未知时保留可核查信息。 */
function RunApproval({ id, run, item, command }: { id: string; run: OrchestrationRunView; item: ReturnType<typeof pendingRunApprovals>[number]; command: (value: OrchestrationUiCommand) => Promise<boolean> }) {
  const submitted = useRef(false);
  const [status, setStatus] = useState("");
  const { approval, executionToken } = item;
  const allowed = (approval.allowedDecisions ?? approval.display?.allowedDecisions ?? ["allow_once", "deny"]).filter(isManagedApprovalDecision);
  /** 原身份由待审批投影和现有宿主命令共同核对。 */
  async function decide(decision: ManagedApprovalDecision) {
    if (submitted.current || !allowed.includes(decision)) return;
    submitted.current = true;
    setStatus("正在提交审批决定…");
    const target = item.assignmentId ? { type: "control" as const, assignmentId: item.assignmentId, revision: run.revision } : { type: "controller" as const };
    const saved = await command({ ...target, workspaceId: run.workspaceId, runId: run.id, executionToken, requestId: crypto.randomUUID(), operation: "approval", approvalId: approval.approvalId, decision, continueAfterApproval: true }).catch(function unknown() { return false; });
    setStatus(saved ? decision === "deny" ? "已拒绝，正在恢复原任务…" : "已批准，正在恢复原任务…" : "请核查原审批决定与继续结果。");
  }
  return <article id={id} className="space-y-2 rounded-md border border-border p-2">
    <h3 className="font-semibold">{item.assignmentId ? `执行者 ${item.assignmentId}` : "主控"} · {approval.display?.operation || approval.toolName}</h3>
    <p className="break-words">{approval.reason}</p>
    {approval.display?.resource && <p className="break-words">{approval.display.resource}</p>}
    <p className="break-words text-xs text-muted">授权对象：{item.assignmentId ? "本执行者会话" : "本主控会话"}{allowed.includes("allow_workspace") && " / 本工作区"} · 约束：{approval.constraint ?? approval.display?.resource ?? "当前操作"}</p>
    {approval.display?.risk && <p className="text-muted">风险级别 {approval.display.risk}</p>}
    {approval.display?.hostExecution && <p className="text-warning">此操作将在宿主执行，未启用 OS 沙箱隔离。</p>}
    <div className="flex flex-wrap items-center gap-2">
      {allowed.map(function option(decision) {
        const labels: Record<ManagedApprovalDecision, string> = { allow_once: "仅本次批准", allow_session: item.assignmentId ? "批准本执行者会话" : "批准本主控会话", allow_workspace: "批准本工作区", deny: "拒绝" };
        return <Button key={decision} size="sm" variant={decision === "deny" ? "outline" : "default"} disabled={!!status} onClick={function choose() { void decide(decision); }}>{labels[decision]}</Button>;
      })}
      {status && <span role="status" className="text-xs text-muted">{status}</span>}
    </div>
    <details><summary className="cursor-pointer text-xs text-muted">审批技术详情</summary><p className="break-all">Session {item.sessionId} · Turn {item.turnId} · 审批 {item.requestId}</p><pre className="max-h-52 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-surface p-2">{JSON.stringify(approval.display, null, 2)}</pre></details>
  </article>;
}

/** 相同 Turn/请求重试复用 requestId；新卡片由执行 token 重置草稿。 */
export function OrchestrationActions({ run, assignment, command, controller = false }: { controller?: boolean; controllerView?: "question"; run: OrchestrationRunView; assignment: Pick<OrchestrationRunView["assignments"][number], "id" | "sessionId" | "executionToken" | "inspection" | "takeover" | "state" | "canCancel" | "pendingResume">; command: (value: OrchestrationUiCommand) => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [requests] = useState(new Map<string, string>());
  const base = { workspaceId: run.workspaceId, runId: run.id, revision: run.revision, assignmentId: assignment.id, executionToken: assignment.executionToken };
  const inspection = assignment.inspection;
  const interaction = inspection?.interaction;
  const readOnly = busy || !run.connected || !base.executionToken;
  /** 按原交互身份生成请求，重复点击只核查原回执。 */
  async function saveAnswer() {
    const question = interaction?.question;
    if (!base.executionToken || !question) return;
    const key = JSON.stringify([inspection?.turnId, question.requestId, answers]);
    const requestId = requests.get(key) ?? crypto.randomUUID();
    requests.set(key, requestId);
    setBusy(true);
    try {
      const target = controller ? { type: "controller" as const, workspaceId: run.workspaceId, runId: run.id, executionToken: base.executionToken } : { ...base, executionToken: base.executionToken, type: "control" as const };
      await command({ ...target, continueAfterAnswer: true, operation: "answer", requestId, questionId: question.requestId,
        answers: question.questions.map(function answer(q) {
          const value = answers[q.id] ?? "";
          return q.options.some(function option(o) { return o.label === value; }) ? { id: q.id, selected: [value] } : { id: q.id, selected: [], custom: value };
        }) });
    }
    finally { setBusy(false); }
  }
  return <>{interaction?.state === "pending" && interaction.question && <div className="space-y-3">{interaction.question.questions.map(function question(q) { return <div key={q.id} className="space-y-2"><p>{q.question}</p><Select value={q.options.some(function option(o) { return o.label === answers[q.id]; }) ? answers[q.id] : ""} onValueChange={function select(value) { setAnswers({ ...answers, [q.id]: value }); }}><SelectTrigger aria-label={q.header}><SelectValue placeholder="选择回答" /></SelectTrigger><SelectContent>{q.options.map(function option(o) { return <SelectItem key={o.label} value={o.label}>{o.label} · {o.description}</SelectItem>; })}</SelectContent></Select><Input aria-label={`${q.header} 补充回答`} placeholder="或输入自己的回答" value={answers[q.id] ?? ""} onChange={function change(event) { setAnswers({ ...answers, [q.id]: event.target.value }); }} /></div>; })}<Button disabled={readOnly || interaction.question.questions.some(function empty(q) { return !answers[q.id]?.trim(); })} onClick={function answer() { void saveAnswer(); }}>保存答案</Button></div>}</>;
}
