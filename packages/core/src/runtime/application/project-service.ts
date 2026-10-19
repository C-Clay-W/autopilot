/**
 * runtime/application/project-service.ts — Project 用例编排
 *
 * 封装 Project 的 CRUD 操作，不实现业务规则，只编排 ProjectStore。
 * Phase 3 引入；为未来 P0 阶段的 Web Project 管理页面提供共享入口。
 */

import type { ProjectStore } from "../ports";
import type { Project, CreateProjectInput } from "../domain";
import { AgentRuntimeError as RuntimeError } from "../protocol";

/** ProjectService 接口。 */
export interface ProjectService {
  /** 创建新 Project。 */
  create(input: CreateProjectInput): Promise<Project>;

  /** 根据 ID 读取 Project。 */
  get(id: string): Promise<Project | null>;

  /** 列出全部 Project。 */
  list(): Promise<Project[]>;

  /** 保存或更新 Project。 */
  save(project: Project): Promise<void>;

  /** 删除指定 Project。 */
  delete(id: string): Promise<boolean>;
}

/** 创建 ProjectService 实例。 */
export function createProjectService(projectStore: ProjectStore): ProjectService {
  return {
    create,
    get,
    list,
    save,
    delete: deleteProject,
  };

  async function create(input: CreateProjectInput): Promise<Project> {
    return projectStore.create(input);
  }

  async function get(id: string): Promise<Project | null> {
    const project = await projectStore.get(id);
    if (!project) {
      throw new RuntimeError("PROJECT_NOT_FOUND", `Project ${id} 不存在`);
    }
    return project;
  }

  async function list(): Promise<Project[]> {
    return projectStore.list();
  }

  async function save(project: Project): Promise<void> {
    await projectStore.save(project);
  }

  async function deleteProject(id: string): Promise<boolean> {
    return projectStore.delete(id);
  }
}
