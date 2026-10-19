/**
 * 内存 EventSink 适配器
 *
 * 将 Runtime 输出的事件保存在内存数组中，便于测试断言。
 */

import type { AgentEventEnvelope } from "../../protocol";
import type { EventSink } from "../../ports";

export class MemoryEventSink implements EventSink {
  private events: AgentEventEnvelope[] = [];

  async write(envelope: AgentEventEnvelope): Promise<void> {
    this.events.push(envelope);
  }

  getEvents(): AgentEventEnvelope[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}
