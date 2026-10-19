/**
 * RAG Stage 1 契约测试：验证 Work 排除文档 RAG 后独立数据库的注册、结果回灌和 Turn 开关隔离。
 */

import { describe, expect, it, vi } from "vitest";
import { createMemoryPorts } from "../adapters/memory";
import { createAgentRuntime } from "../public/create-agent-runtime";
import type { AgentMessage } from "../../internal/types/agent-message";
import type { ModelSampler } from "../../internal/kernel/model-sampler";
import type { AgentModelToolDefinition } from "../../internal/lib/llm";

/** 创建测试 Session。 */
async function createSession(ports: ReturnType<typeof createMemoryPorts>, sessionId: string): Promise<void> {
  await ports.sessionStore.save({ id: sessionId, persistenceMode: "durable", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
}

/** 收集 Runtime 事件直到 Turn 终态。 */
async function collectEvents(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("RAG Stage 1 contract", function ragStage1ContractSuite() {
  it("数据库关闭时 RAG 与数据库工具均不可用", async function keepsDocumentRagWhenDatabaseDisabled() {
    const ports = createMemoryPorts();
    await createSession(ports, "rag-stage1-disabled");
    let visibleTools: string[] = [];
    const sampler: ModelSampler = {
      async sample(_messages: AgentMessage[], tools: AgentModelToolDefinition[]) {
        visibleTools = tools.map((tool) => tool.function.name);
        return { content: "完成", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" };
      },
    };
    const databaseSearch = vi.fn(async function shouldNotRun() { return { kind: "sql" as const, columns: [], rows: [], involvedTables: [], truncated: false, snapshotStatus: "current" as const }; });
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelSampler: sampler,
        rag: { async search() { return []; }, async searchAcrossTables() { return { results: [] }; }, async prepareRagSearch() { return { results: [] }; } },
        databaseSearch: { search: databaseSearch },
      },
    });

    await collectEvents(runtime.turns.start({ sessionId: "rag-stage1-disabled", content: "查文档", runConfig: { databaseSearchPolicy: { enabled: false } } }));
    expect(visibleTools).not.toContain("rag_search");
    expect(visibleTools).not.toContain("lancedb_query");
    expect(visibleTools).not.toContain("database_search");
    expect(databaseSearch).not.toHaveBeenCalled();
  });

  it("数据库开启时只执行数据库工具，旧 RAG 装配不进入 Provider", async function returnsSeparateToolResultsToProvider() {
    const ports = createMemoryPorts();
    await createSession(ports, "rag-stage1-enabled");
    const samples: Array<{ tools: string[]; messages: string }> = [];
    const sampler: ModelSampler = {
      async sample(messages: AgentMessage[], tools: AgentModelToolDefinition[]) {
        samples.push({ tools: tools.map((tool) => tool.function.name), messages: JSON.stringify(messages) });
        if (samples.length === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "database-call", name: "database_search", input: { kind: "sql", sql: "SELECT COUNT(*) AS total FROM fixture_items" } },
            ],
            reasoningSummary: "fixture",
            finishReason: "tool_calls",
          };
        }
        return { content: "完成", toolCalls: [], reasoningSummary: "fixture", finishReason: "stop" };
      },
    };
    const ragSearch = vi.fn(async function prepare(_query: string, _topK?: number, _tableName?: string, _focusedPdfFileName?: string, _focusedResourceId?: string) { return { results: [{ id: "document-marker" }], sources: [{ id: "document-marker" }] }; });
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        modelSampler: sampler,
        rag: {
          async search() { return []; },
          async searchAcrossTables() { return { results: [] }; },
          prepareRagSearch: ragSearch,
        },
        databaseSearch: {
          async search() { return { kind: "sql", columns: ["total"], rows: [{ total: "database-marker" }], involvedTables: ["fixture_items"], truncated: false, snapshotStatus: "current" }; },
        },
      },
    });

    const focusedResourceId = "resource_0123456789abcdef0123456789abcdef";
    await collectEvents(runtime.turns.start({ sessionId: "rag-stage1-enabled", content: "同时查文档和数据库", runConfig: { databaseSearchPolicy: { enabled: true }, ragSourcePolicy: { focusedResourceId } } }));
    expect(samples[0].tools).toEqual(expect.arrayContaining(["database_search"]));
    expect(samples[0].tools).not.toEqual(expect.arrayContaining(["snapshot_query", "database_query", "lancedb_query"]));
    expect(samples[0].tools).not.toContain("rag_search");
    expect(samples[1].messages).not.toContain("document-marker");
    expect(samples[1].messages).toContain("database-marker");
    expect(ragSearch).not.toHaveBeenCalled();
    const turn = await ports.turnStore.getLatest("rag-stage1-enabled");
    expect(turn?.frozenRunConfig.databaseSearchPolicy).toEqual({ enabled: true });
  });
});
