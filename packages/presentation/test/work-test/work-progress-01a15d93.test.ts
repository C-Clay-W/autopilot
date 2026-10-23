/** 执行过场回归：真实调用身份、模型优先、等待审批与安全失败投影。 */
import { describe, expect, it } from "vitest";
import { createPresentationState, groupToolCalls, selectToolProgress, replayPresentationInputs, type PresentationInput, type ToolCallItem } from "../../src/index.js";

/** 构造安全工具节点，故意携带不可用于猜测行动的敏感目标。 */
function call(id: string, state: ToolCallItem["state"] = "running", stepId = "s"): ToolCallItem {
  return { id, callId: id, kind: "tool_call", turnId: "t", stepId, toolName: "open_preview", state, category: "other", profileKey: "unknown", titleKey: "tool.other.running", target: "SECRET_URL?token=SECRET" };
}

describe("安全短进展", function suite() {
  it("恢复重放按 Turn 与 callId 保留真实调用，重复事件不生成额外行动节点", function replaysCalls() {
    const inputs: PresentationInput[] = ["first", "second"].map(function input(turnId) {
      return { kind: "runtime_event", envelope: { sessionId: "session", turnId, seq: 1, timestamp: "2026-10-21T00:00:00.000Z", event: { type: "tool_started", turnId, stepId: "s", callId: "same-provider-id", toolName: "open_preview", summary: "PRIVATE" } } };
    });
    const state = replayPresentationInputs([...inputs, ...inputs]);
    expect(state.items).toHaveLength(2);
    expect(state.items.map(function id(item) { return item.id; })).toEqual(["tool:first:same-provider-id", "tool:second:same-provider-id"]);
    expect(JSON.stringify(state.items)).not.toContain("PRIVATE");
    expect(state.items.map(function progress(item) { return selectToolProgress(state, item)?.action; })).toEqual(["检查预览页面是否可访问", "检查预览页面是否可访问"]);
  });
  it("无模型正文有行动，模型同一步前置正文优先，其他步与迟到正文不吞当前行动", function modelPriority() {
    const tool = call("a");
    const state = { ...createPresentationState(), items: [tool] };
    expect(selectToolProgress(state, tool)).toEqual({ source: "system", action: "检查预览页面是否可访问", outcome: undefined });
    const model = { id: "model", kind: "assistant_answer" as const, channel: "process" as const, turnId: "t", stepId: "s", content: "检查页面" };
    expect(selectToolProgress({ ...state, items: [model, tool] }, tool)?.action).toBeUndefined();
    expect(selectToolProgress({ ...state, items: [tool, model] }, tool)?.action).toBeDefined();
    expect(selectToolProgress({ ...state, items: [{ ...model, stepId: "old" }, tool] }, tool)?.action).toBeDefined();
  });

  it("等待确认不称执行；失败只陈述结果，新调用才产生新行动且不读原始目标", function safeFailure() {
    const state = createPresentationState();
    expect(selectToolProgress(state, call("a", "awaiting_approval"))?.action).toBe("等待确认后执行");
    const failed = { ...call("a", "failed"), errorCode: "PREVIEW_PAGE_NOT_FOUND" };
    expect(selectToolProgress(state, failed)?.outcome).toBe("预览页面不存在（HTTP 404）");
    expect(JSON.stringify(selectToolProgress(state, failed))).not.toMatch(/SECRET|重试|路径|IPv6/);
    expect(selectToolProgress(state, { ...failed, errorCode: "PREVIEW_NOT_READY" })?.outcome).toBe("预览地址检查未通过");
    expect(selectToolProgress(state, { ...call("b"), toolName: "run_command" })?.action).toBe("执行本地命令");
    expect(selectToolProgress(state, call("c", "completed"))?.outcome).toBe("预览请求已准备");
  });

  it("并行探索在同一步分组而跨步保留行动边界，不吞 callId", function groupsByStep() {
    const tools = [call("a"), call("b"), call("c", "running", "next")].map(function read(tool) { return { ...tool, toolName: "read_file" }; });
    const timeline = groupToolCalls(tools);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ kind: "tool_group", toolCallIds: ["a", "b"] });
    expect(selectToolProgress({ ...createPresentationState(), items: tools }, timeline[0])?.action).toBe("读取文件内容");
    expect(tools).toHaveLength(3);
  });
});
