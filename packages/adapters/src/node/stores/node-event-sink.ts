/**
 * Node EventSink：当前 Node 宿主没有额外观察者时丢弃事件；durable Transcript 由 Runtime 单独写入。
 */

import type { AgentEventEnvelope, EventSink } from "@autopilot-agent/core";
import type { NodeStoreOptions } from "../types";

/** 创建不拥有持久化职责的 Node EventSink。 */
export function createNodeEventSink(_options: NodeStoreOptions): EventSink {
  return {
    async write(_envelope: AgentEventEnvelope): Promise<void> {
      return undefined;
    },
  };
}
