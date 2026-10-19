/**
 * runtime/domain/project.ts — Project 实体
 *
 * Phase 3 将 Project 升级为一等实体：扩展默认模型、推理强度、凭据引用等字段。
 * Project 作为路由维度（参考 Claude Code 的 getProjectDir / getSessionProjectDir），
 * Session 与 Turn 可按 projectId 分目录持久化。
 */

import type { SessionRunConfig } from "./session-run-config";

/**
 * Project 实体；defaultRunConfig 提供 Session 与 Turn 的最低优先级默认值。
 * - schemaVersion：持久化 schema 版本，未来迁移用
 */
export interface Project {
  id: string;
  name: string;
  workspaceRoot?: string;
  description?: string;
  /** Project 级默认运行配置；优先级最低，可被 Session 默认值或 Turn 覆盖。 */
  defaultRunConfig?: SessionRunConfig;
  createdAt: number;
  updatedAt: number;
  /** 持久化 schema 版本；Phase 3 起为 1。 */
  schemaVersion?: number;
}

/** 创建 Project 的输入；id 与时间戳由 ProjectStore 生成。 */
export interface CreateProjectInput {
  name: string;
  workspaceRoot?: string;
  description?: string;
  defaultRunConfig?: SessionRunConfig;
}
