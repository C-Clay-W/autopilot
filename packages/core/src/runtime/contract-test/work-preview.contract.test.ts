/** Talk-Plan0908 Stage1 契约测试：Work 预览能力冻结、注册边界、安全投影与 override/continue 负向（fake Host）。 */

import { describe, expect, it } from "vitest";
import type { Session } from "../domain";
import { resolveRunConfig } from "../protocol/run-config";
import type { RunConfig } from "../protocol/run-config";
import type { WorkPreviewCapability, WorkPreviewPrepareRequest, WorkPreviewPrepareResult } from "../protocol/work-preview-capability";
import { resolveTurnCapabilities } from "../application/turn/turn-capability-ceiling";
import { createAgentRuntime } from "../../internal/agent-runtime";
import { createOpenPreviewTool } from "../../internal/tools/builtins/open-preview-tool";
import { ToolExecutor } from "../../internal/tools/tool-executor";
import { ToolRegistry } from "../../internal/tools/tool-registry";
import type { AgentToolDefinition } from "../../internal/tools/types";

/** 创建带调用记录的 fake Host 预览能力；label 用于区分宿主注入与 override 伪造来源。 */
function fakeCapability(label: string): WorkPreviewCapability & { calls: WorkPreviewPrepareRequest[] } {
  const calls: WorkPreviewPrepareRequest[] = [];
  return {
    calls,
    async preparePreview(request: WorkPreviewPrepareRequest): Promise<WorkPreviewPrepareResult> {
      calls.push(request);
      return { previewId: "pvw-" + label, hostLabel: "127.0.0.1:5173", copyUrl: "http://127.0.0.1:5173/demo", openWhen: request.openWhen, state: "prepared" };
    },
  };
}

/** 构造最小 Work Session 身份；resolveTurnCapabilities 只读取身份与归属字段。 */
function workSession(): Session {
  return { id: "s1", productMode: "work", projectId: "p1" } as unknown as Session;
}

/** 构造最小 Chat Session 身份。 */
function chatSession(): Session {
  return { id: "s2", productMode: "chat", chatRetrievalMode: "none" } as unknown as Session;
}

/** 为工具创建统一的可信 Work 执行器（与后台 Job 工具测试同一范式）。 */
function executorFor(definition: AgentToolDefinition<any, any>, permissionMode: "ask" | "full_access" = "full_access"): ToolExecutor {
  const registry = new ToolRegistry({ productMode: "work" });
  registry.register(definition);
  return new ToolExecutor(registry, { capabilityCeiling: { productMode: "work" }, permissionMode, workspaceTrusted: true });
}

describe("Work 预览冻结字段", function suite() {
  it("宿主注入能力时冻结为 true，未注入时缺省 false", function freezesFromRuntimeDefault() {
    const fake = fakeCapability("host");
    expect(resolveRunConfig({ runtimeDefault: { workPreview: fake } }).workPreviewEnabled).toBe(true);
    expect(resolveRunConfig({ runtimeDefault: {} }).workPreviewEnabled).toBe(false);
  });

  it("override 注入能力或 loader 均不能开启冻结开关", function overrideCannotEnable() {
    const fake = fakeCapability("override");
    const malicious = { workPreview: fake, workPreviewLoader: async () => fake } as unknown as Partial<RunConfig>;
    expect(resolveRunConfig({ runtimeDefault: {}, turnOverride: malicious }).workPreviewEnabled).toBe(false);
  });
});

describe("resolveTurnCapabilities 的 Work 预览装配", function suite() {
  it("新 Turn 且冻结开启时经宿主 loader 装配能力", async function loadsFromHostLoader() {
    const fake = fakeCapability("host");
    const runtimeDefault: RunConfig = { workPreviewLoader: async () => fake };
    const resolved = await resolveTurnCapabilities({
      session: workSession(), turnId: "t1", runtimeDefault,
      override: { workPreview: fakeCapability("override"), workPreviewLoader: async () => fakeCapability("override-loader") } as Partial<RunConfig>,
      frozen: { workPreviewEnabled: true }, now: 1,
    });
    expect(resolved.capabilities.workPreview).toBe(fake);
  });

  it("旧 Turn 继续时冻结缺失不开新能力", async function oldTurnStaysClosed() {
    const fake = fakeCapability("host");
    const resolved = await resolveTurnCapabilities({
      session: workSession(), turnId: "t1", runtimeDefault: { workPreviewLoader: async () => fake },
      frozen: {}, continuing: true, now: 1,
    });
    expect(resolved.capabilities.workPreview).toBeUndefined();
  });

  it("loader 返回 undefined 时能力明确不可用", async function loaderMayDisable() {
    const resolved = await resolveTurnCapabilities({
      session: workSession(), turnId: "t1", runtimeDefault: { workPreviewLoader: async () => undefined },
      frozen: { workPreviewEnabled: true }, now: 1,
    });
    expect(resolved.capabilities.workPreview).toBeUndefined();
  });

  it("Chat 冻结开关恒为 false 且能力不进入 Chat capabilities", async function chatNeverGetsPreview() {
    const fake = fakeCapability("host");
    const resolved = await resolveTurnCapabilities({
      session: chatSession(), turnId: "t2",
      runtimeDefault: { chatLoader: async () => undefined, workPreviewLoader: async () => fake } as RunConfig,
      frozen: { workPreviewEnabled: true }, now: 1,
    });
    expect(resolved.frozen.workPreviewEnabled).toBe(false);
    expect(resolved.capabilities.workPreview).toBeUndefined();
  });
});

describe("open_preview 注册边界", function suite() {
  it("Work 且宿主注入能力时注册 open_preview", function registersInWork() {
    const names = createAgentRuntime({
      capabilityCeiling: { productMode: "work" }, workspaceRoot: "/workspace",
      workPreview: fakeCapability("host"), jobBinding: { workspaceId: "/workspace", sessionId: "s1", turnId: "t1" },
    }).getToolDefinitions().map(function name(definition) { return definition.name; });
    expect(names).toContain("open_preview");
  });

  it("Chat 即使被伪造注入能力也不注册；CLI（无能力）同样不注册", function chatAndCliNeverRegister() {
    const chatNames = createAgentRuntime({
      capabilityCeiling: { productMode: "chat", chatRetrievalMode: "none", allowedTools: [] }, workspaceRoot: "/private",
      workPreview: fakeCapability("host"), jobBinding: { workspaceId: "/private", sessionId: "s2", turnId: "t2" },
    }).getToolDefinitions().map(function name(definition) { return definition.name; });
    expect(chatNames).not.toContain("open_preview");
    const cliNames = createAgentRuntime({
      capabilityCeiling: { productMode: "work" }, workspaceRoot: "/workspace",
      jobBinding: { workspaceId: "/workspace", sessionId: "s3", turnId: "t3" },
    }).getToolDefinitions().map(function name(definition) { return definition.name; });
    expect(cliNames).not.toContain("open_preview");
  });
});

describe("open_preview 执行与安全投影", function suite() {
  const WORK_BINDING = { workspaceId: "/workspace", sessionId: "s1", turnId: "t1" };

  it("成功输出仅含冻结安全事实，copyUrl/hostLabel 只进入受控展示明细", async function projectsSafeFacts() {
    const fake = fakeCapability("host");
    const result = await executorFor(createOpenPreviewTool({ capability: fake, ...WORK_BINDING }))
      .execute({ callId: "c1", toolName: "open_preview", input: { url: "http://127.0.0.1:5173/demo" } });
    expect(result).toMatchObject({ status: "success" });
    if (result.status !== "success") return;
    expect(result.output).toEqual({ previewId: "pvw-host", state: "prepared", openWhen: "after_turn" });
    expect(JSON.stringify(result.output)).not.toContain("copyUrl");
    expect(result.display?.detail).toEqual({
      kind: "open_preview", previewId: "pvw-host", hostLabel: "127.0.0.1:5173",
      copyUrl: "http://127.0.0.1:5173/demo", openWhen: "after_turn", state: "prepared",
    });
    expect(fake.calls[0]).toMatchObject({ url: "http://127.0.0.1:5173/demo", openWhen: "after_turn", workspaceId: "/workspace", sessionId: "s1", turnId: "t1" });
    expect(typeof fake.calls[0].callId === "string" && fake.calls[0].callId.length > 0).toBe(true);
  });

  it("openWhen 缺省 after_turn 且 now 显式透传", async function passesOpenWhen() {
    const fake = fakeCapability("host");
    await executorFor(createOpenPreviewTool({ capability: fake, ...WORK_BINDING }))
      .execute({ callId: "c2", toolName: "open_preview", input: { url: "http://localhost:3000/", openWhen: "now" } });
    expect(fake.calls[0].openWhen).toBe("now");
  });

  it("宿主返回非法形状时 fail-closed 不产出展示明细", async function failsClosedOnMalformedResult() {
    const malformed: WorkPreviewCapability = {
      async preparePreview() {
        return { previewId: "bad id", hostLabel: "h", copyUrl: "http://x/", openWhen: "now", state: "prepared" };
      },
    };
    const result = await executorFor(createOpenPreviewTool({ capability: malformed, ...WORK_BINDING }))
      .execute({ callId: "c3", toolName: "open_preview", input: { url: "http://localhost:3000/" } });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.display?.detail).toBeUndefined();
  });

  it("ask 模式下外部效果进入审批，预览卡只含 url/openWhen 等安全字段且不执行", async function requiresApprovalInAskMode() {
    const fake = fakeCapability("host");
    const result = await executorFor(createOpenPreviewTool({ capability: fake, ...WORK_BINDING }), "ask")
      .execute({ callId: "c4", toolName: "open_preview", input: { url: "http://127.0.0.1:5173/" } });
    expect(result.status).toBe("approval_required");
    if (result.status !== "approval_required") return;
    expect(result.approval.preview).toEqual({ url: "http://127.0.0.1:5173/", openWhen: "after_turn" });
    expect(fake.calls).toHaveLength(0);
  });
});
