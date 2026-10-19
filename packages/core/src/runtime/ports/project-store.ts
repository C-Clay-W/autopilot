/**
 * runtime/ports/project-store.ts — Project 持久化接口
 *
 * Phase 3 扩展：新增 list / create / delete 方法，支持 Project 作为一等实体。
 * Project 作为路由维度（参考 Claude Code 的 getProjectDir / getSessionProjectDir），
 * Session 与 Turn 可按 projectId 分目录持久化（Node Adapter 可选实现）。
 */

import type { Project, CreateProjectInput } from "../domain";

/** Project 存储端口。 */
export interface ProjectStore {
  /** 根据 ID 读取 Project；不存在时返回 null。 */
  get(id: string): Promise<Project | null>;

  /** 保存或更新 Project。 */
  save(project: Project): Promise<void>;

  /** 列出全部 Project；可选按 projectId 过滤（Node Adapter 可按目录分片）。 */
  list(projectId?: string): Promise<Project[]>;

  /** 创建新 Project；id 与时间戳由 Store 生成。 */
  create(input: CreateProjectInput): Promise<Project>;

  /** 删除指定 Project；不存在时返回 false。 */
  delete(id: string): Promise<boolean>;
}
