/** 私有受管执行通道：固定有界协议帧，能力只绑定本次宿主创建的 pipe。 */
import type { ManagedExecutionChannel, ManagedExecutionControl } from "@autopilot-agent/core";

/** 构造一次性执行控制；握手来源为私有句柄，绝不从目标 stdout/stderr 推断停止。 */
export function createManagedExecutionControl(): ManagedExecutionControl & { dispose(): void } {
  let channel: ManagedExecutionChannel | undefined;
  let failure: Error | undefined;
  let bound = false;
  let ready = false;
  let stopping = false;
  let stopped = false;
  let pending = Buffer.alloc(0);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stopPromise: Promise<{ evidence: "container_empty" }> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<void>(function createReady(resolve, reject) { resolveReady = resolve; rejectReady = reject; });
  let resolveEmpty!: () => void;
  let rejectEmpty!: (error: Error) => void;
  const emptyPromise = new Promise<void>(function createEmpty(resolve, reject) { resolveEmpty = resolve; rejectEmpty = reject; });
  void readyPromise.catch(function ignoreUntilStop() {});
  void emptyPromise.catch(function ignoreUntilStop() {});

  /** 固定失败并唤醒等待者；禁止失败后换通道、重新发停止或降级认证。 */
  function fail(error: Error): void {
    failure ??= error;
    clearTimeout(timeout);
    rejectReady(failure);
    rejectEmpty(failure);
    channel?.close();
  }

  /** 消费严格有界帧；版本错误、额外内容和未请求回执都拒绝。 */
  async function consume(): Promise<void> {
    try {
      for await (const bytes of channel!.incoming) {
        if (pending.length + bytes.length > 15 || stopped) throw new Error("managed control invalid frame length");
        pending = Buffer.concat([pending, bytes]);
        if (!ready && pending.length >= 8) {
          if (!pending.subarray(0, 8).equals(Buffer.from("SRTJOB1\n"))) throw new Error("managed control unsupported protocol");
          pending = pending.subarray(8);
          ready = true;
          clearTimeout(timeout);
          resolveReady();
        }
        if (ready && pending.length) {
          if (!stopping) throw new Error("managed control unsolicited confirmation");
          if (pending.length > 7) throw new Error("managed control invalid confirmation length");
          if (pending.length === 7) {
            if (!pending.equals(Buffer.from("EMPTY1\n"))) throw new Error("managed control invalid confirmation");
            pending = Buffer.alloc(0);
            stopped = true;
            clearTimeout(timeout);
            resolveEmpty();
          }
        }
      }
      if (!stopped) fail(new Error("managed control disconnected"));
    } catch {
      fail(new Error("managed control protocol failed"));
    }
  }

  return {
    protocolVersion: 1,
    bind(input): void {
      if (bound) throw new Error("managed control already bound");
      bound = true;
      channel = input;
      timeout = setTimeout(function handshakeTimeout() { fail(new Error("managed control handshake timeout")); }, 10_000);
      void consume();
    },
    stop(): Promise<{ evidence: "container_empty" }> {
      if (stopPromise) return stopPromise;
      stopPromise = (async function stopBoundExecution() {
        if (!bound || failure) throw failure ?? new Error("managed control not bound");
        await readyPromise;
        if (failure) throw failure;
        stopping = true;
        timeout = setTimeout(function stopTimeout() { fail(new Error("managed control stop timeout")); }, 10_000);
        try { channel!.send(Uint8Array.of(1)); }
        catch { fail(new Error("managed control send failed")); }
        await emptyPromise;
        return { evidence: "container_empty" as const };
      })();
      return stopPromise;
    },
    dispose(): void {
      clearTimeout(timeout);
      if (!stopped) fail(new Error("managed control released"));
      else channel?.close();
    },
  };
}
