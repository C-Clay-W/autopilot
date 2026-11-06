/** 本轮Kernel/审批/静态准备回归，仅用fake sampler和任务自有临时HTML，不连接Provider。 */
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAgentRuntime } from "../../../src/internal/agent-runtime";
import { createAgentTextMessage, createAgentToolResultMessage, validateAgentMessages } from "../../../src/internal/types/agent-message";
import { createTodoWriteTool } from "../../../src/internal/tools/builtins/todo-write-tool";
import { createThreadTools } from "../../../src/internal/tools/builtins/thread-tools";
import { createOpenPreviewTool } from "../../../src/internal/tools/builtins/open-preview-tool";
import { PolicyEngine } from "../../../src/internal/tools/policy-engine";
import type { AgentThreadsCapability } from "../../../src/runtime/application/thread-tool-binding";
import type { JobService } from "../../../src/runtime/application/job-service";
import { prepareStaticPreview, resolveStaticPreviewFile, STATIC_PREVIEW_SCRIPT } from "../../../src/internal/tools/builtins/static-preview";

/** 构造最小fake工具能力，避免读真实会话。 */
function threads(wait: AgentThreadsCapability["wait"]) {
  return { wait, reportProgress: vi.fn(async function report() { return { progressSeq: 1, taskId: "task", taskProgressSeq: 1 }; }), readProgress: vi.fn(async function read() { return { items: [{ kind: "milestone", summary: "第一阶段完成，当前验证中" }], cursor: "progress-one", compacted: 0 }; }), send: vi.fn(async function send() { return { messageId: "steer", mode: "steer", expectedTurnId: "child-turn", deliverySeq: 1, deliveryStatus: "accepted" }; }) } as unknown as AgentThreadsCapability;
}

/** 收集一次独立内存Turn。 */
async function run(runtime: ReturnType<typeof createAgentRuntime>, text: string, signal?: AbortSignal) {
  const events = [];
  for await (const event of runtime.run({ turnId: "main-turn", messages: [createAgentTextMessage("user", text)], signal })) events.push(event);
  return events;
}

describe("持续观察", function followTests() {
  it("审批阶段正文不能completed，timeout不采样，批准后继续原task并消费差量摘要", async function followApproval() {
    let waits = 0; let samples = 0;
    const capability = threads(async function wait(input) {
      waits++;
      expect(input.targets[0].taskId).toBe("task");
      await new Promise(function tick(resolve) { setTimeout(resolve, 5); });
      const state = waits === 1 ? "waiting_approval" : waits < 4 ? "running" : "completed";
      return { results: [{ threadId: "child", taskId: "task", cursor: `wait-${waits}`, reason: waits === 1 ? "attention" : waits === 2 ? "timeout" : waits === 3 ? "progress" : "terminal", pendingProgress: waits === 3 ? 1 : 0, summary: { turnId: "child-turn", turnStatus: state } }], timedOut: waits === 2 };
    });
    const runtime = createAgentRuntime({ threads: capability, modelSampler: { async sample(messages) {
      validateAgentMessages(messages);
      samples++;
      return samples === 1 ? { content: "", toolCalls: [{ id: "wait", name: "wait_threads", input: { targets: [{ threadId: "child", taskId: "task" }], timeoutMs: 0, followUntilTerminal: true } }], reasoningSummary: "观察" } : { content: waits < 4 ? "阶段：请进入执行会话处理审批，我会继续观察。" : "原任务已完成", toolCalls: [], reasoningSummary: "汇报" };
    } } });
    const events = await run(runtime, "持续跟踪并按阶段汇报");
    expect(events.at(-1)?.type, (events.at(-1) as { error?: string }).error).toBe("turn_completed");
    expect(waits).toBe(4); expect(samples).toBe(4);
    expect(capability.readProgress).toHaveBeenCalledWith(expect.objectContaining({ threadId: "child", taskId: "task" }));
    expect(capability.send).toHaveBeenCalledWith(expect.objectContaining({ mode: "steer", expectedTurnId: "child-turn" }));
    expect(events.filter(function completed(event) { return event.type === "turn_completed"; })).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("turn_completed");
  });

  it("显式false撤销观察，用户措辞本身不建立或撤销责任", async function stopOrOnce() {
    for (const text of ["劳驾替我守着那边，有变化就说一声", "停止持续跟踪，只告诉我当前状态"]) {
      let samples = 0;
      const wait = vi.fn(async function snapshot() { return { results: [{ threadId: "child", taskId: "task", cursor: "c", reason: "attention" as const, pendingProgress: 0, summary: { turnId: "child-turn", turnStatus: "waiting_approval" } }], timedOut: false }; });
      const runtime = createAgentRuntime({ threads: threads(wait), modelSampler: { async sample() {
        samples++;
        return samples <= 2 ? { content: "", toolCalls: [{ id: `w-${samples}`, name: "wait_threads", input: { targets: [{ threadId: "child", taskId: "task" }], timeoutMs: 0, followUntilTerminal: samples === 1 } }], reasoningSummary: "按结构化合同观察或撤销" } : { content: "已结束当前观察", toolCalls: [], reasoningSummary: "回复" };
      } } });
      expect((await run(runtime, text)).at(-1)?.type).toBe("turn_completed"); expect(wait).toHaveBeenCalledTimes(2);
    }
    const wait = vi.fn();
    const runtime = createAgentRuntime({ threads: threads(wait), modelSampler: { async sample() { return { content: "仅回复当前状态", toolCalls: [], reasoningSummary: "回复" }; } } });
    expect((await run(runtime, "持续跟踪原任务")).at(-1)?.type).toBe("turn_completed"); expect(wait).not.toHaveBeenCalled();
  });

  it("后续模型依据历史run回执显式选择原task观察", async function restoreFromReceipt() {
    let samples = 0;
    const wait = vi.fn(async function terminal() { return { results: [{ threadId: "child", taskId: "original-task", cursor: "done", reason: "terminal" as const, pendingProgress: 0, summary: { turnId: "original-turn", turnStatus: "completed" } }], timedOut: false }; });
    const runtime = createAgentRuntime({ threads: threads(wait), modelSampler: { async sample() { samples++; return samples === 1 ? { content: "", toolCalls: [{ id: "new-watch", name: "wait_threads", input: { targets: [{ threadId: "child", taskId: "original-task" }], timeoutMs: 0, followUntilTerminal: true } }], reasoningSummary: "选择原task" } : { content: "原任务完成", toolCalls: [], reasoningSummary: "观察" }; } } });
    const messages = [createAgentTextMessage("user", "派工"), { role: "assistant" as const, content: [{ type: "tool-call" as const, id: "old-send", name: "send_thread", input: { threadId: "child", mode: "run", content: "原任务" } }] }, createAgentToolResultMessage({ toolCallId: "old-send", text: JSON.stringify({ status: "success", output: { mode: "run", taskId: "original-task" } }), isError: false }), createAgentTextMessage("user", "替我照看刚才那项委托")];
    const events = [];
    for await (const event of runtime.run({ turnId: "follow-up", messages })) events.push(event);
    expect(wait).toHaveBeenCalledWith(expect.objectContaining({ targets: [expect.objectContaining({ threadId: "child", taskId: "original-task" })] }));
    expect(samples).toBe(2); expect(events.at(-1)?.type).toBe("turn_completed");
  });

  it("用户取消会中断观察，不完成也不恢复目标", async function cancel() {
    const controller = new AbortController(); let calls = 0; let samples = 0;
    const capability = threads(async function wait(input) {
      calls++;
      if (calls > 1) { controller.abort(); return { results: [{ threadId: "child", taskId: "task", cursor: "c", reason: "aborted", pendingProgress: 0, summary: {} }], timedOut: false }; }
      return { results: [{ threadId: "child", taskId: "task", cursor: "c", reason: "attention", pendingProgress: 0, summary: { turnId: "child-turn", turnStatus: "waiting_approval" } }], timedOut: false };
    });
    const runtime = createAgentRuntime({ threads: capability, modelSampler: { async sample() { samples++; return samples === 1 ? { content: "", toolCalls: [{ id: "watch", name: "wait_threads", input: { targets: [{ threadId: "child", taskId: "task" }], timeoutMs: 0, followUntilTerminal: true } }], reasoningSummary: "观察" } : { content: "正在等待审批", toolCalls: [], reasoningSummary: "阶段" }; } } });
    const events = await run(runtime, "持续观察", controller.signal);
    expect(events.at(-1)?.type).toBe("turn_interrupted"); expect(capability.send).not.toHaveBeenCalled();
  });

  it("任意用户插话交回模型后，有界约定字段原样更新同一精确Turn", async function agreementChange() {
    let waits = 0; let samples = 0; let injected = false;
    const original = "  先别打扰我，只有卡住或交付时再说。\n";
    const changed = "每推进两个阶段给一句话，遇到阻塞马上告诉我；保留验证结论。";
    const capability = threads(async function wait() { waits++; return { results: [{ threadId: "child", taskId: "task", cursor: `c-${waits}`, reason: waits > 2 ? "terminal" : "snapshot", pendingProgress: 0, summary: { turnId: "child-turn", turnStatus: waits > 2 ? "completed" : "running" } }], timedOut: false }; });
    const runtime = createAgentRuntime({ threads: capability, inputInbox: { async drain() { if (!injected && waits === 1 && samples >= 2) { injected = true; return [{ inputId: "new-agreement", content: "换个节奏：两步说一声，卡住就叫我" }]; } return []; } }, modelSampler: { async sample(messages) {
      validateAgentMessages(messages); samples++;
      if (samples === 1 || (injected && waits === 1)) return { content: "", toolCalls: [{ id: `watch-${samples}`, name: "wait_threads", input: { targets: [{ threadId: "child", taskId: "task" }], timeoutMs: 0, followUntilTerminal: true, reportingInstructions: injected ? changed : original } }], reasoningSummary: "模型决定汇报约定" };
      return { content: waits < 3 ? "按新约定继续观察" : "完成", toolCalls: [], reasoningSummary: "汇报" };
    } } });
    const events = await run(runtime, "劳驾替我守着委托，照我的节奏来");
    expect(injected).toBe(true); expect(events.at(-1)?.type).toBe("turn_completed");
    expect(capability.send).toHaveBeenCalledWith(expect.objectContaining({ expectedTurnId: "child-turn", content: `【本次任务汇报约定更新】\n${original}` }));
    expect(capability.send).toHaveBeenCalledWith(expect.objectContaining({ expectedTurnId: "child-turn", content: `【本次任务汇报约定更新】\n${changed}` }));
    const schemas = createThreadTools(capability).waitThreads.inputSchema;
    expect(schemas.safeParse({ targets: [{ threadId: "child", taskId: "task" }], timeoutMs: 0, reportingInstructions: "x".repeat(1025) }).success).toBe(false);
  });

  it("无关键词的人类插话唤醒等待，再由模型显式撤销观察", async function steerWithdraws() {
    let waits = 0; let samples = 0; let ready = false; let consumed = false;
    const capability = threads(async function wait(input) {
      waits++;
      if (waits === 2) await new Promise<void>(function aborted(resolve) { input.signal!.addEventListener("abort", function wake() { resolve(); }, { once: true }); });
      return { results: [{ threadId: "child", taskId: "task", cursor: `c-${waits}`, reason: "attention", pendingProgress: 0, summary: { turnId: "child-turn", turnStatus: "waiting_approval" } }], timedOut: false };
    });
    const runtime = createAgentRuntime({ threads: capability, inputInbox: {
      async waitForInput() { if (!consumed) { await new Promise(function tick(resolve) { setTimeout(resolve, 5); }); ready = true; } },
      async drain() { if (ready && !consumed) { consumed = true; return [{ inputId: "different-plan", content: "换个安排，这会儿先收工吧" }]; } return []; },
    }, modelSampler: { async sample(messages) {
      validateAgentMessages(messages); samples++;
      if (samples === 3) expect(JSON.stringify(messages)).toContain("换个安排，这会儿先收工吧");
      return samples === 1 || samples === 3 ? { content: "", toolCalls: [{ id: `w-${samples}`, name: "wait_threads", input: { targets: [{ threadId: "child", taskId: "task" }], timeoutMs: 0, followUntilTerminal: samples === 1 } }], reasoningSummary: "模型决策" } : { content: consumed ? "已撤销观察" : "等待中", toolCalls: [], reasoningSummary: "回复" };
    } } });
    const events = await run(runtime, "劳驾照看那项委托");
    expect(consumed).toBe(true); expect(waits).toBe(3); expect(samples).toBe(4); expect(events.at(-1)?.type).toBe("turn_completed");
  });

  it("真实Todo阶段转换产生累计摘要", async function todoStage() {
    const capability = threads(vi.fn()); let samples = 0;
    const runtime = createAgentRuntime({ threads: capability, modelSampler: { async sample() { samples++; return samples <= 2 ? { content: "", toolCalls: [{ id: `todo-${samples}`, name: "todo_write", input: { todos: [{ content: "调查", activeForm: "调查中", status: samples === 1 ? "in_progress" : "completed" }, { content: "验证", activeForm: "验证中", status: samples === 1 ? "pending" : "in_progress" }] } }], reasoningSummary: "阶段" } : { content: "阶段已推进", toolCalls: [], reasoningSummary: "回复" }; } } });
    await run(runtime, "只读分析并记录阶段");
    expect(capability.reportProgress).toHaveBeenCalledWith(expect.objectContaining({ kind: "milestone", summary: expect.stringMatching(/当前 验证.*已完成 1\/2.*调查/u) }));
  });
});

describe("可信事实审批边界", function policyTests() {
  it("普通todo和内部read/report不审批，批量写集合仍审批，不按名字放行", async function policy() {
    const engine = new PolicyEngine(); const context = { permissionMode: "ask" as const };
    const todo = createTodoWriteTool(); const builtins = createThreadTools(threads(vi.fn()));
    for (const tool of [todo, builtins.readThread, builtins.waitThreads, builtins.reportProgress, builtins.readProgress]) {
      const facts = await tool.createActionFacts({ todos: [] } as never, context);
      expect(engine.evaluate({ context, facts, metadata: tool.metadata, grantMatched: false }).decision).toBe("allow");
    }
    const facts = await todo.createActionFacts({ todos: [], fileTargets: [{ path: "page.html", operation: "create" }] }, context);
    expect(engine.evaluate({ context, facts, metadata: todo.metadata, grantMatched: false }).decision).toBe("approval_required");
    expect(engine.evaluate({ context, facts: { toolName: "read_anything", effect: "external", destructive: false, requiresApproval: true }, metadata: { effect: "external", destructive: false } as never, grantMatched: false }).decision).toBe("approval_required");
  });
});

describe("受管静态预览准备", function staticTests() {
  it("无服务时只启动固定Job，后续复用相同Session/HTML并交真实URL给宿主", async function prepare() {
    const fixtures = path.resolve(process.cwd(), "../../.agent-tests/work-test/manual-followup-01a19eed/fixtures");
    await mkdir(fixtures, { recursive: true });
    const root = await mkdtemp(path.join(fixtures, "static-")); await writeFile(path.join(root, "page.html"), "<!doctype html><title>fixture</title>");
    let job: any; const start = vi.fn(async function start(input) { job = { ...input, id: "static-job", status: "running" }; return job; });
    const scoped = { list: async function list() { return { jobs: job ? [{ jobId: job.id, status: "running", controlState: "owned" }] : [] }; }, verifyServiceOwnership: async function own() { return "owned"; } };
    const jobs = { forSession: function scopedJobs() { return scoped; }, get: async function get() { return job; }, start } as unknown as JobService;
    const preparePreview = vi.fn(async function preview(input) { return { previewId: "preview", state: "prepared" as const, copyUrl: input.url, hostLabel: "127.0.0.1", openWhen: input.openWhen, jobId: input.jobId }; });
    const tool = createOpenPreviewTool({ capability: { preparePreview }, jobs, workspaceRoot: root, workspaceId: "workspace", sessionId: "owner", turnId: "turn" });
    const input = tool.inputSchema.parse({ staticPath: "page.html" }); await tool.validateInput?.(input, { permissionMode: "ask" });
    const context = { permissionMode: "ask" as const, sandboxPolicy: { execution: "host" as const, policy: { mode: "workspace-write" } as never } };
    const first = await tool.execute(input, context); const second = await tool.execute(input, context);
    expect(first.copyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/page\.html$/u); expect(second.copyUrl).toBe(first.copyUrl); expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toMatchObject({ sessionId: "owner", args: ["-e", STATIC_PREVIEW_SCRIPT, await resolveStaticPreviewFile(root, "page.html"), expect.any(String)] });
    expect(tool.inputSchema.safeParse({ staticPath: "page.html", url: "http://127.0.0.1:1" }).success).toBe(false);
    await expect(resolveStaticPreviewFile(root, "../page.html")).rejects.toBeDefined();
    await expect(prepareStaticPreview({ jobs, workspaceRoot: root, workspaceId: "workspace", sessionId: "other", turnId: "turn", staticPath: "page.html" }, { permissionMode: "ask" })).rejects.toBeDefined();
  });
});
