/** 验证瞬时失败后的图片回退恢复与多图分析次数。 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSampleError } from '../../src/internal/lib/llm';
import { createAgentKernel } from '../../src/internal/kernel/agent-kernel';
import { ToolRegistry } from '../../src/internal/tools/tool-registry';
import { createVisionAnalyzeTool } from '../../src/internal/tools/builtins/vision-analyze-tool';
/** 收集 Kernel 事件。 */
async function collect(kernel: ReturnType<typeof createAgentKernel>){const events:any[]=[];for await(const event of kernel.run())events.push(event);return events;}
afterEach(function reset(){vi.useRealTimers();});
describe('图片重试预算恢复',function suite(){
  it('五次重试后恢复审批，已完成图片不重复分析',async function resumes(){
    vi.useFakeTimers(); const workspaceRoot=mkdtempSync(join(process.cwd(),'../../.agent-tests/work-test/image-input-01a17db3/fixtures/budget-'));
    const bytes=Buffer.from('image'); const sha256=createHash('sha256').update(bytes).digest('hex'); const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
    ids.forEach(function file(id){writeFileSync(join(workspaceRoot,`${id}.png`),bytes);});
    const messages=[{role:'user' as const,content:ids.map(function ref(id){return {type:'image-ref' as const,id,sha256,width:1,height:1};})}];
    const snapshots: any[] = []; const sample=vi.fn(async function take(messages, tools, options) { snapshots.push({ messages: JSON.parse(JSON.stringify(messages)), hasImageData: Boolean(options.imageData && Object.keys(options.imageData).length) }); throw new AgentSampleError('限流','PROVIDER_RATE_LIMIT'); }); const analyze=vi.fn().mockResolvedValue('观察'); const registry=new ToolRegistry(); registry.register(createVisionAnalyzeTool());
    const options={turnId:'turn',sessionId:'session',workspaceRoot,messages,toolRegistry:registry,permissionContext:{mode:'ask' as const,workspaceTrusted:true,validateApproval:vi.fn().mockResolvedValue(true)},modelSampler:{sample},supportsImageInput:true,visionAnalyzer:{analyze},sessionImageStore:{put:vi.fn(),async read({id}:{id:string}){return {image:{id,sha256,width:1,height:1,bytes:bytes.length,name:'a.png',mimeType:'image/png',relativePath:`${id}.png`},bytes};}}};
    const promise=collect(createAgentKernel(options)); await vi.advanceTimersByTimeAsync(60000); const first=await promise;
    expect(sample).toHaveBeenCalledTimes(6); const pause=first.find(function find(e){return e.type==='turn_paused';}); const approval=first.find(function find(e){return e.type==='approval_required';}); expect(pause.checkpoint.imageProviderRecoveryAttempts).toBe(5);
    const second=await collect(createAgentKernel({...options,messages:pause.checkpoint.messages,checkpoint:pause.checkpoint,approval:{approvalId:approval.result.approval.approvalId,decision:'allow_once'}}));
    console.log('DIAG', JSON.stringify({ checkpoint: pause.checkpoint.messages, second: second.map(function project(e) { return { type: e.type, errorCode: e.errorCode, toolName: e.toolName, callId: e.callId }; }), sampleCalls: snapshots }));
    expect(sample).toHaveBeenCalledTimes(6); expect(analyze).toHaveBeenCalledTimes(1);
    const pause2=second.find(function find(e){return e.type==='turn_paused';}); const approval2=second.find(function find(e){return e.type==='approval_required';}); expect(pause2).toBeDefined();
    sample.mockResolvedValue({content:'完成',toolCalls:[],reasoningSummary:'',finishReason:'stop'});
    const third=await collect(createAgentKernel({...options,messages:pause2.checkpoint.messages,checkpoint:pause2.checkpoint,approval:{approvalId:approval2.result.approval.approvalId,decision:'allow_once'}}));
    expect(analyze).toHaveBeenCalledTimes(2); expect(sample).toHaveBeenCalledTimes(7); expect(third.at(-1)).toMatchObject({type:'turn_completed'});
  });
});



