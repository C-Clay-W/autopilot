/** S3 一次性离线诊断：保留原断言，仅输出采样边界、固定断言标签与安全事件。 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";
import { createAgentRuntime } from "../../../src/runtime/public/create-agent-runtime";
import { UI_COMPONENT_NAMES } from "../../../src/ui";
import type { ModelSampler } from "../../../src/internal/kernel/model-sampler";
import type { AgentEvent } from "../../../src/runtime/protocol";

describe("S3 isolated fallback diagnosis", function suite() {
  it("仅采集sampler边界和原断言结果，不代表修复通过", async function diagnose() {
    const root = path.resolve("../../.agent-tests/work-test/01a17177-204c-7123-8aa1-8f8982f3a069/runs/fallback-diagnosis-20261026");
    fs.mkdirSync(root, { recursive: true });
    let entries = 0;
    let samples = 0;
    const checks: Array<{ label: string; entry: number; passed: boolean }> = [];
    const boundaries: Array<{ entry: number; point: string; samples: number }> = [];
    const events: AgentEvent[] = [];
    const safeEvents: Array<{ type: string; errorCode?: string }> = [];
    let diagnosticStatus = "collected";
    /** 捕获原断言结果，只保留固定标签，不序列化底层异常。 */
    function check(label: string, assertion: () => void): boolean {
      try { assertion(); checks.push({ label, entry: entries, passed: true }); return true; }
      catch { checks.push({ label, entry: entries, passed: false }); return false; }
    }
    /** 前置断言失败仍中断本次sample，保持原测试的执行路径。 */
    function requireCheck(label: string, assertion: () => void): void {
      if (!check(label, assertion)) throw new Error("S3_DIAGNOSTIC_PRECONDITION_FAILED");
    }
    const modelSampler: ModelSampler = {
      /** 仅在原计数前后插入边界；原工具与说明断言保持不变。 */
      async sample(_messages, tools, _options, onDelta) {
        entries++;
        boundaries.push({ entry: entries, point: "sampler-entered", samples });
        const ui = tools.find(function tool(item) { return item.function.name === "render_ui"; });
        requireCheck("PRE_UI_PRESENT", function assertUi() { expect(ui).toBeDefined(); });
        for (const name of UI_COMPONENT_NAMES) requireCheck(`PRE_COMPONENT_${name}`, function assertComponent() { expect(ui!.function.description).toContain(`"${name}"`); });
        requireCheck("PRE_COMPARISON_PHRASE", function assertPhrase() { expect(ui!.function.description).toContain("并排比较"); });
        samples++;
        boundaries.push({ entry: entries, point: "counter-incremented", samples });
        if (samples === 1) return { content: "", reasoningSummary: "", toolCalls: [{ id: "invalid-ui", name: "render_ui", input: { title: "错误样例", fallbackText: "说明", spec: { root: "x", elements: { x: { type: "UnknownNode", props: {} } } } } }] };
        onDelta?.("改用普通文字说明。");
        return { content: "改用普通文字说明。", reasoningSummary: "", toolCalls: [] };
      },
    };
    try {
      const runtime = createAgentRuntime({ ports: createMemoryPorts(), defaultRunConfig: { modelSampler, maxSteps: 3, chatLoader: async function capability() { return { interactiveUi: true }; } } });
      await runtime.sessions.create({ id: "s3-fallback", productMode: "chat", chatRetrievalMode: "none" });
      for await (const event of runtime.turns.start({ sessionId: "s3-fallback", content: "创建交互说明" })) {
        events.push(event);
        const safe: { type: string; errorCode?: string } = { type: event.type };
        if (event.type === "tool_result" && event.result.status === "error") {
          const allowed = ["INVALID_INPUT", "TOOL_NOT_FOUND", "TOOL_EXECUTION_FAILED", "TOOL_TIMEOUT", "TOOL_CANCELLED"];
          safe.errorCode = allowed.includes(event.result.error.code) ? event.result.error.code : "OTHER_TOOL_ERROR";
        }
        safeEvents.push(safe);
      }
      check("FINAL_SAMPLE_COUNT_2", function assertCount() { expect(samples).toBe(2); });
      check("FINAL_NO_UI_DOCUMENT", function assertNoUi() { expect(events.some(function document(event) { return event.type === "ui_document"; })).toBe(false); });
      check("FINAL_INVALID_INPUT_FALLBACK_MESSAGE", function assertError() { expect(events.find(function invalid(event) { return event.type === "tool_result"; })).toMatchObject({ result: { status: "error", error: { code: "INVALID_INPUT", message: expect.stringContaining("改用普通文字") } } }); });
      check("FINAL_PLAIN_TEXT", function assertText() { expect(events.some(function text(event) { return event.type === "answer_delta" && event.delta.includes("普通文字"); })).toBe(true); });
      check("FINAL_TURN_COMPLETED", function assertTerminal() { expect(events.at(-1)?.type).toBe("turn_completed"); });
    } catch { diagnosticStatus = "diagnostic-stream-failed"; }
    finally {
      fs.writeFileSync(path.join(root, "safe-summary.json"), JSON.stringify({ diagnosticStatus, entries, samples, boundaries, checks, events: safeEvents, terminal: safeEvents.at(-1)?.type ?? "not-observed", providerHttpRequests: 0 }, null, 2));
    }
    if (diagnosticStatus !== "collected" || checks.some(function failed(item) { return !item.passed; })) throw new Error("S3_DIAGNOSTIC_RECORDED_UNRESOLVED_ASSERTIONS");
  });
});
