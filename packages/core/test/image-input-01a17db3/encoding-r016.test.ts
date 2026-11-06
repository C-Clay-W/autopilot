/** 验证发送副本精确字节、Base64 临界值与 RAG 输出体积上限。 */
import { randomBytes } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { normalizeWorkImage } from '../../src/internal/lib/image-normalization';
import { normalizeKnowledgeImage } from '../../src/internal/lib/pdf-processor';
/** 按字节比较大缓冲区；逐元素深比较在 3.9 MB 数据上会多耗十几秒。 */
function sameBytes(actual: Uint8Array, expected: Uint8Array) { return Buffer.compare(Buffer.from(actual), Buffer.from(expected)) === 0; }
describe('编码边界', function suite(){
  it('3,932,160 字节原样保留，超一字节先处理', async function boundary(){
    const png=createCanvas(2,2).toBuffer('image/png'); const compliant=Buffer.concat([png,Buffer.alloc(3_932_160-png.length)]); const result=await normalizeWorkImage({bytes:compliant,mimeType:'image/png'});
    expect(sameBytes(result.bytes, compliant)).toBe(true); expect(Buffer.from(result.bytes).toString('base64')).toHaveLength(5_242_880);
    const oversized=Buffer.concat([compliant,Buffer.alloc(1)]); const normalized=await normalizeWorkImage({bytes:oversized,mimeType:'image/png'});
    expect(normalized.bytes.byteLength).toBeLessThanOrEqual(3_932_160); expect(Buffer.from(normalized.bytes).toString('base64').length).toBeLessThanOrEqual(5_242_880);
  });
  it('RAG 输出超过 5 MiB 时按无效输入拒绝', async function ragVolume(){
    const canvas=createCanvas(2048,2048); const context=canvas.getContext('2d'); const pixels=context.createImageData(2048,2048);
    pixels.data.set(randomBytes(pixels.data.length));
    context.putImageData(pixels,0,0);
    const noisy=canvas.toBuffer('image/png');
    expect(noisy.length).toBeGreaterThan(5*1024*1024);
    await expect(normalizeKnowledgeImage(noisy)).rejects.toMatchObject({ code: 'RAG_INVALID_INPUT' });
  });
});
