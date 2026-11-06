/** 验证 steer/queue 在受控 inbox 中保留并校验图片身份。 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryInputInbox } from '../../src/runtime/adapters/memory/memory-input-inbox';
import { createAgentInputInboxCapability } from '../../src/runtime/application/input-inbox-service';
const id='00000000-0000-4000-8000-000000000001'; const sha256='a'.repeat(64);
const image={id,sha256,width:1,height:1,bytes:3,name:'a.png',mimeType:'image/png',relativePath:'safe'};
describe('图片 inbox', function suite(){
  it('steer 与 queue 在各自边界保留引用并只消费一次', async function drains(){
    const inbox = new MemoryInputInbox(); const store={put:vi.fn(),read:vi.fn(async function read(){return {image,bytes:Buffer.from('abc')};})};
    await inbox.post({sessionId:'s',turnId:'t',delivery:'steer',content:'引导',attachments:[image]}); await inbox.post({sessionId:'s',delivery:'queue',content:'排队',attachments:[image]});
    const capability=createAgentInputInboxCapability(inbox,'s','t',store);
    const first=await capability.drain({maxDelivery:'steer',boundary:'before_sample'}); expect(first).toHaveLength(1); expect(first[0].images).toEqual([{type:'image-ref',id,sha256,width:1,height:1}]);
    const next=await capability.drain({maxDelivery:'queue',boundary:'before_complete'}); expect(next).toHaveLength(1); expect(next[0].images).toEqual(first[0].images);
    expect(await capability.drain({maxDelivery:'queue',boundary:'before_complete'})).toEqual([]);
  });
  it('图片身份改变时不交给 Kernel', async function mismatch(){
    const inbox=new MemoryInputInbox(); await inbox.post({sessionId:'s',turnId:'t',delivery:'steer',content:'引导',attachments:[image]});
    const store={put:vi.fn(),read:vi.fn(async function read(){return {image:{...image,sha256:'b'.repeat(64)},bytes:Buffer.from('abc')};})};
    await expect(createAgentInputInboxCapability(inbox,'s','t',store).drain({maxDelivery:'steer',boundary:'before_sample'})).rejects.toThrow('校验失败');
  });
});
