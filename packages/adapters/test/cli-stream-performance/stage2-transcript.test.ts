/**
 * CLI 流式持久化 Stage 2 回归测试：验证 Transcript 增量尾读、异步追加和损坏行恢复。
 */

import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEventEnvelope } from "@autopilot-agent/core";
import { createNodeRuntimePorts, getNodeStatePaths, initializeNodeStateRoot } from "../../src/index";

const temporaryRoots: string[] = [];

/** 构造固定大小的 Transcript 信封。 */
function createEnvelope(seq: number, delta: string): AgentEventEnvelope {
  return {
    seq,
    sessionId: "session-stage2-transcript",
    turnId: "turn-stage2-transcript",
    timestamp: new Date(seq * 1_000).toISOString(),
    event: { type: "answer_delta", turnId: "turn-stage2-transcript", stepId: "step-stage2-transcript", delta },
  };
}

/** 创建隔离的 Node stateRoot。 */
function createTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rag-stage2-transcript-"));
  temporaryRoots.push(root);
  return root;
}

/** 在独立 Node 子进程中追加一段事件，验证跨进程锁与尾读协作。 */
function appendFromChildProcess(root: string, startSeq: number): Promise<void> {
  const script = [
    'import adapters from "./src/index.ts";',
    'const { createNodeRuntimePorts } = adapters;',
    'const root = process.env.STAGE2_ROOT;',
    'const start = Number(process.env.STAGE2_START);',
    'if (!root || !Number.isInteger(start)) throw new Error("missing stage2 child input");',
    'const ports = createNodeRuntimePorts({ stateRoot: root });',
    'for (let index = 0; index < 8; index += 1) {',
    '  const seq = start + index;',
    '  await ports.transcriptStore.append("session-stage2-cross-process", { seq, sessionId: "session-stage2-cross-process", turnId: "turn-stage2-cross-process", timestamp: new Date(seq * 1000).toISOString(), event: { type: "answer_delta", turnId: "turn-stage2-cross-process", stepId: "step-stage2-cross-process", delta: String(seq) } });',
    '}',
  ].join("\n");
  return new Promise<void>(function waitForChild(resolve, reject) {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, STAGE2_ROOT: root, STAGE2_START: String(startSeq) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", function collectChildError(chunk: Buffer) { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", function childClosed(code) {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Stage 2 child append failed with code ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

afterEach(function cleanTemporaryRoots() {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("跨实例追加只异步读取新增尾部，并保持严格顺序", async function appendsOnlyTailAfterInitialIndex() {
  const root = createTemporaryRoot();
  initializeNodeStateRoot(root);
  const first = createNodeRuntimePorts({ stateRoot: root });
  const second = createNodeRuntimePorts({ stateRoot: root });
  const firstEnvelope = createEnvelope(1, "first");
  const secondEnvelope = createEnvelope(2, "second");

  await first.transcriptStore.append(firstEnvelope.sessionId, firstEnvelope);
  const readFileSync = vi.spyOn(fs, "readFileSync");
  const appendFileSync = vi.spyOn(fs, "appendFileSync");
  await second.transcriptStore.append(secondEnvelope.sessionId, secondEnvelope);

  expect(await first.transcriptStore.getEvents(firstEnvelope.sessionId)).toEqual([firstEnvelope, secondEnvelope]);
  expect(readFileSync).not.toHaveBeenCalled();
  expect(appendFileSync).not.toHaveBeenCalled();
});

it("追加到损坏的无换行尾部时保留有效事件并继续恢复", async function recoversAfterPartialCorruption() {
  const root = createTemporaryRoot();
  initializeNodeStateRoot(root);
  const ports = createNodeRuntimePorts({ stateRoot: root });
  const first = createEnvelope(1, "first");
  const second = createEnvelope(2, "second");
  await ports.transcriptStore.append(first.sessionId, first);
  const transcriptPath = path.join(getNodeStatePaths(root).transcriptsDir, `${first.sessionId}.jsonl`);
  fs.appendFileSync(transcriptPath, "partial-corrupted-record", "utf8");

  await ports.transcriptStore.append(second.sessionId, second);

  expect(await ports.transcriptStore.getEvents(first.sessionId)).toEqual([first, second]);
});

it("旧文件最后一条 JSON 没有换行时追加仍保持 JSONL 可恢复", async function separatesValidNoNewlineTail() {
  const root = createTemporaryRoot();
  initializeNodeStateRoot(root);
  const ports = createNodeRuntimePorts({ stateRoot: root });
  const first = createEnvelope(1, "first");
  const second = createEnvelope(2, "second");
  const transcriptPath = path.join(getNodeStatePaths(root).transcriptsDir, `${first.sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, JSON.stringify(first), "utf8");

  await ports.transcriptStore.append(second.sessionId, second);

  expect(await ports.transcriptStore.getEvents(first.sessionId)).toEqual([first, second]);
});

it("两个 Node 进程并发追加时保持完整 JSONL 与 16 条事件", async function appendsAcrossProcesses() {
  const root = createTemporaryRoot();
  initializeNodeStateRoot(root);

  await Promise.all([appendFromChildProcess(root, 1), appendFromChildProcess(root, 9)]);

  const ports = createNodeRuntimePorts({ stateRoot: root });
  const events = await ports.transcriptStore.getEvents("session-stage2-cross-process");
  expect(events).toHaveLength(16);
  expect(new Set(events.map((event) => event.seq))).toEqual(new Set(Array.from({ length: 16 }, function makeSeq(_, index) { return index + 1; })));
}, 30_000);
