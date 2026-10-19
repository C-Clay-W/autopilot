/**
 * runtime/contract-test/project-store.contract.test.ts — ProjectStore 契约测试
 *
 * 验证 ProjectStore 的 list / create / delete 在 Memory Adapter 下通过。
 */

import { describe, it, expect } from "vitest";
import { MemoryProjectStore } from "../adapters/memory/memory-project-store";
import type { SessionRunConfig } from "../domain";

describe("ProjectStore contract test (Memory Adapter)", function projectStoreContractSuite() {
  it("create 创建 Project 并返回完整字段", async function createProject() {
    const store = new MemoryProjectStore();
    const defaultRunConfig: SessionRunConfig = { permissionMode: "auto_approve", maxSteps: 8 };

    const project = await store.create({
      name: "测试项目",
      workspaceRoot: "/tmp/test",
      description: "测试用",
      defaultRunConfig,
    });

    expect(project.id).toBeDefined();
    expect(project.name).toBe("测试项目");
    expect(project.workspaceRoot).toBe("/tmp/test");
    expect(project.defaultRunConfig).toEqual(defaultRunConfig);
    expect(project.schemaVersion).toBe(1);
    expect(project.createdAt).toBe(project.updatedAt);
  });

  it("get 读取已创建的 Project", async function getProject() {
    const store = new MemoryProjectStore();
    const created = await store.create({ name: "项目A" });

    const fetched = await store.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("项目A");
  });

  it("get 不存在的 ID 返回 null", async function getMissing() {
    const store = new MemoryProjectStore();
    const fetched = await store.get("nonexistent");
    expect(fetched).toBeNull();
  });

  it("list 返回全部 Project", async function listProjects() {
    const store = new MemoryProjectStore();
    await store.create({ name: "项目A" });
    await store.create({ name: "项目B" });

    const list = await store.list();
    expect(list.length).toBe(2);
    expect(list.map((p) => p.name).sort()).toEqual(["项目A", "项目B"]);
  });

  it("save 更新已存在的 Project", async function saveProject() {
    const store = new MemoryProjectStore();
    const created = await store.create({ name: "原名" });

    created.name = "新名";
    created.updatedAt = Date.now();
    await store.save(created);

    const fetched = await store.get(created.id);
    expect(fetched!.name).toBe("新名");
  });

  it("delete 删除 Project 并返回 true", async function deleteProject() {
    const store = new MemoryProjectStore();
    const created = await store.create({ name: "待删除" });

    const result = await store.delete(created.id);
    expect(result).toBe(true);

    const fetched = await store.get(created.id);
    expect(fetched).toBeNull();
  });

  it("delete 不存在的 ID 返回 false", async function deleteMissing() {
    const store = new MemoryProjectStore();
    const result = await store.delete("nonexistent");
    expect(result).toBe(false);
  });
});
