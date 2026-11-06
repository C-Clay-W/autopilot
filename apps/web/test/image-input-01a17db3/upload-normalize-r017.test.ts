/** 验证 Work 上传的大图先规范化再落盘，不再按原图 3.75 MiB 直接拒绝。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteSessionImages, readSessionImage, storeSessionImage } from '@/lib/session-attachment-store';
let workspace: string;
const previousRoot = process.env.AGENT_WORKSPACE_ROOT;
beforeAll(function prepareWorkspace() {
  workspace = mkdtempSync(path.join(tmpdir(), 'work-image-r017-'));
  process.env.AGENT_WORKSPACE_ROOT = workspace;
});
afterAll(function cleanupWorkspace() {
  if (previousRoot === undefined) delete process.env.AGENT_WORKSPACE_ROOT;
  else process.env.AGENT_WORKSPACE_ROOT = previousRoot;
  rmSync(workspace, { recursive: true, force: true });
});
describe('Work 大图上传', function suite() {
  it('超过 3.75 MiB 的有效原图规范化后保存，读取校验通过', async function largeImage() {
    const canvas = createCanvas(1600, 1600);
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(1600, 1600);
    pixels.data.set(randomBytes(pixels.data.length));
    context.putImageData(pixels, 0, 0);
    const png = canvas.toBuffer('image/png');
    expect(png.length).toBeGreaterThan(3_932_160);
    const sessionId = randomUUID();
    try {
      const attachment = await storeSessionImage(sessionId, new File([png], 'big.png', { type: 'image/png' }));
      expect(attachment.bytes).toBeLessThanOrEqual(3_932_160);
      expect(attachment.mimeType).toBe('image/jpeg');
      expect(attachment.sha256).toMatch(/^[0-9a-f]{64}$/);
      const read = readSessionImage(sessionId, attachment.id);
      expect(read.content.length).toBe(attachment.bytes);
    } finally { deleteSessionImages(sessionId); }
  });
});
