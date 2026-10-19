/** r003 私有协议定向用例：仅内存通道，不启动原生目标或模拟 macOS。 */
import { it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { createManagedExecutionControl } from "../../src/node/sandbox/managed-execution-control";

/** 提供独立入站数据与出站记录，保持实际双向通道不回显的语义。 */
function fixture() {
  const input = new PassThrough();
  const sent: Uint8Array[] = [];
  const control = createManagedExecutionControl();
  control.bind({ incoming: input, send: function send(bytes) { sent.push(bytes); }, close: function close() { input.destroy(); } });
  return { input, sent, control };
}

/** 等待内存流消费当前字节，避免依赖事件执行顺序猜测。 */
async function drain() { await new Promise<void>(function next(resolve) { setImmediate(resolve); }); }

it("分片握手后重复停止只发一次，EMPTY才确认容器空", async function splitStop() {
  const f = fixture();
  const first = f.control.stop();
  expect(f.control.stop()).toBe(first);
  f.input.write("SRT");
  await drain();
  expect(f.sent).toHaveLength(0);
  f.input.write("JOB1\n");
  await drain();
  expect(f.sent.map(function bytes(data) { return [...data]; })).toEqual([[1]]);
  f.input.write("EMP");
  await drain();
  f.input.end("TY1\n");
  expect(await first).toEqual({ evidence: "container_empty" });
  expect(function bindAgain() { f.control.bind({ incoming: f.input, send: function send() {}, close: function close() {} }); }).toThrow("already bound");
  f.control.dispose();
});

it("版本不匹配拒绝且不会发送停止", async function unknownVersion() {
  const f = fixture();
  const result = expect(f.control.stop()).rejects.toThrow();
  f.input.end("SRTJOB2\n");
  await result;
  expect(f.sent).toHaveLength(0);
  f.control.dispose();
});

it("未请求EMPTY和超长帧不能认证", async function unsolicitedAndOversized() {
  for (const bytes of ["SRTJOB1\nEMPTY1\n", "SRTJOB1\nxxxxxxxxxxxxxxxx"]) {
    const f = fixture();
    f.input.end(bytes);
    await drain();
    await expect(f.control.stop()).rejects.toThrow();
    expect(f.sent).toHaveLength(0);
    f.control.dispose();
  }
});

it("停止后断连保持失败且重复调用不重发", async function disconnectedStop() {
  const f = fixture();
  f.input.write("SRTJOB1\n");
  await drain();
  const first = f.control.stop();
  const result = expect(first).rejects.toThrow("disconnected");
  await drain();
  f.input.end();
  await result;
  expect(f.control.stop()).toBe(first);
  expect(f.sent).toHaveLength(1);
  f.control.dispose();
});
