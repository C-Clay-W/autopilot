// 只读状态协议的白名单与 UTF-8 字节边界回归，不启动业务 Runtime。
import { describe, expect, it } from "vitest";
import { DesktopStatusLines, isDesktopStatusFrame, isDesktopSessionStatus, DESKTOP_STATUS_FRAME_BYTES } from "../src/node/desktop-status-protocol";
import { createNodeThreadRunner, type NodeThreadRunnerOptions } from "../src/node/thread-runner";

const session = { sessionId: "session-1", selected: true, relation: "opened", freshness: "fresh", status: "idle", lastSeq: 0 };
const frame = { protocolVersion: 1, desktopInstanceId: "desktop-1", paneId: "pane-1", generation: 1, apInstanceId: "ap-1", seq: 1, type: "snapshot", snapshotId: "snapshot-1", part: 0, final: true, lifecycle: "ready", workspace: { workspaceId: "workspace-1", stateRootId: "state-1", projectId: "project-1", displayName: "project" }, sessions: [session] };
describe("Desktop 状态协议", function protocol() {
  it("Runner 只读身份副本不能修改活动索引，释放仍沿原登记边界", function runnerIdentity() {
    const runner = createNodeThreadRunner({ delivery: { ownerId: "owner-1" }, runtime: {}, ports: {} } as NodeThreadRunnerOptions);
    const registration = runner.registerExecution({ threadId: "session-1", turnId: "turn-1", cancel: function cancel() {} });
    const copy = runner.listExecutions();
    copy[0].threadId = "other-session";
    assertIdentity();
    registration.release();
    expect(runner.listExecutions()).toEqual([]);
    /** 读取副本不改变业务登记的身份。 */
    function assertIdentity() { expect(runner.listExecutions()).toEqual([{ threadId: "session-1", turnId: "turn-1" }]); }
  });
  it("接受安全事实，拒绝未知版本、字段、正文与路径身份", function allowlist() {
    expect(isDesktopStatusFrame(frame)).toBe(true);
    expect(isDesktopStatusFrame({ ...frame, protocolVersion: 2 })).toBe(false);
    expect(isDesktopStatusFrame({ ...frame, prompt: "private" })).toBe(false);
    expect(isDesktopSessionStatus({ ...session, sessionId: "E:/private" })).toBe(false);
    expect(isDesktopSessionStatus({ ...session, interaction: { question: "private" } })).toBe(false);
    expect(isDesktopStatusFrame({ ...frame, workspace: undefined })).toBe(false);
    expect(isDesktopStatusFrame({ ...frame, lifecycle: "starting" })).toBe(false);
  });
  it("跨 chunk 中文 UTF-8 完整解码，字节超限与非法 UTF-8 拒绝", function utf8() {
    const lines = new DesktopStatusLines();
    const buffer = Buffer.from(JSON.stringify({ name: "中文" }) + "\n");
    expect(lines.push(buffer.subarray(0, 11))).toEqual([]);
    expect(lines.push(buffer.subarray(11))).toEqual([{ name: "中文" }]);
    expect(function tooLarge() { new DesktopStatusLines().push(Buffer.alloc(DESKTOP_STATUS_FRAME_BYTES + 1, 65)); }).toThrow();
    expect(function invalidUtf8() { new DesktopStatusLines().push(Buffer.from([0xff, 10])); }).toThrow();
  });
});
