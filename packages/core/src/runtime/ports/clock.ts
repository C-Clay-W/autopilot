/**
 * Clock Port — 时间抽象
 *
 * 便于测试控制时间，也避免 Runtime 直接依赖系统 Date。
 */

/** 时钟端口。 */
export interface Clock {
  /** 返回当前时间戳（毫秒）。 */
  now(): number;

  /** 返回 ISO 8601 格式当前时间字符串。 */
  timestamp(): string;
}
