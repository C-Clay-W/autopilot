/**
 * thread-host.ts — CLI 常驻协作宿主
 *
 * 只由常驻 `ap` 会话装配：发现已启用组后启动 Node Runner，用既有 turns 驱动目标会话；
 * 短命令与 watch 不启动本宿主。退出时停止本进程持有的驱动并报告未确认项，
 * 不假称目标已完成，也不接管其他 owner 的 Turn。
 */

import { createNodeThreadRunner, type NodeThreadRunner, type NodeThreadRunnerStopReport } from "@autopilot-agent/adapters";
import { createThreadDeliveryService } from "@autopilot-agent/core";
import type { AgentRuntime, RuntimePorts } from "@autopilot-agent/core";

/** 创建常驻宿主所需的受信事实；全部来自 Composition Root 与当前 Runtime。 */
export interface CreateCliThreadHostOptions {
  observeExecution?: (input: { threadId: string; turnId: string }) => void;
  workspaceId: string;
  stateRootId: string;
  runtime: AgentRuntime;
  ports: RuntimePorts;
  /** 组发现间隔；未启用协作的工作区不做执行轮询。 */
  discoverIntervalMs?: number;
  /** 单轮调度异常的观测回调；不改变持久事实。 */
  onError?: import("@autopilot-agent/adapters").NodeThreadRunnerOptions["onError"];
}

/** 常驻宿主；是否在驱动由真实启动状态决定，不由调用方猜测。 */
export interface CliThreadHost {
  listExecutions: NodeThreadRunner["listExecutions"];
  /** 开始发现并驱动；重复调用无副作用。 */
  start(): void;
  /** 停止发现与驱动，返回停机报告；从未启动时返回 undefined。 */
  stop(): Promise<NodeThreadRunnerStopReport | undefined>;
  registerExecution: NodeThreadRunner["registerExecution"];
  isRunning(): boolean;
}

/** 创建 CLI 常驻协作宿主；构造只装配，不启动轮询。 */
export function createCliThreadHost(options: CreateCliThreadHostOptions): CliThreadHost {
  const delivery = createThreadDeliveryService(options.ports, options.ports.threadStore, {
    workspaceId: options.workspaceId,
    executionHost: "cli-work-v1",
    stateRootId: options.stateRootId,
    // 同一进程重启视为新 owner，旧领取由 Runner 首轮 reconcile 收敛。
    ownerId: `cli:${options.workspaceId}:${process.pid}`,
  });
  const runner: NodeThreadRunner = createNodeThreadRunner({
    delivery,
    runtime: options.runtime,
    ports: options.ports,
    ...(options.onError ? { onError: options.onError } : {}),
    onTurnStarted: function observeStarted(input) { options.observeExecution?.({ threadId: input.threadId, turnId: input.turnId }); },
    onTurnSettled: function observeSettled(input) { options.observeExecution?.(input); },
  });
  let started = false;
  let discovering = false;
  let discovery: ReturnType<typeof setInterval> | undefined;

  /** 发现已启用组后接管驱动；没有组时保持轻量复查，不做执行轮询。 */
  async function discover(): Promise<void> {
    if (started || discovering) return;
    discovering = true;
    try {
      const groups = await options.ports.threadStore.listGroups();
      if (groups.length === 0) return;
      started = true;
      if (discovery) {
        clearInterval(discovery);
        discovery = undefined;
      }
      await runner.start();
    } finally {
      discovering = false;
    }
  }

  return {
    start: function start() {
      if (discovery || started) return;
      /** 单次发现失败不阻断会话；保持复查，异常只交给宿主观测。 */
      function attempt(): void {
        void discover().catch(function report(error: unknown) { options.onError?.(error); });
      }
      attempt();
      discovery = setInterval(attempt, options.discoverIntervalMs ?? 5_000);
      // 发现定时器不应单独阻止进程退出。
      discovery.unref?.();
    },
    stop: async function stop() {
      if (discovery) {
        clearInterval(discovery);
        discovery = undefined;
      }
      if (!started) return undefined;
      started = false;
      return runner.stop();
    },
    registerExecution: runner.registerExecution,
    listExecutions: runner.listExecutions,
    isRunning: function isRunning() {
      return started;
    },
  };
}
