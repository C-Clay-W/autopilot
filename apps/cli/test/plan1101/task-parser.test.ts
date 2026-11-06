/** Plan1101 S2：CLI 显式任务观察身份透传，不启动 Runtime。 */
import { expect, it } from "vitest";
import { executeThreadCommand, type CliThreadCommandScope } from "../../src/thread-commands.js";
import { parseArgv } from "../../src/parser.js";

/** 任务只绑定指定目标；缺省仍为会话观察，非法或重复目标拒绝。 */
it("thread wait 显式任务绑定及歧义拒绝", function taskWait() {
  const result = parseArgv(["thread", "wait", "--group", "g", "--thread", "b", "--task", "b=message", "--timeout-ms", "0"]);
  expect(result).toMatchObject({ kind: "command", invocation: { command: { type: "thread", command: { type: "wait", targets: [{ threadId: "b", taskId: "message" }], timeoutMs: 0 } } } });
  expect(parseArgv(["thread", "wait", "--group", "g", "--thread", "b", "--task", "c=message"])).toMatchObject({ kind: "error" });
  expect(parseArgv(["thread", "wait", "--group", "g", "--thread", "b", "--task", "b=m1", "--task", "b=m2"])).toMatchObject({ kind: "error" });
});

/** 关联只透传显式目标，不启动模型或把请求伪造为 thread actor。 */
it("thread associate 将人类显式目标交给既有受信Facade", async function explicitAssociate() {
  const parsed = parseArgv(["thread", "associate", "--group", "g", "--thread", "b", "--request-id", "join"]);
  if (parsed.kind !== "command" || parsed.invocation.command.type !== "thread") throw new Error("expected thread");
  const calls: unknown[] = [];
  const scope = { threads: { associate: async function associate(input: unknown) { calls.push(input); return { groupId: "g", threadId: "b" }; } } } as unknown as CliThreadCommandScope;
  expect(await executeThreadCommand(parsed.invocation.command.command, scope)).toMatchObject({ exitCode: 0, result: { groupId: "g", threadId: "b" } });
  expect(calls).toEqual([{ protocolVersion: 1, groupId: "g", threadId: "b", requestId: "join" }]);
});
