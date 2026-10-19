/**
 * Node ProjectStore：在显式 stateRoot/projects 下原子保存 Project 元数据。
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { CreateProjectInput, Project, ProjectStore } from "@autopilot-agent/core";
import { atomicReplace, readJsonFile, safeFilePath, withFileLock } from "../file-utils";
import { ensureNodeStateRoot, getNodeStatePaths } from "../state-root";
import type { NodeStoreOptions } from "../types";

/** 创建基于共享状态根的 ProjectStore。 */
export function createNodeProjectStore(options: NodeStoreOptions): ProjectStore {
  const paths = getNodeStatePaths(options.stateRoot);

  /** 确保存储目录存在并校验状态 schema。 */
  function ensureDir(): void {
    const state = ensureNodeStateRoot(paths.root);
    fs.mkdirSync(state.projectsDir, { recursive: true });
  }

  /** 返回指定 Project 的安全文件路径。 */
  function filePath(projectId: string): string {
    return safeFilePath(paths.projectsDir, projectId, ".json");
  }

  return {
    async get(id: string): Promise<Project | null> {
      ensureDir();
      return withFileLock(filePath(id), () => readJsonFile<Project>(filePath(id)));
    },

    async save(project: Project): Promise<void> {
      ensureDir();
      await withFileLock(filePath(project.id), () => {
        atomicReplace(filePath(project.id), JSON.stringify(project, null, 2));
      });
    },

    async list(): Promise<Project[]> {
      ensureDir();
      const projects: Project[] = [];
      for (const file of fs.readdirSync(paths.projectsDir).filter((entry) => entry.endsWith(".json"))) {
        const project = readJsonFile<Project>(filePath(file.slice(0, -5)));
        if (project) projects.push(project);
      }
      return projects;
    },

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
      await this.save(project);
      return project;
    },

    async delete(id: string): Promise<boolean> {
      ensureDir();
      const target = filePath(id);
      return withFileLock(target, () => {
        if (!fs.existsSync(target)) return false;
        fs.unlinkSync(target);
        return true;
      });
    },
  };
}
