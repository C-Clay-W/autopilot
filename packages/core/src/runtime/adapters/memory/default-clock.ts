/**
 * 默认时钟适配器
 *
 * 直接委托系统 Date；生产与默认场景使用。
 */

import type { Clock } from "../../ports";

export class DefaultClock implements Clock {
  now(): number {
    return Date.now();
  }

  timestamp(): string {
    return new Date().toISOString();
  }
}
