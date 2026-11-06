/**
 * web-thread-capability.ts — Web Work 协作能力范围
 *
 * 只由受信宿主装配：授权工具目录、合法模型目录与不透明状态根身份。
 * 浏览器请求、模型输出和普通 RunConfig override 都不能构造或改写本模块的产物。
 */

import { createNodeStateRootId, LOCAL_HUMAN_PRINCIPAL_ID } from "@autopilot-agent/adapters";
import type { ModelRef } from "@autopilot-agent/core";

/** 宿主本地人类身份：与 CLI 共用同一本机约定，由 Adapters 统一定义。 */
export const WEB_THREAD_PRINCIPAL_ID = LOCAL_HUMAN_PRINCIPAL_ID;

/**
 * 子会话可用的工具目录：协作工具用于回报，Work 常用工具用于真正执行任务。
 * 这份清单会随组记录冻结，并在协作面板中向用户展示。
 */
export const WEB_THREAD_ALLOWED_TOOLS: readonly string[] = [
  "create_thread",
  "list_threads",
  "read_thread",
  "send_thread",
  "wait_threads",
  "read_shared_state",
  "update_shared_state",
  "report_progress",
  "read_progress",
  "interrupt_thread",
  "resume_thread",
  "read_file",
  "glob_files",
  "grep_files",
  "edit_file",
  "write_file",
  "run_command",
  "todo_write",
];

/** 状态根的不透明稳定身份：与 CLI 共用同一派生方式，只暴露摘要，不写入宿主绝对路径。 */
export const createWebStateRootId = createNodeStateRootId;

/** 从受信 settings 的 Provider route 目录构造合法模型目录；跳过非法项，不由请求追加。 */
export function createWebThreadModelCatalog(settings: {
  modelRef?: ModelRef;
  providerRoutes?: Readonly<Record<string, { models?: ReadonlyArray<{ id?: unknown }> }>>;
}): ModelRef[] {
  const catalog: ModelRef[] = [];
  const seen = new Set<string>();

  /** 去重后加入目录；provider 与 modelId 都必须是非空字符串。 */
  function push(reference: ModelRef | undefined): void {
    if (!reference || typeof reference.provider !== "string" || typeof reference.modelId !== "string") return;
    if (!reference.provider || !reference.modelId) return;
    const key = `${reference.provider}/${reference.modelId}`;
    if (seen.has(key)) return;
    seen.add(key);
    catalog.push({ provider: reference.provider, modelId: reference.modelId });
  }

  push(settings.modelRef);
  for (const [provider, route] of Object.entries(settings.providerRoutes ?? {})) {
    for (const model of route.models ?? []) {
      if (typeof model.id === "string") push({ provider, modelId: model.id });
    }
  }
  return catalog;
}
