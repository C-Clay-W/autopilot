/** repair-03仅重签：完整校验/Policy必须复用，full_access/grant仍不得执行，硬拒绝不能放宽。 */
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolExecutor } from "../../../src/internal/tools/tool-executor";
import { ToolRegistry } from "../../../src/internal/tools/tool-registry";

/** 注册带真实输入schema和本地事实的隔离工具，执行为可观测spy。 */
function fixture(deny = false) {
  const execute = vi.fn(async function forbiddenExecution() { return "must not execute"; });
  const validateInput = vi.fn(async function validate() {});
  const registry = new ToolRegistry({ productMode: "work" });
  registry.register({ name: "reissue_fixture", description: "fixture", inputSchema: z.object({ target: z.string() }).strict(), metadata: { effect: "dynamic", destructive: false, concurrency: { max: 1, resourceKey: "fixture" }, retry: { safe: false }, timeout: { defaultMs: 1000, maxMs: 1000 } }, validateInput,
    createActionFacts: function facts() { return { toolName: "reissue_fixture", effect: "external", destructive: false, operation: "fixture", risk: "external_side_effect", requiresApproval: true, ...(deny ? { hardDenyReason: "fixed deny" } : {}) }; }, execute, serializeOutput: function serialize(value) { return value; } });
  return { execute, validateInput, executor: new ToolExecutor(registry, { permissionMode: "full_access", workspaceTrusted: true, capabilityCeiling: { productMode: "work" }, resolvePersistentGrant: async function grant() { return true; } }) };
}

it("仅重签在全权限和已有grant下仍只生成新审批，输入校验沿原路径", async function noExecution() {
  const f = fixture(); const request = { toolName: "reissue_fixture", callId: "call", input: { target: "same-frozen-target" } };
  const first = await f.executor.execute(request, { approvalOnly: true });
  expect(first.status).toBe("approval_required");
  if (first.status !== "approval_required") throw new Error("missing approval");
  const second = await f.executor.execute({ ...request, approval: { approvalId: first.approval.approvalId, decision: "allow_once" } }, { approvalOnly: true });
  expect(second.status).toBe("approval_required"); expect(f.execute).not.toHaveBeenCalled(); expect(f.validateInput).toHaveBeenCalledTimes(2);
});

it("仅重签不绕过schema与Policy硬拒绝", async function hardBoundary() {
  const f = fixture(true);
  expect((await f.executor.execute({ toolName: "reissue_fixture", callId: "call", input: { target: "same" } }, { approvalOnly: true })).status).toBe("denied");
  expect((await f.executor.execute({ toolName: "reissue_fixture", callId: "bad", input: { unknown: "bad" } }, { approvalOnly: true })).status).toBe("error");
  expect(f.execute).not.toHaveBeenCalled();
});
