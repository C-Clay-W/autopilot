/** r004共享目录契约：轻量Store不支持时显式失败，内存分页与末尾游标可复用。 */
import { expect, it, vi } from "vitest";
import { createSessionService } from "../../../src/runtime/application/session-service";
import { createMemoryPorts } from "../../../src/runtime/adapters/memory";

it("Service只转发轻量分页且旧Store不会退回全量list", async function noHeavyFallback() {
  const ports = createMemoryPorts();
  await ports.sessionStore.save({ id: "a", title: "标题", productMode: "work", projectId: "p", createdAt: 1, updatedAt: 1, status: "idle" } as never);
  const list = vi.spyOn(ports.sessionStore, "list"); const get = vi.spyOn(ports.sessionStore, "get");
  const service = createSessionService(ports);
  expect(await service.listDirectoryPage({ projectId: "p", limit: 1 })).toEqual({ items: [{ id: "a", title: "标题" }] }); expect(list).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  ports.sessionStore.listDirectoryPage = undefined;
  await expect(service.listDirectoryPage({ projectId: "p", limit: 1 })).rejects.toThrow("当前存储不支持轻量会话目录"); expect(list).not.toHaveBeenCalled();
});

it("Memory末尾游标支持空页后增量追加而不重放旧事件", async function memoryTail() {
  const ports = createMemoryPorts(); const store = ports.transcriptStore;
  const item = { sessionId: "s", turnId: "t", seq: 1 } as never;
  const first = await store.readPage("s", { limit: 1 }); expect(first.cursor).toBeTruthy();
  await store.append("s", item); const second = await store.readPage("s", { limit: 1, cursor: first.cursor }); expect(second.items).toEqual([item]);
  expect((await store.readPage("s", { limit: 1, cursor: second.cursor })).items).toEqual([]);
});
