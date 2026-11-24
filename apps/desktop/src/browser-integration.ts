// 受管第三方CLI的原生工具/生命周期适配，浏览器引擎与审批仍统一归Desktop。
const browserCommandSource = String.raw`// 原生命令解析、稳定错误与shell引用由四个受管CLI共用。
function browserError(error, fallback = 'BROWSER_NATIVE_BINDING_FAILED') {
  const message = typeof error === 'string' ? error : error && error.message;
  return typeof message === 'string' && /^BROWSER_[A-Z0-9_]{1,96}$/.test(message) ? message : fallback;
}
// 同一契约目录显式进入原生会话上下文；不替换用户已有规则。
function routing(file) {
  return 'Available skill: ap-browser — Autopilot Desktop 内置浏览器必须使用 ap browser；不要误选 Codex IAB / Computer Use. Read ' + file + '. Use one foreground native shell tool call: ap browser ACTION single-quoted JSON. A REPL may dispatch that native Bash/PowerShell tool; do not evaluate the browser command as JavaScript or launch a nested shell. Missing native bridge/turn/tool identity is an error. On failure report the error; do not retry command variants. Ordinary commands and a user explicitly selecting an external browser keep native behavior. These instructions apply only to this Desktop-managed process and its children.';
}
// 仅接收固定单动作，JSON不得伪造type或已有许可。
function parse(command) {
  if (typeof command !== 'string') return;
  const match = /^\s*ap browser ([a-z-]+) '([^'\r\n]+)'\s*$/.exec(command);
  if (!match) {
    if (/^\s*ap\s+browser\b/.test(command)) throw new Error('BROWSER_ACTION_INVALID');
    return;
  }
  let input;
  try { input = JSON.parse(match[2]); } catch { throw new Error('BROWSER_ACTION_INVALID'); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || 'type' in input) throw new Error('BROWSER_ACTION_INVALID');
  return { type: match[1], ...input };
}
// 使用Desktop已冻结的绝对运行时；Git Bash不继承PowerShell的ap函数，也不能落到全局旧ap。
function browserCommand(operation, permit, shell, node, cli) {
  if (!node || !cli || !/^(?:[A-Za-z]:[/\\]|\/)/.test(node) || !/^(?:[A-Za-z]:[/\\]|\/)/.test(cli)) throw new Error('BROWSER_MANAGED_CLI_REQUIRED');
  if (!/^[a-f0-9]{64}$/.test(permit)) throw new Error('BROWSER_PERMIT_INVALID');
  const { type, ...input } = operation;
  // Shell参数全部逐项引用，原始用户正文不会成为命令语法。
  function quote(value) {
    if (shell === 'PowerShell') return "'" + value.replace(/'/g, "''") + "'";
    return "'" + value.replace(/'/g, "'\\''") + "'";
  }
  // Win32原生argv（包括PS5与Git Bash）不能可靠保留JSON内部引号/反斜线。
  // 固定Node前导只恢复参数再加载同一CLI，不执行模型生成的代码。
  const backtick = String.fromCharCode(96);
  const bootstrap = [
    'process.argv[3] = decodeURIComponent(process.argv[3]);',
    'process.argv.splice(2, 0, ' + backtick + 'browser' + backtick + ');',
    'import(require(' + backtick + 'node:url' + backtick + ').pathToFileURL(process.argv[1]).href);',
  ].join('\n');
  const encoded = encodeURIComponent(JSON.stringify(input)).replace(/'/g, '%27');
  const args = [node, '-e', bootstrap, cli, type, encoded, '--permit', permit];
  if (shell === 'Bash') { args[0] = node.replace(/\\/g, '/'); args[3] = cli.replace(/\\/g, '/'); }
  return (shell === 'PowerShell' ? '& ' : '') + args.map(quote).join(' ');
}
`;

export const browserRunnerSource = String.raw`// 仅用于Desktop自有runner和原生hooks，不提供用户可自报的回合命令。
const http = require('node:http');
${browserCommandSource}
// 请求不重试；HTTP仅使用宿主生成的loopback地址。
function request(path, value, token = process.env.AUTOPILOT_BROWSER_CALLER_TOKEN) {
  return new Promise(function send(resolve, reject) {
    const endpoint = process.env.AUTOPILOT_BROWSER_ENDPOINT;
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint || '') || !token) return reject(new Error('BROWSER_UNAVAILABLE'));
    const req = http.request(endpoint + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, function response(res) {
      let data = ''; res.on('data', function chunk(chunk) { data += chunk; if (data.length > 65536) req.destroy(); });
      res.on('end', function end() {
        let result;
        try { result = JSON.parse(data); } catch { reject(new Error('BROWSER_RESPONSE_INVALID')); return; }
        if (!result.ok) reject(new Error(browserError(result.error, 'BROWSER_REQUEST_FAILED')));
        else resolve(result.result);
      });
      res.on('error', function failed() { reject(new Error('BROWSER_UNAVAILABLE')); });
    });
    req.on('error', function failed() { reject(new Error('BROWSER_UNAVAILABLE')); }); req.setTimeout(5000, function timeout() { req.destroy(new Error('BROWSER_UNAVAILABLE')); }); req.end(JSON.stringify(value));
  });
}
// 受管CLI包装进程持有监视连接；子CLI退出或wrapper崩溃都会使授权失效。
async function start(agent, runId) {
  delete process.env.AUTOPILOT_BROWSER_NATIVE_TOKEN;
  if (!process.env.AUTOPILOT_BROWSER_AGENT_TOKEN) return;
  const connected = await request('/connect-agent', { agent, runId }, process.env.AUTOPILOT_BROWSER_AGENT_TOKEN);
  delete process.env.AUTOPILOT_BROWSER_AGENT_TOKEN;
  process.env.AUTOPILOT_BROWSER_CALLER_TOKEN = connected.token;
  let watch;
  await new Promise(function listen(resolve, reject) {
    watch = http.request(process.env.AUTOPILOT_BROWSER_ENDPOINT + '/watch', { method: 'POST', headers: { Authorization: 'Bearer ' + connected.token, 'Content-Type': 'application/json' } }, function ready(response) { if (response.statusCode !== 200) { response.resume(); reject(new Error('BROWSER_UNAVAILABLE')); return; } response.resume(); response.socket.unref(); resolve(); });
    watch.on('error', function failed() { reject(new Error('BROWSER_UNAVAILABLE')); }); watch.end('{}');
  });
  return function close() { watch.destroy(); };
}
// Codex原生turn/tool ID决定许可，Stop仅冻结到同一turn的明确续接，Interrupt真正撤销。
async function codexHook(value) {
  if (process.env.AUTOPILOT_AGENT_TYPE !== 'codex' || !process.env.AUTOPILOT_BROWSER_CALLER_TOKEN) return;
  const turnId = value.turn_id;
  if (['SessionStart', 'UserPromptSubmit'].includes(value.hook_event_name) && !value.agent_id) {
    if (value.hook_event_name === 'UserPromptSubmit' && turnId) await request('/turn/replace', { turnId });
    return { hookSpecificOutput: { hookEventName: value.hook_event_name, additionalContext: routing(process.env.AUTOPILOT_BROWSER_SKILL) } };
  }
  if (value.hook_event_name === 'PreToolUse') {
    const input = value.tool_input;
    const field = typeof input?.cmd === 'string' ? 'cmd' : typeof input?.command === 'string' ? 'command' : undefined;
    const command = field && input[field];
    // deny结果不运行原工具；updatedInput不声明allow，保留Codex自身权限检查。
    function deny(error) { return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: browserError(error) } }; }
    // code是JavaScript工具输入，绝不能作为Shell执行或编造许可；仅提供路由纠正。
    if (!field) {
      if (typeof input?.code === 'string' && /(?:cua\.|ap browser)/.test(input.code)) return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: routing(process.env.AUTOPILOT_BROWSER_SKILL) } };
      return;
    }
    let operation;
    try { operation = parse(command); } catch (error) { return deny(error); }
    if (!operation) return;
    if (!turnId || value.agent_id) return deny('BROWSER_NATIVE_TURN_REQUIRED');
    if (!value.tool_use_id) return deny('BROWSER_CALL_REQUIRED');
    if (!process.env.AUTOPILOT_BROWSER_CALLER_TOKEN) return deny('BROWSER_UNAVAILABLE');
    try {
      await request('/turn/begin', { turnId });
      const result = await request('/permit', { turnId, callId: value.tool_use_id, operation });
      const shell = typeof input.shell === 'string' ? input.shell : process.platform === 'win32' ? 'powershell' : 'bash';
      if (!/(?:bash|zsh|sh|powershell|pwsh)(?:\.exe)?$/i.test(shell)) return deny('BROWSER_NATIVE_SHELL_UNSUPPORTED');
      const managed = browserCommand(operation, result.permit, /(?:powershell|pwsh)(?:\.exe)?$/i.test(shell) ? 'PowerShell' : 'Bash', process.env.AUTOPILOT_DESKTOP_NODE, process.env.AUTOPILOT_DESKTOP_CLI);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, [field]: managed } } };
    } catch (error) { return deny(error); }
  }
  if (!turnId || value.agent_id || !process.env.AUTOPILOT_BROWSER_CALLER_TOKEN) return;
  if (value.hook_event_name === 'Stop') { await request('/turn/suspend', { turnId }); return {}; }
  if (value.hook_event_name === 'Interrupt') { await request('/turn/end', { turnId }); return; }
}
exports.routing = routing; exports.browserError = browserError; exports.browserCommand = browserCommand; exports.parse = parse; exports.request = request; exports.start = start; exports.codexHook = codexHook;
`;

export const browserModSource = String.raw`// Claude保留next，CodeBuddy新建原生工具调用重新审批；取消来自真实工具signal。
let activeTurn;
${browserCommandSource}
const instructions = 'Autopilot Desktop browser MUST use ap browser ACTION \'JSON\' in the native foreground Bash/PowerShell tool. A REPL may dispatch that native shell tool; do not evaluate the command as JavaScript or launch a nested shell. For a selected local Markdown/HTML file use ap browser document with {"path":"absolute or workspace-relative selected file"}; this supports external selected files and requires exact-file approval. Never pass file URLs to open or screenshot. After document/open returns pageId/revision use snapshot or screenshot with that identity. For Desktop browser requests do not select Codex IAB / Computer Use or a direct driver. Explicit external-browser requests keep native behavior. This managed routing overrides conflicting browser skills. Missing bridge or native identity must be reported; no outside-browser fallback. On failure report the error; do not retry command variants.';
// 模块内没有Node权限，通过原生HTTP接口访问Desktop固定loopback服务。
async function call($, path, value) {
  const endpoint = await $.env.get('AUTOPILOT_BROWSER_ENDPOINT');
  const token = await $.env.get('AUTOPILOT_BROWSER_CALLER_TOKEN');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint || '') || !token) throw new Error('BROWSER_UNAVAILABLE');
  let response;
  try { response = await $.http.fetch(endpoint + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); }
  catch { throw new Error('BROWSER_UNAVAILABLE'); }
  let result;
  try { result = JSON.parse(response.text); } catch { throw new Error('BROWSER_RESPONSE_INVALID'); }
  if (!response.ok || !result.ok) throw new Error(browserError(result.error, 'BROWSER_REQUEST_FAILED'));
  return result.result;
}
// 每次原生turn.start包围多次turn.step，模型请求不是用户回合边界。
export function register(on) {
  // CodeBuddy系统提示与Skill正文在局部plugin内覆盖冲突路线，不改全局启用项。
  on('prompt.compose', async function prompt($, e, next) {
    const result = await next(e);
    if (await $.env.get('AUTOPILOT_AGENT_TYPE') !== 'codebuddy' && await $.env.get('AUTOPILOT_AGENT_TYPE') !== 'claude') return result;
    return { ...result, sections: [...result.sections.filter(function own(section) { return section.id !== 'autopilot-browser:routing'; }), { id: 'autopilot-browser:routing', scope: 'session', text: instructions }] };
  });
  on('skill.prompt', async function skill($, e, next) {
    return next(e);
  });
  on('turn.start', async function begin($, e, next) { if (e.agentId !== undefined) return next(e); activeTurn = e.turnId; try { await call($, '/turn/replace', { turnId: e.turnId }); } catch { /* 普通工具仍可工作，浏览器调用会fail closed。 */ } return next(e); });
  on('turn.complete', async function end($, e, next) { if (e.agentId !== undefined) return next(e); if (activeTurn === e.turnId) activeTurn = undefined; try { await call($, '/turn/end', { turnId: e.turnId }); } catch { /* 失联已由watch撤销，普通CLI生命周期继续。 */ } return next(e); });
  on('tool.call', async function tool($, e, next) {
    if (!['Bash', 'PowerShell'].includes(e.tool)) return next(e);
    let operation;
    try { operation = parse(e.command); } catch (error) { return { deny: browserError(error) }; }
    if (!operation) return next(e);
    if (next.signal.aborted) return { deny: 'BROWSER_CANCELLED' };
    if (!activeTurn || e.agentId !== undefined || next.origin.plugin !== 'engine' || next.origin.tier !== 'core') return { deny: 'BROWSER_NATIVE_TURN_REQUIRED' };
    if (!e.tool_use_id) return { deny: 'BROWSER_CALL_REQUIRED' };
    const turnId = activeTurn;
    let revocation;
    // 许可返回前的取消先撤销，返回后再撤销一次以覆盖服务端授予竞争。
    function revoke() {
      revocation ??= call($, '/permit/revoke', { turnId, callId: e.tool_use_id }).catch(function unavailable() {});
      return revocation;
    }
    function cancel() { void revoke(); }
    next.signal.addEventListener('abort', cancel, { once: true });
    try {
      if (next.signal.aborted) return { deny: 'BROWSER_CANCELLED' };
      let permit;
      try { permit = await call($, '/permit', { turnId, callId: e.tool_use_id, operation }); }
      catch (error) { return { deny: browserError(error) }; }
      if (next.signal.aborted) { revocation = undefined; return { deny: 'BROWSER_CANCELLED' }; }
      let command;
      try { command = browserCommand(operation, permit.permit, e.tool, await $.env.get('AUTOPILOT_DESKTOP_NODE'), await $.env.get('AUTOPILOT_DESKTOP_CLI')); }
      catch (error) { return { deny: browserError(error) }; }
      // REPL已审批原输入，不能经next改参；新调用跳过本hook并重新经过其他hooks及原生权限。
      if (await $.env.get('AUTOPILOT_AGENT_TYPE') === 'codebuddy') {
        if (next.signal.aborted) return { deny: 'BROWSER_CANCELLED' };
        const input = { ...e, command, run_in_background: false };
        delete input.tool_use_id;
        return await $.tool.call(input);
      }
      return await next({ ...e, command, run_in_background: false });
    } finally {
      next.signal.removeEventListener('abort', cancel);
      await revoke();
    }
  }).catch(function failClosed($, e, next) {
    if (next.called) return next(e);
    return { deny: browserError(next.error && next.error.message) };
  });
}
`;

export const browserOpenCodeSource = String.raw`// OpenCode逐工具callID绑定原生assistant.parentID，不以busy/idle猜测请求所属回合。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const bridge = require('./browser.cjs');
export const AutopilotBrowser = async function ({ client }) {
  const active = new Map();
  const calls = new Map();
  const shells = new Map();
  // session/call共同限定恢复对象；异常路径没有after，原生错误/idle事件也必须回收。
  function key(input) { return JSON.stringify([input.sessionID, input.callID]); }
  // 先恢复引用并删除缓存，网络失联时仍由watch保持撤销边界。
  async function finish(id) {
    const call = calls.get(id); if (!call) return;
    calls.delete(id); call.args.command = call.command;
    await bridge.request('/permit/revoke', { turnId: call.turnId, callId: call.callId }).catch(function disconnected() {});
  }
  // 只识别本适配固定Node前导，不清洗任意历史文本或改写用户持久数据。
  function internal(command) {
    const tick = String.fromCharCode(96);
    return typeof command === 'string' && /^(?:& )?'(?:[A-Za-z]:[/\\]|\/)[^\r\n]+?' '-e' '/.test(command) && command.includes('process.argv[3] = decodeURIComponent(process.argv[3]);') && command.includes('process.argv.splice(2, 0, ' + tick + 'browser' + tick + ');') && command.includes('import(require(' + tick + 'node:url' + tick + ').pathToFileURL(process.argv[1]).href);') && command.includes('--permit');
  }
  return {
    // 原生工具定义由实际选定Shell生成；未知定义拒绝浏览器动作，不按工具名或平台猜测。
    'tool.definition': async function definition(input, output) {
      if (!['bash', 'shell'].includes(input.toolID)) return;
      const match = /^Be aware: OS: [^,\r\n]+, Shell: ([a-z0-9]+)\s*$/m.exec(output.description);
      const name = match && match[1];
      shells.set(input.toolID, ['powershell', 'pwsh'].includes(name) ? 'PowerShell' : ['bash', 'zsh', 'sh', 'dash', 'ksh'].includes(name) ? 'Bash' : undefined);
    },
    // 既有污染记录只在模型副本隐藏已确认的内部包装，不恢复/重放旧许可。
    'experimental.chat.messages.transform': async function history(_input, output) {
      for (const message of output.messages) for (const part of message.parts) {
        if (part.type !== 'tool' || !['bash', 'shell'].includes(part.tool) || !part.state) continue;
        const state = part.state;
        if (internal(state.input && state.input.command)) state.input = { ...state.input, command: 'BROWSER_NATIVE_COMMAND_REDACTED' };
        for (const field of ['title', 'output', 'error']) if (internal(state[field])) state[field] = 'BROWSER_NATIVE_COMMAND_REDACTED';
        if (state.metadata && internal(state.metadata.output)) state.metadata = { ...state.metadata, output: 'BROWSER_NATIVE_COMMAND_REDACTED' };
      }
    },
    // ShellTool先将command字符串捕获到run参数，再取env；首次metadata/structuredClone之前恢复闭包args。
    'shell.env': async function environment(input) {
      const call = calls.get(key(input));
      if (call) call.args.command = call.command;
    },
    'experimental.chat.system.transform': async function system(_input, output) { output.system.push(bridge.routing(process.env.AUTOPILOT_BROWSER_SKILL)); },
    'tool.execute.before': async function before(input, output) {
      if (!['bash', 'shell'].includes(input.tool)) return;
      const operation = bridge.parse(output.args.command); if (!operation) return;
      const shell = shells.get(input.tool);
      if (!shell) throw new Error('BROWSER_NATIVE_SHELL_UNSUPPORTED');
      const session = await client.session.get({ path: { id: input.sessionID } });
      if (!session.data || session.data.parentID) throw new Error('BROWSER_MAIN_SESSION_REQUIRED');
      const result = await client.session.messages({ path: { id: input.sessionID } });
      const messages = result.data || [];
      const assistant = messages.find(function owns(message) { return message.info.role === 'assistant' && message.parts.some(function called(part) { return part.callID === input.callID; }); });
      let user = assistant && messages.find(function parent(message) { return message.info.id === assistant.info.parentID && message.info.role === 'user'; });
      // 压缩产生的synthetic continue沿原生时间/消息字段回溯，不把提示词前缀当身份。
      function actual(message) { return message.info.role === 'user' && message.parts.some(function authored(part) { return ['text', 'file'].includes(part.type) && part.synthetic !== true; }); }
      if (user && !actual(user) && user.parts.every(function synthetic(part) { return part.synthetic === true || part.type === 'compaction'; })) {
        const created = user.info.time && user.info.time.created;
        user = messages.filter(function previous(message) { return actual(message) && message.info.time && message.info.time.created <= created; }).sort(function recent(a, b) { return b.info.time.created - a.info.time.created; })[0];
      }
      if (!user || !actual(user)) throw new Error('BROWSER_USER_TURN_UNAVAILABLE');
      const turnId = input.sessionID + ':' + user.info.id;
      const previous = active.get(input.sessionID);
      if (previous && previous !== turnId) await bridge.request('/turn/end', { turnId: previous });
      await bridge.request('/turn/begin', { turnId }); active.set(input.sessionID, turnId);
      const id = key(input);
      const call = { turnId, callId: input.callID, args: output.args, command: output.args.command };
      calls.set(id, call);
      try {
        const resultPermit = await bridge.request('/permit', { turnId, callId: input.callID, operation });
        // 许可等待期间若错误/idle已取消，迟到许可也撤销，不再执行原生工具。
        if (calls.get(id) !== call) {
          await bridge.request('/permit/revoke', { turnId, callId: input.callID });
          throw new Error('BROWSER_CANCELLED');
        }
        output.args.command = bridge.browserCommand(operation, resultPermit.permit, shell, process.env.AUTOPILOT_DESKTOP_NODE, process.env.AUTOPILOT_DESKTOP_CLI);
      } catch (error) { await finish(id); throw new Error(bridge.browserError(error)); }
    },
    'tool.execute.after': async function after(input, output) {
      const id = key(input); const call = calls.get(id);
      if (call && output) output.title = call.command;
      await finish(id);
    },
    event: async function event({ event }) {
      if (event.type === 'message.part.updated') {
        const part = event.properties.part;
        if (part.type === 'tool' && part.state.status === 'error') await finish(key({ sessionID: part.sessionID, callID: part.callID }));
        return;
      }
      if (event.type !== 'session.status' || event.properties.status.type !== 'idle') return;
      const sessionId = event.properties.sessionID;
      const turnId = active.get(sessionId);
      active.delete(sessionId);
      for (const [id, call] of calls) if (JSON.parse(id)[0] === sessionId) await finish(id);
      if (turnId) await bridge.request('/turn/end', { turnId });
    },
  };
};
`;
