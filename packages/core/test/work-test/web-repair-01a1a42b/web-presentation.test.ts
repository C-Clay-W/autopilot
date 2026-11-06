/** Web宿主审批指引与安全目标事实回归，采样完全使用本地替身。 */
import { expect, it } from "vitest";
import { createAgentRuntime } from "../../../src/internal/agent-runtime";
import { createAgentTextMessage, getAgentMessageText } from "../../../src/internal/types/agent-message";
import { createThreadObservationDisplay } from "../../../src/internal/tools/thread-observation-display";
import { createThreadsToolBinding } from "../../../src/runtime/application/thread-tool-binding";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";

/** 从受信宿主绑定走真实运行入口，捕获给模型的系统上下文。 */
async function promptFor(executionHost?: string): Promise<string> {
  let prompt = "";
  const threads = createThreadsToolBinding(createMemoryPorts(), { executionHost, workspaceId: "ws", stateRootId: "state", projectId: "p", modelCatalog: [], allowedTools: [] }, { threadId: "s", turnId: "t" });
  const runtime = createAgentRuntime({ threads, modelSampler: { sample: async function sample(messages) {
    prompt = messages.filter(function system(message) { return message.role === "system"; }).map(getAgentMessageText).join("\n");
    return { content: "完成", toolCalls: [], reasoningSummary: "" };
  } } });
  for await (const event of runtime.run({ turnId: "t", messages: [createAgentTextMessage("user", "等待任务")] })) { void event; }
  return prompt;
}

it("Web受信宿主审批仅固定短句且无新事实不重复，默认宿主保留原指引", async function trustedHostInstructions() {
  const web = await promptFor("web-work-v1");
  expect(web).toContain("子会话等待审批，需要人为介入");
  expect(web).toContain("同一审批无新事实时不重复");
  expect(web).not.toContain("Ctrl+A");
  const legacy = await promptFor();
  expect(legacy).toContain("Ctrl+A");
  expect(legacy).not.toContain("同一审批无新事实时不重复");
});

it("安全审批目标只来自真实waiting状态和对应目标，回答等待与正文不能伪造", function safeApprovalTargets() {
  const id = "44438780-5607-4e06-8151-3e65d70fa968";
  const input = { targets: [{ threadId: id, taskId: "task" }] };
  const approval = createThreadObservationDisplay("wait_threads", input, { results: [{ threadId: id, reason: "attention", summary: { waiting: "approval", interactionState: "pending" } }] });
  expect(approval).toHaveProperty("approvalTargets", [id]);
  expect(createThreadObservationDisplay("wait_threads", input, { results: [{ threadId: id, reason: "attention", summary: { waiting: "user_input" } }] })).not.toHaveProperty("approvalTargets");
  expect(createThreadObservationDisplay("wait_threads", input, { results: [{ threadId: "other", summary: { waiting: "approval" } }] })).not.toHaveProperty("approvalTargets");
  expect(createThreadObservationDisplay("wait_threads", input, { results: [{ threadId: id, summary: { waiting: "approval", interactionState: "decided" } }] })).not.toHaveProperty("approvalTargets");
  expect(createThreadObservationDisplay("read_progress", { threadId: id }, { items: [{ kind: "blocked", summary: "waiting=approval" }] })).not.toHaveProperty("approvalTargets");
});
