/** 末端兼容回归，真实旧schema8无档位记录经人类绑定后可从正常Runtime开始新Turn。 */
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { createAgentRuntime } from '../../../src/runtime/public/create-agent-runtime';
import { createNodeRuntimePorts } from '../../../../adapters/src/node/create-node-runtime-ports';

/** 生成真实completed旧会话，创建与执行都没有档位、owner投递或Web专属工具证据。 */
async function fixture(associated = false) {
  const root = await mkdtemp(path.resolve('../../.agent-tests/work-test/cli-core-web-refix-01a1a631/runs/r001/terminal-host-'));
  const workspaceRoot = path.join(root, 'workspace'); await mkdir(workspaceRoot);
  const ports = createNodeRuntimePorts({ stateRoot: path.join(root, 'state'), workspaceRoot });
  await ports.projectStore.save({ id: "project", name: "controlled", workspaceRoot, createdAt: 1, updatedAt: 1 });
  const seed = createAgentRuntime({ ports });
  const parent = await seed.sessions.create({ projectId: 'project', title: '旧根' });
  const target = associated ? await seed.sessions.create({ projectId: parent.projectId, title: '旧关联' }) : parent;
  const context = { workspaceId: 'workspace', stateRootId: 'state', projectId: parent.projectId!, humanPrincipalId: 'user', allowedTools: [], modelCatalog: [] };
  const sampler = { async sample() { return { content: 'controlled', toolCalls: [], reasoningSummary: 'controlled' }; } };
  /** 各宿主通过现有受信Runtime和人类Facade进入。 */
  function runtime(host?: 'cli' | 'web') { return createAgentRuntime({ ports, defaultRunConfig: { workspaceRoot, threads: { ...context, ...(host ? { executionHost: `${host}-work-v1` } : {}) }, modelSampler: sampler } }); }
  const old = runtime();
  const human = old.threads.bind({ ...context, actor: { kind: 'human', principalId: 'user' } });
  const group = await human.enable({ protocolVersion: 1, rootThreadId: parent.id, requestId: 'enable' });
  if (associated) await human.associate({ protocolVersion: 1, groupId: group.group.groupId, threadId: target.id, requestId: 'associate' });
  for await (const _event of old.turns.start({ sessionId: target.id, content: 'old completed turn' })) { /* 正常旧Runtime产生权威终态。 */ }
  const control = (await ports.threadStore.readControl(group.group.groupId))!;
  const turn = (await ports.turnStore.getLatest(target.id))!;
  const checkpoint = (await ports.checkpointStore.getLatest(target.id))!;
  expect(control.members.find(function member(item) { return item.threadId === target.id; })?.executionHost).toBeUndefined();
  expect(turn.status).toBe('completed'); expect(checkpoint.status).toBe('completed');
  expect(checkpoint.samplingTools?.some(function webOnly(tool) { return tool.function.name === 'ask_user_question'; })).toBeFalsy();
  return { ports, target, context, groupId: group.group.groupId, revision: control.revision, runtime, turn, checkpoint };
}

it.each([['cli', false], ['web', false], ['cli', true], ['web', true]] as const)('terminal兼容 %s 旧completed根/关联=%s 人类绑定后正常start新Turn', async function startsNewTurn(host, associated) {
  const f = await fixture(associated);
  const current = f.runtime(host);
  await expect(current.turns.start({ sessionId: f.target.id, content: 'new task' })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'THREAD_RECOVERY_REQUIRED' });
  const human = current.threads.bind({ ...f.context, executionHost: `${host}-work-v1`, actor: { kind: 'human', principalId: 'user' } });
  await human.bindExecutionHost({ protocolVersion: 1, groupId: f.groupId, threadId: f.target.id, expectedRevision: f.revision, executionHost: `${host}-work-v1` });
  expect(await f.ports.turnStore.get(f.turn.id)).toEqual(f.turn);
  expect(await f.ports.checkpointStore.getByTurn(f.target.id, f.turn.id)).toEqual(f.checkpoint);
  const events = [];
  for await (const event of current.turns.start({ sessionId: f.target.id, content: 'new task' })) events.push(event);
  expect(events.some(function completed(event) { return event.type === 'turn_completed'; })).toBe(true);
  expect((await f.ports.turnStore.getLatest(f.target.id))?.id).not.toBe(f.turn.id);
  expect(await f.ports.turnStore.get(f.turn.id)).toEqual(f.turn);
  expect(await f.ports.checkpointStore.getByTurn(f.target.id, f.turn.id)).toEqual(f.checkpoint);
});

it.each(['awaiting_approval', 'awaiting_user_input', 'interrupted_recoverable'] as const)('terminal兼容 %s原Turn仍拒绝绑定', async function rejectsUnfinished(status) {
  const f = await fixture();
  const human = f.runtime('cli').threads.bind({ ...f.context, actor: { kind: 'human', principalId: 'user' } });
  await f.ports.checkpointStore.save(f.target.id, { ...f.checkpoint, status });
  await expect(human.bindExecutionHost({ protocolVersion: 1, groupId: f.groupId, threadId: f.target.id, expectedRevision: f.revision, executionHost: 'cli-work-v1' })).rejects.toMatchObject({ code: 'THREAD_RECOVERY_REQUIRED' });
  expect((await f.ports.threadStore.readControl(f.groupId))?.revision).toBe(f.revision);
});

it('terminal兼容 新执行事件结果未确认不能借旧completed绑定', async function rejectsUnknownOutcome() {
  const f = await fixture();
  await f.ports.transcriptStore.append(f.target.id, { sessionId: f.target.id, turnId: f.turn.id, seq: (f.checkpoint.lease?.safeBoundarySeq ?? 10) + 1, timestamp: new Date().toISOString(), event: { type: 'turn_started', turnId: f.turn.id, stepCount: 0 } });
  const human = f.runtime('cli').threads.bind({ ...f.context, actor: { kind: 'human', principalId: 'user' } });
  await expect(human.bindExecutionHost({ protocolVersion: 1, groupId: f.groupId, threadId: f.target.id, expectedRevision: f.revision, executionHost: 'cli-work-v1' })).rejects.toMatchObject({ code: 'THREAD_RECOVERY_REQUIRED' });
  expect(await f.ports.leaseStore.readCurrent!(f.target.id)).toBeNull();
});

it('terminal兼容 活跃owner或已领取控制不能绑定', async function protectsOwnerAndClaim() {
  const f = await fixture(); const human = f.runtime('cli').threads.bind({ ...f.context, actor: { kind: 'human', principalId: 'user' } });
  const input = { protocolVersion: 1, groupId: f.groupId, threadId: f.target.id, expectedRevision: f.revision, executionHost: 'cli-work-v1' as const };
  const lease = { leaseId: 'active', ownerId: 'active-owner', heartbeatAt: Date.now(), safeBoundarySeq: 0 };
  await f.ports.leaseStore.acquire({ sessionId: f.target.id, turnId: f.turn.id, lease, now: Date.now(), staleAfterMs: 45000 });
  await expect(human.bindExecutionHost(input)).rejects.toMatchObject({ code: 'THREAD_RECOVERY_REQUIRED' });
  expect((await f.ports.leaseStore.readCurrent!(f.target.id))?.lease.ownerId).toBe('active-owner');
  await f.ports.leaseStore.release({ sessionId: f.target.id, lease });
  const control = (await f.ports.threadStore.readControl(f.groupId))!;
  await f.ports.threadStore.compareAndSetControl(f.groupId, control.revision, { ...control, revision: control.revision + 1, controls: [{ controlId: 'claimed', kind: 'continue_interaction', threadId: f.target.id, expectedTurnId: f.turn.id, requestId: 'old', checkpointDigest: '0'.repeat(64), status: 'claimed', ownerId: 'runner', createdAt: Date.now(), updatedAt: Date.now() }] });
  await expect(human.bindExecutionHost({ ...input, expectedRevision: control.revision + 1 })).rejects.toMatchObject({ code: 'THREAD_RECOVERY_REQUIRED' });
});

it('terminal兼容 两个人类并发/迟到绑定只成功一个，明确档位及模型边界保持', async function bindingCas() {
  const f = await fixture();
  const human = f.runtime('cli').threads.bind({ ...f.context, actor: { kind: 'human', principalId: 'user' } });
  const input = { protocolVersion: 1, groupId: f.groupId, threadId: f.target.id, expectedRevision: f.revision };
  const outcomes = await Promise.allSettled([human.bindExecutionHost({ ...input, executionHost: 'cli-work-v1' }), human.bindExecutionHost({ ...input, executionHost: 'web-work-v1' })]);
  expect(outcomes.filter(function success(item) { return item.status === 'fulfilled'; })).toHaveLength(1);
  const current = (await f.ports.threadStore.readControl(f.groupId))!;
  const chosen = current.members.find(function member(item) { return item.threadId === f.target.id; })!.executionHost;
  await expect(human.bindExecutionHost({ ...input, expectedRevision: current.revision, executionHost: chosen === 'cli-work-v1' ? 'web-work-v1' : 'cli-work-v1' })).rejects.toMatchObject({ code: 'THREAD_STATE_CONFLICT' });
  const model = f.runtime('cli').threads.bind({ ...f.context, actor: { kind: 'thread', threadId: f.target.id, turnId: f.turn.id } });
  await expect(model.bindExecutionHost({ ...input, expectedRevision: current.revision, executionHost: 'cli-work-v1' })).rejects.toMatchObject({ code: 'THREAD_SCOPE_DENIED' });
});

it('terminal兼容 旧Runtime准备新Turn期间的人类绑定在领租约后生效且不创建伪Turn', async function rechecksAfterLease() {
  const f = await fixture();
  let reached!: () => void, release!: () => void;
  const atAcquire = new Promise<void>(function wait(resolve) { reached = resolve; });
  const gate = new Promise<void>(function hold(resolve) { release = resolve; });
  const original = f.ports.leaseStore.acquire.bind(f.ports.leaseStore);
  const acquire = vi.spyOn(f.ports.leaseStore, 'acquire').mockImplementationOnce(async function delayed(input) { reached(); await gate; return original(input); });
  const preparing = f.runtime().turns.start({ sessionId: f.target.id, content: 'late legacy new task' })[Symbol.asyncIterator]().next();
  await atAcquire;
  try {
    const human = f.runtime('cli').threads.bind({ ...f.context, actor: { kind: 'human', principalId: 'user' } });
    await human.bindExecutionHost({ protocolVersion: 1, groupId: f.groupId, threadId: f.target.id, expectedRevision: f.revision, executionHost: 'cli-work-v1' });
    release();
    await expect(preparing).rejects.toMatchObject({ code: 'THREAD_RECOVERY_REQUIRED' });
    expect(await f.ports.turnStore.getLatest(f.target.id)).toEqual(f.turn);
    expect(await f.ports.checkpointStore.getLatest(f.target.id)).toEqual(f.checkpoint);
    expect(await f.ports.leaseStore.readCurrent!(f.target.id)).toBeNull();
  } finally { release(); acquire.mockRestore(); }
});
