/**
 * CLI 流式持久化 Stage 0 基准：用固定 200 delta/s 输入比较 ephemeral 与 durable Node Port 链路。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AgentEventEnvelope } from "@autopilot-agent/core";
import { createNodeRuntimePorts, initializeNodeStateRoot } from "../../src/index";

const temporaryRoots: string[] = [];
const DELTA_COUNT = 100;
const DELTA_INTERVAL_MS = 5;

interface ScenarioResult {
  mode: "ephemeral" | "durable";
  elapsedMs: number;
  visibleDeltasPerSecond: number;
  eventSinkP95Ms: number;
  transcriptP95Ms: number;
  persistedEvents: number;
}

/** 构造不含真实模型正文的固定大小事件。 */
function createEnvelope(seq: number): AgentEventEnvelope {
  return {
    seq,
    sessionId: "session-stage0-performance",
    turnId: "turn-stage0-performance",
    timestamp: new Date(seq * 1_000).toISOString(),
    event: { type: "answer_delta", turnId: "turn-stage0-performance", stepId: "step-stage0-performance", delta: "0123456789abcdef" },
  };
}

/** 返回已排序样本的 p95。 */
function percentile95(samples: number[]): number {
  const sorted = [...samples].sort(function sortAscending(left, right) { return left - right; });
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

/** 等待 fake sampler 的下一个固定 5ms 发射时刻。 */
async function waitUntil(target: number): Promise<void> {
  const remaining = target - performance.now();
  if (remaining > 0) await new Promise<void>(function wait(resolve) { setTimeout(resolve, remaining); });
}

/** 运行一个 Node Port 场景，并只返回计时与事件数量。 */
async function runScenario(mode: ScenarioResult["mode"]): Promise<ScenarioResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rag-stage0-${mode}-`));
  temporaryRoots.push(root);
  initializeNodeStateRoot(root);
  const ports = createNodeRuntimePorts({ stateRoot: root });
  const eventSinkDurations: number[] = [];
  const transcriptDurations: number[] = [];
  const startedAt = performance.now();
  for (let index = 0; index < DELTA_COUNT; index += 1) {
    await waitUntil(startedAt + index * DELTA_INTERVAL_MS);
    const envelope = createEnvelope(index + 1);
    const eventSinkStartedAt = performance.now();
    await ports.eventSink.write(envelope);
    eventSinkDurations.push(performance.now() - eventSinkStartedAt);
    if (mode === "durable") {
      const transcriptStartedAt = performance.now();
      await ports.transcriptStore.append(envelope.sessionId, envelope);
      transcriptDurations.push(performance.now() - transcriptStartedAt);
    }
  }
  const elapsedMs = performance.now() - startedAt;
  const persistedEvents = (await ports.transcriptStore.getEvents("session-stage0-performance")).length;
  return {
    mode,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    visibleDeltasPerSecond: Number((DELTA_COUNT / (elapsedMs / 1_000)).toFixed(3)),
    eventSinkP95Ms: Number(percentile95(eventSinkDurations).toFixed(3)),
    transcriptP95Ms: Number(percentile95(transcriptDurations).toFixed(3)),
    persistedEvents,
  };
}

afterEach(function cleanTemporaryRoots() {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("固定 200 delta/s 下记录 ephemeral 与 durable 分段基线", async function recordsStage0Baseline() {
  const ephemeral = await runScenario("ephemeral");
  const durable = await runScenario("durable");
  const expectLegacyEventSinkPersistence = process.env.STAGE0_EXPECT_EVENT_SINK_PERSISTS === "1";
  process.stdout.write(`STAGE0_PERFORMANCE ${JSON.stringify({ deltaCount: DELTA_COUNT, intervalMs: DELTA_INTERVAL_MS, ephemeral, durable })}\n`);

  expect(ephemeral.persistedEvents).toBe(expectLegacyEventSinkPersistence ? DELTA_COUNT : 0);
  expect(durable.persistedEvents).toBe(DELTA_COUNT);
  expect(ephemeral.visibleDeltasPerSecond).toBeGreaterThan(0);
  expect(durable.visibleDeltasPerSecond).toBeGreaterThan(0);
}, 15_000);
