/** r008结构化等待只在真实观察阶段/计数变化时发布；不读取私有checkpoint。 */
import { expect, it } from "vitest";
import { createAgentRuntime } from "../../../src/internal/agent-runtime";
import { createAgentTextMessage } from "../../../src/internal/types/agent-message";
import { sanitizeEventForExternal } from "../../../src/runtime/protocol/sanitize-checkpoint";
import type { AgentThreadsCapability } from "../../../src/runtime/application/thread-tool-binding";

it("真实观察等待审批→运行→处理结果，timeout不重复发布或采样，出口严格白名单", async function structuredWait() {
 let waits=0;let samples=0;
 const threads={ wait:async function wait(){waits++;const status=waits===1?"waiting_approval":waits<4?"running":"completed";return {results:[{threadId:"child",taskId:"task",cursor:String(waits),reason:waits===1?"attention":waits===2?"timeout":waits===3?"changed":"terminal",pendingProgress:0,summary:{turnId:"child-turn",turnStatus:status}}],timedOut:waits===2};} } as unknown as AgentThreadsCapability;
 const runtime=createAgentRuntime({threads,modelSampler:{async sample(){samples++;return samples===1?{content:"",toolCalls:[{id:"w",name:"wait_threads",input:{targets:[{threadId:"child",taskId:"task"}],timeoutMs:30000}}],reasoningSummary:"等待"}:{content:waits<4?"阶段说明":"完成",toolCalls:[],reasoningSummary:"汇报"};}}});
 const events=[];for await(const event of runtime.run({messages:[createAgentTextMessage("user","等待原任务")]}))events.push(event);
 const facts=events.filter(function fact(event){return event.type==="thread_wait";});expect(facts.map(function fact(event){return event.type==="thread_wait"?[event.phase,event.pending,event.running,event.approvals]:[];})).toEqual([["waiting",1,0,1],["processing",1,1,0],["waiting",1,1,0],["processing",0,0,0]]);expect(samples).toBe(4);expect(waits).toBe(4);expect(events.at(-1)?.type).toBe("turn_completed");
 const safe=sanitizeEventForExternal({...facts[0],targetIds:["private"],rawInput:"secret"} as never);expect(Object.keys(safe).sort()).toEqual(["approvals","pending","phase","running","turnId","type"]);expect(sanitizeEventForExternal({type:"thread_wait",turnId:"p",phase:"waiting",pending:1,running:2,approvals:0})).toMatchObject({phase:"none",pending:0});
});
