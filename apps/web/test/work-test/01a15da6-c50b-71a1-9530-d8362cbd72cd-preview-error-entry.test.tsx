/**
 * Tester r001 integration artifact: synthetic WorkPreviewService failures through
 * the actual Core open_preview/ToolExecutor and Web Presentation entry.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createAgentRuntime, createMemoryPorts, type AgentEvent, type ModelSampler } from "@autopilot-agent/core";
import { replayWebPresentation } from "@/lib/runtime-host/web-presentation-adapter";
import TurnPresentation from "@/app/chat/components/TurnPresentation";
import { createWorkPreviewService } from "@/lib/workspace-host/work-preview-service";
import type { ProbeResult } from "@/lib/workspace-host/work-preview-readiness";

const PRIVATE_CANARY = "PRIVATE_PREVIEW_QUERY_CANARY";
const WORKSPACE_ROOT = "/tmp/work-progress-error-entry";

const failureCases: Array<{ name: string; result: ProbeResult; code: string; display: string; modelText: string }> = [
  { name: "404", result: { state: "unavailable", reason: "http_status", status: 404 }, code: "PREVIEW_PAGE_NOT_FOUND", display: "预览页面不存在（HTTP 404）", modelText: "HTTP 404" },
  { name: "HTTP 503", result: { state: "unavailable", reason: "http_status", status: 503 }, code: "PREVIEW_HTTP_ERROR", display: "预览地址返回 HTTP 错误", modelText: "HTTP 503" },
  { name: "连接失败", result: { state: "unavailable", reason: "connection_refused" }, code: "PREVIEW_CONNECTION_FAILED", display: "无法连接预览地址", modelText: "无法连接预览地址" },
  { name: "探测超时", result: { state: "unavailable", reason: "timeout" }, code: "PREVIEW_PROBE_TIMEOUT", display: "预览地址检查超时", modelText: "预览地址检查超时" },
  { name: "探测取消", result: { state: "unavailable", reason: "aborted" }, code: "PREVIEW_PROBE_ABORTED", display: "预览地址检查已取消", modelText: "预览地址检查已取消" },
];

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function renderWorkTurn(state: ReturnType<typeof replayWebPresentation>, turnId: string): string {
  return renderToStaticMarkup(
    <TurnPresentation
      state={state}
      turnId={turnId}
      showThinking={false}
      productMode="work"
      onApprovalDecision={function ignore() {}}
      onUserQuestionSubmit={async function ignore() {}}
      onUserQuestionCancel={async function ignore() {}}
    />,
  );
}

describe("WorkPreviewError → Core ToolExecutor → model/transcript → Web Presentation", function suite() {
  it.each(failureCases)("$name 通过真实 capability 错误入口保留类别并公开展示", async function reachesModelAndDisplay(testCase) {
    const service = createWorkPreviewService({
      workspaceRoot: WORKSPACE_ROOT,
      agentAuthorities: ["localhost:3000"],
      jobsOf: function unexpectedJobLookup(): never { throw new Error("probe failure must stop before Job lookup"); },
      probe: async function syntheticProbe(): Promise<ProbeResult> {
        return Object.assign({}, testCase.result, { privateDiagnostic: PRIVATE_CANARY });
      },
    });

    const sampledMessages: unknown[][] = [];
    let advertisedTools: string[] = [];
    let sampleCount = 0;
    const modelSampler: ModelSampler = {
      async sample(messages, tools) {
        sampledMessages.push([...messages]);
        advertisedTools = tools.map(function toolName(tool) { return tool.function.name; });
        sampleCount += 1;
        if (sampleCount === 1) {
          return {
            content: "",
            toolCalls: [{ id: "preview-error-call", name: "open_preview", input: { url: "http://127.0.0.1:8099/demo" } }],
            finishReason: "tool-call",
            reasoningSummary: "",
          };
        }
        return { content: "已收到预览检查结果。", toolCalls: [], finishReason: "stop", reasoningSummary: "" };
      },
    };

    const ports = createMemoryPorts(WORKSPACE_ROOT);
    const runtime = createAgentRuntime({
      ports,
      defaultRunConfig: {
        permissionMode: "full_access",
        workspaceRoot: WORKSPACE_ROOT,
        workspaceTrusted: true,
        toolAllowlist: ["open_preview"],
        workPreview: service,
        workPreviewLoader: async function loadPreview() { return service; },
        modelSampler,
      },
    });
    const session = await runtime.sessions.create({ id: "preview-error-session", title: "合成预览错误" });
    const turnId = "preview-error-turn";

    try {
      const events = await collect(runtime.turns.start({ sessionId: session.id, turnId, content: "检查预览页" }));
      expect(advertisedTools).toContain("open_preview");
      const result = events.find(function failedPreview(event) { return event.type === "tool_result" && event.toolName === "open_preview"; });
      expect(result, `sampleCount=${sampleCount}; tools=${JSON.stringify(advertisedTools)}; events=${JSON.stringify(events)}`).toMatchObject({ type: "tool_result", toolName: "open_preview", result: { status: "error", error: { code: testCase.code } } });
      expect(advertisedTools).toContain("open_preview");
      expect(JSON.stringify(result)).not.toContain(PRIVATE_CANARY);
      expect(sampleCount).toBe(2);
      expect(JSON.stringify(sampledMessages[1])).toContain(testCase.code);
      expect(JSON.stringify(sampledMessages[1])).toContain(testCase.modelText);
      expect(JSON.stringify(sampledMessages[1])).not.toContain(PRIVATE_CANARY);

      const envelopes = await ports.transcriptStore.getEvents(session.id);
      const state = replayWebPresentation(envelopes);
      const markup = renderWorkTurn(state, turnId);
      expect(markup).toContain("检查预览页面是否可访问");
      expect(markup).toContain(testCase.display);
      expect(markup).not.toContain(PRIVATE_CANARY);
    } finally {
      await runtime.shutdown?.();
    }
  });
});
