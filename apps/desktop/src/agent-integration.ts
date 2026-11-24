// 为受管 Shell 生成状态观察、浏览器原生绑定及局部包装入口，不修改第三方全局配置或状态根。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentType } from "./workspace";
import type { AgentInstallation } from "./contract";
import { prepareManagedBrowserSkill } from "./browser-skills";
import { browserRunnerSource, browserModSource, browserOpenCodeSource } from "./browser-integration";

export const agentRunnerSource = String.raw`// 受管调用及短时 hook 上报，stdout 永远留给原 CLI。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const cp = require('node:child_process');
const browser = require('./browser.cjs');
// 固定字段上报，不传入 prompt、工具输入、路径、原始错误或凭据。
function report(event, session = '', turn = '') {
  return new Promise(function settle(resolve) {
    if (!process.env.AUTOPILOT_AGENT_ENDPOINT) return resolve();
    const socket = net.createConnection(process.env.AUTOPILOT_AGENT_ENDPOINT);
    const timer = setTimeout(function expired() { socket.destroy(); resolve(); }, 500);
    socket.on('connect', function connected() {
      socket.end(JSON.stringify({ paneId: process.env.AUTOPILOT_AGENT_PANE, generation: Number(process.env.AUTOPILOT_AGENT_GENERATION), token: process.env.AUTOPILOT_AGENT_TOKEN, instanceId: process.env.AUTOPILOT_AGENT_RUN, agent: process.env.AUTOPILOT_AGENT_TYPE, event, turn: turn ? crypto.createHash('sha256').update(String(turn)).digest('hex') : '', observation: process.env.AUTOPILOT_AGENT_OBSERVATION === 'off' ? 'disabled' : 'pending', session: crypto.createHash('sha256').update(String(session)).digest('hex'), stamp: process.hrtime.bigint().toString() }) + '\n');
    });
    socket.resume();
    socket.on('error', function ignore() {});
    socket.on('close', function closed() { clearTimeout(timer); resolve(); });
  });
}
// Windows原生入口必须具有PE签名，拒绝npm安装期间的占位脚本或残缺文件。
function nativeExecutable(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(64);
    if (fs.readSync(fd, header, 0, 64, 0) !== 64 || header.readUInt16LE(0) !== 0x5a4d) return false;
    const offset = header.readUInt32LE(60);
    if (offset < 64 || offset + 4 > fs.fstatSync(fd).size) return false;
    const signature = Buffer.alloc(4);
    return fs.readSync(fd, signature, 0, 4, offset) === 4 && signature.readUInt32LE(0) === 0x4550;
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
// 已安装 CLI 的受支持入口，Windows npm shim 映射到包内文件以避免 cmd 字符串拼接。
function command(agent) {
  let incomplete = false;
  const packages = { claude: ['@anthropic-ai/claude-code', 'bin/claude.exe'], codex: ['@openai/codex', 'bin/codex.js'], opencode: ['opencode-ai', 'bin/opencode.exe'], codebuddy: ['@tencent-ai/codebuddy-code', 'bin/codebuddy'] };
  for (const directory of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!directory) continue;
    if (process.platform !== 'win32') {
      const file = path.join(directory, agent);
      try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return { file, prefix: [] }; }
      catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error; }
      continue;
    }
    const exe = path.join(directory, agent + '.exe');
    if (fs.existsSync(exe)) {
      if (agent !== 'claude' || nativeExecutable(exe)) return { file: exe, prefix: [] };
      incomplete = true;
    }
    const [pkg, fallback] = packages[agent];
    const packageDirectory = path.join(directory, 'node_modules', pkg);
    const manifest = path.join(packageDirectory, 'package.json');
    let bin;
    try { bin = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')).bin : undefined; }
    catch { throw new Error('CLI_INSTALL_INVALID'); }
    const relative = (typeof bin === 'string' ? bin : bin && bin[agent]) || fallback;
    const file = path.join(directory, 'node_modules', pkg, relative);
    if (agent === 'claude' && file.endsWith('.exe') && !nativeExecutable(file) && fs.existsSync(manifest)) {
      incomplete = true;
      // 官方wrapper负责同版本平台包解析；安装过渡不自行复制全局文件或改变PATH。
      const wrapper = path.join(packageDirectory, 'cli-wrapper.cjs');
      if (fs.existsSync(wrapper)) return { file: process.execPath, prefix: [wrapper] };
      continue;
    }
    if (fs.existsSync(file)) {
      if (file.endsWith('.exe')) return { file, prefix: [] };
      const node = path.join(directory, 'node.exe');
      if (fs.existsSync(node)) return { file: node, prefix: [file] };
      return { file: process.execPath, prefix: [file] };
    }
  }
  throw new Error(incomplete ? 'CLI_INSTALL_INVALID' : 'CLI_MISSING');
}
exports.report = report;
// 仅把确认的第三方生命周期映射为粗状态，可恢复工具失败不当最终失败。
async function hook() {
  let data = '';
  for await (const chunk of process.stdin) { data += chunk; if (data.length > 4 * 1024 * 1024) return; }
  const value = JSON.parse(data);
  const browserOutput = await browser.codexHook(value);
  const session = value.session_id || value.thread_id;
  if (browserOutput !== undefined) process.stdout.write(JSON.stringify(browserOutput));
  if (!session || value.agent_id || value.agent_type === 'subagent') return;
  if (process.env.AUTOPILOT_AGENT_OBSERVATION === 'off') return;
  let event;
  switch (value.hook_event_name) {
    case 'SessionStart': event = 'ready'; break;
    case 'UserPromptSubmit': event = 'submit'; break;
    case 'PostToolUse': event = 'activity'; break;
    case 'PreToolUse': event = value.tool_name === 'AskUserQuestion' ? 'waiting' : 'activity'; break;
    case 'Notification': if (value.notification_type === 'permission_prompt' || value.notification_type === 'elicitation_dialog') event = 'waiting'; break;
    case 'PermissionRequest': if (process.env.AUTOPILOT_AGENT_TYPE === 'codex') event = 'waiting'; break;
    case 'Stop': event = 'done'; break;
    case 'StopFailure': event = 'failed'; break;
    case 'Interrupt': event = 'interrupted'; break;
    case 'SessionEnd': return;
  }
  if (event) await report(event, session, value.turn_id || '');
  if (browserOutput === undefined && process.env.AUTOPILOT_AGENT_TYPE === 'codex' && value.hook_event_name === 'Stop') process.stdout.write('{}');
}
// 每次手动重启获得新实例，退出事实由原 CLI 子进程 close 提供。
async function run(agent, args) {
  const target = command(agent);
  if (agent === 'claude') {
    // 只运行离线版本探测，发现更新过渡和坏入口；不触发会话或Provider。
    try {
      const version = cp.execFileSync(target.file, [...target.prefix, '--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (!/^\d+\.\d+\.\d+[^\r\n]*\(Claude Code\)\s*$/.test(version)) throw new Error('CLI_INSTALL_INVALID');
    } catch { throw new Error('CLI_INSTALL_INVALID'); }
  }
  if (args.includes('--autopilot-check')) return;
  process.env.AUTOPILOT_AGENT_TYPE = agent;
  process.env.AUTOPILOT_AGENT_RUN = crypto.randomUUID();
  let closeBrowser;
  try {
    // 独立进程避免共享daemon丢失PTY凭据；旧CLI不支持时保留普通CLI，不猜测flag。
    if (agent === 'codex' && process.env.AUTOPILOT_BROWSER_AGENT_TOKEN) {
      const help = cp.execFileSync(target.file, [...target.prefix, '--help'], { encoding: 'utf8', timeout: 5000, maxBuffer: 262144, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (!help.includes('--no-daemon')) throw new Error('BROWSER_CODEX_LOCAL_PROCESS_UNSUPPORTED');
    }
    closeBrowser = await browser.start(agent, process.env.AUTOPILOT_AGENT_RUN);
  }
  catch { delete process.env.AUTOPILOT_BROWSER_CALLER_TOKEN; delete process.env.AUTOPILOT_BROWSER_AGENT_TOKEN; console.error('Desktop 浏览器接入不可用，普通 CLI 仍可使用。'); }
  await report('begin');
  const directory = __dirname;
  const originalConfig = process.env.OPENCODE_CONFIG_CONTENT;
  const originalArgs = args;
  try {
    if (process.env.AUTOPILOT_AGENT_OBSERVATION !== 'off') {
      if (agent === 'claude' || agent === 'codebuddy') args = ['--plugin-dir', path.join(directory, agent), ...args];
      if (agent === 'codex') {
        const definition = JSON.parse(fs.readFileSync(path.join(directory, 'codex-hooks.json'), 'utf8')).hooks;
        // CLI -c 层只增加本进程 hooks，信任仍由原生 /hooks 处理。
        for (const [event, groups] of Object.entries(definition)) args = ['-c', 'hooks.' + event + '=' + JSON.stringify(groups).replace(/"(\w+)":/g, '$1='), ...args];
      }
      if (agent === 'opencode') {
        const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
        if (!config || typeof config !== 'object' || Array.isArray(config) || config.plugin !== undefined && !Array.isArray(config.plugin)) throw new Error('OBSERVER_CONFIG_INVALID');
        config.plugin = [...(Array.isArray(config.plugin) ? config.plugin : []), require('node:url').pathToFileURL(path.join(directory, 'opencode.mjs')).href];
        process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      }
    }
    if (closeBrowser && process.env.AUTOPILOT_BROWSER_CALLER_TOKEN) {
      const contract = path.join(directory, 'browser-contract', 'skills', 'ap-browser', 'SKILL.md');
      process.env.AUTOPILOT_BROWSER_SKILL = contract;
      const routing = browser.routing(contract);
      if (agent === 'claude' || agent === 'codebuddy') args = ['--append-system-prompt', routing, ...args];
      if (agent === 'codex') args = ['--no-daemon', '-c', 'features.hooks=true', ...args];
      if (agent === 'claude' || agent === 'codebuddy') args = ['--plugin-dir', path.join(directory, 'browser-' + agent), ...args];
      if (agent === 'codex' && process.env.AUTOPILOT_AGENT_OBSERVATION === 'off') {
        const definition = JSON.parse(fs.readFileSync(path.join(directory, 'codex-hooks.json'), 'utf8')).hooks;
        for (const [event, groups] of Object.entries(definition)) args = ['-c', 'hooks.' + event + '=' + JSON.stringify(groups).replace(/"(\w+)":/g, '$1='), ...args];
      }
      if (agent === 'opencode') {
        const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
        if (!config || typeof config !== 'object' || Array.isArray(config) || config.plugin !== undefined && !Array.isArray(config.plugin)) throw new Error('BROWSER_CONFIG_INVALID');
        config.plugin = [...(config.plugin || []), require('node:url').pathToFileURL(path.join(directory, 'browser-opencode.mjs')).href];
        if (config.instructions !== undefined && !Array.isArray(config.instructions)) throw new Error('BROWSER_CONFIG_INVALID');
        config.instructions = [...(config.instructions || []), contract];
        process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      }
    }
  } catch {
    closeBrowser?.(); closeBrowser = undefined; delete process.env.AUTOPILOT_BROWSER_CALLER_TOKEN;
    args = originalArgs;
    if (originalConfig === undefined) delete process.env.OPENCODE_CONFIG_CONTENT; else process.env.OPENCODE_CONFIG_CONTENT = originalConfig;
    console.error('Desktop 局部观察不可用，继续启动原 CLI。');
  }
  const child = cp.spawn(target.file, [...target.prefix, ...args], { stdio: 'inherit', env: process.env, windowsHide: true });
  process.on('SIGINT', function preserveWrapperUntilChildCloses() {});
  child.on('error', function failed() { closeBrowser?.(); process.exitCode = 1; console.error('所选 CLI 无法启动，安装可能正在更新，请稍后重新检测。'); });
  child.on('close', async function closed(code) { closeBrowser?.(); await report('exit'); process.exitCode = code === null ? 1 : code; });
}
if (require.main === module) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'hook') hook().catch(function ignored() {});
  else run(mode, args).catch(function failed(error) {
    const missing = error.message === 'CLI_MISSING';
    console.error(missing ? '未检测到所选 CLI，请安装后重新检测。' : error.message === 'CLI_INSTALL_INVALID' ? '所选 CLI 安装不完整或正在更新，请等待更新完成后重新检测；仍失败时修复官方 CLI 安装。' : '所选 CLI 启动检查失败，请核对安装与运行时。');
    process.exitCode = missing ? 2 : error.message === 'CLI_INSTALL_INVALID' ? 3 : 1;
  });
}
`;

export const openCodePluginSource = String.raw`// OpenCode 只读事件插件，逐会话维护状态，原始正文不离开 CLI。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { report } = require('./runner.cjs');
export const AutopilotObserver = async function ({ client }) {
  const sessions = new Map();
  const blockers = new Map();
  let queue = Promise.resolve();
  // SDK 查询失败或子会话归属不清时保持未知，不把子会话结束当主任务完成。
  async function event({ event }) {
    const p = event.properties || {};
    const sessionId = p.sessionID || p.info?.id || blockers.get(p.requestID || p.id);
    if (!sessionId) return;
    let info;
    try { const result = await client.session.get({ path: { id: sessionId } }); info = result.data; } catch { await report('unknown', sessionId); return; }
    if (!info || info.parentID) return;
    const previous = sessions.get(sessionId) || 'idle';
    if (event.type === 'permission.asked' || event.type === 'question.asked') {
      blockers.set(p.id, sessionId);
      sessions.set(sessionId, 'waiting');
      await report('waiting', sessionId);
    } else if (['permission.replied', 'question.replied', 'question.rejected'].includes(event.type)) {
      blockers.delete(p.requestID || p.id);
      if (![...blockers.values()].includes(sessionId)) { sessions.set(sessionId, 'running'); await report('activity', sessionId); }
    } else if (event.type === 'session.status') {
      const status = p.status?.type;
      if (status === 'busy' || status === 'retry') {
        if (previous !== 'waiting') { sessions.set(sessionId, 'running'); await report(previous === 'idle' ? 'submit' : 'activity', sessionId); }
      } else if (status === 'idle') {
        for (const [id, owner] of blockers) if (owner === sessionId) blockers.delete(id);
        sessions.set(sessionId, 'idle');
        await report('done', sessionId);
      }
    } else if (event.type === 'session.created') await report('ready', sessionId);
    // session.error 常可恢复，只有后续 canonical status 决定本轮状态。
  }
  return { event: function receive(value) { queue = queue.then(function apply() { return event(value); }).catch(function ignored() {}); return queue; } };
};
`;

/** 只生成 Desktop 自有文件，引用路径经 JSON 编码，不读取或覆写用户配置。 */
export async function prepareAgentIntegration(userData: string, node: string): Promise<string> {
  const directory = join(userData, "agent-observer");
  await mkdir(directory, { recursive: true });
  await prepareManagedBrowserSkill(join(directory, "browser-contract", "skills", "ap-browser"));
  const runner = join(directory, "runner.cjs");
  await writeFile(runner, agentRunnerSource, { mode: 0o600 });
  await writeFile(join(directory, "browser.cjs"), browserRunnerSource, { mode: 0o600 });
  await writeFile(join(directory, "browser-opencode.mjs"), browserOpenCodeSource, { mode: 0o600 });
  await writeFile(join(directory, "opencode.mjs"), openCodePluginSource, { mode: 0o600 });
  const command = `"${node}" "${runner}" hook`;
  // Codex 在 Windows 通过 PowerShell 执行 hook，带引号的路径必须使用调用运算符。
  const codexCommand = process.platform === "win32" ? `& '${node.replaceAll("'", "''")}' '${runner.replaceAll("'", "''")}' hook` : command;
  const hooks: Record<string, unknown> = {};
  const codexHooks: Record<string, unknown> = {};
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop", "StopFailure", "SessionEnd", "Interrupt"]) {
    hooks[event] = [{ hooks: [{ type: "command", command, timeout: 1 }] }];
    if (event !== "Notification" && event !== "StopFailure") codexHooks[event] = [{ hooks: [{ type: "command", command: codexCommand, timeout: 3 }] }];
  }
  await writeFile(join(directory, "codex-hooks.json"), JSON.stringify({ hooks: codexHooks }), { mode: 0o600 });
  for (const agent of ["claude", "codebuddy"]) {
    const root = join(directory, agent);
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(join(root, "hooks"), { recursive: true });
    await writeFile(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "autopilot-observer", version: "1.0.0", description: "Desktop 只读粗粒度状态观察" }), { mode: 0o600 });
    await writeFile(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: Object.fromEntries(Object.entries(hooks).filter(function supported([event]) { return event !== "Interrupt" && event !== "PermissionRequest"; })) }), { mode: 0o600 });
    const browserRoot = join(directory, `browser-${agent}`);
    await mkdir(join(browserRoot, ".claude-plugin"), { recursive: true });
    await mkdir(join(browserRoot, "hooks"), { recursive: true });
    await writeFile(join(browserRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "autopilot-browser", version: "1.0.0", description: "Desktop浏览器原生回合与单动作绑定" }), { mode: 0o600 });
    await writeFile(join(browserRoot, "hooks", "hooks.json"), JSON.stringify({ modules: ["./register.js"] }), { mode: 0o600 });
    await writeFile(join(browserRoot, "hooks", "register.js"), browserModSource, { mode: 0o600 });
    await prepareManagedBrowserSkill(join(browserRoot, "skills", "ap-browser"));
  }
  return runner;
}

/** 安装检测与实际启动共用入口解析，缺失与检测异常分别返回固定状态。 */
export async function getAgentInstallation(node: string, runner: string, agent: Exclude<AgentType, "ap">): Promise<AgentInstallation> {
  try { await promisify(execFile)(node, [runner, agent, "--autopilot-check"], { timeout: 7000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: "" } }); }
  catch (error) { return (error as { code?: number }).code === 2 ? "missing" : "error"; }
  return "available";
}

/** 启动前复查入口，CLI 的交互、认证和权限仍由原程序处理。 */
export async function checkAgentInstallation(node: string, runner: string, agent: AgentType): Promise<void> {
  if (agent === "ap") return;
  const installation = await getAgentInstallation(node, runner, agent);
  if (installation === "missing") throw new Error("未检测到所选 CLI，请安装后重新检测。");
  if (installation === "error") throw new Error("所选 CLI 安装不完整、正在更新或运行时不可用，请稍后重新检测；仍失败时修复官方 CLI 安装。");
}
