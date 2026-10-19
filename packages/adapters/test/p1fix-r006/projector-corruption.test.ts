/** R7 回归：真实 Node 投影器在 add/remove 时保留损坏配置，并让 Core 返回 pending。 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createNodeExternalPermissionProjector } from "../../src/node/settings/node-external-permission-projector";
import { createMemoryPorts, createAgentRuntime } from "@autopilot-agent/core";

const artifacts = path.resolve("../../.agent-tests/work-test/external-workspace-permissions/runs/p1fix-r006-controller");

/** 创建任务目录内的配置、home 与外部目标，只操作合成 fixture。 */
function fixture(content: string) {
  fs.mkdirSync(artifacts, { recursive: true });
  const root = fs.mkdtempSync(path.join(artifacts, "r7-"));
  const workspaceRoot = path.join(root, "workspace");
  const home = path.join(root, "home");
  const localPath = path.join(workspaceRoot, ".autopilot", "settings.local.json");
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(localPath, content);
  const target = path.join(root, "outside.txt");
  return { workspaceRoot, localPath, target, rule: `Write(${target})`, projector: createNodeExternalPermissionProjector({ homeDirectory: home }) };
}

describe("R7 corrupted local projection", function suite() {
  for (const action of ["add", "remove"] as const) {
    for (const content of ['{"provider":', 'not-json', 'null', '[]', '42']) {
      it(`${action} 拒绝损坏或非对象配置 ${content} 且保留字节`, async function preservesInvalid() {
        const f = fixture(content);
        await expect(f.projector.project({ workspaceRoot: f.workspaceRoot, rule: f.rule, action })).rejects.toThrow("EXTERNAL_RULE_SETTINGS_INVALID");
        expect(fs.readFileSync(f.localPath, "utf8")).toBe(content);
      });
    }

    it(`${action} existing local 不可读时拒绝并保留原文件`, async function preservesUnreadable() {
      const f = fixture('{"permissions":{"deny":[]},"language":"zh"}');
      const original = fs.readFileSync(f.localPath);
      const read = fs.readFileSync.bind(fs);
      const mock = vi.spyOn(fs, "readFileSync").mockImplementation(function denied(file, ...args) {
        if (String(file) === f.localPath) throw Object.assign(new Error("fixture access denied"), { code: "EACCES" });
        return (read as Function)(file, ...args);
      } as typeof fs.readFileSync);
      try { await expect(f.projector.project({ workspaceRoot: f.workspaceRoot, rule: f.rule, action })).rejects.toThrow("EXTERNAL_RULE_SETTINGS_UNREADABLE"); }
      finally { mock.mockRestore(); }
      expect(fs.readFileSync(f.localPath)).toEqual(original);
    });
  }

  it("正常 add/remove 保持其他配置与 deny/ask 字段", async function preservesValid() {
    const f = fixture(JSON.stringify({ language: "zh", permissions: { allow: [], deny: [`Read(${path.resolve("denied.txt")})`], ask: [] } }));
    await f.projector.project({ workspaceRoot: f.workspaceRoot, rule: f.rule, action: "add" });
    expect(JSON.parse(fs.readFileSync(f.localPath, "utf8")).permissions.allow).toEqual([f.rule]);
    await f.projector.project({ workspaceRoot: f.workspaceRoot, rule: f.rule, action: "remove" });
    expect(JSON.parse(fs.readFileSync(f.localPath, "utf8"))).toEqual({ language: "zh", permissions: { allow: [], deny: [`Read(${path.resolve("denied.txt")})`], ask: [] } });
  });

  it("Core submit 保持 pending、grant 不生效；撤销仍删除权威且保留坏配置", async function coreIntegration() {
    const f = fixture('{"permissions":');
    const ports = createMemoryPorts(f.workspaceRoot);
    ports.externalPermissionProjector = f.projector;
    const constraint = `ext-file:${f.target}`;
    await ports.sessionStore.save({ id: "s-r7", status: "waiting_approval", persistenceMode: "durable", createdAt: 1, updatedAt: 1, activeTurnId: "t-r7" });
    await ports.turnStore.save({ id: "t-r7", sessionId: "s-r7", status: "waiting_approval", frozenRunConfig: { workspaceRoot: f.workspaceRoot }, startedAt: 1 });
    await ports.checkpointStore.save("s-r7", { turnId: "t-r7", status: "awaiting_approval", stepCount: 1, messages: [], completedCallIds: [], pendingCalls: [{ id: "c-r7", name: "write_file", input: {} }] });
    await ports.transcriptStore.append("s-r7", { seq: 1, sessionId: "s-r7", turnId: "t-r7", timestamp: ports.clock.timestamp(), event: { type: "approval_required", turnId: "t-r7", stepId: "step-r7", callId: "c-r7", toolName: "write_file", result: { status: "approval_required", callId: "c-r7", toolName: "write_file", approval: { approvalId: "a-r7", callId: "c-r7", toolName: "write_file", normalizedInputHash: "fixture-hash", expiresAt: "2099-01-01T00:00:00Z", constraint, reason: "fixture", risk: "external_side_effect", preview: { path: f.target }, allowedDecisions: ["allow_once", "allow_session", "allow_workspace", "deny"] } } } });
    const runtime = createAgentRuntime({ ports });
    const decision = await runtime.approvals.submit({ sessionId: "s-r7", turnId: "t-r7", approvalId: "a-r7", decision: "allow_workspace" });
    expect(decision.projection).toBe("pending");
    const query = { workspaceRoot: f.workspaceRoot, sessionId: "s-r7", toolName: "write_file", constraint };
    expect(await runtime.approvals.hasPersistentGrant(query)).toBe(false);
    expect(await runtime.approvals.revokePersistentGrant(query)).toEqual({ deleted: true, ruleRemoved: false });
    expect(await ports.approvalStore.getPersistentGrant(query)).toBeNull();
    expect(fs.readFileSync(f.localPath, "utf8")).toBe('{"permissions":');
  });
});
