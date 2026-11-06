/** 验证显式交接：只允许 run、文档先写、消息携带同版引用、重试幂等与失败不降级。 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createSessionService } from "../../src/runtime/application/session-service";
import { createThreadFacade } from "../../src/runtime/application/thread-service";
import type { ThreadHandoffDocumentInput } from "../../src/runtime/ports/thread-handoff";

/** 记录写入顺序的内存交接写入器；可注入冲突与失败。 */
function createWriter(options: { conflict?: boolean; fail?: boolean } = {}) {
  const writes: ThreadHandoffDocumentInput[] = [];
  return {
    writes,
    async write(input: ThreadHandoffDocumentInput) {
      if (options.fail) throw new Error("disk down");
      if (options.conflict) throw new Error("THREAD_HANDOFF_CONFLICT");
      writes.push(input);
      return {
        handoffId: input.handoffId,
        relativePath: `.autopilot/thread-passdown-${input.handoffId}.md`,
        sha256: createHash("sha256").update(`# Handoff：${input.title}\n\n${input.markdown}\n`, "utf8").digest("hex"),
      };
    },
  };
}

/** 建立已启用协作组的内存宿主，并可注入交接写入能力。 */
async function setup(writer?: ReturnType<typeof createWriter>) {
  const ports = createMemoryPorts();
  const sessions = createSessionService(ports);
  const root = await sessions.create({ title: "root" });
  const child = await sessions.create({ title: "child", projectId: root.projectId });
  const context = {
    workspaceId: "workspace",
    stateRootId: "state-one",
    projectId: root.projectId!,
    allowedTools: ["send_thread"],
    modelCatalog: [],
    ...(writer ? { handoff: writer } : {}),
  };
  const human = createThreadFacade(ports, { ...context, actor: { kind: "human", principalId: "user" } });
  const { group } = await human.enable({ protocolVersion: 1, requestId: "enable", rootThreadId: root.id });
  // 已有会话不能通过启用被自动吸收；交接测试需要显式成员，按创建语义补一个子会话。
  const created = await human.create({ protocolVersion: 1, groupId: group.groupId, parentThreadId: root.id, title: "执行", requestId: "create-child" });
  return { ports, sessions, root, child, human, groupId: group.groupId, created, context };
}

describe("显式任务交接", function threadHandoffContract() {
  it("run 携带 handoff 时先写文档，再接受含固定首行与同版摘要的消息", async function writesBeforeAccept() {
    const writer = createWriter();
    const f = await setup(writer);
    const sent = await f.human.send({
      protocolVersion: 1,
      groupId: f.groupId,
      threadId: f.created.threadId,
      requestId: "handoff-1",
      mode: "run",
      content: "继续完成 Stage S4b",
      handoff: { title: "S4b 交接", markdown: "目标：完成来源标签与交接\n下一步：跑定向用例" },
    });
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]).toMatchObject({ workspaceId: "workspace", title: "S4b 交接" });
    expect(writer.writes[0]!.handoffId).toMatch(/^[0-9a-f]{32}$/);
    expect(sent.handoffRef).toMatchObject({ handoffId: writer.writes[0]!.handoffId, relativePath: `.autopilot/thread-passdown-${writer.writes[0]!.handoffId}.md` });
    expect(sent.handoffRef!.sha256).toMatch(/^[0-9a-f]{64}$/);

    const page = await f.human.messages({ protocolVersion: 1, groupId: f.groupId, threadId: f.created.threadId });
    const message = page.items[0]!;
    expect(message.content.startsWith("# Handoff：S4b 交接\n\n继续完成 Stage S4b")).toBe(true);
    expect(message.content).toContain("交接文档：.autopilot/thread-passdown-");
    expect(message.content).toContain("目标：完成来源标签与交接");
    expect(message.content).toContain(`交接摘要 sha256：${sent.handoffRef!.sha256}`);
    expect(message.handoff).toEqual(sent.handoffRef);
    expect(message.handoffDisplay).toEqual({ title: "S4b 交接", instruction: "继续完成 Stage S4b", summary: "目标：完成来源标签与交接\n下一步：跑定向用例" });

    // 同 requestId 同参数重放：返回原消息与同一引用，不重复写文件。
    const replay = await f.human.send({
      protocolVersion: 1,
      groupId: f.groupId,
      threadId: f.created.threadId,
      requestId: "handoff-1",
      mode: "run",
      content: "继续完成 Stage S4b",
      handoff: { title: "S4b 交接", markdown: "目标：完成来源标签与交接\n下一步：跑定向用例" },
    });
    expect(replay).toMatchObject({ messageId: sent.messageId, handoffRef: sent.handoffRef });
    expect((await f.human.messages({ protocolVersion: 1, groupId: f.groupId, threadId: f.created.threadId })).items).toHaveLength(1);
  });

  it("同 requestId 换摘要视为不同请求，不覆盖文件或消息", async function conflictingRetry() {
    const f = await setup(createWriter());
    await f.human.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.created.threadId, requestId: "handoff-2", mode: "run", content: "接续", handoff: { title: "A", markdown: "摘要 A" } });
    await expect(f.human.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.created.threadId, requestId: "handoff-2", mode: "run", content: "接续", handoff: { title: "B", markdown: "摘要 B" } })).rejects.toMatchObject({ code: "THREAD_REQUEST_CONFLICT" });
    expect((await f.human.messages({ protocolVersion: 1, groupId: f.groupId, threadId: f.created.threadId })).items).toHaveLength(1);
  });

  it("notify/steer 携带 handoff 明确拒绝，普通 send 不建文件", async function modeRestriction() {
    const writer = createWriter();
    const f = await setup(writer);
    await expect(f.human.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.created.threadId, requestId: "handoff-notify", mode: "notify", content: "通知", handoff: { title: "A", markdown: "B" } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(f.human.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.created.threadId, requestId: "handoff-steer", mode: "steer", content: "引导", expectedTurnId: "turn-1", handoff: { title: "A", markdown: "B" } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const plain = await f.human.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.created.threadId, requestId: "plain", mode: "run", content: "普通任务" });
    expect("handoffRef" in plain).toBe(false);
    expect(writer.writes).toHaveLength(0);
  });

  it("宿主未装配写入能力时不可用，不降级为普通发送", async function unavailable() {
    const f = await setup();
    await expect(f.human.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.created.threadId, requestId: "handoff-3", mode: "run", content: "接续", handoff: { title: "A", markdown: "B" } })).rejects.toMatchObject({ code: "THREAD_HANDOFF_UNAVAILABLE" });
    expect((await f.human.messages({ protocolVersion: 1, groupId: f.groupId, threadId: f.created.threadId })).items).toHaveLength(0);
  });

  it("写入失败或内容冲突时不接受消息", async function writeFailures() {
    const failing = await setup(createWriter({ fail: true }));
    await expect(failing.human.send({ protocolVersion: 1, groupId: failing.groupId, threadId: failing.created.threadId, requestId: "handoff-fail", mode: "run", content: "接续", handoff: { title: "A", markdown: "B" } })).rejects.toMatchObject({ code: "THREAD_HANDOFF_WRITE_FAILED" });
    const conflicting = await setup(createWriter({ conflict: true }));
    await expect(conflicting.human.send({ protocolVersion: 1, groupId: conflicting.groupId, threadId: conflicting.created.threadId, requestId: "handoff-conflict", mode: "run", content: "接续", handoff: { title: "A", markdown: "B" } })).rejects.toMatchObject({ code: "THREAD_HANDOFF_CONFLICT" });
    expect((await conflicting.human.messages({ protocolVersion: 1, groupId: conflicting.groupId, threadId: conflicting.created.threadId })).items).toHaveLength(0);
  });

  it("标题非单行、摘要超限与合成正文超限都被拒绝", async function limits() {
    const f = await setup(createWriter());
    await expect(f.human.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.created.threadId, requestId: "handoff-title", mode: "run", content: "接续", handoff: { title: "A\nB", markdown: "B" } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(f.human.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.created.threadId, requestId: "handoff-long", mode: "run", content: "接续", handoff: { title: "A", markdown: "x".repeat(16 * 1024 + 1) } })).rejects.toMatchObject({ code: "THREAD_PAYLOAD_TOO_LARGE" });
    await expect(f.human.send({ protocolVersion: 1, groupId: f.groupId, threadId: f.created.threadId, requestId: "handoff-composed", mode: "run", content: "x".repeat(20 * 1024), handoff: { title: "A", markdown: "y".repeat(15 * 1024) } })).rejects.toMatchObject({ code: "THREAD_PAYLOAD_TOO_LARGE" });
  });
});
