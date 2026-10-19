/**
 * CLI TUI 共享动画时钟。
 *
 * 时钟只负责向订阅者发出当前时间，不持有任何业务状态；终端活动区不可见、
 * screen reader、reduced-motion 或终态时可以停止订阅，测试也可以注入时间和调度器。
 */

export interface TuiAnimationClock {
  now(): number;
  subscribe(listener: (time: number) => void): () => void;
  setActive(active: boolean): void;
  tick(): void;
  dispose(): void;
}

/** 共享时钟可注入的调度器配置，避免动画单测依赖真实 setInterval。 */
export interface TuiAnimationClockOptions {
  now?: () => number;
  frameMs?: number;
  schedule?: (listener: () => void, frameMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/** 使用 Node 默认定时器启动一枚共享时钟任务。 */
function scheduleDefaultTimer(listener: () => void, frameMs: number): unknown {
  return setInterval(listener, frameMs);
}

/** 清理由 Node 默认定时器创建的共享时钟任务。 */
function cancelDefaultTimer(handle: unknown): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}

/** 创建可暂停、可注入且只在有订阅者时运行的 TUI 时钟。 */
export function createTuiAnimationClock(options: TuiAnimationClockOptions = {}): TuiAnimationClock {
  const now = options.now ?? function readCurrentTime(): number { return Date.now(); };
  const frameMs = Math.max(16, options.frameMs ?? 50);
  const schedule = options.schedule ?? scheduleDefaultTimer;
  const cancel = options.cancel ?? cancelDefaultTimer;
  const listeners = new Set<(time: number) => void>();
  let timer: unknown;
  let active = true;
  let disposed = false;

  /** 停止当前定时器，确保没有订阅者或时钟暂停时不继续唤醒进程。 */
  function stopTimer(): void {
    if (timer === undefined) return;
    cancel(timer);
    timer = undefined;
  }

  /** 根据订阅者和 active 状态启动唯一的共享定时器。 */
  function ensureTimer(): void {
    if (disposed || !active || listeners.size === 0 || timer !== undefined) return;
    timer = schedule(function emitScheduledTick(): void { clock.tick(); }, frameMs);
  }

  const clock: TuiAnimationClock = {
    now,
    subscribe(listener: (time: number) => void): () => void {
      if (disposed) return function ignoreDisposedSubscription(): void {};
      listeners.add(listener);
      ensureTimer();
      return function unsubscribe(): void {
        listeners.delete(listener);
        if (listeners.size === 0) stopTimer();
      };
    },
    setActive(nextActive: boolean): void {
      if (disposed || active === nextActive) return;
      active = nextActive;
      if (!active) stopTimer();
      else ensureTimer();
    },
    tick(): void {
      if (disposed || !active) return;
      const time = now();
      for (const listener of [...listeners]) listener(time);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopTimer();
      listeners.clear();
    },
  };

  return clock;
}
