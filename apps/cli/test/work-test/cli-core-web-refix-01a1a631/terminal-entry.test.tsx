/** 旧completed会话从真实CLI提示、只读发现、bind-host到兼容Runtime新Turn的正常入口。 */
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { expect, it } from 'vitest';
import { createAgentRuntime, createMemoryPorts } from '@autopilot-agent/core';
import { createCliController } from '../../../src/controller.js';
import { createPlainRenderer } from '../../../src/renderer.js';
import { parseArgv, renderHelp } from '../../../src/parser.js';
import { executeThreadCommand } from '../../../src/thread-commands.js';
import { createCliSessionManager } from '../../../src/tui/session-manager.js';
import { CliSessionWorkspace } from '../../../src/tui/session-workspace.js';

/** 给正式Ink输入和异步Core提交一个有界执行机会。 */
async function frame() { await new Promise(function tick(resolve) { setTimeout(resolve, 40); }); }

it.each(['cli', 'web'] as const)('terminalCLI提示和argv发现/bind-host选择%s后正常新Turn完成', async function humanRecovery(host) {
  const ports = createMemoryPorts();
  const seed = createAgentRuntime({ ports }); const session = await seed.sessions.create({ title: '旧会话' });
  const context = { workspaceId: 'workspace', stateRootId: 'state', projectId: session.projectId!, allowedTools: [], modelCatalog: [], humanPrincipalId: 'user' };
  const sampler = { async sample() { return { content: 'done', toolCalls: [], reasoningSummary: 'controlled' }; } };
  const old = createAgentRuntime({ ports, defaultRunConfig: { threads: context, modelSampler: sampler } });
  const human = old.threads.bind({ ...context, actor: { kind: 'human', principalId: 'user' } });
  await human.enable({ protocolVersion: 1, rootThreadId: session.id, requestId: 'enable' });
  for await (const _event of old.turns.start({ sessionId: session.id, content: 'old task' })) { /* 正常旧记录终态。 */ }
  const oldTurn = (await ports.turnStore.getLatest(session.id))!;
  const cli = createAgentRuntime({ ports, defaultRunConfig: { threads: { ...context, executionHost: 'cli-work-v1' }, modelSampler: sampler } });
  /** 每个目标固定同一个真实Controller。 */
  function controller(id: string) { return createCliController({ runtime: cli, sessionId: id, renderer: createPlainRenderer('text') }); }
  const main = controller(session.id);
  const manager = createCliSessionManager({ runtime: cli, projectId: session.projectId!, initialSession: session, initialController: main, createController: controller, readEventPage: async function page() { return { items: await ports.transcriptStore.getEvents(session.id), cursor: 'end' }; } });
  await manager.select(session.id); manager.selected().viewState.initialStarted = true;
  const view = render(createElement(CliSessionWorkspace, { manager, renderMode: 'inline', useColor: false, screenReader: false, closeWhenIdle: false, onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: function cancel() {}, onEof: function eof() {}, onAppExit: function exit() {} }));
  try {
    await frame(); view.stdin.write('new task'); view.stdin.write('\r');
    for (let n = 0; n < 30 && !JSON.stringify(manager.selected().store.getSnapshot()).includes('thread bind-host'); n++) await frame();
    expect(JSON.stringify(manager.selected().store.getSnapshot())).toContain('thread group of');
    expect(JSON.stringify(manager.selected().store.getSnapshot())).toContain('thread bind-host');
    expect(renderHelp()).toContain('groupId/revision');
    /** 正常argv经原薄命令映射调用人类Facade。 */
    async function command(args: string[]) {
      const parsed = parseArgv(args);
      if (parsed.kind !== 'command' || parsed.invocation.command.type !== 'thread') throw new Error('Expected thread command');
      return (await executeThreadCommand(parsed.invocation.command.command, { threads: human, readFile: async function unused() { throw new Error('unused'); }, readStdin: async function unused() { throw new Error('unused'); }, write: function write() {}, signal: new AbortController().signal })).result as any;
    }
    const discovered = await command(['thread', 'group', 'of', '--thread', session.id]);
    const listed = await command(['thread', 'list', '--group', discovered.group.groupId]);
    expect(listed.items.some(function target(item: any) { return item.threadId === session.id; })).toBe(true);
    await command(['thread', 'bind-host', '--group', discovered.group.groupId, '--thread', session.id, '--expected-revision', String(listed.revision), '--execution-host', `${host}-work-v1`]);
    if (host === 'cli') expect((await main.dispatch({ type: 'submit_prompt', content: 'new CLI task' })).projection.status).toBe('completed');
    else {
      const web = createAgentRuntime({ ports, enableUserQuestions: true, defaultRunConfig: { threads: { ...context, executionHost: 'web-work-v1' }, modelSampler: sampler } });
      for await (const _event of web.turns.start({ sessionId: session.id, content: 'new Web task' })) { /* 兼容Web Runtime正常入口。 */ }
    }
    expect((await ports.turnStore.getLatest(session.id))?.id).not.toBe(oldTurn.id);
    expect((await ports.turnStore.getLatest(session.id))?.status).toBe('completed');
    expect(await ports.turnStore.get(oldTurn.id)).toEqual(oldTurn);
  } finally { view.unmount(); await manager.stop(); }
});
