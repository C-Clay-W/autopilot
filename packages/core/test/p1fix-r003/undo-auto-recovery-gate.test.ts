/**
 * p1fix-r003 Tester 回归用例：R6 必测 #6 preview 自动 journal recovery 门控
 * （Talk-Plan1013 Stage5 CR R6）。
 *
 * 合同要求（CR R6 verification + Plan §7.5）：未完成 journal 的 compensateTransaction
 * 先于显式确认运行（reconcileUndoTransactions → preview），在 canonical 身份失配或
 * deny/ask 收紧下同样必须被门控——恢复不得自动写入被禁/已转移目标，preview 收敛为
 * UNDO_CONFLICT，目标零变化。Executor r003 新增 3 用例覆盖 execute 主路径与
 * resolveFileMutationTarget 单点，未覆盖 preview 自动恢复路径，本文件补齐。
 *
 * 本文件只新增测试断言，不修改任何产品源码。fixture 全部合成临时目录，用后清理。
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUndoService } from "../../src/runtime/application/undo-service";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import type { ExternalPermissionProjector } from "../../src/runtime/ports";
import type { RuntimePorts } from "../../src/runtime/ports";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 最小投影器替身：只返回固定 allow/deny/ask 规则集合，project 为 no-op。 */
function createUndoProjector(rules: { allow?: string[]; deny?: string[]; ask?: string[] }): ExternalPermissionProjector {
  const allow = rules.allow ?? [];
  const deny = rules.deny ?? [];
  const ask = rules.ask ?? [];
  return {
    async project() { /* 恢复路径不写投影 */ },
    async read() { return { allow: [...allow], deny: [...deny], ask: [...ask] }; },
  };
}

/** 构造“已 applied 的外部 mutation + 未完成 undo journal（status=prepared）”fixture；restriction 指定投影器注入的收紧规则。 */
async function createIncompleteJournalFixture(options: { restriction?: "deny" | "ask" }): Promise<{
  ports: RuntimePorts;
  sessionId: string;
  targetFile: string;
}> {
  const base = await mkdtemp(path.join(os.tmpdir(), "p1fix-r003-recovery-"));
  temporaryRoots.push(base);
  const workspaceRoot = path.join(base, "ws");
  const outsideRoot = path.join(base, "outside");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  const targetFile = path.join(outsideRoot, "journaled.txt");
  const before = Buffer.from("before-bytes", "utf8");
  const after = Buffer.from("after-bytes", "utf8");
  await writeFile(targetFile, after);
  const sessionId = "s-r6-recovery";
  const turnId = "t-r6-recovery";
  const ports: RuntimePorts = { ...createMemoryPorts(workspaceRoot), ...(options.restriction ? { externalPermissionProjector: createUndoProjector({ [options.restriction]: [`Write(${targetFile})`] }) } : {}) };
  await ports.sessionStore.save({ id: sessionId, status: "waiting_approval", persistenceMode: "durable", createdAt: 1, updatedAt: 1, activeTurnId: turnId });
  await ports.turnStore.save({ id: turnId, sessionId, status: "completed", startedAt: 1, completedAt: 2, schemaVersion: 1, frozenRunConfig: { workspaceRoot, workspaceTrusted: true, permissionMode: "ask" } });
  const mutation = await ports.fileMutationStore.prepare({ sessionId, turnId, toolCallId: "call-r6-recovery", path: `ext:${targetFile}`, operation: "overwrite", before, after, createdAt: 10 });
  mutation.status = "applied";
  await ports.fileMutationStore.save(mutation);
  // 未完成 journal：崩溃发生在 prepare 之后、真实提交之前（无 staging/isolation 工件）。
  await ports.fileMutationStore.saveUndoTransaction({
    id: "tx-r6-recovery",
    sessionId,
    turnId,
    workspaceRoot,
    status: "prepared",
    files: [{ mutationId: mutation.id, path: `ext:${targetFile}`, status: "prepared" }],
    createdAt: 11,
    updatedAt: 11,
  });
  return { ports, sessionId, targetFile };
}

describe("p1fix-r003 R6 preview 自动 journal recovery 门控（Talk-Plan1013 Stage5 CR R6 必测 #6）", () => {
  it("未完成 journal 的自动补偿在 deny 下被门控：preview 收敛 UNDO_CONFLICT，目标零变化", async () => {
    const { ports, sessionId, targetFile } = await createIncompleteJournalFixture({ restriction: "deny" });
    const undo = createUndoService(ports);
    // preview 先跑 reconcileUndoTransactions → compensateTransaction：写入门必须拒绝自动补偿。
    await expect(undo.preview({ sessionId })).resolves.toMatchObject({ status: "unavailable", reason: "UNDO_CONFLICT" });
    expect(await readFile(targetFile, "utf8")).toBe("after-bytes");
  });

  it("未完成 journal 的自动补偿在 ask 下同样被门控（Undo 无逐次确认通道，fail-closed）", async () => {
    const { ports, sessionId, targetFile } = await createIncompleteJournalFixture({ restriction: "ask" });
    const undo = createUndoService(ports);
    await expect(undo.preview({ sessionId })).resolves.toMatchObject({ status: "unavailable", reason: "UNDO_CONFLICT" });
    expect(await readFile(targetFile, "utf8")).toBe("after-bytes");
  });

  it("未完成 journal 的自动补偿在 canonical 身份失配（父链接替换到同 SHA 目录）下被门控", async () => {
    const { ports, sessionId, targetFile } = await createIncompleteJournalFixture({});
    // 父链接替换：outside 换成指向 sameShaRoot 的 junction，B 放置与 afterSha 相同字节。
    const base = path.dirname(path.dirname(targetFile));
    const sameShaRoot = path.join(base, "same-sha");
    await mkdir(sameShaRoot, { recursive: true });
    await writeFile(path.join(sameShaRoot, "journaled.txt"), "after-bytes", "utf8");
    await rm(path.dirname(targetFile), { recursive: true, force: true });
    await symlink(sameShaRoot, path.dirname(targetFile), "junction");
    const undo = createUndoService(ports);
    await expect(undo.preview({ sessionId })).resolves.toMatchObject({ status: "unavailable", reason: "UNDO_CONFLICT" });
    // execute 同样 fail-closed：内部先跑同一 preview 收敛，稳定失败且不写任何字节。
    await expect(undo.execute({ sessionId, confirmed: true })).rejects.toThrow("UNDO_NOT_AVAILABLE");
    // 转移目标零变化：自动补偿没有把任何字节写入新位置。
    expect(await readFile(path.join(sameShaRoot, "journaled.txt"), "utf8")).toBe("after-bytes");
  });

  it("对照：未完成 journal 且无限制时自动补偿正常收敛，preview 不被误门控（不回归）", async () => {
    const { ports, sessionId, targetFile } = await createIncompleteJournalFixture({});
    const undo = createUndoService(ports);
    // 无投影器即无已知限制：自动补偿成功（无冲突），preview 继续正常流程并可用。
    await expect(undo.preview({ sessionId })).resolves.toMatchObject({ status: "available" });
    expect(await readFile(targetFile, "utf8")).toBe("after-bytes");
  });

  it("语义边界记录（待主控裁决）：仅撤销 grant（投影规则删除、无 deny/ask）后外部 Undo 仍恢复 before", async () => {
    // 复现 revokePersistentGrant 后的投影器状态：allow 规则被删除，deny/ask 为空。
    // 该状态与 allow_once 写入（从未投影规则）在 Undo 门处不可区分；派工 R6 #7 要求
    // “无限制外部目标的 Undo 保持”，故本场景按当前实现恢复 before 字节。
    // 派工 R6 #5 字面表述（撤销 grant → UNDO_CONFLICT）与该不可区分性矛盾：Undo 门
    // 只按 deny/ask 收窄判定，无法从快照区分“从未有规则”与“规则被撤销”。若主控要求
    // 严格拒绝，需 WAL 记录原审批 lifetime（Executor 明确避免的 schema 变更）。
    // 本用例固化当前语义供裁决参考，不构成缺陷判定。
    const { ports, sessionId, targetFile } = await createIncompleteJournalFixture({});
    const projected: string[] = [`Write(${targetFile})`];
    (ports as RuntimePorts & { externalPermissionProjector?: ExternalPermissionProjector }).externalPermissionProjector = {
      async project({ rule, action }) {
        const index = projected.indexOf(rule);
        if (action === "add" && index < 0) projected.push(rule);
        if (action === "remove" && index >= 0) projected.splice(index, 1);
      },
      async read() { return { allow: [...projected], deny: [], ask: [] }; },
    };
    // 模拟撤销：先投影后删除（revokePersistentGrant 的删顺序）。
    await ports.externalPermissionProjector!.project({ workspaceRoot: "", rule: `Write(${targetFile})`, action: "remove" });
    const undo = createUndoService(ports);
    await expect(undo.preview({ sessionId })).resolves.toMatchObject({ status: "available" });
    const result = await undo.execute({ sessionId, confirmed: true });
    expect(result.status).toBe("completed");
    expect(await readFile(targetFile, "utf8")).toBe("before-bytes");
  });
});
