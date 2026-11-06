/** S3定向契约：同一白名单模型目录与非法生成后的普通文字退路，不接真实Provider。 */
import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";
import { createAgentRuntime } from "../../../src/runtime/public/create-agent-runtime";
import { UI_COMPONENT_NAMES } from "../../../src/ui";
import type { ModelSampler } from "../../../src/internal/kernel/model-sampler";
import type { AgentEvent } from "../../../src/runtime/protocol";

describe("S3 render_ui generation guidance", function suite() {
  it("模型只收到同一14类目录，非法节点拒绝后可在原循环内用普通文字收口", async function fallback() {
    let samples = 0;
    const modelSampler: ModelSampler = {
      /** 先给非法UI再给文字，核对真实模型可见的唯一工具目录。 */
      async sample(_messages, tools, _options, onDelta) {
        if (samples === 0) {
          const ui = tools.find(function tool(item) { return item.function.name === "render_ui"; });
          expect(ui).toBeDefined();
          for (const name of UI_COMPONENT_NAMES) expect(ui!.function.description).toContain(`"${name}"`);
          expect(ui!.function.description).toContain("并排比较");
        } else {
          expect(tools).toEqual([]);
        }
        samples++;
        if (samples === 1) return { content: "", reasoningSummary: "", toolCalls: [{ id: "invalid-ui", name: "render_ui", input: { title: "错误样例", fallbackText: "说明", spec: { root: "x", elements: { x: { type: "UnknownNode", props: {} } } } } }] };
        onDelta?.("改用普通文字说明。");
        return { content: "改用普通文字说明。", reasoningSummary: "", toolCalls: [] };
      },
    };
    const runtime = createAgentRuntime({ ports: createMemoryPorts(), defaultRunConfig: { modelSampler, maxSteps: 3, chatLoader: async function capability() { return { interactiveUi: true }; } } });
    await runtime.sessions.create({ id: "s3-fallback", productMode: "chat", chatRetrievalMode: "none" });
    const events: AgentEvent[] = [];
    for await (const event of runtime.turns.start({ sessionId: "s3-fallback", content: "创建交互说明" })) events.push(event);
    expect(samples).toBe(2);
    expect(events.some(function dispatched(event) { return event.type === "tool_started"; })).toBe(false);
    expect(events.some(function document(event) { return event.type === "ui_document"; })).toBe(false);
    expect(events.find(function invalid(event) { return event.type === "tool_result"; })).toMatchObject({ result: { status: "error", error: { code: "INVALID_INPUT", message: expect.stringContaining("改用普通文字") } } });
    expect(events.some(function text(event) { return event.type === "answer_delta" && event.delta.includes("普通文字"); })).toBe(true);
    expect(events.at(-1)?.type).toBe("turn_completed");
    expect(JSON.stringify(events)).not.toContain("uiTextFallbackOnly");
  });
});
