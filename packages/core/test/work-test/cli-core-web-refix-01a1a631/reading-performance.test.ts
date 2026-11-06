/** S5真实Node读取基线与后续同夹具量测，所有状态固定本任务目录。 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { it, expect, vi } from "vitest";
import { createNodeRuntimePorts } from "../../../../adapters/src/node/create-node-runtime-ports";
import { readJsonLines, withFileLock } from "../../../../adapters/src/node/file-utils";
import { readTurnExecutionView } from "../../../src/runtime/application/turn/turn-execution-view";

/** 记录业务JSON解析量、完整读取次数与事件循环最大延迟，不记录私有正文。 */
async function measure(operation: () => Promise<unknown>, reads: Record<string, number>) {
  for (const key of Object.keys(reads)) reads[key] = 0;
  let parseBytes = 0, parsedEvents = 0, fullReads = 0, blockingMs = 0;
  const parse = JSON.parse;
  const parseSpy = vi.spyOn(JSON, "parse").mockImplementation(function parseMeasured(text, reviver) {
    const value = parse(text, reviver);
    if (value?.turnId || value?.event || value?.group) { parseBytes += Buffer.byteLength(text); if (value.event) parsedEvents++; }
    return value;
  });
  const syncRead = fs.readFileSync, asyncRead = fsp.readFile;
  const syncSpy = vi.spyOn(fs, "readFileSync").mockImplementation(function readMeasured(file, ...args) { if (String(file).endsWith(".jsonl")) fullReads++; return (syncRead as any)(file, ...args); });
  const asyncSpy = vi.spyOn(fsp, "readFile").mockImplementation(async function readMeasured(file, ...args) { if (String(file).endsWith(".jsonl")) fullReads++; return (asyncRead as any)(file, ...args); });
  let previous = performance.now();
  const timer = setInterval(function sampleDelay() { const now = performance.now(); blockingMs = Math.max(blockingMs, now - previous); previous = now; }, 1);
  const start = performance.now();
  try { await operation(); await new Promise(function settle(resolve) { setTimeout(resolve, 5); }); }
  finally { clearInterval(timer); parseSpy.mockRestore(); syncSpy.mockRestore(); asyncSpy.mockRestore(); }
  return { elapsedMs: performance.now() - start, blockingMs, parseBytes, parsedEvents, fullReads, reads: { ...reads } };
}

it("S5短长历史大checkpoint与四关联的冷热外部追加量测", async function readingBaseline() {
  const run = path.resolve("../../.agent-tests/work-test/cli-core-web-refix-01a1a631/runs/r001");
  const root = await fsp.mkdtemp(path.join(run, "s5-reading-"));
  const ports = createNodeRuntimePorts({ stateRoot: path.join(root, "state"), workspaceRoot: root });
  const reads: Record<string, number> = {};
  for (const [label, store, methods] of [["checkpoint", ports.checkpointStore, ["getLatest", "getByTurn"]], ["transcript", ports.transcriptStore, ["getEvents", "readPage"]], ["control", ports.threadStore, ["listGroups", "readControl"]]] as const) {
    for (const method of methods) {
      const original = (store as any)[method].bind(store);
      (store as any)[method] = function counted(...args: unknown[]) { const key = label + "." + method; reads[key] = (reads[key] ?? 0) + 1; return original(...args); };
    }
  }
  await ports.projectStore.save({ id: "project", name: "controlled", workspaceRoot: root, createdAt: 1, updatedAt: 1 });
  await fsp.mkdir(path.join(root, "state/transcripts"), { recursive: true });
  const results: unknown[] = [];
  for (const [name, count, checkpointCount, payloadSize] of [["short", 20, 2, 1024], ["long", 3000, 16, 1024 * 1024]] as const) {
    const ids = name === "short" ? ["short"] : ["long", "related1", "related2", "related3"];
    for (const id of ids) {
      await ports.sessionStore.save({ id, productMode: "work", projectId: "project", persistenceMode: "durable", status: "waiting_approval", createdAt: 1, updatedAt: 1 });
      await ports.turnStore.save({ id: "turn-" + id, sessionId: id, status: "waiting_approval", createdAt: 1, updatedAt: 1 } as any);
      const checkpoint = { turnId: "turn-" + id, status: "awaiting_approval", stepCount: 1, messages: [{ role: "user", content: "x".repeat(payloadSize) }], pendingCalls: [], completedCallIds: [], lease: { leaseId: "lease", ownerId: "owner", heartbeatAt: 1, safeBoundarySeq: count } };
      await ports.checkpointStore.save(id, checkpoint as any);
      await fsp.writeFile(path.join(root, "state/checkpoints", id + ".jsonl"), (JSON.stringify(checkpoint) + "\n").repeat(checkpointCount));
      const events = Array.from({ length: count }, function event(_, i) { return JSON.stringify({ sessionId: id, turnId: "turn-" + id, seq: i + 1, timestamp: new Date(1).toISOString(), event: i === 0 ? { type: "turn_started", turnId: "turn-" + id, stepCount: 0 } : { type: "answer_delta", turnId: "turn-" + id, delta: "x".repeat(1024) } }); });
      await fsp.writeFile(path.join(root, "state/transcripts", id + ".jsonl"), events.join("\n") + "\n");
    }
    await ports.threadStore.compareAndSetControl("group-" + name, null, { group: { groupId: "group-" + name, enabled: true }, revision: 0, members: ids.map(function member(threadId) { return { threadId, executionHost: "cli-work-v1" }; }), controls: [], sharedState: { controlled: "x".repeat(512 * 1024) } } as any);
    /** 同一刷新逐目标执行正式安全投影，包含S2 control观察。 */
    async function refresh() { for (const sessionId of ids) expect(await readTurnExecutionView(ports, { sessionId })).not.toBeNull(); }
    const cold = await measure(refresh, reads);
    const hot = await measure(refresh, reads);
    for (const id of ids) await fsp.appendFile(path.join(root, "state/transcripts", id + ".jsonl"), JSON.stringify({ sessionId: id, turnId: "turn-" + id, seq: count + 1, timestamp: new Date(1).toISOString(), event: { type: "answer_delta", turnId: "turn-" + id, delta: "external" } }) + "\n");
    const appended = await measure(refresh, reads);
    results.push({ name, targets: ids.length, eventsPerTarget: count, checkpointCount, payloadSize, cold, hot, appended });
  }
  await fsp.writeFile(path.join(run, process.env.S5_MEASUREMENT_NAME ?? "s5-baseline.json"), JSON.stringify(results, null, 2));
}, 60000);

it("S5变化及历史checkpoint扫描与单条大JSON的阻塞量测", async function checkpointMeasurements() {
  const run = path.resolve("../../.agent-tests/work-test/cli-core-web-refix-01a1a631/runs/r001");
  const root = await fsp.mkdtemp(path.join(run, "s5-checkpoint-"));
  const ports = createNodeRuntimePorts({ stateRoot: path.join(root, "state"), workspaceRoot: root });
  const external = createNodeRuntimePorts({ stateRoot: path.join(root, "state"), workspaceRoot: root });
  const checkpoint = { turnId: "historical", status: "interrupted_recoverable", stepCount: 1, messages: [{ role: "user", content: "x".repeat(1024 * 1024) }], completedCallIds: [] } as any;
  await ports.checkpointStore.save("session", checkpoint);
  const file = path.join(root, "state/checkpoints/session.jsonl");
  await fsp.writeFile(file, (JSON.stringify(checkpoint) + "\n").repeat(16));
  const reads: Record<string, number> = {};
  // 对照首编辑备份中的readJsonLines/最后记录/克隆算法，不代称旧公开入口的完整计时。
  const originalScan = await measure(async function originalLatestAlgorithm() { await withFileLock(file, function scan() { const values = readJsonLines<any>(file).values; const latest = values[values.length - 1]; Buffer.byteLength(JSON.stringify(latest)); return structuredClone(latest); }); }, reads);
  const cold = await measure(async function latest() { expect((await ports.checkpointStore.getLatest("session"))?.turnId).toBe("historical"); }, reads);
  await external.checkpointStore.save("session", { ...checkpoint, turnId: "current" });
  const changed = await measure(async function latest() { expect((await ports.checkpointStore.getLatest("session"))?.turnId).toBe("current"); }, reads);
  const historyCold = await measure(async function historical() { expect((await ports.checkpointStore.getByTurn("session", "historical"))?.turnId).toBe("historical"); }, reads);
  const historyHot = await measure(async function historical() { expect((await ports.checkpointStore.getByTurn("session", "historical"))?.turnId).toBe("historical"); }, reads);
  const large = JSON.stringify({ ...checkpoint, messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024) }] });
  const singleJson = await measure(async function singleRecord() { expect(JSON.parse(large).turnId).toBe("historical"); }, reads);
  await fsp.writeFile(path.join(run, "s5-checkpoint-measurements.json"), JSON.stringify({ originalScan, cold, changed, historyCold, historyHot, singleJson }, null, 2));
}, 60000);
