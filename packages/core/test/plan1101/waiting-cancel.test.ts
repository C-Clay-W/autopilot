/** C2：等待取消经租约、标准安全终态与失败重试收敛，不启动模型。 */
import { expect, it, vi } from "vitest";
import { createMemoryPorts } from "../../src/runtime/adapters/memory";
import { createSessionService } from "../../src/runtime/application/session-service";
import { createTurnService } from "../../src/runtime/application/turn-service";
import { createTurnEventRecorder } from "../../src/runtime/application/turn/turn-event-recorder";
import { createApprovalService } from "../../src/runtime/application/approval-service";

/** 创建真实Store与标准暂停信封，保留私有checkpoint用于核对安全事件未泄露。 */
async function setup(status: "waiting_approval" | "waiting_user_input" = "waiting_approval") {
  const ports = createMemoryPorts();
  const session = await createSessionService(ports).create({ title: "waiting" });
  await ports.sessionStore.save({ ...session, status, activeTurnId: undefined });
  await ports.turnStore.save({ id: "waiting-turn", sessionId: session.id, status, frozenRunConfig: {}, startedAt: 1 });
  const checkpoint = { turnId: "waiting-turn", status: status === "waiting_approval" ? "awaiting_approval" as const : "awaiting_user_input" as const, stepCount: 1, messages: [], pendingCalls: [{ id: "private-call", name: "run_command", input: { privatePayload: "private-test-body" } }], completedCallIds: [] };
  await ports.checkpointStore.save(session.id, checkpoint);
  await createTurnEventRecorder(ports).record({ seq: 5, sessionId: session.id, turnId: "waiting-turn", isDurable: true, event: { type: "turn_paused", turnId: "waiting-turn", checkpoint } });
  return { ports, session, input: { sessionId: session.id, turnId: "waiting-turn" } };
}

/** 同一精确取消的重试只保留一条单调安全终态，并封住旧审批入口。 */
it.each(["waiting_approval", "waiting_user_input"] as const)("C2 %s 取消持久终态且幂等", async function interruptsWaiting(status) {
  const f = await setup(status);
  await createTurnService(f.ports).cancel(f.input);
  await createTurnService(f.ports).cancel(f.input);
  expect((await f.ports.checkpointStore.getLatest(f.session.id))?.status).toBe("interrupted");
  expect((await f.ports.turnStore.get(f.input.turnId))?.status).toBe("interrupted");
  expect(await f.ports.sessionStore.get(f.session.id)).toMatchObject({ status: "interrupted", activeTurnId: undefined });
  const events = await f.ports.transcriptStore.getEvents(f.session.id);
  expect(events.map(function sequence(event) { return event.seq; })).toEqual([5, 6]);
  expect(events.filter(function terminal(event) { return event.event.type === "turn_interrupted"; })).toHaveLength(1);
  expect(JSON.stringify(events.at(-1))).not.toContain("private-test-body");
  await expect(createApprovalService(f.ports).submit({ ...f.input, approvalId: "old-approval", decision: "allow_once" })).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
});

/** 独立Store无事务；每个写入窗口失败后，新Service按同一身份补齐，sink失败复用原信封。 */
it.each(["checkpoint", "transcript", "sink", "turn", "session"] as const)("C2 %s 写入失败后精确重试收敛且不重复终态", async function recoversPartialCancellation(point) {
  const f = await setup();
  const writes = {
    checkpoint: vi.spyOn(f.ports.checkpointStore, "save"), transcript: vi.spyOn(f.ports.transcriptStore, "append"),
    sink: vi.spyOn(f.ports.eventSink, "write"), turn: vi.spyOn(f.ports.turnStore, "save"), session: vi.spyOn(f.ports.sessionStore, "save"),
  };
  writes[point].mockRejectedValueOnce(new Error("injected write failure"));
  await expect(createTurnService(f.ports).cancel(f.input)).rejects.toThrow("injected write failure");
  const existing = (await f.ports.transcriptStore.getEvents(f.session.id)).find(function terminal(event) { return event.event.type === "turn_interrupted"; });
  if (point !== "checkpoint") expect((await f.ports.checkpointStore.getLatest(f.session.id))?.status).toBe("interrupted");
  await createTurnService(f.ports).cancel(f.input);
  const events = await f.ports.transcriptStore.getEvents(f.session.id);
  expect(events.map(function sequence(event) { return event.seq; })).toEqual([5, 6]);
  const terminal = events.find(function interrupted(event) { return event.event.type === "turn_interrupted"; });
  if (existing) expect(terminal).toEqual(existing);
  if (point === "sink") expect(writes.sink.mock.calls.at(-1)?.[0]).toEqual(existing);
  expect((await f.ports.turnStore.get(f.input.turnId))?.status).toBe("interrupted");
  expect((await f.ports.sessionStore.get(f.session.id))?.status).toBe("interrupted");
  for (const write of Object.values(writes)) write.mockRestore();
});

/** 旧取消的恢复不能覆盖后续新Turn，也不能使用其他Session的身份。 */
it("C2 错 Session 或后续新 Turn 拒绝旧取消恢复", async function rejectsStaleIdentity() {
  const f = await setup();
  await expect(createTurnService(f.ports).cancel({ ...f.input, sessionId: "foreign" })).rejects.toMatchObject({ code: "TURN_NOT_FOUND" });
  const save = vi.spyOn(f.ports.sessionStore, "save").mockRejectedValueOnce(new Error("session write failed"));
  await expect(createTurnService(f.ports).cancel(f.input)).rejects.toThrow();
  save.mockRestore();
  await f.ports.turnStore.save({ id: "new-turn", sessionId: f.session.id, status: "waiting_approval", frozenRunConfig: {}, startedAt: 2 });
  await f.ports.sessionStore.save({ ...f.session, status: "waiting_approval", activeTurnId: undefined });
  await f.ports.checkpointStore.save(f.session.id, { turnId: "new-turn", status: "awaiting_approval", stepCount: 0, messages: [], completedCallIds: [] });
  await expect(createTurnService(f.ports).cancel(f.input)).rejects.toMatchObject({ code: "TURN_FROZEN_MISMATCH" });
  expect((await f.ports.checkpointStore.getLatest(f.session.id))?.turnId).toBe("new-turn");
  expect((await f.ports.turnStore.get("new-turn"))?.status).toBe("waiting_approval");
});
