/** 图片格式、尺寸及原 RAG 上限的受控边界测试。 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { normalizeWorkImage } from '../../src/internal/lib/image-normalization';
import { normalizeKnowledgeImage } from '../../src/internal/lib/pdf-processor';
describe('图片输入边界', function imageBoundaries() {
  it('GIF 转静态 PNG 并提示首帧', async function gif() {
    const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const result = await normalizeWorkImage({ bytes, mimeType: 'image/gif' });
    expect(result).toMatchObject({ mimeType: 'image/png', width: 1, height: 1, gifFirstFrame: true });
    expect((await loadImage(Buffer.from(result.bytes))).width).toBe(1);
  });
  it('长边缩至 2000 且保持比例，小图不放大', async function dimensions() {
    const large = createCanvas(2400, 1200).toBuffer('image/png');
    const result = await normalizeWorkImage({ bytes: large });
    expect(result).toMatchObject({ width: 2000, height: 1000 });
    const small = createCanvas(2, 1).toBuffer('image/png');
    expect(await normalizeWorkImage({ bytes: small })).toMatchObject({ width: 2, height: 1, bytes: small });
  });
  it('实际输入超过 20 MiB 先拒绝', async function tooLarge() {
    const bytes = Buffer.alloc(20 * 1024 * 1024 + 1);
    await expect(normalizeWorkImage({ bytes })).rejects.toThrow('20 MiB');
  });
  it('RAG 保留 2048 长边', async function ragSize() {
    const bytes = createCanvas(2400, 1200).toBuffer('image/png');
    const result = await normalizeKnowledgeImage(bytes);
    const image = await loadImage(result);
    expect([image.width, image.height]).toEqual([2048, 1024]);
  });
});
