/** CLI 安全错误分类测试：错误消息、cause 与敏感对象字段不得进入诊断结果。 */

import { NodeChatError, NodeStateError } from "@autopilot-agent/adapters";
import { AgentRuntimeError, WorkspaceTrustError } from "@autopilot-agent/core";
import { describe, expect, it } from "vitest";
import { classifyCliError } from "../src/error-diagnostics.js";

describe("CLI error diagnostics", function cliErrorDiagnosticsSuite() {
  it("为 Core、Adapter、Trust 与配置异常返回稳定类别和白名单码", function classifiesKnownCliErrors() {
    expect(classifyCliError(new AgentRuntimeError("RUNTIME_ERROR", "api_key=secret C:/private/prompt.txt")))
      .toEqual({ category: "agent_runtime", code: "RUNTIME_ERROR" });
    expect(classifyCliError(new NodeStateError("STATE_STORAGE_UNAVAILABLE")))
      .toEqual({ category: "node_state", code: "STATE_STORAGE_UNAVAILABLE" });
    expect(classifyCliError(new NodeChatError("CHAT_ATTACHMENT_UNAVAILABLE")))
      .toEqual({ category: "node_chat", code: "CHAT_ATTACHMENT_UNAVAILABLE" });
    expect(classifyCliError(new WorkspaceTrustError("C:/private", "pending", "api_key=secret")))
      .toEqual({ category: "workspace_trust", code: "WORKSPACE_TRUST_REQUIRED" });
    expect(classifyCliError({ code: "AUTOPILOT_HOME_UNRESOLVED", message: "C:/private" }))
      .toEqual({ category: "config_directory", code: "AUTOPILOT_HOME_UNRESOLVED" });
  });

  it("未知或被篡改的错误码回退为固定标记且不带异常正文", function rejectsUntrustedErrorDetails() {
    const runtimeError = new AgentRuntimeError("RUNTIME_ERROR", "api_key=secret C:/private/prompt.txt");
    Object.defineProperty(runtimeError, "code", { value: "api_key=secret" });
    const stateError = new NodeStateError("STATE_STORAGE_UNAVAILABLE");
    Object.defineProperty(stateError, "code", { value: "C:/private/state.json" });
    const rawError = new Error("token=secret C:/private/provider-response.json");
    const hostileProxy = new Proxy({}, { has() { throw new Error("proxy secret"); } });

    const classifications = [classifyCliError(runtimeError), classifyCliError(stateError), classifyCliError(rawError), classifyCliError({ code: "token=secret" }), classifyCliError(hostileProxy)];
    expect(classifications).toEqual([
      { category: "agent_runtime", code: "AGENT_RUNTIME_ERROR" },
      { category: "node_state", code: "NODE_STATE_ERROR" },
      { category: "unknown", code: "CLI_RUNTIME_ERROR" },
      { category: "unknown", code: "CLI_RUNTIME_ERROR" },
      { category: "unknown", code: "CLI_RUNTIME_ERROR" },
    ]);
    expect(JSON.stringify(classifications)).not.toMatch(/secret|private|provider-response/iu);
  });
});
