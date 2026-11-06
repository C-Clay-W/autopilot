/**
 * ChildTaskStrip.tsx — 会话顶部的明确委派任务活动条。
 *
 * 只投影子会话的状态、最近活动时间与入口链接，不镜像子会话输出、工具参数或推理，
 * 也不写入父对话正文；数据全部来自 SessionTaskManager 与组归属的安全投影。
 */
"use client";

import { navigateChat } from "../chat-navigation";
import { conversationUrl } from "../conversation-target";
import type { SessionTaskPhase } from "../session-task-store";

/** 子任务条目的最小安全投影；不含 Turn 内容或工具参数。 */
export interface ChildTaskSummary {
  taskId: string;
  sessionId: string;
  title: string;
  phase: SessionTaskPhase;
  updatedAt: number;
}

/** 只把活跃阶段翻成状态文字；其余阶段不在本条内展示。 */
function describePhase(phase: SessionTaskPhase): string {
  if (phase === "waiting_approval") return "等待审批";
  if (phase === "waiting_user_input") return "等待回答";
  if (phase === "starting") return "启动中";
  return "执行中";
}

/** 渲染活跃子任务条；没有可展示条目时不占用版面。 */
export default function ChildTaskStrip({ workspaceId, items }: { workspaceId: string; items: readonly ChildTaskSummary[] }) {
  if (items.length === 0) return null;

  return (
    <section aria-label="协作任务" className="border-b-2 border-ink bg-card px-4 py-2 text-xs">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-1">
        <span className="shrink-0 font-semibold text-ink">协作任务</span>
        {items.map(function renderChildTask(item) {
          /** 最近活动时间只用本地时分，避免把宿主时钟差写进正文。 */
          const time = new Date(item.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
          return (
            <button
              key={item.taskId}
              type="button"
              onClick={function openChildTask() { navigateChat(conversationUrl(workspaceId, item.sessionId)); }}
              className="flex min-w-0 items-center gap-1.5 border-2 border-transparent px-1 py-0.5 hover:border-ink hover:text-accent focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-accent"
              title={`打开任务会话：${item.title}`}
            >
              <span aria-hidden="true" className="h-2 w-2 shrink-0 bg-accent" />
              <span className="max-w-56 truncate text-ink">{item.title}</span>
              <span className="shrink-0 text-muted">{describePhase(item.phase)} · {time}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
