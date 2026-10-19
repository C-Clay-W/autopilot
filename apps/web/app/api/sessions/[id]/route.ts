/** Work 处理器只能由已校验 Workspace 的 canonical Route 调用。 */
import { toWorkSessionErrorResponse } from "@/lib/workspace-host/work-session-error";
import { rejectUnscopedWorkRequest } from "@/lib/workspace-host/work-route-boundary";
/**
 * GET /api/sessions/:id — 取某会话全部消息（含首行 meta）
 * DELETE /api/sessions/:id — 删除会话文件
 */

import { NextResponse } from "next/server";
import { getSessionMessages, getSessionMeta, deleteSession } from "@/lib/session-store";
import { cancelActiveTurn, hasActiveTurn } from "@/lib/agent-turn-store";
import { getSharedWebRuntime } from "@/lib/composition-root";
import { toWebTurnDto } from "@/lib/runtime-host/web-ui-dto";
import { projectEvents } from "@/lib/runtime-host/web-message-projection";
import { replayWebPresentation } from "@/lib/runtime-host/web-presentation-adapter";
import { restoreWebInputPresentation } from "@/lib/runtime-host/web-input-presentation";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rejected = rejectUnscopedWorkRequest();
  if (rejected) return rejected;
  try {
    const { id } = await params;
    const runtime = await getSharedWebRuntime();
    const meta = await getSessionMeta(runtime, id);
    const messages = await getSessionMessages(runtime, id);
    const inputs = await runtime.inbox.list({ sessionId: id });
    const queuedTurns = new Map(inputs.filter(function queued(input) { return input.delivery === "queue" && input.status === "consumed"; }).map(function key(input) { return [`input:${input.inputId}`, input.turnId]; }));
    const publicMessages = messages.map((message) => ({
      ...message,
      turnId: message.role === "user" && message.clientRecordId ? queuedTurns.get(message.clientRecordId) ?? message.turnId : message.turnId,
      attachments: message.attachments?.map(({ id: attachmentId, name, mimeType }) => ({ id: attachmentId, name, mimeType })),
    }));
    const state = await runtime.turns.getState({ sessionId: id });
    const checkpoint = state.checkpoint;
    // 只读查询 Core 最新安全 Context Usage 快照；无数据时为 null，浏览器不得自行重算。
    const contextUsage = await runtime.turns.getContextUsage({ sessionId: id });
    // queue 已有真实 persistUserMessage，历史沿用普通用户气泡；只补从未写入该投影的 steer。
    const presentation = restoreWebInputPresentation(replayWebPresentation(state.events), state.events, inputs.filter(function steer(input) { return input.delivery === "steer"; }));
    const recoverable = await runtime.turns.getRecoverableState({ sessionId: id });
    const shouldExposeAgent = recoverable && (
      recoverable.status === "awaiting_approval"
      || recoverable.status === "awaiting_user_input"
      || recoverable.status === "interrupted_recoverable"
      || recoverable.status === "limit_reached"
      || (recoverable.status === "failed" && Boolean(recoverable.termination?.reason))
    );
    const agent = !state.readOnlyReason && shouldExposeAgent
      ? { turnId: recoverable.turnId, status: recoverable.status, recoverable: recoverable.recoverable, termination: recoverable.termination }
      : undefined;
    if (!state.readOnlyReason && recoverable?.status === "awaiting_approval") {
      const projection = projectEvents(state.events);
      publicMessages.push({
        type: "message",
        id: `agent-turn-${checkpoint.turnId}`,
        role: "assistant",
        turnId: checkpoint.turnId,
        content: projection.answer,
        attachments: [],
        sources: projection.sources.length ? projection.sources : undefined,
        editDiffs: projection.editDiffs.length ? projection.editDiffs : undefined,
        processSteps: projection.processSteps.length ? projection.processSteps : undefined,
        turnSegments: projection.turnSegments.length ? projection.turnSegments : undefined,
        createdAt: Date.now(),
      });
    }
    // Session 展示消息是可删除 cache；旧快照曾覆盖 assistant cache 时，仍按 transcript 的同一 Presentation 补回 Turn 容器。
    const assistantTurnIds = new Set(publicMessages.filter((message) => message.role === "assistant" && message.turnId).map((message) => message.turnId));
    for (const item of presentation.items) {
      if (!("turnId" in item) || !["assistant_answer", "input_notice", "todo", "turn_summary"].includes(item.kind) || assistantTurnIds.has(item.turnId)) continue;
      publicMessages.push({
        type: "message",
        id: `agent-turn-${item.turnId}`,
        role: "assistant",
        turnId: item.turnId,
        content: "",
        attachments: [],
        createdAt: Date.now(),
      });
      assistantTurnIds.add(item.turnId);
    }
    // 仅在上一轮已成功完成时允许页面自动领取遗留输入；失败或中断必须保留给用户显式处理。
    const canAutoStartNext = !state.readOnlyReason && checkpoint?.status === "completed";
    const consumedInputIds = new Set(checkpoint?.consumedInputIds ?? []);
    const pendingInputs = inputs.filter((input) => (input.status === "pending" || input.status === "claimed") && !consumedInputIds.has(input.inputId)).map((input) => ({
      inputId: input.inputId,
      clientMessageId: input.clientMessageId,
      delivery: input.delivery,
      status: input.status,
      content: input.content,
      attachmentCount: input.attachments.length,
      skillCount: input.selectedSkills.length,
      createdAt: input.createdAt,
    }));
    return NextResponse.json({ meta, messages: publicMessages, presentation, agent, canAutoStartNext, pendingInputs, readOnlyReason: state.readOnlyReason, contextUsage });
  } catch (err) {
    return toWorkSessionErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rejected = rejectUnscopedWorkRequest();
  if (rejected) return rejected;
  try {
    const { id } = await params;
    const runtime = await getSharedWebRuntime();
    await getSessionMeta(runtime, id);
    const state = await runtime.turns.getState({ sessionId: id });
    const checkpoint = state.checkpoint;
    const turn = toWebTurnDto(state.turn);
    const turnId = checkpoint?.turnId ?? turn?.turnId;
    const status = checkpoint?.status ?? turn?.status;
    if (turnId && (status === "running" || status === "awaiting_approval" || status === "waiting_approval")) {
      if (hasActiveTurn(id, turnId)) {
        cancelActiveTurn(id, turnId);
        await runtime.turns.cancel({ sessionId: id, turnId });
        const deadline = Date.now() + 2_000;
        let settled = false;
        while (Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          const latest = await runtime.turns.getState({ sessionId: id, turnId });
          const latestStatus = latest.checkpoint?.status ?? latest.turn?.status;
          if (latestStatus && latestStatus !== "running" && latestStatus !== "awaiting_approval" && latestStatus !== "waiting_approval") {
            settled = true;
            break;
          }
        }
        if (!settled) return NextResponse.json({ error: "活动 Agent 尚未确认停止，未删除会话审计记录" }, { status: 409 });
      } else {
        await runtime.turns.cancel({ sessionId: id, turnId });
      }
    }
    const inputs = await runtime.inbox.list({ sessionId: id });
    for (const input of inputs) {
      if (input.status === "pending") await runtime.inbox.cancel(input.inputId);
    }
    const deleted = await deleteSession(runtime, id);
    if (!deleted) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toWorkSessionErrorResponse(err);
  }
}
