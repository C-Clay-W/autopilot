/**
 * 工具注册表：以单一来源维护工具名称、运行时 Schema 与模型可见定义。
 */
import { isToolWithinCeiling, type CapabilityCeiling } from "../../runtime/domain/product-mode";
import { z } from "zod";
import { createToolError, TOOL_ERROR_CODES } from "./tool-error";
import type { AgentToolDefinition, ToolMetadata, ToolModelDefinition } from "./types";

const toolNamePattern = /^[a-zA-Z0-9_-]{1,64}$/;

/** 校验每个工具都给出完整且保守的调度声明，拒绝可能放宽副作用边界的组合。 */
function assertValidMetadata(metadata: ToolMetadata): void {
  if (!(["none", "workspace", "external", "dynamic"] as const).includes(metadata.effect)) {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "工具 metadata.effect 不合法");
  }
  if (typeof metadata.destructive !== "boolean") {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "工具 metadata.destructive 必须为布尔值");
  }
  if (metadata.effect === "none" && metadata.destructive) {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "无副作用工具不能声明 destructive");
  }
  if (!Number.isSafeInteger(metadata.concurrency?.max) || metadata.concurrency.max < 1) {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "工具 metadata.concurrency.max 必须为正整数");
  }
  const resourceKey = metadata.concurrency.resourceKey;
  if (resourceKey !== undefined && typeof resourceKey !== "string" && typeof resourceKey !== "function") {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "工具 metadata.concurrency.resourceKey 不合法");
  }
  if (typeof resourceKey === "string" && !resourceKey.trim()) {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "工具 metadata.concurrency.resourceKey 不能为空");
  }
  if (typeof metadata.retry?.safe !== "boolean") {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "工具 metadata.retry.safe 必须为布尔值");
  }
  if (metadata.retry.maxRetries !== undefined && (!Number.isSafeInteger(metadata.retry.maxRetries) || metadata.retry.maxRetries < 0)) {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "工具 metadata.retry.maxRetries 必须为非负整数");
  }
  if (!metadata.retry.safe && metadata.retry.maxRetries !== undefined) {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "不可重试工具不能声明 maxRetries");
  }
  if (metadata.retry.safe && (metadata.effect !== "none" || metadata.destructive)) {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "只有非破坏性的无副作用工具可以声明安全重试");
  }
  if (metadata.timeout?.defaultMs !== undefined && (!Number.isSafeInteger(metadata.timeout.defaultMs) || metadata.timeout.defaultMs < 1)) {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "工具 metadata.timeout.defaultMs 必须为正整数");
  }
  if (metadata.timeout?.maxMs !== undefined && (!Number.isSafeInteger(metadata.timeout.maxMs) || metadata.timeout.maxMs < 1)) {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "工具 metadata.timeout.maxMs 必须为正整数");
  }
  if (metadata.timeout?.defaultMs !== undefined && metadata.timeout.maxMs !== undefined && metadata.timeout.defaultMs > metadata.timeout.maxMs) {
    throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "工具 metadata.timeout.defaultMs 不能超过 maxMs");
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition<unknown, unknown>>();

  /** 复制产品上限，调用方后续修改原列表不能放宽 Registry。 */
  constructor(private readonly ceiling?: CapabilityCeiling) {
    this.ceiling = ceiling ? structuredClone(ceiling) : undefined;
  }

  /** 注册一个工具并拒绝名称不合规或重复注册，避免模型定义与执行器漂移。 */
  register<TInput, TOutput>(definition: AgentToolDefinition<TInput, TOutput>): void {
    if (!isToolWithinCeiling(this.ceiling, definition.name)) return;
    if (!toolNamePattern.test(definition.name)) {
      throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, `工具名不合法: ${definition.name}`);
    }
    if (this.tools.has(definition.name)) {
      throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, `工具名重复: ${definition.name}`);
    }
    assertValidMetadata(definition.metadata);
    if (typeof definition.createActionFacts !== "function") {
      throw createToolError(TOOL_ERROR_CODES.INVALID_INPUT, "工具必须提供本地 createActionFacts");
    }
    this.tools.set(definition.name, definition as AgentToolDefinition<unknown, unknown>);
  }

  /** 移除 Runtime 临时注册的 capability 工具；只由受控生命周期在 shutdown 后调用。 */
  unregister(toolName: string): void {
    this.tools.delete(toolName);
  }

  /** 按名称读取已注册工具；未知名称返回稳定错误。 */
  get(toolName: string): AgentToolDefinition<unknown, unknown> {
    const definition = this.tools.get(toolName);
    if (!definition) {
      throw createToolError(TOOL_ERROR_CODES.TOOL_NOT_FOUND, `未知工具: ${toolName}`);
    }
    return definition;
  }

  /** 输出仅供模型消费的定义，不暴露 handler、权限和执行实现。 */
  getModelDefinitions(): ToolModelDefinition[] {
    /** 过滤尚无合法输入引用的工具，再投影模型可见定义。 */
    return [...this.tools.values()].filter(function available(definition) { return definition.isAvailable?.() !== false; }).map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: z.toJSONSchema(definition.inputSchema, { target: "draft-2020-12" }) as Record<string, unknown>,
    }));
  }
}
