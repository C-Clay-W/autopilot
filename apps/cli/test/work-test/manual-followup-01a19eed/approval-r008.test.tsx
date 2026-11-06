/** r006待审批身份与关联/当前卡：合成Runtime、真实Controller和内存Ink。 */
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import { readCliSessionSummary } from "../../../src/session-summary.js";
import { createCliController } from "../../../src/controller.js";
import { createPlainRenderer } from "../../../src/renderer.js";
import { createCliSessionManager } from "../../../src/tui/session-manager.js";
import { CliSessionWorkspace } from "../../../src/tui/session-workspace.js";
import { TuiLiveTurn } from "../../../src/tui/timeline/turn.js";
import type { AgentEventEnvelope, AgentRuntime, RuntimePorts, Session } from "@autopilot-agent/core";

/** 给Ink被动effect一次有界提交机会。 */
async function frame() { await new Promise(function tick(resolve) { setTimeout(resolve, 40); }); }
/** 等待可观察帧，不重发输入。 */
async function until(check: () => boolean) { for (let i = 0; i < 25 && !check(); i++) await frame(); expect(check()).toBe(true); }
const pending = { approvalId: "approval-child", callId: "call", toolName: "todo_write", constraint: "task-files:v1", reason: "合成文件清单", allowedDecisions: ["allow_once", "deny"] as const, display: { operation: "编辑任务文件", actionPreview: "合成文件清单", allowedDecisions: ["allow_once", "deny"] as const } };

it("第一次真实批准continue后82→84→106跨页，已打开目标父Ctrl+A第二次准确提交", async function relatedApproval() {
  const initial = { id: "root", title: "父任务", status: "running", activeTurnId: "parent-turn", productMode: "work", projectId: "p", createdAt: 0, updatedAt: 0 } as Session;
  const child = { ...initial, id: "child", title: "子任务", status: "waiting_approval" as const };
  let phase = 1; let holdBody = false; let releaseBody: (() => void) | undefined;
  const submit = vi.fn(async function approve() {}); const resumed = vi.fn();
  const runtime = { sessions: { get: async function get(id: string) { return id === "root" ? initial : child; } }, approvals: { submit }, turns: { getFrozenRunConfig: async function frozen() { return null; }, getUsageSnapshot: async function usage() { return { contextUsage: null, turnUsage: null }; }, continue: async function* resume(input: unknown) { resumed(input); phase = 2; yield { type: "turn_started", turnId: "turn-child", stepCount: 1 }; } } } as unknown as AgentRuntime;
  const ports = { sessionStore: { getDirectoryEntry: runtime.sessions.get }, turnStore: { getLatest: async function latest() { return { id: "turn-child", sessionId: "child", status: "waiting_approval" }; } } } as unknown as RuntimePorts;
  /** 每目标固定绑定真实Controller，禁止观察启动执行。 */
  function controller(id: string) { return createCliController({ runtime, sessionId: id, renderer: createPlainRenderer("text") }); }
  const all = Array.from({ length:107 }, function envelope(_, index) { const seq=index+1;return { sessionId:"child",turnId:"turn-child",seq,timestamp:new Date(seq).toISOString(),event:seq===1||seq===84?{type:"turn_started",turnId:"turn-child",stepCount:0}:seq===82||seq===106?{type:"approval_required",turnId:"turn-child",stepId:"s",callId:seq===82?"first":"second",toolName:"todo_write",result:{status:"approval_required",approval:{...pending,approvalId:seq===82?"first":"second",display:{...pending.display,actionPreview:seq===82?"first":"second"}}}}:{type:"answer_delta",turnId:"turn-child",stepId:"s",delta:`[${seq}]`}} as unknown as AgentEventEnvelope; });
  const manager = createCliSessionManager({ runtime, projectId: "p", initialSession: initial, initialController: controller("root"), createController: controller, readSummary: function summary(id) { return id === "root" ? Promise.resolve({ title: "父任务", status: "running" as const, currentTurnId: "parent-turn" }) : readCliSessionSummary(ports, id); }, readRelations: async function relations(id) { const summary = await readCliSessionSummary(ports, "child"); return id === "root" ? [{ threadId: "child", parentThreadId: "root", title: "子任务", status: summary!.status, activeTurnId: summary!.currentTurnId }] : []; }, readEventPage: async function page(id, input) { if(id!=="child")return {items:[],cursor:"0"};if(holdBody && !input.cursor){await new Promise<void>(function delayed(resolve){releaseBody=resolve;});holdBody=false;}const source=phase===1?all.slice(0,82):all;const start=Number(input.cursor??0);const items=source.slice(start,start+100);const cursor=String(start+items.length);return {items,cursor,...(start+items.length<source.length?{nextCursor:cursor}:{})}; } });
  await manager.refresh();
  const target = manager.related()[0]!;
  await target.controller.dispatch({type:"approve",expected:{sessionId:"child",turnId:"turn-child",approvalId:"first"},decision:"allow_once"});
  expect(submit).toHaveBeenCalledTimes(1);expect(resumed).toHaveBeenCalledTimes(1);
  holdBody=true;const selecting=manager.select("child");await until(function reading(){return Boolean(releaseBody);});await manager.refresh();releaseBody!();await selecting;await manager.select("root");await manager.refresh();
  expect(target.historyCursor).toBe("100");expect(target.historyMore).toBe(true);expect(target.store.getSnapshot().pendingApproval?.approvalId).toBe("second");
  const terminal = Object.assign(new EventEmitter(), { columns: 120, rows: 28 });
  const view = render(createElement(CliSessionWorkspace, { manager, terminalSizeSource: terminal, renderMode: "inline", useColor: false, screenReader: false, reducedMotion: true, closeWhenIdle: false, onResult: function result() {}, onRequestInterrupt: function interrupt() {}, onRequestCancel: function cancel() {}, onEof: function eof() {}, onAppExit: function exit() {} }));
  try {
    await frame(); view.stdin.write("父草稿"); await frame(); expect(view.lastFrame()).toContain("Ctrl+A原地处理");
    view.stdin.write("\u0001"); await until(function listed() { return view.lastFrame().includes("关联任务"); }); view.stdin.write("\r"); await until(function menu() { return view.lastFrame().includes("批准本任务文件修改"); });
    view.stdin.write("\r"); await until(function approved() { return submit.mock.calls.length === 2; });view.stdin.write("\r");await frame();expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledWith({ sessionId: "child", turnId: "turn-child", approvalId: "second", decision: "allow_once" });
    expect(resumed).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "child", turnId: "turn-child" })); expect(manager.entries()[0]!.viewState.draftRef.current?.inputRef.current).toBe("父草稿");
    await manager.loadHistory("child");expect(target.historyMore).toBe(false);expect(target.controller.getProjection().answer).toContain("[107]");
  } finally { view.unmount(); await manager.stop(); }
});


it("同Turn恢复立即清旧pending，不让running旧卡成为输入许可", function clearsOld() {
 const controller=createCliController({sessionId:"child",renderer:createPlainRenderer("text")});
 controller.observe!([{sessionId:"child",turnId:"turn-child",seq:82,timestamp:new Date().toISOString(),event:{type:"approval_required",turnId:"turn-child",stepId:"s",callId:"c",toolName:"todo_write",result:{status:"approval_required",approval:pending}}} as unknown as AgentEventEnvelope]);
 expect(controller.getProjection().pendingApproval).toBeTruthy();controller.observe!([{sessionId:"child",turnId:"turn-child",seq:84,timestamp:new Date().toISOString(),event:{type:"turn_started",turnId:"turn-child",stepCount:1}}]);expect(controller.getProjection().pendingApproval).toBeUndefined();
});


it("父结构化等待标签与子审批门独立，未带事实的父仍保持执行文案", async function waitLabels() {
 const { resolveCliActivityView, createInitialCliActivityState } = await import("../../../src/activity-animation.js");
 const controller=createCliController({sessionId:"parent",renderer:createPlainRenderer("text")});
 const activity=createInitialCliActivityState(0);
 /** 只有受信Runtime安全事实进入标签，不读取子Store或自然语言。 */
 function label(fact?: {phase:"waiting"|"processing";pending:number;running:number;approvals:number}) {return resolveCliActivityView({activity,status:"running",now:1,threadWait:fact})?.label;}
 const { TuiStatusLine }=await import("../../../src/tui/status-line.js");const { createCliTuiStore }=await import("../../../src/tui/store.js");
 const snapshot={...createCliTuiStore().getSnapshot(),status:"running" as const,threadWait:{phase:"waiting" as const,pending:1,running:0,approvals:1}};
 const bottom=render(createElement(TuiStatusLine,{snapshot,useColor:false,screenReader:false}));
 try {expect(bottom.lastFrame()).toContain("等待关联审批 · 1项待处理 · Ctrl+A处理");expect(bottom.lastFrame()).not.toContain("Working");bottom.rerender(createElement(TuiStatusLine,{snapshot,statusView:{model:"test",effort:"medium",permissionMode:"ask",source:"runtime_default"},useColor:false,screenReader:false}));await frame();expect(bottom.lastFrame()).toContain("等待关联审批");bottom.rerender(createElement(TuiStatusLine,{snapshot:{...snapshot,threadWait:undefined},useColor:false,screenReader:false}));await frame();expect(bottom.lastFrame()).toContain("Working");}finally{bottom.unmount();}
 expect(label()).not.toContain("关联");expect(label({phase:"waiting",pending:2,running:1,approvals:0})).toBe("等待关联任务 · 1项运行中");expect(label({phase:"waiting",pending:2,running:0,approvals:1})).toBe("等待关联审批 · 1项待处理 · Ctrl+A处理");expect(label({phase:"waiting",pending:2,running:0,approvals:0})).toContain("2项未完成");expect(label({phase:"processing",pending:0,running:0,approvals:0})).toBe("正在处理关联结果");
 controller.observe!([{sessionId:"parent",turnId:"p",seq:1,timestamp:new Date().toISOString(),event:{type:"thread_wait",turnId:"p",phase:"waiting",pending:1,running:0,approvals:1}} as unknown as AgentEventEnvelope]);expect(controller.getProjection().threadWait).toBeTruthy();controller.observe!([{sessionId:"parent",turnId:"next",seq:1,timestamp:new Date().toISOString(),event:{type:"turn_started",turnId:"next",stepCount:0}}]);expect(controller.getProjection().threadWait).toBeUndefined();
});
