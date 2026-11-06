/** CLI 协作命令映射契约：验证参数整形、文件/stdin 读取与观察输出，不启动 Runtime。 */
import { describe, expect, it } from "vitest";
import type { ThreadFacade } from "@autopilot-agent/core";
import { CliThreadInputError, executeThreadCommand, type CliThreadCommandScope } from "../../src/thread-commands.js";
import type { CliThreadCommand } from "../../src/types.js";

/** 记录 Facade 入参并返回固定安全结果；事件首页有数据，后续为空。 */
function createScope(overrides: Partial<CliThreadCommandScope> = {}) {
  const calls = {
    send: [] as Array<Record<string, unknown>>,
    updateState: [] as Array<Record<string, unknown>>,
    wait: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
  };
  const writes: string[] = [];
  let pages = 0;
  const facade = {
    send: async function send(input: Record<string, unknown>) {
      calls.send.push(input);
      return { protocolVersion: 1, messageId: "m1", deliverySeq: 1, deliveryStatus: "pending" };
    },
    updateState: async function updateState(input: Record<string, unknown>) {
      calls.updateState.push(input);
      return { protocolVersion: 1, revision: Number(input.expectedRevision) + 1 };
    },
    wait: async function wait(input: Record<string, unknown>) {
      calls.wait.push(input);
      return { protocolVersion: 1, results: [], timedOut: false };
    },
    events: async function events(input: Record<string, unknown>) {
      calls.events.push(input);
      pages += 1;
      return { protocolVersion: 1, items: pages === 1 ? [{ groupId: "g1", groupSeq: 1, kind: "message_accepted" }] : [], cursor: "cursor-1" };
    },
  } as unknown as ThreadFacade;
  const scope: CliThreadCommandScope = {
    threads: facade,
    readFile: async function readFile(path: string) { return `content:${path}`; },
    readStdin: async function readStdin() { return "stdin 正文"; },
    write: function write(line: string) { writes.push(line); },
    signal: new AbortController().signal,
    pollIntervalMs: 10,
    ...overrides,
  };
  return { scope, calls, writes };
}

describe("CLI 协作命令映射", function threadCommandSuite() {
  it("send 从文件读取正文并透传交接摘要", async function sendsHandoffFromFiles() {
    const { scope, calls } = createScope();
    const command: CliThreadCommand = {
      type: "send",
      requestId: "req-1",
      groupId: "g1",
      threadId: "t1",
      mode: "run",
      contentSource: { kind: "file", path: "task.md" },
      handoff: { title: "交接", markdownFile: "summary.md" },
    };
    await expect(executeThreadCommand(command, scope)).resolves.toMatchObject({ exitCode: 0, result: { messageId: "m1" } });
    expect(calls.send).toEqual([{
      protocolVersion: 1,
      requestId: "req-1",
      groupId: "g1",
      threadId: "t1",
      mode: "run",
      content: "content:task.md",
      handoff: { title: "交接", markdown: "content:summary.md" },
    }]);
  });

  it("send 从 stdin 读取正文，空正文在投递前拒绝", async function rejectsEmptyStdin() {
    const { scope, calls } = createScope();
    await executeThreadCommand({ type: "send", requestId: "req", groupId: "g1", threadId: "t1", mode: "notify", contentSource: { kind: "stdin" } }, scope);
    expect(calls.send[0]).toMatchObject({ mode: "notify", content: "stdin 正文" });

    const empty = createScope({ readStdin: async function readStdin() { return "   "; } });
    await expect(executeThreadCommand({ type: "send", requestId: "req", groupId: "g1", threadId: "t1", mode: "notify", contentSource: { kind: "stdin" } }, empty.scope)).rejects.toBeInstanceOf(CliThreadInputError);
    expect(empty.calls.send).toHaveLength(0);
  });

  it("state set 解析内联 JSON 并只发一条 set 操作", async function updatesStateWithParsedJson() {
    const { scope, calls } = createScope();
    await executeThreadCommand({ type: "state_set", requestId: "req", groupId: "g1", expectedRevision: 2, key: "goal", value: { kind: "inline", json: "{\"steps\":[1,2]}" } }, scope);
    expect(calls.updateState).toEqual([{
      protocolVersion: 1,
      requestId: "req",
      groupId: "g1",
      expectedRevision: 2,
      operations: [{ op: "set", key: "goal", value: { steps: [1, 2] } }],
    }]);
    await expect(executeThreadCommand({ type: "state_set", requestId: "req", groupId: "g1", expectedRevision: 2, key: "goal", value: { kind: "inline", json: "not-json" } }, scope)).rejects.toBeInstanceOf(CliThreadInputError);
  });

  it("state remove 只提交 remove 操作", async function removesStateKey() {
    const { scope, calls } = createScope();
    await executeThreadCommand({ type: "state_remove", requestId: "req", groupId: "g1", expectedRevision: 3, key: "goal" }, scope);
    expect(calls.updateState).toEqual([{ protocolVersion: 1, requestId: "req", groupId: "g1", expectedRevision: 3, operations: [{ op: "remove", key: "goal" }] }]);
  });

  it("wait 透传目标、游标与中止信号", async function waitsWithSignal() {
    const controller = new AbortController();
    const { scope, calls } = createScope({ signal: controller.signal });
    await executeThreadCommand({ type: "wait", groupId: "g1", targets: [{ threadId: "a", cursor: "ca" }, { threadId: "b" }], timeoutMs: 1200 }, scope);
    expect(calls.wait).toEqual([{ protocolVersion: 1, groupId: "g1", targets: [{ threadId: "a", cursor: "ca" }, { threadId: "b" }], timeoutMs: 1200, signal: controller.signal }]);
  });

  it("watch 逐行输出事件，中止只结束本地观察", async function streamsEventsUntilAborted() {
    const controller = new AbortController();
    const { scope, calls, writes } = createScope({ signal: controller.signal, pollIntervalMs: 50 });
    const pending = executeThreadCommand({ type: "watch", groupId: "g1" }, scope);
    await new Promise<void>(function waitForFirstPage(resolve) { setTimeout(resolve, 20); });
    controller.abort();
    await expect(pending).resolves.toEqual({ exitCode: 0 });
    expect(writes).toEqual([JSON.stringify({ groupId: "g1", groupSeq: 1, kind: "message_accepted" })]);
    expect(calls.events).toHaveLength(1);
  });
});
