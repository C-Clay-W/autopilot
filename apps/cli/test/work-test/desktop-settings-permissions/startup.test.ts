// 验证 CLI 只在新建 Session 消费 Desktop 权限，不调用 Provider。
import { describe, expect, it } from "vitest";
import type { AgentRuntime, Project } from "@autopilot-agent/core";
import { ensureChatSession } from "../../../src/main.js";

describe("Desktop startup permission", function startupPermissions() {
  /** 创建使用 Session 公开默认配置，已有会话完全不写入。 */
  it("applies all startup modes only to new sessions and leaves existing sessions unchanged", async function newAndExisting() {
    const inputs: unknown[] = [];
    const existing = { id: "old", projectId: "project", defaultRunConfig: { permissionMode: "ask", maxSteps: 7 } };
    const runtime = { sessions: {
      get: async function get() { return existing; },
      create: async function create(input: unknown) { inputs.push(input); return { id: "new", ...input as object }; },
    } } as unknown as AgentRuntime;
    const project = { id: "project" } as Project;
    for (const mode of ["ask", "auto_approve", "full_access"]) {
      const environment = { AUTOPILOT_DESKTOP_AP_PERMISSION: mode };
      const session = await ensureChatSession(runtime, project, undefined, environment);
      expect(session.defaultRunConfig?.permissionMode).toBe(mode);
      expect(await ensureChatSession(runtime, project, "old", environment)).toBe(existing);
    }
    expect(inputs).toHaveLength(3);
    expect(existing.defaultRunConfig).toEqual({ permissionMode: "ask", maxSteps: 7 });
    await ensureChatSession(runtime, project, undefined, {});
    expect(inputs[3]).not.toHaveProperty("defaultRunConfig");
    await expect(ensureChatSession(runtime, project, undefined, { AUTOPILOT_DESKTOP_AP_PERMISSION: "bypass" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(inputs).toHaveLength(4);
  });
});
