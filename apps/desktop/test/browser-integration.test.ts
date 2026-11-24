// 原生适配仅在VM内验证生命周期协议，不启动任何第三方CLI。
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { browserModSource, browserOpenCodeSource, browserRunnerSource } from "../src/browser-integration";

const TEST_PERMIT = "a".repeat(64);
/** VM仅提供确定的受管运行时；实际Shell/Server组合另有独立特性用例。 */
function fixtureEnv(name: string): string {
  if (name === "AUTOPILOT_DESKTOP_NODE") return "/managed/node";
  if (name === "AUTOPILOT_DESKTOP_CLI") return "/managed/cli.js";
  return name.endsWith("ENDPOINT") ? "http://127.0.0.1:1234" : "token";
}

test("Codex parses only a single foreground action and binds native turn/tool", async function codex() {
  const exports: any = {};
  const calls: any[] = [];
  const source = browserRunnerSource.replace("exports.parse =", "request = async function(path, value) { calls.push({path,value}); return {permit:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}; }; exports.parse =");
  runInNewContext(source, { exports, calls, require: function require() { return {}; }, process: { env: { AUTOPILOT_AGENT_TYPE: "codex", AUTOPILOT_BROWSER_CALLER_TOKEN: "token", AUTOPILOT_DESKTOP_NODE: "/managed/node", AUTOPILOT_DESKTOP_CLI: "/managed/cli.js" } } });
  assert.throws(function compound() { exports.parse("ap browser list '{}' && echo bad"); }, /BROWSER_ACTION_INVALID/);
  assert.throws(function extra() { exports.parse("ap browser list '{\"type\":\"open\"}'"); });
  const value = { hook_event_name: "PreToolUse", turn_id: "turn", tool_use_id: "call", tool_input: { command: "ap browser list '{}'" } };
  const output = await exports.codexHook(value);
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  assert.match(output.hookSpecificOutput.updatedInput.command, /managed\/cli\.js/);
  assert.ok(output.hookSpecificOutput.updatedInput.command.includes(TEST_PERMIT));
  assert.equal(calls[1].value.callId, "call"); assert.equal(calls[1].value.turnId, "turn");
  for (const [event, path] of [["Stop", "/turn/suspend"], ["Interrupt", "/turn/end"], ["UserPromptSubmit", "/turn/replace"]]) { await exports.codexHook({ ...value, hook_event_name: event }); assert.equal(calls.at(-1).path, path); }
  const count = calls.length; await exports.codexHook({ ...value, agent_id: "child" }); assert.equal(calls.length, count);
});

test("native mods bind main turn, run next once and revoke on tool failure", async function mods() {
  const hooks: Record<string, any> = {}; const calls: any[] = [];
  const context: any = { on: function on(name: string, fn: any) { hooks[name] = fn; return { catch: function recover() {} }; } };
  runInNewContext(browserModSource.replace("export function register", "function register") + "\nregister(on);", context);
  const $ = { env: { async get(name: string) { return fixtureEnv(name); } }, http: { async fetch(url: string, options: any) { calls.push({ url, value: JSON.parse(options.body) }); return { ok: true, text: JSON.stringify({ ok: true, result: { permit: TEST_PERMIT } }) }; } } };
  let executions = 0;
  const next = Object.assign(async function next(e: any) { executions++; return e; }, { origin: { plugin: "engine", tier: "core" }, signal: new AbortController().signal });
  await hooks["turn.start"]($, { turnId: "turn" }, next);
  const e = { tool: "Bash", tool_use_id: "call", command: "ap browser list '{}'", run_in_background: true };
  const result = await hooks["tool.call"]($, e, next);
  assert.match(result.command, /managed\/cli\.js/); assert.ok(result.command.includes(TEST_PERMIT)); assert.equal(result.run_in_background, false);
  assert.equal(calls.at(-1).url, "http://127.0.0.1:1234/permit/revoke");
  const count = executions; assert.ok((await hooks["tool.call"]($, { ...e, agentId: "child" }, next)).deny); assert.equal(executions, count);
  const failed = Object.assign(async function fail() { executions++; throw new Error("native failed"); }, { origin: next.origin, signal: next.signal });
  await assert.rejects(hooks["tool.call"]($, e, failed), /native failed/); assert.equal(executions, count + 1);
  assert.ok(calls.at(-1).url.endsWith("/permit/revoke"));
  await hooks["turn.complete"]($, { turnId: "turn", reason: "aborted" }, next);
  assert.ok((await hooks["tool.call"]($, e, next)).deny);
});

test("OpenCode traces native assistant parent through synthetic continuation", async function opencode() {
  const requests: any[] = [];
  const bridge = { routing: function routing() { return 'route'; }, browserCommand: function browserCommand() { return 'fixed --permit ' + TEST_PERMIT; }, parse: function parse() { return { type: "list" }; }, async request(path: string, value: any) { requests.push({ path, value }); return { permit: TEST_PERMIT }; } };
  const source = browserOpenCodeSource.slice(browserOpenCodeSource.indexOf("export const AutopilotBrowser")).replace("export const AutopilotBrowser", "var AutopilotBrowser");
  const context: any = { bridge, process }; runInNewContext(source, context);
  let child = false;
  const client = { session: { async get() { return { data: { parentID: child ? "parent" : undefined } }; }, async messages() { return { data: [
    { info: { role: "user", id: "real", time: { created: 1 } }, parts: [{ type: "text" }] },
    { info: { role: "user", id: "synthetic", time: { created: 2 } }, parts: [{ type: "text", synthetic: true }] },
    { info: { role: "assistant", id: "assistant", parentID: "synthetic" }, parts: [{ callID: "call" }] },
  ] }; } } };
  const plugin = await context.AutopilotBrowser({ client });
  await plugin["tool.definition"]({ toolID: "bash" }, { description: "Be aware: OS: win32, Shell: powershell" });
  const input = { tool: "bash", sessionID: "session", callID: "call" }; const output = { args: { command: "ap browser list '{}'" } };
  await plugin["tool.execute.before"](input, output);
  assert.equal(requests[0].value.turnId, "session:real"); assert.ok(output.args.command.endsWith("--permit " + TEST_PERMIT));
  await plugin["tool.execute.after"](input); assert.equal(requests.at(-1).path, "/permit/revoke");
  await assert.rejects(plugin["tool.execute.before"]({ ...input, callID: "foreign" }, output), /USER_TURN/);
  child = true; await assert.rejects(plugin["tool.execute.before"](input, output), /MAIN_SESSION/);
  await plugin.event({ event: { type: "session.status", properties: { sessionID: "session", status: { type: "idle" } } } });
  assert.equal(requests.at(-1).path, "/turn/end");
});

// 取消先于许可返回时仍回收迟到许可，禁止调用原生工具。
test("native mods revoke cancellation before permit response and during next", async function cancellation() {
  for (const phase of ["permit", "next"]) {
    const hooks: Record<string, any> = {};
    runInNewContext(browserModSource.replace("export function register", "function register") + "\nregister(on);", { on: function on(name: string, fn: any) { hooks[name] = fn; return { catch: function caught() {} }; } });
    let entered!: () => void;
    const ready = new Promise<void>(function started(resolve) { entered = resolve; });
    let finish!: () => void;
    const pending = new Promise<void>(function waiting(resolve) { finish = resolve; });
    let revokes = 0;
    let executions = 0;
    const $ = { env: { async get(name: string) { return fixtureEnv(name); } }, http: { async fetch(url: string) {
      if (url.endsWith("/permit/revoke")) revokes++;
      if (url.endsWith("/permit") && phase === "permit") { entered(); await pending; }
      return { ok: true, text: JSON.stringify({ ok: true, result: { permit: TEST_PERMIT } }) };
    } } };
    await hooks["turn.start"]($, { turnId: "turn" }, async function begin(e: any) { return e; });
    const abort = new AbortController();
    const next = Object.assign(async function execute() { executions++; entered(); await pending; }, { origin: { plugin: "engine", tier: "core" }, signal: abort.signal });
    const running = hooks["tool.call"]($, { tool: "Bash", tool_use_id: "call", command: "ap browser list '{}'" }, next);
    await ready; abort.abort();
    await new Promise(function tick(resolve) { setImmediate(resolve); });
    assert.equal(revokes, 1);
    finish(); await running;
    assert.equal(executions, phase === "permit" ? 0 : 1);
    assert.equal(revokes, phase === "permit" ? 2 : 1);
  }
});

// 与本机CodeBuddy tool-call-boundary声明一致：REPL cell内部调用以Bash/PowerShell平铺事件派发。
test("CodeBuddy inner shell preserves external browser and appends managed routing locally", async function codebuddyRouting() {
  const hooks: Record<string, any> = {};
  runInNewContext(browserModSource.replace("export function register", "function register") + "\nregister(on);", { on: function on(name: string, fn: any) { hooks[name] = fn; return { catch: function caught() {} }; } });
  let executions = 0;
  const $ = { env: { async get(name: string) { if (name === "AUTOPILOT_AGENT_TYPE") return "codebuddy"; return undefined; } } };
  const next = Object.assign(async function next(e: any) { executions++; return e; }, { origin: { plugin: "engine", tier: "core" }, signal: new AbortController().signal });
  const commands = ["agent-browser open https://example.test", "npx -y agent-browser snapshot", "& 'C:\\Program Files\\nodejs\\agent-browser.ps1' open https://example.test", "'/usr/local/bin/agent-browser' open https://example.test", "./agent-browser screenshot", 'echo ready; agent-browser list'];
  for (const tool of ["Bash", "PowerShell"]) for (const command of commands) {
    const before = executions;
    const result = await hooks["tool.call"]($, { tool, command, tool_use_id: "repl-inner-shell" }, next);
    assert.equal(result.command, command); assert.equal(executions, before + 1);
  }
  assert.equal((await hooks["tool.call"]($, { tool: "Bash", command: "echo agent-browser", tool_use_id: "ordinary" }, next)).command, "echo agent-browser");
  await hooks["turn.start"]($, { turnId: "turn" }, next);
  assert.equal((await hooks["tool.call"]($, { tool: "Bash", command: "ap browser list '{}'", tool_use_id: "browser" }, next)).deny, "BROWSER_UNAVAILABLE");
  const skill = await hooks["skill.prompt"]($, { skill: "agent-browser", text: "call global driver" }, next);
  assert.equal(skill.text, 'call global driver');
  const prompt = await hooks["prompt.compose"]($, {}, async function composed() { return { sections: [{ id: "system", text: "original", scope: "shared" }] }; });
  assert.equal(prompt.sections[0].text, "original"); assert.equal(prompt.sections[1].id, "autopilot-browser:routing");
});
