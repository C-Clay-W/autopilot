// 独立验证 Desktop 启动默认值只写新会话，用户 slash 调整及历史重入继续有效。
import { expect, it } from "vitest";
import type { AgentRuntime, Project, Session, RunConfig } from "@autopilot-agent/core";
import { ensureChatSession } from "../../../src/main.js";
import { createCliController } from "../../../src/controller.js";
import { createPlainRenderer } from "../../../src/renderer.js";
import { parseSlashAction } from "../../../src/parser.js";

/** Session 存储使用内存 double；控制器和 slash 解析均使用真实源码且不启动 Turn。 */
it("keeps user permission changes after Desktop startup and historical reentry", async function permissionsAfterStartup() {
  let session: Session;
  const runtime = { sessions: {
    create: async function create(input: Partial<Session>) { session = { id: "session", ...input } as Session; return session; },
    get: async function get() { return session; },
    setDefaultRunConfig: async function save(_id: string, config: RunConfig) { session.defaultRunConfig = config; return session; },
  } } as unknown as AgentRuntime;
  await ensureChatSession(runtime, { id: "project" } as Project, undefined, { AUTOPILOT_DESKTOP_AP_PERMISSION: "full_access" });
  expect(session!.defaultRunConfig?.permissionMode).toBe("full_access");
  const controller = createCliController({ runtime, renderer: createPlainRenderer("text"), sessionId: "session", workspaceRoot: "E:/fixture" });
  const parsed = parseSlashAction("/permissions ask");
  expect(parsed.kind).toBe("action");
  if (parsed.kind !== "action") throw new Error("expected slash action");
  const result = await controller.dispatch(parsed.action);
  expect(result.kind).toBe("ok");
  expect(session!.defaultRunConfig?.permissionMode).toBe("ask");
  await ensureChatSession(runtime, { id: "project" } as Project, "session", { AUTOPILOT_DESKTOP_AP_PERMISSION: "full_access" });
  expect(session!.defaultRunConfig?.permissionMode).toBe("ask");
});
