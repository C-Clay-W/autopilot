/** 验证子会话进展摘要的写入边界、游标差量、合并与容量淘汰；不启动真实 Provider。 */
import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createSessionService } from "../../src/runtime/application/session-service";
import { createThreadFacade } from "../../src/runtime/application/thread-service";
import { createThreadsToolBinding } from "../../src/runtime/application/thread-tool-binding";
import { createAgentRuntime as createPublicRuntime } from "../../src/runtime/public/create-agent-runtime";
import { createThreadTools } from "../../src/internal/tools/builtins/thread-tools";
import type { AgentLoopEvent } from "../../src/internal/agent-runtime";
import type { AgentSampleResult } from "../../src/internal/lib/llm";
import type { ModelSampler } from "../../src/internal/kernel/model-sampler";
import type { RuntimePorts } from "../../src/runtime/ports";
import type { ToolExecutionContext } from "../../src/internal/tools/types";

/** 宿主授权目录：与 Web/CLI 宿主保持同一最小集合。 */
const THREAD_TOOL_NAMES = ["create_thread", "list_threads", "read_thread", "send_thread", "wait_threads", "read_shared_state", "update_shared_state", "report_progress", "read_progress", "interrupt_thread"];

/** 工具执行上下文：本轮不触发审批。 */
function contextOf(callId: string): ToolExecutionContext {
  return { permissionMode: "ask", toolCallId: callId };
}

/** 一次模型工具调用；callId 稳定，用于派生幂等键。 */
function call(name: string, input: Record<string, unknown>, id: string): AgentSampleResult {
  return { content: "", toolCalls: [{ id, name, input }], reasoningSummary: "fixture", finishReason: "tool_calls" };
}

/** 预设步骤的采样器；同时记录每次实际组装给模型的输入，供上下文边界断言。 */
function capturingSampler(steps: AgentSampleResult[], captured: unknown[][]): ModelSampler {
  let index = 0;
  return {
    async sample(messages, _tools, _options, onDelta) {
      captured.push(messages);
      const result = steps[index++] ?? { content: "完成", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" as const };
      onDelta?.(result.content);
      return result;
    },
  };
}

/** 直接在存储中放一个 running Turn，模拟该会话正在执行中的 Turn。 */
async function startRunningTurn(ports: RuntimePorts, sessionId: string, turnId: string): Promise<void> {
  await ports.turnStore.save({ id: turnId, sessionId, status: "running", frozenRunConfig: {}, startedAt: ports.clock.now(), schemaVersion: 2 });
  const session = await ports.sessionStore.get(sessionId);
  await ports.sessionStore.save({ ...session!, status: "running", activeTurnId: turnId, updatedAt: ports.clock.now() });
}

/** 建立已启用协作组，并让子会话处于运行中以便回报进展。 */
async function setup() {
  const ports = createMemoryPorts();
  const sessions = createSessionService(ports);
  const root = await sessions.create({ title: "root" });
  const capability = { workspaceId: "workspace", stateRootId: "state-one", projectId: root.projectId!, allowedTools: THREAD_TOOL_NAMES, modelCatalog: [] };
  const human = createThreadFacade(ports, { ...capability, actor: { kind: "human", principalId: "user" } });
  const { group } = await human.enable({ protocolVersion: 1, requestId: "enable", rootThreadId: root.id });
  const child = await human.create({ protocolVersion: 1, groupId: group.groupId, parentThreadId: root.id, title: "child", requestId: "create-child" });
  const task = await human.send({ protocolVersion: 1, groupId: group.groupId, threadId: child.threadId, requestId: "run-child", mode: "run", content: "本次明确委派" });
  const control = (await ports.threadStore.readControl(group.groupId))!;
  await ports.threadStore.compareAndSetControl(group.groupId, control.revision, { ...control, revision: control.revision + 1, deliveries: control.deliveries.map(function bind(item) { return item.messageId === task.messageId ? { ...item, reservedTurnId: "turn-child", status: "claimed" as const } : item; }) });
  await startRunningTurn(ports, child.threadId, "turn-child");
  const tools = createThreadTools(createThreadsToolBinding(ports, capability, { threadId: child.threadId, turnId: "turn-child" }));
  return { ports, sessions, root, capability, human, group, child, tools };
}

describe("子会话进展摘要", function threadProgressContract() {
  it("按游标差量读取，重复回传不重复返回已读条目", async function cursorDiff() {
    const f = await setup();
    for (let n = 1; n <= 3; n++) await f.tools.reportProgress.execute({ kind: "progress", summary: `第 ${n} 步` }, contextOf(`call-p${n}`));
    const first = await f.tools.readProgress.execute({ threadId: f.child.threadId }, contextOf("call-read-1"));
    // 连续普通进度合并为一条，摘要取最新，条数只做计数。
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ kind: "progress", summary: "第 3 步", mergedCount: 3, progressSeq: 3 });
    expect(first.compacted).toBe(0);
    const again = await f.tools.readProgress.execute({ threadId: f.child.threadId, cursor: first.cursor }, contextOf("call-read-2"));
    expect(again.items).toEqual([]);
    expect(again.compacted).toBe(0);
    // 新增条目只返回增量，不重放已消费内容。
    await f.tools.reportProgress.execute({ kind: "blocked", summary: "等待审批" }, contextOf("call-p4"));
    const delta = await f.tools.readProgress.execute({ threadId: f.child.threadId, cursor: first.cursor }, contextOf("call-read-3"));
    expect(delta.items).toHaveLength(1);
    expect(delta.items[0]).toMatchObject({ kind: "blocked", summary: "等待审批", mergedCount: 1 });
  });

  it("密集普通进度合并后关键结论、阻塞与终态逐条保留", async function coalesceKeepsKeyFacts() {
    const f = await setup();
    for (let n = 1; n <= 5; n++) await f.tools.reportProgress.execute({ kind: "progress", summary: `进度 ${n}` }, contextOf(`call-a${n}`));
    await f.tools.reportProgress.execute({ kind: "milestone", summary: "定位到根因在投递回填" }, contextOf("call-milestone"));
    await f.tools.reportProgress.execute({ kind: "blocked", summary: "缺少目标工作区写权限" }, contextOf("call-blocked"));
    for (let n = 6; n <= 7; n++) await f.tools.reportProgress.execute({ kind: "progress", summary: `进度 ${n}` }, contextOf(`call-a${n}`));
    await f.tools.reportProgress.execute({ kind: "completed", summary: "定向测试全部通过" }, contextOf("call-completed"));
    const page = await f.tools.readProgress.execute({ threadId: f.child.threadId }, contextOf("call-read"));
    expect(page.items.map(function kind(item) { return item.kind; })).toEqual(["progress", "milestone", "blocked", "progress", "completed"]);
    expect(page.items[0]).toMatchObject({ summary: "进度 5", mergedCount: 5 });
    expect(page.items[3]).toMatchObject({ summary: "进度 7", mergedCount: 2 });
    expect(page.items[1]).toMatchObject({ summary: "定位到根因在投递回填", mergedCount: 1 });
    expect(page.items[4]).toMatchObject({ summary: "定向测试全部通过", mergedCount: 1 });
  });

  it("容量上限只淘汰最旧普通进度，关键条目不被丢弃", async function capacityCompaction() {
    const f = await setup();
    for (let n = 1; n <= 5; n++) await f.tools.reportProgress.execute({ kind: "progress", summary: `旧进度 ${n}` }, contextOf(`call-old${n}`));
    await f.tools.reportProgress.execute({ kind: "milestone", summary: "必须保留的结论" }, contextOf("call-keep"));
    for (let n = 1; n <= 30; n++) await f.tools.reportProgress.execute({ kind: "progress", summary: `新进度 ${n}` }, contextOf(`call-new${n}`));
    const page = await f.tools.readProgress.execute({ threadId: f.child.threadId }, contextOf("call-read"));
    // 36 条超过每目标 32 条上限：最旧的 4 条普通进度被淘汰，并以计数说明。
    expect(page.compacted).toBe(4);
    expect(page.items.map(function kind(item) { return item.kind; })).toEqual(["progress", "milestone", "progress"]);
    expect(page.items[1]).toMatchObject({ summary: "必须保留的结论", progressSeq: 6 });
    expect(page.items[2]).toMatchObject({ summary: "新进度 30", progressSeq: 36, mergedCount: 30 });
  });

  it("关键条目占满上限时拒绝新增，不静默丢弃", async function keyEntriesFull() {
    const f = await setup();
    for (let n = 1; n <= 32; n++) await f.tools.reportProgress.execute({ kind: "milestone", summary: `结论 ${n}` }, contextOf(`call-m${n}`));
    await expect(f.tools.reportProgress.execute({ kind: "milestone", summary: "第 33 条" }, contextOf("call-over")))
      .rejects.toMatchObject({ toolError: { code: "THREAD_STORAGE_FULL" } });
    const page = await f.tools.readProgress.execute({ threadId: f.child.threadId, limit: 50 }, contextOf("call-read"));
    expect(page.items).toHaveLength(32);
    expect(page.compacted).toBe(0);
  });

  it("write 只能由成员会话自报，读与证据引用不能越界", async function sourceIsolation() {
    const f = await setup();
    // 人类入口不能代替子会话写进展。
    await expect(f.human.reportProgress({ protocolVersion: 1, groupId: f.group.groupId, requestId: "human-write", kind: "progress", summary: "伪造" }))
      .rejects.toMatchObject({ code: "THREAD_SCOPE_DENIED" });
    // 模型不能自报来源或目标。
    expect(f.tools.reportProgress.inputSchema.safeParse({ kind: "progress", summary: "x", threadId: f.root.id }).success).toBe(false);
    // 证据只能是本会话的 Turn 或本组已提交消息。
    const other = await f.human.create({ protocolVersion: 1, groupId: f.group.groupId, parentThreadId: f.root.id, title: "other", requestId: "create-other" });
    await startRunningTurn(f.ports, other.threadId, "turn-other");
    await expect(f.tools.reportProgress.execute({ kind: "milestone", summary: "越界证据", evidence: { turnId: "turn-other" } }, contextOf("call-bad-turn")))
      .rejects.toMatchObject({ toolError: { code: "THREAD_SCOPE_DENIED" } });
    await expect(f.tools.reportProgress.execute({ kind: "milestone", summary: "越界证据", evidence: { messageId: "missing" } }, contextOf("call-bad-message")))
      .rejects.toMatchObject({ toolError: { code: "THREAD_SCOPE_DENIED" } });
    const ok = await f.tools.reportProgress.execute({ kind: "milestone", summary: "本会话结论", evidence: { turnId: "turn-child" } }, contextOf("call-good-evidence"));
    expect(ok.progressSeq).toBe(1);
    // 非成员会话不能读本组进展。
    const outsider = await f.sessions.create({ title: "outsider" });
    await startRunningTurn(f.ports, outsider.id, "turn-outsider");
    const outsiderTools = createThreadTools(createThreadsToolBinding(f.ports, f.capability, { threadId: outsider.id, turnId: "turn-outsider" }));
    await expect(outsiderTools.readProgress.execute({ threadId: f.child.threadId }, contextOf("call-outside")))
      .rejects.toMatchObject({ toolError: { code: "THREAD_SCOPE_DENIED" } });
  });

  it("同一调用重试不重复写入，同一 requestId 不同内容冲突", async function idempotentWrite() {
    const f = await setup();
    const first = await f.tools.reportProgress.execute({ kind: "progress", summary: "同一步骤" }, contextOf("call-same"));
    const retried = await f.tools.reportProgress.execute({ kind: "progress", summary: "同一步骤" }, contextOf("call-same"));
    expect(retried.progressSeq).toBe(first.progressSeq);
    await expect(f.tools.reportProgress.execute({ kind: "progress", summary: "换过的内容" }, contextOf("call-same")))
      .rejects.toMatchObject({ toolError: { code: "THREAD_REQUEST_CONFLICT" } });
    const page = await f.tools.readProgress.execute({ threadId: f.child.threadId }, contextOf("call-read"));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.mergedCount).toBe(1);
  });

  it("CAS 竞争后仍只写一次并保持单调序号", async function casRace() {
    const f = await setup();
    const original = f.ports.threadStore.compareAndSetControl.bind(f.ports.threadStore);
    let failOnce = true;
    f.ports.threadStore.compareAndSetControl = async function flaky(groupId, expected, value) {
      if (failOnce) { failOnce = false; return false; }
      return original(groupId, expected, value);
    };
    const written = await f.tools.reportProgress.execute({ kind: "progress", summary: "竞争后写入" }, contextOf("call-race"));
    expect(written.progressSeq).toBe(1);
    const page = await f.tools.readProgress.execute({ threadId: f.child.threadId }, contextOf("call-read"));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ summary: "竞争后写入", progressSeq: 1 });
  });

  it("进展落在持久聚合中，另一个服务实例仍能按游标读取", async function durableAcrossInstances() {
    const f = await setup();
    await f.tools.reportProgress.execute({ kind: "milestone", summary: "持久结论" }, contextOf("call-m"));
    const reopened = createThreadFacade(f.ports, { ...f.capability, actor: { kind: "human", principalId: "user" } });
    const page = await reopened.readProgress({ protocolVersion: 1, groupId: f.group.groupId, threadId: f.child.threadId });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ kind: "milestone", summary: "持久结论", mergedCount: 1 });
  });

  it("父模型只收到有界摘要：子会话原始日志不进入父上下文", async function boundedParentInput() {
    const f = await setup();
    for (let n = 1; n <= 12; n++) {
      await f.tools.reportProgress.execute({ kind: "progress", summary: `第 ${n} 轮：读取 gongwang 场景配置并核对渲染顺序，未发现新的阻塞` }, contextOf(`call-dense${n}`));
    }
    await f.tools.reportProgress.execute({ kind: "completed", summary: "子任务完成：定向测试通过" }, contextOf("call-done"));
    // 子会话展示历史里放一段只存在于子会话的原始日志；摘要读取不应带到父上下文。
    const childSession = await f.ports.sessionStore.get(f.child.threadId);
    await f.ports.sessionStore.save({ ...childSession!, presentation: { messages: [{ id: "raw-1", role: "assistant", content: "CHILD-RAW-LOG-9f2 命令输出：PASS 43 tests", createdAt: f.ports.clock.now() }] } });
    const captured: unknown[][] = [];
    const steps: AgentSampleResult[] = [call("read_progress", { threadId: f.child.threadId }, "call-progress")];
    const runtime = createPublicRuntime({ ports: f.ports, defaultRunConfig: { modelSampler: capturingSampler(steps, captured), permissionMode: "ask", threads: f.capability } });
    const events: AgentLoopEvent[] = [];
    for await (const event of runtime.turns.start({ sessionId: f.root.id, content: "查看子任务进展" })) events.push(event);
    expect(events.filter(function failed(event) { return event.type === "turn_failed"; })).toEqual([]);
    const result = events.find(function match(event) { return event.type === "tool_result" && event.callId === "call-progress"; });
    expect(result?.type).toBe("tool_result");
    const output = (result as { result?: { status?: string; output?: { items: Array<{ kind: string; mergedCount: number; summary: string }> } } }).result?.output;
    expect(output?.items).toHaveLength(2);
    expect(output?.items[0]).toMatchObject({ kind: "progress", mergedCount: 12 });
    expect(output?.items[1]).toMatchObject({ kind: "completed", summary: "子任务完成：定向测试通过" });
    // 实际组装给父模型的输入只含合并摘要，不含子会话原始日志，也没有 12 条逐条注入。
    const assembled = JSON.stringify(captured[captured.length - 1]);
    expect(assembled).toContain("子任务完成：定向测试通过");
    expect(assembled).not.toContain("CHILD-RAW-LOG-9f2");
    expect(assembled.match(/未发现新的阻塞/gu)?.length).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThan(4096);
  });
});
