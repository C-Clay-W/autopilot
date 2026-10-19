/** Web CR 缺陷反例：验证实际 Runtime、审批、Node Adapter 和公开边界，不调用真实服务。 */
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createAgentRuntime } from '../packages/core/src/runtime/public/create-agent-runtime';
import { createMemoryPorts } from '../packages/core/src/runtime/adapters/memory';
import { MemoryWorkspaceAdapter } from '../packages/core/src/runtime/adapters/memory/memory-workspace-adapter';
import { createRuntimeBootstrapService } from '../packages/core/src/runtime/bootstrap/runtime-bootstrap-service';
import { resolveAutopilotSettings } from '../packages/core/src/runtime/config/autopilot-settings';
import { validateAgentMessages } from '../packages/core/src/internal/types/agent-message';
import type { AgentEvent, RunConfig, WebFetchCapability } from '../packages/core/src/runtime/protocol';
import { createNodeCapabilityLoader } from '../packages/adapters/src/node/create-node-capability-loader';
import { createSafeWebFetchCapability, requestPinnedWebUrl } from '../packages/adapters/src/node/capabilities/web/safe-web-fetch';
import type { WebFetchHttpResponse } from '../packages/adapters/src/node/capabilities/web/safe-web-fetch';

const query = 'CR_PRIVATE_QUERY';
const url = 'https://source.example/page?token=CR_URL_TOKEN#CR_FRAGMENT';
const prompt = 'CR_PRIVATE_PROMPT';
const body = 'CR_PRIVATE_PAGE_BODY';

/** 收集公开 Runtime 事件。 */
async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

/** 构造只包含合成标记的网页结果。 */
function fetchResult(target: string) {
  return { url: target, finalUrl: target, content: body, contentType: 'text/plain', truncated: false };
}

/** 构造内存响应；无端口监听、真实 DNS 或外部网络。 */
function response(statusCode: number, location?: string): WebFetchHttpResponse {
  const stream = Readable.from([body]);
  return { statusCode, headers: location ? { location } : { 'content-type': 'text/plain' }, body: stream,
    /** 模拟生产响应释放。 */
    abort() { stream.destroy(); },
  };
}

/** 创建同批 Fetch/Search 并记录实际执行参数的 durable Runtime。 */
async function fixture(fetch?: WebFetchCapability, permissionMode: RunConfig['permissionMode'] = 'ask') {
  const ports = createMemoryPorts();
  const sent: string[] = [];
  const observations: string[] = [];
  let sampleCount = 0;
  const config: RunConfig = {
    permissionMode,
    modelSampler: {
      /** 发出确定调用批次，后续采样检查 canonical 配对并读取模型观察。 */
      async sample(messages) {
        observations.push(JSON.stringify(messages));
        validateAgentMessages(messages);
        if (sampleCount++ === 0) return { content: '', reasoningSummary: '', toolCalls: [
          { id: 'fetch-first', name: 'web_fetch', input: { url, prompt } },
          { id: 'search-second', name: 'web_search', input: { query } },
        ] };
        return { content: 'PUBLIC_DONE', reasoningSummary: '', toolCalls: [] };
      },
    },
    web: { fetch: fetch ?? {
      /** 记录 Fetch 的真实参数，返回合成正文。 */
      async fetch(input) { sent.push(input.url, input.prompt ?? ''); return fetchResult(input.url); },
    }, search: {
      /** 记录 Search 的真实参数，返回有界空结果。 */
      async search(input) { sent.push(input.query); return { answer: 'CR_PRIVATE_SEARCH_ANSWER', sources: [], truncated: false }; },
    } },
  };
  const runtime = createAgentRuntime({ ports, defaultRunConfig: config });
  const session = await runtime.sessions.create({ persistenceMode: 'durable' });
  return { runtime, ports, config, sessionId: session.id, sent, observations };
}

/** 提交实际审批服务，并恢复相同 Turn。 */
async function approve(f: Awaited<ReturnType<typeof fixture>>, events: AgentEvent[], decision: 'allow_once' | 'deny' = 'allow_once') {
  const event = events.find(function isApproval(event) { return event.type === 'approval_required'; });
  if (event?.type !== 'approval_required') throw new Error('缺少实际审批事件');
  await f.runtime.approvals.submit({ sessionId: f.sessionId, turnId: event.turnId, approvalId: event.result.approval.approvalId, decision });
  return collect(f.runtime.turns.continue({ sessionId: f.sessionId, turnId: event.turnId, approval: { approvalId: event.result.approval.approvalId, decision: decision === 'deny' ? 'deny' : 'allow' } }));
}

/** 检查所有公开和 durable 出口没有工具原始参数与正文。 */
async function assertNoLeaks(f: Awaited<ReturnType<typeof fixture>>, events: AgentEvent[]) {
  for (const data of [events, await f.ports.transcriptStore.getEvents(f.sessionId), await f.ports.checkpointStore.getLatest(f.sessionId)]) {
    for (const secret of [query, prompt, 'CR_URL_TOKEN', 'CR_FRAGMENT', body, 'CR_PRIVATE_SEARCH_ANSWER', 'CR_REDIRECT_TOKEN']) {
      expect(JSON.stringify(data)).not.toContain(secret);
    }
  }
}

describe('Web CR production boundaries', function webCrSuite() {
  /** 完整正文只进入当前采样链，所有事件和 durable Store 都只保留安全事实。 */
  it('Fetch 成功时无公开或持久化泄露', async function safeFetchPersistence() {
    const f = await fixture(undefined, 'full_access');
    const events = await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: '读取公开页面' }));
    expect(f.observations.at(-1)).toContain(body);
    expect(f.sent).toEqual([url, prompt, query]);
    await assertNoLeaks(f, events);
  });

  /** 旧事件读取时也应用当前安全投影，且不改写历史存储。 */
  it('旧 Fetch transcript 的读取出口脱敏', async function redactLegacyRead() {
    const f = await fixture();
    const event: AgentEvent = { type: 'tool_result', turnId: 'legacy', stepId: 'legacy:1', callId: 'legacy-fetch', toolName: 'web_fetch', retryCount: 0, summary: '已读取网页',
      result: { status: 'success', callId: 'legacy-fetch', toolName: 'web_fetch', output: fetchResult(url), meta: { durationMs: 1, inputHash: 'safe' } } };
    await f.ports.transcriptStore.append(f.sessionId, { seq: 1, sessionId: f.sessionId, turnId: 'legacy', timestamp: new Date().toISOString(), event });
    const view = await f.runtime.turns.getState({ sessionId: f.sessionId });
    expect(JSON.stringify(view.events)).not.toContain(body);
    expect(JSON.stringify(view.events)).not.toContain('CR_URL_TOKEN');
    expect(JSON.stringify(await f.ports.transcriptStore.getEvents(f.sessionId))).toContain(body);
  });

  /** 原批次等待 Fetch 审批后，Search 应使用原 query，不得发出占位字符串。 */
  it('同进程审批恢复原始 Fetch/Search 参数', async function resumeOriginalInputs() {
    const f = await fixture();
    const paused = await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: '检索公开信息' }));
    expect(f.sent).toEqual([]);
    await assertNoLeaks(f, paused);
    const completed = await approve(f, paused);
    expect(f.sent).toEqual([url, prompt, query]);
    expect(completed.at(-1)?.type).toBe('turn_completed');
    await assertNoLeaks(f, completed);
  });

  /** 禁用配置后继续旧审批，也不能执行旧批次里等待中的 Search。 */
  it('继续审批时刷新能力并安全关闭已禁用 Search', async function disablePendingSearch() {
    const f = await fixture();
    f.config.webLoader = async function loadCurrentWeb() { return f.config.web; };
    const paused = await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: '检索公开信息' }));
    f.config.web = { fetch: f.config.web!.fetch };
    const completed = await approve(f, paused);
    expect(f.sent).toEqual([url, prompt]);
    expect(JSON.stringify(completed)).toContain('TOOL_NOT_FOUND');
    expect(completed.at(-1)?.type).toBe('turn_completed');
    await assertNoLeaks(f, completed);
  });

  /** 丢失进程内参数后关闭整批调用，让模型重新规划，不重发网络或执行后续副作用。 */
  it('进程重建后安全闭合丢失参数的批次', async function restartDropsPendingNetwork() {
    const f = await fixture();
    const paused = await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: '检索公开信息' }));
    f.runtime = createAgentRuntime({ ports: f.ports, defaultRunConfig: f.config });
    const completed = await approve(f, paused);
    expect(f.sent).toEqual([]);
    expect(f.observations.at(-1)).toContain('WEB_INPUT_UNAVAILABLE');
    expect(completed.at(-1)?.type).toBe('turn_completed');
    await assertNoLeaks(f, completed);
  });

  /** 跨域必须先审批目标，批准后只请求目标，且不把 Location 参数落盘。 */
  it.each(['allow_once', 'deny'] as const)('跨域审批 %s 保留目标且不重复首域', async function redirectApproval(decision) {
    const requests: string[] = [];
    const dns: string[] = [];
    const target = 'https://target.example/new?token=CR_REDIRECT_TOKEN';
    const fetch = createSafeWebFetchCapability({
      /** 记录逐域 DNS 校验，确保审批前不会解析目标域。 */
      async resolveDns(host) { dns.push(host); return [{ address: '93.184.216.34', family: 4 }]; },
      /** 首域只返回跳转，第二域返回正文。 */
      async request(input) { requests.push(input.url.toString()); return input.url.hostname === 'source.example' ? response(302, target) : response(200); },
    });
    const f = await fixture(fetch);
    const sourceApproval = await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: '读取页面' }));
    const targetApproval = await approve(f, sourceApproval);
    expect(requests).toEqual([url]);
    expect(dns).toEqual(['source.example']);
    const approval = targetApproval.find(function select(event) { return event.type === 'approval_required'; });
    expect(approval?.type === 'approval_required' && approval.result.approval.constraint).toBe('web-fetch-host:target.example');
    await assertNoLeaks(f, targetApproval);
    const completed = await approve(f, targetApproval, decision);
    expect(requests).toEqual(decision === 'deny' ? [url] : [url, target]);
    expect(f.sent).toEqual(decision === 'deny' ? [] : [query]);
    expect(completed.at(-1)?.type).toBe('turn_completed');
    await assertNoLeaks(f, completed);
  });

  /** 自动授权跨域也不能在每次重入时重置五跳总预算。 */
  it('跨域自动授权仍受五跳总上限约束', async function boundCrossHostChain() {
    let requests = 0;
    const fetch = createSafeWebFetchCapability({
      /** 使用固定公共地址，不访问真实 DNS。 */
      async resolveDns() { return [{ address: '93.184.216.34', family: 4 }]; },
      /** 每次跳到新域名，触发连续的受控续接。 */
      async request() { requests++; return response(302, `https://hop${requests}.example/page`); },
    });
    const f = await fixture(fetch, 'full_access');
    const events = await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: '读取页面' }));
    expect(requests).toBe(6);
    expect(JSON.stringify(events)).toContain('WEB_URL_BLOCKED');
  });

  /** 每次审批恢复都沿用剩余预算，不能借暂停重新获得五跳额度。 */
  it('多次跨域审批共享五跳预算', async function boundApprovedChain() {
    let requests = 0;
    const fetch = createSafeWebFetchCapability({
      /** 返回合成公网地址。 */
      async resolveDns() { return [{ address: '93.184.216.34', family: 4 }]; },
      /** 连续返回新域名。 */
      async request() { requests++; return response(302, `https://approved${requests}.example/page`); },
    });
    const f = await fixture(fetch);
    let events = await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: '读取页面' }));
    for (let count = 0; count < 6; count++) events = await approve(f, events);
    expect(requests).toBe(6);
    expect(JSON.stringify(events)).toContain('WEB_URL_BLOCKED');
    expect(events.at(-1)?.type).toBe('turn_completed');
  });

  /** 跳转响应同时收到取消后，不能解析或请求目标域名。 */
  it('取消不继续跨域请求', async function cancelRedirect() {
    const controller = new AbortController();
    const requests: string[] = [];
    const fetch = createSafeWebFetchCapability({
      /** 返回合成公网地址。 */
      async resolveDns() { return [{ address: '93.184.216.34', family: 4 }]; },
      /** 在首域响应到达时取消。 */
      async request(input) { requests.push(input.url.hostname); controller.abort(); return response(302, 'https://cancelled-target.example'); },
    });
    const f = await fixture(fetch, 'full_access');
    const events = await collect(f.runtime.turns.start({ sessionId: f.sessionId, content: '读取页面', signal: controller.signal }));
    expect(requests).toEqual(['source.example']);
    expect(JSON.stringify(events)).toContain('EXECUTION_CANCELLED');
  });

  /** 实际 Node HTTP 连接路径应走到连接层，不能再在 lookup 形状上报错。 */
  it.each([{ address: '127.0.0.1', family: 4 as const }, { address: '::1', family: 6 as const }])('生产 HTTP 钉住 $address 的地址族', async function pinnedFamily(address) {
    const error = await requestPinnedWebUrl({ url: new URL('http://local-cr.invalid:1'), address, signal: AbortSignal.timeout(1000) }).catch(function capture(error: NodeJS.ErrnoException) { return error; });
    expect(['ECONNREFUSED', 'EPERM', 'EACCES']).toContain((error as NodeJS.ErrnoException).code);
    expect((error as NodeJS.ErrnoException).message).not.toContain('Invalid IP address');
  });

  /** 真实 Bootstrap 与 Node loader 每次 Turn 都读当前配置；移除 Search 不会残留工具。 */
  it('关闭配置后新 Turn 隐藏 Search，撤销 Trust 后停止加载', async function refreshWebConfiguration() {
    const ports = createMemoryPorts();
    let enabled = true;
    let trusted = true;
    let loads = 0;
    const visible: boolean[] = [];
    const loader = createNodeCapabilityLoader({ env: { DEEPSEEK_SEARCH: 'synthetic-secret' }, settingsLoader: {
      /** 只使用内存用户设置；不会读取磁盘或真实凭据。 */
      load() { loads++; return { settings: resolveAutopilotSettings([{ scope: 'user', value: enabled ? { webSearch: { credentialRef: { provider: 'deepseek', key: 'SEARCH' } } } : {} }]), paths: { user: '/synthetic/settings.json', project: '/synthetic/project.json', local: '/synthetic/local.json' } }; },
    } });
    const runtime = await createRuntimeBootstrapService({
      config: { host: 'cli', workspaceRoot: '/synthetic', debug: false, logLevel: 'silent', context: {} },
      workspaceAdapter: new MemoryWorkspaceAdapter('/synthetic'),
      trustPolicy: {
        /** 信任测试不执行持久写入。 */
        async isTrusted() { return trusted; },
        /** 返回合成授权。 */
        async grantTrust() { return { workspaceRoot: '/synthetic', status: 'trusted', source: 'user' }; },
        /** 返回合成拒绝。 */
        async denyTrust() { return { workspaceRoot: '/synthetic', status: 'denied', source: 'user' }; },
        /** 返回合成撤销。 */
        async revokeTrust() { return { workspaceRoot: '/synthetic', status: 'denied', source: 'user' }; },
        /** 返回当前测试的信任开关。 */
        async getTrustStatus() { return { workspaceRoot: '/synthetic', status: trusted ? 'trusted' : 'denied', source: 'user' }; },
      },
      capabilityLoader: { loadWeb: loader.loadWeb },
      /** 创建内存 Runtime ports。 */
      createPorts() { return ports; },
      defaultRunConfig: { modelSampler: {
        /** 检查实际发送给 sampler 的工具目录。 */
        async sample(_messages, tools) { visible.push(tools.some(function isSearch(tool) { return tool.function.name === 'web_search'; }) === true); return { content: 'done', reasoningSummary: '', toolCalls: [] }; },
      } },
    }).bootstrap();
    const session = await runtime.sessions.create({ persistenceMode: 'durable' });
    await collect(runtime.turns.start({ sessionId: session.id, content: '第一轮' }));
    enabled = false;
    await collect(runtime.turns.start({ sessionId: session.id, content: '第二轮' }));
    expect(visible).toEqual([true, false]);
    expect(loads).toBe(3);
    trusted = false;
    await expect(collect(runtime.turns.start({ sessionId: session.id, content: '第三轮' }))).rejects.toThrow('工作区信任已失效');
    expect(loads).toBe(3);
  });
});
