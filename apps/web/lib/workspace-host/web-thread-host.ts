/**
 * web-thread-host.ts — Web 宿主侧的协作执行宿主
 *
 * 每个 Workspace 一个实例：进程内投递服务负责领取 run 投递，Node Runner 用既有
 * `turns.start` 驱动目标会话；页面与 Route 只观察，不在此定义第二套模型循环。
 * 人类入口一律绑定本地 principal，hostOnline 只由本宿主事实给出。
 */

import { createNodeThreadHandoffWriter, createNodeThreadRunner, type NodeThreadRunner, type NodeThreadRunnerPrompt, type NodeThreadRunnerStopReport } from "@autopilot-agent/adapters";
import { createThreadDeliveryService, createThreadFacade } from "@autopilot-agent/core";
import type { AgentRuntime, RuntimePorts, ThreadDeliveryService, ThreadFacade, ThreadsCapability } from "@autopilot-agent/core";
import { WEB_THREAD_PRINCIPAL_ID } from "./web-thread-capability";
import type { WebTurnHost } from "./web-turn-host";

/** 创建 Web 协作宿主所需的受信事实；全部来自 Composition Root 与 Runtime。 */
export interface CreateWebThreadHostOptions {
  workspaceId: string;
  stateRootId: string;
  projectId: string;
  /** 受信 canonical 工作区根；交接文档只允许写在其固定子目录。 */
  workspaceRoot: string;
  runtime: AgentRuntime;
  ports: RuntimePorts;
  /** 与 Runtime 默认值同源的协作范围；缺失表示本工作区不提供协作。 */
  capability: ThreadsCapability;
  /** 与普通 Work 共用的执行宿主观测；用于把 thread 来源 Prompt 与结果投影到展示历史。 */
  turnHost?: WebTurnHost;
  /** 单轮调度异常的观测回调；不改变持久事实。 */
  onError?: (error: unknown) => void;
}

/** Web 协作宿主：交付、驱动与人类协议入口的唯一持有者。 */
export interface WebThreadHost {
  readonly workspaceId: string;
  readonly stateRootId: string;
  /**
   * 人类协议入口；`hostOnline` 在创建时按当时事实冻结。
   * 调用方必须先 `ensureStarted()` 再创建入口，协作 Route 已按此顺序执行。
   */
  facade(principalId?: string): ThreadFacade;
  /** 保证 Runner 已启动；重复调用无副作用。 */
  ensureStarted(): void;
  /** 立刻触发一次领取，仅加速，不代表已持久化。 */
  kick(): void;
  /** 本宿主是否已接管驱动；用于 `send` 的 hostOffline 事实。 */
  isRunning(): boolean;
  /** 停机：停止领取、取消本 owner 的 Turn 并退回未启动领取。 */
  stop(): Promise<NodeThreadRunnerStopReport | undefined>;
}

/** 进程内 owner 身份：同一进程重启视为新 owner，旧领取由 reconcile 收敛。 */
function createOwnerId(workspaceId: string): string {
  return `web:${workspaceId}:${process.pid}`;
}

/** 创建 Web 协作宿主；构造只装配，不启动轮询。 */
export function createWebThreadHost(options: CreateWebThreadHostOptions): WebThreadHost {
  const delivery: ThreadDeliveryService = createThreadDeliveryService(options.ports, options.ports.threadStore, {
    workspaceId: options.workspaceId,
    stateRootId: options.stateRootId,
    ownerId: createOwnerId(options.workspaceId),
    executionHost: options.capability.executionHost ?? "web-work-v1",
  });
  // 交接文档由 Node Adapter 原子写入受信工作区；Core 只接收安全引用。
  const handoff = createNodeThreadHandoffWriter({ workspaceRoot: options.workspaceRoot });
  const turnHost = options.turnHost;
  const runner: NodeThreadRunner = createNodeThreadRunner({
    delivery,
    runtime: options.runtime,
    ports: options.ports,
    ...(options.onError ? { onError: options.onError } : {}),
    // 只投影真实 thread 来源 Prompt；人类经协作入口发送时仍按普通人类消息处理。
    ...(turnHost ? {
      onTurnStarted: function projectThreadPrompt(input: { threadId: string; turnId: string; prompt: NodeThreadRunnerPrompt }) {
        const from = input.prompt.from;
        if (from.kind !== "thread") return;
        return turnHost.recordThreadPrompt({ sessionId: input.threadId, content: input.prompt.content, fromThreadId: from.threadId, messageId: input.prompt.messageId, handoffDisplay: input.prompt.handoffDisplay });
      },
      onTurnSettled: function projectSettledTurn(input: { threadId: string; turnId: string }) {
        return turnHost.recordSettledTurn({ sessionId: input.threadId, turnId: input.turnId });
      },
    } : {}),
  });
  // 普通 start、continue 与队列执行均在 TurnHost 的唯一入口进入 Runner 的 owner 索引。
  turnHost?.bindExecutionOwner(runner.registerExecution);
  // 只记录“本宿主已接管驱动”的意图：Runner.start 的首轮收敛是异步的，不能用一个 tick 的时序决定回执。
  let started = false;

  return {
    workspaceId: options.workspaceId,
    stateRootId: options.stateRootId,

    facade: function bindHuman(principalId = WEB_THREAD_PRINCIPAL_ID) {
      return createThreadFacade(options.ports, {
        workspaceId: options.capability.workspaceId,
        stateRootId: options.capability.stateRootId,
        projectId: options.capability.projectId,
        allowedTools: options.capability.allowedTools,
        executionHost: options.capability.executionHost ?? "web-work-v1",
        modelCatalog: options.capability.modelCatalog,
        actor: { kind: "human", principalId },
        hostOnline: started,
        handoff,
      });
    },

    ensureStarted: function ensureStarted() {
      if (started) return;
      started = true;
      void runner.start().catch(function ignoreStart() { /* 首轮异常由 onError 观测，持久事实不变 */ });
    },

    kick: function kick() {
      if (!started) return;
      runner.kick();
    },

    isRunning: function isRunning() {
      return started;
    },

    stop: async function stop() {
      if (!started) return undefined;
      started = false;
      return runner.stop();
    },
  };
}
