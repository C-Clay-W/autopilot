/** Chat 新管理调用的 manifest 错误边界：完全模拟文件端口，不创建或读取真实目录。 */
import { expect, it, vi } from "vitest";
import { readFile, lstat } from "node:fs/promises";
import { createKnowledgeResourceStore } from "../../internal/knowledge-resource-store";

/** 使用纯内存文件端口验证损坏、缺失与链接，不操作磁盘。 */
vi.mock("node:fs/promises", function memoryFilesystem() { return { readFile: vi.fn(), lstat: vi.fn(), mkdir: vi.fn(), readdir: vi.fn(), rename: vi.fn(), rm: vi.fn(), writeFile: vi.fn() }; });

it("损坏或链接 manifest 不能隐藏为空库，只有文件确实缺失才返回 undefined", async function rejectsCorruptManifest() {
  const store = createKnowledgeResourceStore("/fixture-unused");
  const id = `resource_${"a".repeat(32)}`;
  vi.mocked(lstat).mockResolvedValue({ isFile: function regular() { return true; } } as Awaited<ReturnType<typeof lstat>>);
  vi.mocked(readFile).mockResolvedValueOnce("{");
  await expect(store.get(id)).rejects.toMatchObject({ code: "RAG_STORAGE_INVALID" });
  vi.mocked(readFile).mockResolvedValueOnce('{"resourceId":"forged"}');
  await expect(store.get(id)).rejects.toMatchObject({ code: "RAG_STORAGE_INVALID" });
  vi.mocked(lstat).mockResolvedValueOnce({ isFile: function link() { return false; } } as Awaited<ReturnType<typeof lstat>>);
  await expect(store.get(id)).rejects.toMatchObject({ code: "RAG_STORAGE_INVALID" });
  vi.mocked(lstat).mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
  expect(await store.get(id)).toBeUndefined();
});
