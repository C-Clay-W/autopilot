/** 验证隔离工作区中会话图片存储的归属、并发与完整性。 */
import { createCanvas } from '@napi-rs/canvas';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeSessionImageStore } from '../../src/node/stores/node-session-image-store';

const root = join(process.cwd(), '../../.agent-tests/work-test/image-input-01a17db3/fixtures');
const sessionA = '00000000-0000-4000-8000-000000000001';
const sessionB = '00000000-0000-4000-8000-000000000002';

describe('会话图片存储', function imageStore() {
  it('首次并发写入可读取且跨会话拒绝', async function concurrentAndIsolated() {
    const workspace = mkdtempSync(join(root, 'store-'));
    const store = createNodeSessionImageStore(workspace);
    const bytes = createCanvas(4, 4).toBuffer('image/png');
    const images = await Promise.all([1, 2].map(function put(i) { return store.put({ sessionId: sessionA, name: `${i}.png`, mimeType: 'image/png', bytes }); }));
    expect(images[0].id).not.toBe(images[1].id);
    expect(Buffer.from((await store.read({ sessionId: sessionA, id: images[0].id })).bytes)).toEqual(bytes);
    await expect(store.read({ sessionId: sessionB, id: images[0].id })).rejects.toThrow();
  });
  it('副本被替换后拒绝读取', async function rejectsChangedBytes() {
    const workspace = mkdtempSync(join(root, 'store-'));
    const store = createNodeSessionImageStore(workspace);
    const bytes = createCanvas(4, 4).toBuffer('image/png');
    const image = await store.put({ sessionId: sessionA, name: 'a.png', mimeType: 'image/png', bytes });
    const target = join(workspace, image.relativePath);
    const changed = readFileSync(target); changed[changed.length - 1] ^= 1; writeFileSync(target, changed);
    await expect(store.read({ sessionId: sessionA, id: image.id })).rejects.toThrow();
  });
});
