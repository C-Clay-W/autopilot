/** CLI 协作命令 parser 契约：只校验语法、选项归属与局部值，不触碰 Runtime。 */
import { describe, expect, it } from "vitest";
import { parseArgv } from "../../src/parser.js";

/** 断言解析成功并返回命令树。 */
function commandOf(argv: readonly string[]) {
  const parsed = parseArgv(argv);
  if (parsed.kind !== "command") throw new Error(`expected command, got ${parsed.kind}`);
  return parsed.invocation.command;
}

/** 提取协作命令树；非协作命令视为用例错误。 */
function threadOf(argv: readonly string[]) {
  const command = commandOf(argv);
  if (command.type !== "thread") throw new Error("expected thread command");
  return command.command;
}

/** 断言解析失败并返回固定错误文案。 */
function errorOf(argv: readonly string[]) {
  const parsed = parseArgv(argv);
  if (parsed.kind !== "error") throw new Error(`expected error, got ${parsed.kind}`);
  return parsed.message;
}

describe("CLI 协作命令 parser", function threadParserSuite() {
  it("解析 group enable/disable 与宿主选项", function parsesGroupCommands() {
    expect(parseArgv(["thread", "group", "enable", "--thread", "root-1", "--request-id", "req-1", "--state-root", "C:/state"])).toEqual({
      kind: "command",
      invocation: {
        command: { type: "thread", command: { type: "group_enable", requestId: "req-1", rootThreadId: "root-1" } },
        host: { stateRoot: "C:/state" },
      },
    });
    expect(commandOf(["thread", "group", "disable", "--group", "g1", "--request-id", "req-2"])).toEqual({
      type: "thread",
      command: { type: "group_disable", requestId: "req-2", groupId: "g1" },
    });
    expect(errorOf(["thread", "group", "enable", "--group", "g1", "--request-id", "r"])).toBe("thread 命令需要且只接受一个 --thread");
    expect(errorOf(["thread", "group"])).toBe("thread group 支持 enable|disable");
  });

  it("解析 create 的父会话、模型与推理强度", function parsesCreate() {
    expect(commandOf(["thread", "create", "--group", "g1", "--thread", "root-1", "--request-id", "req", "--title", "执行", "--role", "executor", "--model", "firstParty/claude", "--effort", "high"])).toEqual({
      type: "thread",
      command: {
        type: "create",
        requestId: "req",
        groupId: "g1",
        parentThreadId: "root-1",
        title: "执行",
        roleLabel: "executor",
        modelRef: { provider: "firstParty", modelId: "claude" },
        reasoningEffort: "high",
      },
    });
    expect(errorOf(["thread", "create", "--group", "g1", "--thread", "root-1", "--request-id", "req", "--model", "claude"])).toBe("--model 需要 provider/modelId");
    expect(errorOf(["thread", "create", "--group", "g1", "--thread", "root-1", "--request-id", "req", "--effort", "maximal"])).toBe("--effort 支持 none|low|medium|high|max");
  });

  it("解析 list/read 的游标与条数，并拒绝越界值", function parsesListAndRead() {
    expect(commandOf(["thread", "list", "--group", "g1", "--limit", "5", "--cursor", "c1"])).toEqual({
      type: "thread",
      command: { type: "list", groupId: "g1", limit: 5, cursor: "c1" },
    });
    expect(commandOf(["thread", "read", "--group", "g1", "--thread", "t1"])).toEqual({
      type: "thread",
      command: { type: "read", groupId: "g1", threadId: "t1" },
    });
    expect(errorOf(["thread", "list", "--group", "g1", "--limit", "101"])).toBe("--limit 必须在 1-100 之间");
    expect(errorOf(["thread", "read", "--group", "g1"])).toBe("thread 命令需要且只接受一个 --thread");
  });

  it("send 必须显式模式，正文只允许文件或 stdin 二选一", function parsesSendSources() {
    expect(commandOf(["thread", "send", "--group", "g1", "--thread", "t1", "--mode", "run", "--request-id", "req", "--message-file", "task.md", "--reply-to", "m0"])).toEqual({
      type: "thread",
      command: { type: "send", requestId: "req", groupId: "g1", threadId: "t1", mode: "run", contentSource: { kind: "file", path: "task.md" }, replyTo: "m0" },
    });
    expect(commandOf(["thread", "send", "--group", "g1", "--thread", "t1", "--mode", "notify", "--request-id", "req", "--message-stdin"])).toEqual({
      type: "thread",
      command: { type: "send", requestId: "req", groupId: "g1", threadId: "t1", mode: "notify", contentSource: { kind: "stdin" } },
    });
    expect(errorOf(["thread", "send", "--group", "g1", "--thread", "t1", "--request-id", "req", "--message-file", "a.md"])).toBe("thread 命令需要且只接受一个 --mode");
    expect(errorOf(["thread", "send", "--group", "g1", "--thread", "t1", "--mode", "run", "--request-id", "req"])).toBe("正文需要 --message-file 或 --message-stdin 二选一");
    expect(errorOf(["thread", "send", "--group", "g1", "--thread", "t1", "--mode", "run", "--request-id", "req", "--message-file", "a.md", "--message-stdin"])).toBe("正文需要 --message-file 或 --message-stdin 二选一");
  });

  it("steer 必须匹配 expected turn，其他模式禁止该字段", function validatesSteer() {
    expect(commandOf(["thread", "send", "--group", "g1", "--thread", "t1", "--mode", "steer", "--request-id", "req", "--message-stdin", "--expected-turn-id", "turn-1"])).toMatchObject({
      command: { mode: "steer", expectedTurnId: "turn-1" },
    });
    expect(errorOf(["thread", "send", "--group", "g1", "--thread", "t1", "--mode", "steer", "--request-id", "req", "--message-stdin"])).toBe("--mode steer 必须提供 --expected-turn-id");
    expect(errorOf(["thread", "send", "--group", "g1", "--thread", "t1", "--mode", "run", "--request-id", "req", "--message-stdin", "--expected-turn-id", "turn-1"])).toBe("只有 --mode steer 接受 --expected-turn-id");
  });

  it("交接只允许 run，且标题与文档必须成对出现", function validatesHandoff() {
    expect(commandOf(["thread", "send", "--group", "g1", "--thread", "t1", "--mode", "run", "--request-id", "req", "--message-stdin", "--handoff-title", "交接", "--handoff-file", "summary.md"])).toMatchObject({
      command: { handoff: { title: "交接", markdownFile: "summary.md" } },
    });
    expect(errorOf(["thread", "send", "--group", "g1", "--thread", "t1", "--mode", "run", "--request-id", "req", "--message-stdin", "--handoff-title", "交接"])).toBe("交接需要同时提供 --handoff-title 与 --handoff-file");
    expect(errorOf(["thread", "send", "--group", "g1", "--thread", "t1", "--mode", "notify", "--request-id", "req", "--message-stdin", "--handoff-title", "交接", "--handoff-file", "summary.md"])).toBe("交接只允许 --mode run");
  });

  it("wait 支持多个目标与逐目标游标", function parsesWaitTargets() {
    expect(commandOf(["thread", "wait", "--group", "g1", "--thread", "a", "--thread", "b", "--cursor", "a=cursor-a", "--timeout-ms", "1500"])).toEqual({
      type: "thread",
      command: { type: "wait", groupId: "g1", targets: [{ threadId: "a", cursor: "cursor-a" }, { threadId: "b" }], timeoutMs: 1500 },
    });
    expect(threadOf(["thread", "wait", "--group", "g1", "--thread", "a"])).toMatchObject({ timeoutMs: 30_000 });    expect(errorOf(["thread", "wait", "--group", "g1"])).toBe("thread wait 需要 1-8 个 --thread");
    expect(errorOf(["thread", "wait", "--group", "g1", "--thread", "a", "--thread", "a"])).toBe("thread wait 的 --thread 不能重复");
    expect(errorOf(["thread", "wait", "--group", "g1", "--thread", "a", "--cursor", "b=c1"])).toBe("--cursor 的目标 b 不在 --thread 列表中");
    expect(errorOf(["thread", "wait", "--group", "g1", "--thread", "a", "--timeout-ms", "30001"])).toBe("--timeout-ms 必须在 0-30000 之间");
  });

  it("state 读写必须给 revision，取值只接受内联或文件二选一", function parsesStateCommands() {
    expect(commandOf(["thread", "state", "read", "--group", "g1"])).toEqual({ type: "thread", command: { type: "state_read", groupId: "g1" } });
    expect(commandOf(["thread", "state", "set", "--group", "g1", "--request-id", "req", "--expected-revision", "3", "--key", "goal", "--value", "\"完成\""])).toEqual({
      type: "thread",
      command: { type: "state_set", requestId: "req", groupId: "g1", expectedRevision: 3, key: "goal", value: { kind: "inline", json: "\"完成\"" } },
    });
    expect(commandOf(["thread", "state", "remove", "--group", "g1", "--request-id", "req", "--expected-revision", "4", "--key", "goal"])).toMatchObject({
      command: { type: "state_remove", expectedRevision: 4, key: "goal" },
    });
    expect(errorOf(["thread", "state", "set", "--group", "g1", "--request-id", "req", "--key", "goal", "--value", "1"])).toBe("thread 命令需要且只接受一个 --expected-revision");
    expect(errorOf(["thread", "state", "set", "--group", "g1", "--request-id", "req", "--expected-revision", "1", "--key", "goal"])).toBe("thread state set 需要 --value 或 --value-file 二选一");
    expect(errorOf(["thread", "state", "remove", "--group", "g1", "--request-id", "req", "--expected-revision", "1", "--key", "goal", "--value", "1"])).toBe("thread state remove 不接受 --value/--value-file");
  });

  it("解析 interrupt 与 watch", function parsesInterruptAndWatch() {
    expect(commandOf(["thread", "interrupt", "--group", "g1", "--thread", "t1", "--expected-turn-id", "turn-1", "--request-id", "req"])).toEqual({
      type: "thread",
      command: { type: "interrupt", requestId: "req", groupId: "g1", threadId: "t1", expectedTurnId: "turn-1" },
    });
    expect(commandOf(["thread", "watch", "--group", "g1", "--cursor", "c1"])).toEqual({
      type: "thread",
      command: { type: "watch", groupId: "g1", cursor: "c1" },
    });
    expect(errorOf(["thread", "interrupt", "--group", "g1", "--thread", "t1", "--request-id", "req"])).toBe("thread 命令需要且只接受一个 --expected-turn-id");
  });

  it("拒绝未知子命令、未知选项、缺值与位置参数", function rejectsInvalidSyntax() {
    expect(errorOf(["thread"])).toBe("thread 支持 group|create|list|read|send|wait|state|interrupt|watch");
    expect(errorOf(["thread", "unknown"])).toBe("未知 thread 子命令 unknown");
    expect(errorOf(["thread", "list", "--group", "g1", "--bogus", "x"])).toBe("未知选项 --bogus");
    expect(errorOf(["thread", "list", "--group"])).toBe("选项 --group 需要一个值");
    expect(errorOf(["thread", "list", "--group", "g1", "extra"])).toBe("thread list 不接受位置参数：extra");
    // 协作选项不能泄漏给其他命令。
    expect(errorOf(["session", "list", "--group", "g1"])).toBe("未知选项 --group");
  });
});
