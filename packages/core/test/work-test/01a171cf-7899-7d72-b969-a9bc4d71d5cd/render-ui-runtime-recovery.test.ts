/** S1 恢复修复契约：真实 Runtime/Kernel/recorder 的同 Turn 预算与私有状态脱敏。 */
import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";
import { createAgentRuntime } from "../../../src/runtime/public/create-agent-runtime";
import { createRenderUiTool } from "../../../src/internal/tools/builtins/render-ui-tool";
import type { AgentEvent } from "../../../src/runtime/protocol";
import type { ModelSampler } from "../../../src/internal/kernel/model-sampler";
import type { AgentSampleResult } from "../../../src/internal/lib/llm";

/** 不同标题避免触发无关的重复参数护栏；始终使用同一安全组件目录。 */
function block(id: string) {
  return { title: `块${id}`, fallbackText: "文字说明", spec: { root: "text", elements: { text: { type: "Text", props: { value: "有限文字", size: "md", tone: "ink" } } } } };
}

/** 返回模型工具调用，不访问真实 Provider。 */
function call(id: string): AgentSampleResult { return { content: "", toolCalls: [{ id, name: "render_ui", input: block(id) }], reasoningSummary: "" }; }

/** 可复用同一控制对象给原 Runtime 或新 Runtime；只提供本地预设采样。 */
function controlledSampler() {
  let steps: AgentSampleResult[] = [];
  return {
    /** 替换后续采样序列，模拟同会话 continue。 */
    set(next: AgentSampleResult[]) { steps = [...next]; },
    sampler: {
      /** 消费预设调用后返回普通终答，所有执行均在内存内。 */
      async sample() { return steps.shift() ?? { content: "完成", toolCalls: [], reasoningSummary: "" }; },
    } satisfies ModelSampler,
  };
}

/** 收集公开 Runtime 事件，实际经过共享 recorder 与脱敏。 */
async function collect(stream: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const event of stream) events.push(event); return events; }

describe("render_ui durable Runtime recovery", function suite() {
  it.each(["same-runtime", "rebuilt-runtime", "transcript-repair", "web-rebuilt-runtime"])("%s 恢复同Turn仍拒绝第四块，另一Turn独立且私有预算不外泄", async function recovery(mode) {
    const ports = createMemoryPorts();
    const control = controlledSampler();
    const config = { modelSampler: control.sampler, chatLoader: async function capability() { return { interactiveUi: true as const }; }, maxSteps: 3 };
    let runtime = createAgentRuntime({ ports, defaultRunConfig: config });
    const sessionId = `session-${mode}`;
    const turnId = "turn-ui-recovery";
    const retrievalMode = mode === "web-rebuilt-runtime" ? "web" : "none";
    await runtime.sessions.create({ id: sessionId, productMode: "chat", chatRetrievalMode: retrievalMode });
    control.set([call("call-1"), call("call-2"), call("call-3")]);
    const first = await collect(runtime.turns.start({ sessionId, turnId, content: "创建交互内容" }));
    expect(first.filter(function ui(event) { return event.type === "ui_document"; })).toHaveLength(3);
    const checkpoint = await ports.checkpointStore.getLatest(sessionId);
    expect(checkpoint?.uiPublishedCallIds).toEqual(["call-1", "call-2", "call-3"]);
    expect(checkpoint?.completedCallIds).toEqual(expect.arrayContaining(["call-1", "call-2", "call-3"]));
    // 序列化后恢复，避免结果依赖同一对象引用；去掉字段模拟旧checkpoint或落盘窗口。
    const restored = JSON.parse(JSON.stringify(checkpoint));
    if (mode === "transcript-repair") delete restored.uiPublishedCallIds;
    await ports.checkpointStore.save(sessionId, restored);
    if (mode !== "same-runtime") runtime = createAgentRuntime({ ports, defaultRunConfig: config });
    control.set([call("call-4")]);
    const resumed = await collect(runtime.turns.continue({ sessionId, turnId }));
    expect(resumed.filter(function ui(event) { return event.type === "ui_document"; })).toEqual([]);
    expect(resumed.find(function fourth(event) { return event.type === "tool_result" && event.callId === "call-4"; })).toMatchObject({ result: { status: "error", error: { code: "INVALID_INPUT" } } });
    const durable = await ports.transcriptStore.getEvents(sessionId);
    expect(durable.filter(function ui(envelope) { return envelope.turnId === turnId && envelope.event.type === "ui_document"; })).toHaveLength(3);
    expect(JSON.stringify(durable)).not.toContain("uiPublishedCallIds");
    expect(JSON.stringify(await runtime.turns.getState({ sessionId }))).not.toContain("uiPublishedCallIds");
    control.set([call("new-turn-call")]);
    const next = await collect(runtime.turns.start({ sessionId, turnId: "turn-new", content: "新一轮" }));
    expect(next.filter(function ui(event) { return event.type === "ui_document"; })).toHaveLength(1);
  });

  it("校验失败或发布callback失败不占配额，恢复后的同callId不重发", async function invalidAndDuplicate() {
    const published: string[] = [];
    const tool = createRenderUiTool(function publish(callId) { if (callId === "not-published") throw new Error("fixture"); published.push(callId); });
    await expect(tool.execute({ ...block("bad"), spec: {} }, { permissionMode: "ask", toolCallId: "bad" })).rejects.toBeDefined();
    await expect(tool.execute(block("not-published"), { permissionMode: "ask", toolCallId: "not-published" })).rejects.toBeDefined();
    for (const callId of ["one", "two", "three"]) await tool.execute(block(callId), { permissionMode: "ask", toolCallId: callId });
    const recovered = createRenderUiTool(function publish(callId) { published.push(callId); }, [...published]);
    await recovered.execute(block("three"), { permissionMode: "ask", toolCallId: "three" });
    await expect(recovered.execute(block("four"), { permissionMode: "ask", toolCallId: "four" })).rejects.toBeDefined();
    expect(published).toEqual(["one", "two", "three"]);
  });
});
