#!/usr/bin/env node
/**
 * Step 4 跨进程 lease 与 durable Store 门禁脚本。
 *
 * 父进程只负责编排真实独立 Node 子进程；子进程共享 stateRoot、隔离 workspaceRoot，
 * 使用确定性 sampler 验证 Session ownership、stale recovery、FrozenRunConfig 与 Inbox exactly-once。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAgentRuntime } from "@autopilot-agent/core";
import { createNodeRuntimePorts, initializeNodeStateRoot } from "@autopilot-agent/adapters";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../..");

/** 创建可推进的测试时钟，避免恢复门禁必须真实等待 45 秒。 */
function createTestClock(now) {
  return {
    now: function nowValue() { return now; },
    timestamp: function timestampValue() { return new Date(now).toISOString(); },
  };
}

/** 创建不访问外部 Provider 的确定性 sampler。 */
function createSampler(label) {
  return {
    sample: async function sample(_messages, _tools, _options, onDelta) {
      onDelta?.(label);
      return { content: label, toolCalls: [], reasoningSummary: "cross-process smoke", finishReason: "stop" };
    },
  };
}

/** 创建使用显式 stateRoot 与可控时钟的 Node Runtime。 */
function createTestRuntime(stateRoot, workspaceRoot, now, label = "CROSS_PROCESS_OK") {
  const ports = createNodeRuntimePorts({ stateRoot, workspaceRoot });
  ports.clock = createTestClock(now);
  return createAgentRuntime({
    ports,
    defaultRunConfig: {
      workspaceRoot,
      permissionMode: "auto_approve",
      maxSteps: 4,
      modelSampler: createSampler(label),
    },
  });
}

/** 收集一个 Runtime 事件流，保证子进程在最终状态落盘后再输出结果。 */
async function collectEvents(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** 从安全 answer_delta 事件拼接确定性回答，避免依赖不存在的 answer_completed 事件。 */
function answerFromEvents(events) {
  return events
    .filter(function isAnswerDelta(event) { return event.type === "answer_delta"; })
    .map(function getDelta(event) { return event.delta; })
    .join("");
}

/** 启动一个独立 Node 子进程并解析其 JSON 结果。 */
function runChild(mode, args) {
  return new Promise(function waitForChild(resolve, reject) {
    const child = spawn(process.execPath, [scriptPath, mode, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", function collectStdout(chunk) { stdout += chunk; });
    child.stderr.on("data", function collectStderr(chunk) { stderr += chunk; });
    child.once("error", reject);
    child.once("close", function parseResult(code) {
      try {
        resolve({ code: code ?? 1, result: JSON.parse(stdout.trim()), stderr });
      } catch (error) {
        reject(new Error(`子进程 ${mode} 输出不是 JSON（exit=${code}）：${stdout}${stderr}\n${error}`));
      }
    });
  });
}

/** 启动持有新鲜 lease 的子进程，并等待其首个 durable turn_started 事件。 */
function startOwner(args) {
  return new Promise(function waitForStarted(resolve, reject) {
    const child = spawn(process.execPath, [scriptPath, "owner", ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", function inspectStarted(chunk) {
      stdout += chunk;
      const line = stdout.split(/\r?\n/u).find(Boolean);
      if (!line || settled) return;
      try {
        const result = JSON.parse(line);
        settled = true;
        resolve({ child, result, stderr });
      } catch {
        // 继续等待完整 JSON 行。
      }
    });
    child.stderr.on("data", function collectStderr(chunk) { stderr += chunk; });
    child.once("error", reject);
    child.once("close", function closed(code) {
      if (!settled) reject(new Error(`owner 未输出 started（exit=${code}）：${stdout}${stderr}`));
    });
  });
}

/** 强制终止持有者并等待句柄关闭，模拟宿主崩溃而不执行 Runtime finally。 */
function killChild(child) {
  return new Promise(function waitForExit(resolve) {
    child.once("close", resolve);
    child.kill("SIGKILL");
  });
}

/** 持有 lease 后输出首个事件并保持进程存活。 */
async function runOwner(stateRoot, workspaceRoot, now, label) {
  initializeNodeStateRoot(stateRoot);
  const runtime = createTestRuntime(stateRoot, workspaceRoot, now, label);
  const session = await runtime.sessions.create({ title: "cross-process owner" });
  const iterator = runtime.turns.start({ sessionId: session.id, content: "owner prompt" });
  const first = await iterator.next();
  if (first.done || !first.value?.turnId) throw new Error("owner 未产生 turn_started");
  process.stdout.write(`${JSON.stringify({ kind: "owner", sessionId: session.id, turnId: first.value.turnId })}\n`);
  setInterval(function keepOwnerAlive() {}, 1_000);
}

/** 尝试在已有 owner 上启动第二个 Turn，输出稳定 Runtime 错误码。 */
async function runContender(stateRoot, workspaceRoot, now, sessionId) {
  try {
    const runtime = createTestRuntime(stateRoot, workspaceRoot, now, "CONTENDER_SHOULD_NOT_RUN");
    await collectEvents(runtime.turns.start({ sessionId, content: "contender prompt" }));
    process.stdout.write(`${JSON.stringify({ kind: "contender", status: "completed" })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ kind: "contender", errorCode: error?.code ?? "UNKNOWN", message: error?.message ?? String(error) })}\n`);
  }
}

/** 创建一个独立 Session 并完成 Turn，返回冻结模型与最终状态。 */
async function runComplete(stateRoot, workspaceRoot, now, modelId, label) {
  const runtime = createTestRuntime(stateRoot, workspaceRoot, now, label);
  const session = await runtime.sessions.create({ title: `parallel-${modelId}` });
  const events = await collectEvents(runtime.turns.start({
    sessionId: session.id,
    content: `parallel ${modelId}`,
    runConfig: { modelRef: { provider: "step4-test", modelId } },
  }));
  const turnId = events.find(function findTurnStarted(event) { return event.type === "turn_started"; })?.turnId;
  const state = turnId ? await runtime.turns.getState({ sessionId: session.id, turnId }) : undefined;
  process.stdout.write(`${JSON.stringify({
    kind: "complete",
    sessionId: session.id,
    turnId,
    modelId: state?.turn?.frozenRunConfig.modelRef?.modelId,
    status: state?.checkpoint?.status,
    answer: answerFromEvents(events),
  })}\n`);
}

/** 在 stale lease 上继续原 Turn；两个子进程同时调用时只能一个取得新 lease。 */
async function runResume(stateRoot, workspaceRoot, now, sessionId, turnId) {
  try {
    const runtime = createTestRuntime(stateRoot, workspaceRoot, now, "CROSS_PROCESS_RECOVERED");
    const recoverable = await runtime.turns.getRecoverableState({ sessionId, turnId });
    const events = await collectEvents(runtime.turns.continue({ sessionId, turnId }));
    const state = await runtime.turns.getState({ sessionId, turnId });
    process.stdout.write(`${JSON.stringify({
      kind: "resume",
      recoverableStatus: recoverable?.status,
      turnId: recoverable?.turnId,
      finalStatus: state.checkpoint?.status,
      finalTurnId: state.checkpoint?.turnId,
      answer: answerFromEvents(events),
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ kind: "resume", errorCode: error?.code ?? "UNKNOWN", message: error?.message ?? String(error) })}\n`);
  }
}

/** 与另一个进程竞争同一 Inbox input，验证 claim 恰好一次。 */
async function runClaim(stateRoot, workspaceRoot, sessionId) {
  const runtime = createTestRuntime(stateRoot, workspaceRoot, Date.now(), "CLAIM");
  const claimed = await runtime.inbox.claimNext({ sessionId });
  process.stdout.write(`${JSON.stringify({ kind: "claim", status: claimed?.status ?? "none", inputId: claimed?.inputId })}\n`);
}

/** 与另一个进程竞争同一审批键，验证 ApprovalStore 保存操作恰好一次。 */
async function runApproval(stateRoot, workspaceRoot, sessionId) {
  const ports = createNodeRuntimePorts({ stateRoot, workspaceRoot });
  const saved = await ports.approvalStore.saveDecision({
    sessionId,
    turnId: "approval-turn",
    approvalId: "approval-once",
    callId: "approval-call",
    toolName: "edit_file",
    normalizedInputHash: "approval-hash",
    decision: "allow_once",
    createdAt: "2026-08-10T00:00:00.000Z",
  });
  process.stdout.write(`${JSON.stringify({ kind: "approval", saved })}\n`);
}

/** 递归统计残留锁/临时文件，确认正常收口没有留下不可恢复的工作文件。 */
function findTemporaryFiles(root) {
  const result = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith(".lock") || entry.name.endsWith(".tmp")) result.push(target);
    }
  }
  visit(root);
  return result;
}

/** 编排所有 Step 4 跨进程场景并写入可审计结果。 */
async function runParent() {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-step4-")).replace(/\\/gu, "/");
  const stateRoot = path.join(runRoot, "state");
  const workspaceA = path.join(runRoot, "workspace-a");
  const workspaceB = path.join(runRoot, "workspace-b");
  fs.mkdirSync(workspaceA, { recursive: true });
  fs.mkdirSync(workspaceB, { recursive: true });
  initializeNodeStateRoot(stateRoot);

  const owner = await startOwner([stateRoot, workspaceA, "100000", "OWNER"]);
  const contender = await runChild("contender", [stateRoot, workspaceB, "100001", owner.result.sessionId]);
  const sameSession = contender.result.errorCode === "TURN_ALREADY_RUNNING";
  await killChild(owner.child);

  const resumes = await Promise.all([
    runChild("resume", [stateRoot, workspaceB, "146000", owner.result.sessionId, owner.result.turnId]),
    runChild("resume", [stateRoot, workspaceA, "146000", owner.result.sessionId, owner.result.turnId]),
  ]);
  const successfulResumes = resumes.filter(function isSuccessfulResume(item) { return item.result.kind === "resume" && !item.result.errorCode; });
  const rejectedResumes = resumes.filter(function isRejectedResume(item) { return item.result.errorCode === "TURN_ALREADY_RUNNING"; });
  const staleRecovery = successfulResumes.length === 1
    && rejectedResumes.length === 1
    && successfulResumes[0].result.recoverableStatus === "interrupted_recoverable"
    && successfulResumes[0].result.finalStatus === "completed"
    && successfulResumes[0].result.finalTurnId === owner.result.turnId;

  const checkpointPath = path.join(stateRoot, "checkpoints", `${owner.result.sessionId}.jsonl`);
  const checkpointRecords = fs.readFileSync(checkpointPath, "utf8").split(/\r?\n/u).filter(Boolean).map(function parseRecord(line) {
    try { return JSON.parse(line); } catch { return null; }
  });
  const recoveredRecordCount = checkpointRecords.filter(function isRecovered(record) { return record?.status === "interrupted_recoverable"; }).length;
  fs.appendFileSync(checkpointPath, "{\"half_written\":", "utf8");
  const tailCheckPorts = createNodeRuntimePorts({ stateRoot, workspaceRoot: workspaceA });
  tailCheckPorts.clock = createTestClock(146000);
  const tailCheck = await tailCheckPorts.checkpointStore.getLatest(owner.result.sessionId).catch(function noOp() { return null; });
  const tailRecovery = tailCheck?.status === "completed";

  const parallel = await Promise.all([
    runChild("complete", [stateRoot, workspaceA, "200000", "model-a", "PARALLEL_A"]),
    runChild("complete", [stateRoot, workspaceB, "200000", "model-b", "PARALLEL_B"]),
  ]);
  const parallelIsolation = parallel.length === 2
    && parallel.every(function completed(item) { return item.result.status === "completed"; })
    && new Set(parallel.map(function model(item) { return item.result.modelId; })).size === 2
    && parallel.some(function hasModelA(item) { return item.result.modelId === "model-a" && item.result.answer === "PARALLEL_A"; })
    && parallel.some(function hasModelB(item) { return item.result.modelId === "model-b" && item.result.answer === "PARALLEL_B"; });

  const inboxRuntime = createTestRuntime(stateRoot, workspaceA, 200000, "CLAIM_SEED");
  const inboxSession = await inboxRuntime.sessions.create({ title: "cross-process inbox" });
  const posted = await inboxRuntime.inbox.post({ sessionId: inboxSession.id, delivery: "queue", content: "exactly once", attachments: [], selectedSkills: [] });
  const claims = await Promise.all([
    runChild("claim", [stateRoot, workspaceA, "0", inboxSession.id]),
    runChild("claim", [stateRoot, workspaceB, "0", inboxSession.id]),
  ]);
  const claimedCount = claims.filter(function isClaimed(item) { return item.result.status === "claimed" && item.result.inputId === posted.inputId; }).length;
  const emptyCount = claims.filter(function isEmpty(item) { return item.result.status === "none"; }).length;
  const inboxExactlyOnce = claimedCount === 1 && emptyCount === 1;

  const steerSession = await inboxRuntime.sessions.create({ title: "cross-process steer" });
  const steerPosted = await inboxRuntime.inbox.post({ sessionId: steerSession.id, delivery: "steer", content: "steer exactly once", attachments: [], selectedSkills: [] });
  const steerClaims = await Promise.all([
    runChild("claim", [stateRoot, workspaceA, "0", steerSession.id]),
    runChild("claim", [stateRoot, workspaceB, "0", steerSession.id]),
  ]);
  const steerClaimedCount = steerClaims.filter(function isSteerClaimed(item) { return item.result.status === "claimed" && item.result.inputId === steerPosted.inputId; }).length;
  const steerEmptyCount = steerClaims.filter(function isSteerEmpty(item) { return item.result.status === "none"; }).length;
  const steerExactlyOnce = steerClaimedCount === 1 && steerEmptyCount === 1;

  const approvalSession = "cross-process-approval";
  const approvalClaims = await Promise.all([
    runChild("approval", [stateRoot, workspaceA, "0", approvalSession]),
    runChild("approval", [stateRoot, workspaceB, "0", approvalSession]),
  ]);
  const approvalSavedCount = approvalClaims.filter(function wasSaved(item) { return item.result.saved === true; }).length;
  const approvalRejectedCount = approvalClaims.filter(function wasRejected(item) { return item.result.saved === false; }).length;
  const approvalExactlyOnce = approvalSavedCount === 1 && approvalRejectedCount === 1;
  const temporaryFiles = findTemporaryFiles(runRoot);

  const result = {
    status: sameSession && staleRecovery && tailRecovery && parallelIsolation && inboxExactlyOnce && steerExactlyOnce && approvalExactlyOnce && temporaryFiles.length === 0 ? "passed" : "failed",
    runRoot,
    sameSession,
    contender: contender.result,
    staleRecovery,
    recoveredRecordCount,
    tailRecovery,
    resumes: resumes.map(function resultOf(item) { return item.result; }),
    parallelIsolation,
    parallel: parallel.map(function resultOf(item) { return item.result; }),
    inboxExactlyOnce,
    claims: claims.map(function resultOf(item) { return item.result; }),
    steerExactlyOnce,
    steerClaims: steerClaims.map(function resultOf(item) { return item.result; }),
    approvalExactlyOnce,
    approvals: approvalClaims.map(function resultOf(item) { return item.result; }),
    temporaryFiles,
  };
  fs.writeFileSync(path.join(runRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "passed") process.exitCode = 1;
}

/** 根据 argv 选择父进程或子进程场景。 */
async function main() {
  const [mode, stateRoot, workspaceRoot, now, arg5, arg6] = process.argv.slice(2);
  if (mode === "owner") return runOwner(stateRoot, workspaceRoot, Number(now), arg5);
  if (mode === "contender") return runContender(stateRoot, workspaceRoot, Number(now), arg5);
  if (mode === "complete") return runComplete(stateRoot, workspaceRoot, Number(now), arg5, arg6);
  if (mode === "resume") return runResume(stateRoot, workspaceRoot, Number(now), arg5, arg6);
  if (mode === "claim") return runClaim(stateRoot, workspaceRoot, arg5);
  if (mode === "approval") return runApproval(stateRoot, workspaceRoot, arg5);
  return runParent();
}

main().catch(function reportFailure(error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
