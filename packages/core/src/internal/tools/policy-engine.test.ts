/**
 * PolicyEngine 契约测试：固定硬拒绝、Skill 范围、grant、Trust 与权限模式的单一优先级。
 * Talk-Plan0917 Stage 1 追加：沙箱 fail-closed 先于所有放行路径（G3/G7/C6）。
 */
import { describe, expect, it } from "vitest";
import { PolicyEngine } from "./policy-engine";
import { SANDBOX_ERROR_CODES } from "../../runtime/domain/sandbox-policy";
import { TOOL_ERROR_CODES } from "./tool-error";
import type { ToolActionFacts, ToolExecutionContext, ToolMetadata } from "./types";

const metadata: ToolMetadata = { effect: "dynamic", destructive: false, concurrency: { max: 1 }, retry: { safe: false } };

/** 构造不带宿主能力的最小可信执行上下文。 */
function createContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    permissionMode: "ask",
    agentFlow: { async search() { return []; } },
    ...overrides,
  };
}

/** 构造本地 ActionFacts，避免测试通过模型输入伪造风险字段。 */
function createFacts(overrides: Partial<ToolActionFacts> = {}): ToolActionFacts {
  return {
    toolName: "run_command",
    effect: "external",
    destructive: false,
    operation: "command",
    risk: "unknown",
    requiresApproval: true,
    approval: { reason: "命令需要审批" },
    ...overrides,
  };
}

describe("PolicyEngine", () => {
  it("硬拒绝优先于 full_access、grant 与任意审批", () => {
    const result = new PolicyEngine().evaluate({
      context: createContext({ permissionMode: "full_access" }),
      metadata,
      facts: createFacts({ destructive: true, risk: "destructive", hardDenyReason: "禁止破坏性命令" }),
      grantMatched: true,
    });
    expect(result).toMatchObject({ decision: "deny", reason: "禁止破坏性命令" });
  });

  it("Skill 白名单在 grant 与权限模式之前收窄工具能力", () => {
    const result = new PolicyEngine().evaluate({
      context: createContext({ permissionMode: "full_access", allowedTools: ["read_file"] }),
      metadata,
      facts: createFacts(),
      grantMatched: true,
    });
    expect(result.decision).toBe("deny");
  });

  it("仅受信任工作区的 auto_approve 可自动执行工作区变更", () => {
    const engine = new PolicyEngine();
    const facts = createFacts({ toolName: "write_file", effect: "workspace", destructive: true, operation: "create", risk: "workspace_mutating" });
    expect(engine.evaluate({ context: createContext({ permissionMode: "auto_approve" }), metadata, facts, grantMatched: false }).decision).toBe("approval_required");
    expect(engine.evaluate({ context: createContext({ permissionMode: "auto_approve", workspaceTrusted: true }), metadata, facts, grantMatched: false }).decision).toBe("allow");
  });

  it("ask 下无精确约束的命令不使用持久 grant，且冻结为单次审批范围", () => {
    const engine = new PolicyEngine();
    const context = createContext({ permissionMode: "ask" });
    const facts = createFacts();
    // 旧 program: 宽约束（或缺约束）一律不参与持久授权：同程序不同参数必须重新判断。
    expect(engine.canUsePersistentGrant(context, facts)).toBe(false);
    expect(engine.evaluate({ context, metadata, facts, grantMatched: false })).toMatchObject({
      decision: "approval_required",
      allowedApprovalDecisions: ["allow_once", "deny"],
    });
  });

  it("ask 下精确命令约束可使用持久授权，审批范围为仅此次/记住此命令/拒绝", () => {
    const engine = new PolicyEngine();
    const context = createContext({ permissionMode: "ask" });
    const facts = createFacts({ stableConstraint: "cmd:v2:abc" });
    expect(engine.canUsePersistentGrant(context, facts)).toBe(true);
    expect(engine.evaluate({ context, metadata, facts, grantMatched: false })).toMatchObject({
      decision: "approval_required",
      allowedApprovalDecisions: ["allow_once", "allow_workspace", "deny"],
    });
  });

  // CR 20261016 R6：v1 已停止签发，仅保留类型识别以维持历史/已恢复审批的决策范围。
  it("遗留 cmd:v1 约束仍可识别为精确约束，但不由当前签发路径产生", () => {
    const engine = new PolicyEngine();
    const context = createContext({ permissionMode: "ask" });
    const facts = createFacts({ stableConstraint: "cmd:v1:legacy" });
    expect(engine.canUsePersistentGrant(context, facts)).toBe(true);
    expect(engine.evaluate({ context, metadata, facts, grantMatched: false })).toMatchObject({
      decision: "approval_required",
      allowedApprovalDecisions: ["allow_once", "allow_workspace", "deny"],
    });
  });

  it("沙箱不可用时无论 grant、full_access 还是 auto_approve+Trust 都 fail-closed（C6）", () => {
    const engine = new PolicyEngine();
    const facts = createFacts();
    const sandbox = { available: false };
    expect(engine.evaluate({ context: createContext({ permissionMode: "full_access" }), metadata, facts, grantMatched: true, sandbox })).toMatchObject({
      decision: "deny",
      errorCode: SANDBOX_ERROR_CODES.UNAVAILABLE,
    });
    expect(engine.evaluate({ context: createContext({ permissionMode: "auto_approve", workspaceTrusted: true }), metadata, facts, grantMatched: false, sandbox })).toMatchObject({
      decision: "deny",
      errorCode: SANDBOX_ERROR_CODES.UNAVAILABLE,
    });
  });

  it("沙箱不可用时只读命令事实同样被拒，不进入免审批放行", () => {
    const engine = new PolicyEngine();
    const result = engine.evaluate({
      context: createContext({ permissionMode: "auto_approve", workspaceTrusted: true }),
      metadata,
      facts: createFacts({ requiresApproval: undefined, risk: "read_only", approval: undefined }),
      grantMatched: false,
      sandbox: { available: false },
    });
    expect(result).toMatchObject({ decision: "deny", errorCode: SANDBOX_ERROR_CODES.UNAVAILABLE });
  });

  it("未注入沙箱事实的调用保持既有行为，零回归", () => {
    const engine = new PolicyEngine();
    // createFacts 默认 risk=unknown 且 requiresApproval=true：现行矩阵下即使
    // auto_approve + Trust 也必须走审批，本断言固定该既有行为未被沙箱字段改变。
    const facts = createFacts();
    expect(engine.evaluate({ context: createContext({ permissionMode: "auto_approve", workspaceTrusted: true }), metadata, facts, grantMatched: false }).decision).toBe("approval_required");
    expect(engine.canUsePersistentGrant(createContext({ permissionMode: "ask" }), facts)).toBe(false);
  });

  it("G4：已确认可沙箱执行的调用在 auto_approve+Trust 下自动放行，无需审批", () => {
    const engine = new PolicyEngine();
    const facts = createFacts();
    const result = engine.evaluate({
      context: createContext({ permissionMode: "auto_approve", workspaceTrusted: true }),
      metadata,
      facts,
      grantMatched: false,
      sandbox: { available: true },
    });
    expect(result).toMatchObject({ decision: "allow" });
  });

  it("G4：auto_approve 但未信任工作区时，沙箱可用也不自动放行外部/未知风险", () => {
    const engine = new PolicyEngine();
    const result = engine.evaluate({
      context: createContext({ permissionMode: "auto_approve", workspaceTrusted: false }),
      metadata,
      facts: createFacts(),
      grantMatched: false,
      sandbox: { available: true },
    });
    expect(result.decision).toBe("approval_required");
  });

  it("G4：ask 模式下沙箱可用仍逐次审批（allow_once-only 不被自动放行替代）", () => {
    const engine = new PolicyEngine();
    const result = engine.evaluate({
      context: createContext({ permissionMode: "ask" }),
      metadata,
      facts: createFacts(),
      grantMatched: false,
      sandbox: { available: true },
    });
    expect(result).toMatchObject({ decision: "approval_required", allowedApprovalDecisions: ["allow_once", "deny"] });
  });

  it("Talk-Plan1013：full_access 下外部文件修改仍必须先取得精确授权，gate 压过模式放行", () => {
    const engine = new PolicyEngine();
    const facts = createFacts({
      toolName: "write_file",
      effect: "external",
      destructive: true,
      operation: "create",
      risk: "external_side_effect",
      stableConstraint: "ext-file:C:\\outside\\a.txt",
      externalMutation: true,
      externalTarget: { canonicalTarget: "C:\\outside\\a.txt", canonicalWorkspace: "C:\\ws" },
    });
    const result = engine.evaluate({ context: createContext({ permissionMode: "full_access" }), metadata, facts, grantMatched: false });
    expect(result).toMatchObject({
      decision: "approval_required",
      constraint: "ext-file:C:\\outside\\a.txt",
      allowedApprovalDecisions: ["allow_once", "allow_session", "allow_workspace", "deny"],
    });
  });

  it("Talk-Plan1013：auto_approve+Trust 且沙箱可用也不能自动放行外部修改", () => {
    const engine = new PolicyEngine();
    const facts = createFacts({
      toolName: "write_file",
      effect: "external",
      destructive: true,
      operation: "edit",
      risk: "external_side_effect",
      externalMutation: true,
      externalTarget: { canonicalTarget: "C:\\outside\\a.txt", canonicalWorkspace: "C:\\ws" },
    });
    const result = engine.evaluate({
      context: createContext({ permissionMode: "auto_approve", workspaceTrusted: true }),
      metadata,
      facts,
      grantMatched: false,
      sandbox: { available: true },
    });
    expect(result.decision).toBe("approval_required");
  });

  it("Talk-Plan1013：命中精确外部持久授权的外部修改放行，宽模式与 ask 均可复用同一 grant", () => {
    const engine = new PolicyEngine();
    const facts = createFacts({
      toolName: "edit_file",
      effect: "external",
      destructive: true,
      operation: "edit",
      risk: "external_side_effect",
      stableConstraint: "ext-file:C:\\outside\\a.txt",
      externalMutation: true,
      externalTarget: { canonicalTarget: "C:\\outside\\a.txt", canonicalWorkspace: "C:\\ws" },
    });
    expect(engine.evaluate({ context: createContext({ permissionMode: "full_access" }), metadata, facts, grantMatched: true }).decision).toBe("allow");
    expect(engine.evaluate({ context: createContext({ permissionMode: "auto_approve", workspaceTrusted: true }), metadata, facts, grantMatched: true }).decision).toBe("allow");
    expect(engine.evaluate({ context: createContext({ permissionMode: "ask" }), metadata, facts, grantMatched: true }).decision).toBe("allow");
  });

  it("Talk-Plan1013：纯读取事实不进入外部修改 gate（读取例外，免新增路径审批）", () => {
    const engine = new PolicyEngine();
    const result = engine.evaluate({
      context: createContext({ permissionMode: "ask" }),
      metadata,
      facts: createFacts({ toolName: "read_file", effect: "none", destructive: false, operation: "read", risk: "read_only", requiresApproval: undefined, approval: undefined }),
      grantMatched: false,
    });
    expect(result.decision).toBe("allow");
  });

  it("Talk-Plan1013 Stage5 R5：外部修改 deny 为硬拒绝，先于 grant 与权限模式且带稳定错误码", () => {
    const engine = new PolicyEngine();
    const facts = createFacts({
      toolName: "write_file",
      effect: "external",
      destructive: true,
      operation: "create",
      risk: "external_side_effect",
      stableConstraint: "ext-file:C:\\outside\\a.txt",
      externalMutation: true,
      externalRestriction: "deny",
      externalTarget: { canonicalTarget: "C:\\outside\\a.txt", canonicalWorkspace: "C:\\ws" },
    });
    for (const grantMatched of [false, true]) {
      for (const permissionMode of ["full_access", "auto_approve", "ask"] as const) {
        const result = engine.evaluate({ context: createContext({ permissionMode, workspaceTrusted: true }), metadata, facts, grantMatched });
        expect(result).toMatchObject({ decision: "deny", errorCode: TOOL_ERROR_CODES.COMMAND_FORBIDDEN });
      }
    }
  });

  it("Talk-Plan1013 Stage5 R5：外部修改 ask 逐次询问，即便命中 grant 也收窄为 allow_once/deny", () => {
    const engine = new PolicyEngine();
    const facts = createFacts({
      toolName: "edit_file",
      effect: "external",
      destructive: true,
      operation: "edit",
      risk: "external_side_effect",
      stableConstraint: "ext-file:C:\\outside\\a.txt",
      externalMutation: true,
      externalRestriction: "ask",
      externalTarget: { canonicalTarget: "C:\\outside\\a.txt", canonicalWorkspace: "C:\\ws" },
    });
    expect(engine.evaluate({ context: createContext({ permissionMode: "full_access" }), metadata, facts, grantMatched: true })).toMatchObject({
      decision: "approval_required",
      allowedApprovalDecisions: ["allow_once", "deny"],
    });
    expect(engine.evaluate({ context: createContext({ permissionMode: "ask" }), metadata, facts, grantMatched: false })).toMatchObject({
      decision: "approval_required",
      allowedApprovalDecisions: ["allow_once", "deny"],
    });
  });

  it("Talk-Plan1013 Stage5 R5：外部读取 ask 逐次确认，先于 grant 与 full_access 且不写持久规则", () => {
    const engine = new PolicyEngine();
    const facts = createFacts({
      toolName: "read_file",
      effect: "none",
      destructive: false,
      operation: "read",
      risk: "read_only",
      requiresApproval: true,
      approval: { reason: "读取该工作区外文件需要逐次确认" },
      externalTarget: { canonicalTarget: "C:\\outside\\a.txt", canonicalWorkspace: "C:\\ws" },
      externalRestriction: "ask",
    });
    expect(engine.evaluate({ context: createContext({ permissionMode: "full_access" }), metadata, facts, grantMatched: true })).toMatchObject({
      decision: "approval_required",
      allowedApprovalDecisions: ["allow_once", "deny"],
    });
    // allow 与工作区内目标维持读取免审批。
    expect(engine.evaluate({
      context: createContext({ permissionMode: "full_access" }),
      metadata,
      facts: createFacts({ toolName: "read_file", effect: "none", destructive: false, operation: "read", risk: "read_only", requiresApproval: undefined, approval: undefined, externalRestriction: "allow" }),
      grantMatched: false,
    }).decision).toBe("allow");
  });
});
