/**
 * 内存 ProjectStore 适配器
 *
 * 用于 contract test 与 headless smoke，不依赖真实文件系统。
 * Phase 3 扩展 list / create / delete 方法。
 */

import { randomUUID } from "node:crypto";
import type { Project, CreateProjectInput } from "../../domain";
import type { ProjectStore } from "../../ports";

export class MemoryProjectStore implements ProjectStore {
  private projects = new Map<string, Project>();

  async get(id: string): Promise<Project | null> {
    return this.projects.get(id) ?? null;
  }

  async save(project: Project): Promise<void> {
    this.projects.set(project.id, project);
  }

  async list(_projectId?: string): Promise<Project[]> {
    return Array.from(this.projects.values());
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const now = Date.now();
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      workspaceRoot: input.workspaceRoot,
      description: input.description,
      defaultRunConfig: input.defaultRunConfig,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };
    this.projects.set(project.id, project);
    return project;
  }

  async delete(id: string): Promise<boolean> {
    return this.projects.delete(id);
  }
}
