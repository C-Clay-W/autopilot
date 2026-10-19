/** CLI parser 契约测试：覆盖帮助、命令参数、未知参数、退出码输入和 slash action。 */

import { describe, expect, it } from "vitest";
import { getSlashCommandSuggestions, parseArgv, parseSlashAction, renderHelp } from "../src/parser.js";

describe("CLI parser", function cliParserSuite() {
  it("解析 project open 与显式宿主根", function parsesProjectOpen() {
    expect(parseArgv(["project", "open", "C:/workspace", "--state-root", "C:/state", "--trust-root", "C:/trust"])).toEqual({
      kind: "command",
      invocation: {
        command: { type: "project_open", path: "C:/workspace" },
        host: { stateRoot: "C:/state", trustRoot: "C:/trust" },
      },
    });
  });

  it("裸命令（无 argv）进入默认 interactive chat，不再返回帮助", function parsesBareCommand() {
    expect(parseArgv([])).toEqual({
      kind: "command",
      invocation: {
        command: { type: "chat", output: "interactive" },
        host: {},
      },
    });
  });

  it("解析 chat/resume 的 session、prompt 和 JSONL 输出", function parsesChatAndResume() {
    expect(parseArgv(["chat", "读取", "README", "--session", "session-1", "--output", "jsonl", "--workspace-root", "C:/workspace"])).toEqual({
      kind: "command",
      invocation: {
        command: { type: "chat", prompt: "读取 README", sessionId: "session-1", output: "jsonl" },
        host: { workspaceRoot: "C:/workspace" },
      },
    });
    expect(parseArgv(["resume", "-s", "session-1", "--jsonl"]).kind).toBe("command");
  });

  it("解析 Stage 10 管理命令并强制 config scope 与删除确认", function parsesManagementCommands() {
    expect(parseArgv(["session", "list"])).toEqual({ kind: "command", invocation: { command: { type: "session_list" }, host: {} } });
    expect(parseArgv(["session", "rename", "session-1", "新", "标题"])).toEqual({ kind: "command", invocation: { command: { type: "session_rename", sessionId: "session-1", title: "新 标题" }, host: {} } });
    expect(parseArgv(["session", "delete", "session-1", "--yes"])).toEqual({ kind: "command", invocation: { command: { type: "session_delete", sessionId: "session-1", yes: true }, host: {} } });
    expect(parseArgv(["project", "remove", "v1-project"])).toEqual({ kind: "command", invocation: { command: { type: "project_remove", workspaceId: "v1-project" }, host: {} } });
    expect(parseArgv(["trust", "revoke"])).toEqual({ kind: "command", invocation: { command: { type: "trust_revoke" }, host: {} } });
    expect(parseArgv(["config", "get", "model"])).toEqual({ kind: "error", message: "config 必须显式提供 --scope user|project|local" });
    expect(parseArgv(["config", "set", "model", "deepseek-v4-pro", "--scope", "project"])).toEqual({ kind: "command", invocation: { command: { type: "config_set", scope: "project", key: "model", value: "deepseek-v4-pro" }, host: {} } });
    expect(parseArgv(["doctor", "--connectivity"])).toEqual({ kind: "command", invocation: { command: { type: "doctor", connectivity: true }, host: {} } });
  });

  it("解析 MCP 管理命令，并要求非交互批准显式传入 --yes", function parsesMcpManagementCommands() {
    expect(parseArgv(["mcp", "list"])).toEqual({ kind: "command", invocation: { command: { type: "mcp_list" }, host: {} } });
    expect(parseArgv(["mcp", "approve", "fixture", "--yes"])).toEqual({ kind: "command", invocation: { command: { type: "mcp_approve", serverName: "fixture", yes: true }, host: {} } });
    expect(parseArgv(["mcp", "revoke", "fixture"])).toEqual({ kind: "command", invocation: { command: { type: "mcp_revoke", serverName: "fixture" }, host: {} } });
  });

  it("解析 sandbox status/setup；系统级 setup 必须显式 --yes", function parsesSandboxCommands() {
    expect(parseArgv(["sandbox", "status"])).toEqual({ kind: "command", invocation: { command: { type: "sandbox_status" }, host: {} } });
    expect(parseArgv(["sandbox", "setup", "--yes"])).toEqual({ kind: "command", invocation: { command: { type: "sandbox_setup", yes: true }, host: {} } });
    expect(parseArgv(["sandbox", "setup"])).toEqual({ kind: "error", message: "sandbox 支持 status | setup --yes" });
    expect(parseArgv(["sandbox"])).toEqual({ kind: "error", message: "sandbox 支持 status | setup --yes" });
  });

  it("解析后台 Job 管理命令", function parsesJobManagementCommands() {
    expect(parseArgv(["job", "list"])).toEqual({ kind: "command", invocation: { command: { type: "job_list" }, host: {} } });
    expect(parseArgv(["job", "show", "job-1"])).toEqual({ kind: "command", invocation: { command: { type: "job_show", jobId: "job-1" }, host: {} } });
    expect(parseArgv(["job", "output", "job-1"])).toEqual({ kind: "command", invocation: { command: { type: "job_output", jobId: "job-1" }, host: {} } });
    expect(parseArgv(["job", "kill", "job-1"])).toEqual({ kind: "command", invocation: { command: { type: "job_kill", jobId: "job-1" }, host: {} } });
  });

  it("帮助文本稳定且标明非 TTY 输出边界", function rendersHelp() {
    const result = parseArgv(["--help"]);
    expect(result.kind).toBe("help");
    expect(renderHelp()).toContain("--output interactive|text|jsonl");
    expect(renderHelp()).toContain("Exit codes:");
    expect(renderHelp()).toContain("never emits ANSI");
  });

  it("未知命令、未知选项和非法输出值均返回 usage error", function rejectsUnknownArguments() {
    expect(parseArgv(["unknown"])).toEqual({ kind: "error", message: "未知命令 unknown" });
    expect(parseArgv(["chat", "--unknown"])).toEqual({ kind: "error", message: "未知选项 --unknown" });
    expect(parseArgv(["chat", "--output", "xml"])).toEqual({ kind: "error", message: "--output 不支持值 xml" });
  });

  it("slash action 不把未知命令改写成 prompt，审批只产生四字段决定", function parsesSlashActions() {
    expect(parseSlashAction("/approve allow_workspace")).toEqual({ kind: "action", action: { type: "approve", decision: "allow_workspace" } });
    expect(parseSlashAction("/exit")).toEqual({ kind: "action", action: { type: "exit" } });
    expect(parseSlashAction("/unknown")).toEqual({ kind: "error", message: "未知 slash command /unknown" });
    expect(parseSlashAction("/approve call-1")).toEqual({ kind: "error", message: "/approve 需要 allow_once|allow_session|allow_workspace|deny" });
    expect(parseSlashAction("/queue 下一步执行测试")).toEqual({ kind: "action", action: { type: "submit_prompt", content: "下一步执行测试", delivery: "queue" } });
    expect(parseSlashAction("/queue")).toEqual({ kind: "error", message: "/queue 需要一条 prompt" });
  });

  it("模型与推理命令解析为 picker 查询或下一 Turn 的默认值更新", function parsesRunConfigActions() {
    expect(parseSlashAction("/model")).toEqual({ kind: "action", action: { type: "open_model_picker" } });
    expect(parseSlashAction("/model deepseek-v4-pro")).toEqual({ kind: "action", action: { type: "set_model", modelId: "deepseek-v4-pro" } });
    expect(parseSlashAction("/model gateway-route/gateway-chat")).toEqual({ kind: "action", action: { type: "set_model", provider: "gateway-route", modelId: "gateway-chat" } });
    expect(parseSlashAction("/reasoning high")).toEqual({ kind: "action", action: { type: "set_effort", effort: "high" } });
    expect(parseSlashAction("/model openai gpt-5")).toEqual({ kind: "error", message: "/model 最多接受一个值" });
  });

  it("解析三态权限查询与默认值更新", function parsesPermissionActions() {
    expect(parseSlashAction("/permissions")).toEqual({ kind: "action", action: { type: "open_permissions" } });
    expect(parseSlashAction("/permissions full_access")).toEqual({ kind: "action", action: { type: "set_permission_mode", mode: "full_access" } });
    expect(parseSlashAction("/permissions unsafe")).toEqual({ kind: "error", message: "/permissions 需要 ask|auto_approve|full_access 或 grants | revoke <constraint>" });
    expect(parseSlashAction("/permissions grants")).toEqual({ kind: "action", action: { type: "list_permission_grants" } });
    expect(parseSlashAction("/permissions revoke ext-file:D:/out/a.txt")).toEqual({ kind: "action", action: { type: "revoke_permission_grant", constraint: "ext-file:D:/out/a.txt" } });
    expect(parseSlashAction("/permissions revoke")).toEqual({ kind: "error", message: "/permissions revoke 需要从 /permissions grants 列表中复制的完整 constraint" });
    expect(parseSlashAction("/permissions bad extra")).toEqual({ kind: "error", message: "/permissions 需要 ask|auto_approve|full_access 或 grants | revoke <constraint>" });
  });

  it("/skill 无参数列出 catalog，有参数才选择 canonical Skill", function parsesSkillListAndSelection() {
    expect(parseSlashAction("/skill")).toEqual({ kind: "action", action: { type: "list_skills" } });
    expect(parseSlashAction("/skill repo:review")).toEqual({ kind: "action", action: { type: "select_skill", skill: "repo:review" } });
    expect(parseSlashAction("/skill repo:review extra")).toEqual({ kind: "error", message: "/skill 最多接受一个 canonical Skill 名称" });
  });

  it("输入普通斜线可发现全部命令并按前缀过滤", function suggestsSlashCommands() {
    expect(getSlashCommandSuggestions("/").map(function commandName(command) { return command.name; })).toHaveLength(12);
    expect(getSlashCommandSuggestions("/perm").map(function commandName(command) { return command.name; })).toEqual(["/permissions"]);
    expect(getSlashCommandSuggestions("/cont").map(function commandName(command) { return command.name; })).toEqual(["/context"]);
    expect(getSlashCommandSuggestions("/queue ")).toEqual([]);
  });
});
