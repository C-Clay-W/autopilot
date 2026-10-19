/**
 * runtime/protocol/frozen-run-config-view.ts — 宿主可展示的冻结运行配置。
 *
 * DTO 仅公开 CLI/Web 状态栏需要的模型、推理和权限配置，不公开凭据、
 * 工作区路径、压缩策略或完整 Turn 实体，避免宿主依赖持久化内部结构。
 */

import type { ModelRef, ReasoningEffort, ReasoningProfile } from "../domain";
import type { ToolPermissionMode } from "../../internal/tools/types";

/** 宿主读取当前 Turn 冻结模型与推理配置的安全视图。 */
export interface FrozenRunConfigView {
  sessionId: string;
  turnId: string;
  modelRef?: Pick<ModelRef, "provider" | "modelId">;
  reasoningProfile?: ReasoningProfile;
  /** Provider resolver 生成的有效 effort；未显式设置时仅展示当前默认值，不代表请求强制发送。 */
  effectiveReasoning?: {
    effort: ReasoningEffort;
    source: "requested";
  };
  permissionMode?: ToolPermissionMode;
  /** 只投影非敏感模式及工具名，不公开 attachment grant 或 Host capability。 */
  capabilityCeiling?: import("../domain/product-mode").CapabilityCeiling;
}
