/** Work 知识边界回归：拒绝旧工具/上下文/审批恢复，保留新任务和既有文件、Web、数据库机制。 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryPorts } from "../adapters/memory";
import { createAgentRuntime } from "../public/create-agent-runtime";
import { ToolExecutor } from "../../internal/tools/tool-executor";
import { ToolRegistry } from "../../internal/tools/tool-registry";
import { resolveTurnCapabilities } from "../application/turn/turn-capability-ceiling";

/** 收集实际 Runtime 生成器，保证检查发生在真正执行入口。 */
async function collect(events: AsyncIterable<unknown>) { const result = []; for await (const event of events) result.push(event); return result; }

/** 通过真实 SessionService 新建工作区任务，捕获所有采样上下文。 */
async function fixture() {
  const ports = createMemoryPorts("/fixture-work");
  const sample = vi.fn(async function answer() { return { content: "完成", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" }; });
  const runtime = createAgentRuntime({ ports, defaultRunConfig: { modelSampler: { sample } } });
  const session = await runtime.sessions.create({});
  return { ports, runtime, session, sample };
}

describe("Work 私有知识边界", function suite() {
  /** 验证真实 Runtime 仍装配 Work 基础任务工具，采样不触发文件、进程或网络操作。 */
  it("Stage7 Work 保留文件、命令、Job、Todo 和问答目录，私有知识工具缺席", async function preservesWorkCatalog() {
    const ports = createMemoryPorts("/fixture-work");
    const runtime = createAgentRuntime({
      ports,
      enableUserQuestions: true,
      defaultRunConfig: {
        workspaceRoot: "/fixture-work",
        modelSampler: {
          /** 精确比较实际模型目录，不用手工复制 Registry 或伪造执行 handler。 */
          async sample(_messages, tools) {
            expect(tools.map(function toolName(tool) { return tool.function.name; }).sort()).toEqual([
              "ask_user_question", "edit_file", "glob_files", "grep_files", "list_background_jobs", "read_background_job", "read_file", "run_command", "start_background_job", "stop_background_job", "todo_write", "write_file",
            ]);
            return { content: "目录已核对", reasoningSummary: "fixture", toolCalls: [] };
          },
        },
      },
    });
    const session = await runtime.sessions.create({});
    await collect(runtime.turns.start({ sessionId: session.id, content: "核对目录" }));
    expect((await runtime.turns.getState({ sessionId: session.id })).turn?.status).toBe("completed");
  });

  it("省略 mode 和伪造旧 allowlist 都不能注册或执行 RAG 兼容工具", async function rejectsLegacyTools() {
    for (const ceiling of [undefined, { productMode: "work" as const, allowedTools: ["rag_search", "lancedb_query", "read_file"] }]) {
      const registry = new ToolRegistry(ceiling);
      const execute = vi.fn();
      for (const name of ["rag_search", "lancedb_query"]) {
        registry.register({ name, description: "fixture", inputSchema: z.object({}), metadata: { effect: "none", destructive: false, concurrency: { max: 1 }, retry: { safe: false } }, createActionFacts: function facts() { return { toolName: name, effect: "none", destructive: false, operation: "read", risk: "read_only" }; }, execute, serializeOutput: function output(value) { return value; } });
        const executor = new ToolExecutor(registry, { capabilityCeiling: ceiling, permissionMode: "full_access", workspaceTrusted: true, agentFlow: { async search() { throw new Error("PRIVATE_CANARY"); } } });
        const result = await executor.execute({ callId: name, toolName: name, input: {} });
        expect(result).toMatchObject({ status: "error", error: { code: "CHAT_TOOL_FORBIDDEN" } });
      }
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("Turn override 和恢复配置都不装配 RAG/Rerank，既有 Work Web loader 仍工作", async function stripsCapabilities() {
    const { session } = await fixture();
    const webLoader = vi.fn(async function web() { return {}; });
    const rag = { async search() { throw new Error("PRIVATE_CANARY"); }, async searchAcrossTables() { throw new Error("PRIVATE_CANARY"); }, async prepareRagSearch() { throw new Error("PRIVATE_CANARY"); } };
    for (const continuing of [false, true]) {
      const result = await resolveTurnCapabilities({ session, turnId: "turn", runtimeDefault: { rag, webLoader }, override: { rag, ragSourcePolicy: { focusedResourceId: "old-ref" }, toolAllowlist: ["rag_search", "read_file"] }, frozen: {}, continuing, now: 1 });
      expect(result.capabilities.rag).toBeUndefined();
      expect(result.frozen).toMatchObject({ workContextVersion: 1, capabilityCeiling: { allowedTools: ["read_file"] } });
      expect(result.frozen.ragSourcePolicy).toBeUndefined();
    }
    expect(webLoader).toHaveBeenCalledTimes(2);
  });

  it("新 Work 可连续执行；旧知识 Turn 阻断 start/continue/compact，查询不改写原记录", async function blocksLegacyHistory() {
    const f = await fixture();
    await collect(f.runtime.turns.start({ sessionId: f.session.id, content: "STAGE7_LEGACY_PRIVATE_CANARY" }));
    await collect(f.runtime.turns.start({ sessionId: f.session.id, content: "任务二" }));
    expect(f.sample).toHaveBeenCalledTimes(2);
    const turn = (await f.ports.turnStore.getLatest(f.session.id))!;
    delete turn.frozenRunConfig.workContextVersion;
    await f.ports.turnStore.save(turn);
    const before = JSON.stringify({ turns: await f.ports.turnStore.list(f.session.id), checkpoint: await f.ports.checkpointStore.getLatest(f.session.id), events: await f.ports.transcriptStore.getEvents(f.session.id) });
    expect((await f.runtime.turns.getState({ sessionId: f.session.id })).readOnlyReason).toBe("WORK_HISTORY_READ_ONLY");
    expect(await f.runtime.turns.getRecoverableState({ sessionId: f.session.id })).toBeNull();
    await expect(collect(f.runtime.turns.start({ sessionId: f.session.id, content: "不要带入旧知识" }))).rejects.toMatchObject({ code: "WORK_HISTORY_READ_ONLY" });
    await expect(collect(f.runtime.turns.continue({ sessionId: f.session.id, turnId: turn.id, approval: { approvalId: "old", decision: "allow" } }))).rejects.toMatchObject({ code: "WORK_HISTORY_READ_ONLY" });
    await expect(f.runtime.turns.compact({ sessionId: f.session.id, turnId: turn.id, trigger: "manual" })).rejects.toMatchObject({ code: "WORK_HISTORY_READ_ONLY" });
    await expect(collect(f.runtime.turns.start({ sessionId: f.session.id, content: "旧队列", continuity: { source: "claimed_queue" } }))).rejects.toMatchObject({ code: "WORK_HISTORY_READ_ONLY" });
    expect(f.sample).toHaveBeenCalledTimes(2);
    expect(JSON.stringify({ turns: await f.ports.turnStore.list(f.session.id), checkpoint: await f.ports.checkpointStore.getLatest(f.session.id), events: await f.ports.transcriptStore.getEvents(f.session.id) })).toBe(before);
    // 同一 Runtime 的新 Work 任务可以执行，但不能自动继承旧任务的上下文。
    const fresh = await f.runtime.sessions.create({});
    await collect(f.runtime.turns.start({ sessionId: fresh.id, content: "新任务" }));
    expect(f.sample).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(f.sample.mock.calls.at(-1))).not.toContain("STAGE7_LEGACY_PRIVATE_CANARY");
  });

  it("旧展示记录不能通过 Session.save 升级成可信 Work 来源", async function blocksForgedProvenance() {
    const f = await fixture();
    const legacy = { ...f.session, workContextVersion: undefined, presentation: { messages: [{ id: "old", role: "assistant" as const, content: "PRIVATE_CANARY", createdAt: 1 }] } };
    await f.ports.sessionStore.save(legacy);
    await expect(f.runtime.sessions.save({ ...legacy, workContextVersion: 1 })).rejects.toMatchObject({ code: "SESSION_MODE_MISMATCH" });
    await expect(collect(f.runtime.turns.start({ sessionId: f.session.id, content: "继续" }))).rejects.toMatchObject({ code: "WORK_HISTORY_READ_ONLY" });
    expect(f.sample).not.toHaveBeenCalled();
  });
});
