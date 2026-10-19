/**
 * 共享类型定义
 */

/** Excel 解析选项 */
export interface ParseExcelOptions {
  /** 工作表名称（不传则默认取第一个工作表） */
  sheetName?: string;
  /** 表头所在行（0-based，默认第 1 行即 index 0） */
  headerRow?: number;
  /** 数据起始行（0-based，默认 headerRow + 1） */
  dataStartRow?: number;
  /** 是否跳过完全空行 */
  skipEmptyRows?: boolean;
}

/** LLM 对话消息 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** LLM 调用选项 */
export interface LLMOptions {
  /**
   * 实际请求的模型 ID；缺省时由各函数用环境变量模型兜底。
   * Talk-Plan0805 起由 ModelRef.modelId 注入，支持真实模型切换。
   */
  model?: string;
  /** 温度（0-2，默认 0.3，数据分析场景倾向低温度以保证准确性） */
  temperature?: number;
  /** nucleus sampling 阈值；与 temperature 同时设置时由 Provider policy 决定取舍。 */
  topP?: number;
  /** 最大输出 token 数。 */
  maxTokens?: number;
  /**
   * Provider 思考模式开关。
   * - "enabled": 强制开启思考
   * - "disabled": 禁用思考
   * - "auto": 由 Provider 自行决定是否思考
   */
  thinking?: "enabled" | "disabled" | "auto";
  /**
   * firstParty Messages 的 output_config.effort；none 时不发送该字段。
   */
  reasoningEffort?: "low" | "medium" | "high" | "max";
  /** 调用取消信号；Agent Runtime 通过它终止正在进行的模型请求。 */
  signal?: AbortSignal;
}

/** 模型完成组装后的原生工具调用。 */
export interface AgentToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * 已由 Provider resolver 解析后的采样选项。
 * ModelRef 与 ReasoningProfile 在应用层解析为这些协议层值，
 * Kernel 只负责透传，不在 Kernel 内猜测 Provider 或改写强度。
 * - model：实际请求的模型 ID（来自 ModelRef.modelId，缺省由 sampler 用环境变量兜底）
 * - thinking：Provider 思考开关（enabled/disabled/auto）
 * - reasoningEffort：协议层推理强度（none 时省略该字段）
 */
export interface ModelSampleOptions {
  /** 仅结构化收尾使用：强制提交指定工具，Adapter 在该次请求关闭思考并保留其余冻结配置。 */
  toolChoice?: { name: string };
  model?: string;
  thinking?: "enabled" | "disabled" | "auto";
  reasoningEffort?: "low" | "medium" | "high" | "max";
  /** 仅非思考模式使用的采样温度。 */
  temperature?: number;
  /** 仅非思考模式使用的 nucleus sampling 阈值。 */
  topP?: number;
  /** Provider 允许的单次输出上限。 */
  maxTokens?: number;
}

/** LLM 调用返回 */
export interface LLMResponse {
  answer: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export {
  CanonicalMessageError,
  isAgentToolPairingBalancedAt,
  isAgentToolPairingBalancedBefore,
  normalizeAgentMessages,
  scanAgentToolPairing,
  validateAgentMessages,
} from "./agent-message";
export type {
  AgentContentBlock,
  AgentJsonObject,
  AgentMessage,
  AgentMessageRole,
  AgentToolPairingScan,
} from "./agent-message";

/** 文档来源类型 */
export type DocumentSource = "pdf" | "excel" | "image" | "text";

/** 入库文档 */
export interface Document {
  id: string;
  source: DocumentSource;
  fileName: string;
  filePath: string;
  thumbnailPath?: string;
  createdAt: Date;
}

/** 入库结果 */
export interface IngestResult {
  documentId: string;
  chunkCount: number;
  success: boolean;
  error?: string;
}

/** 搜索结果项 */
export interface SearchResult {
  documentId: string;
  fileName: string;
  chunkText: string;
  score: number;
  thumbnailUrl?: string;
}

/** 问答请求 */
export interface AskRequest {
  question: string;
  history?: { role: "user" | "assistant"; content: string }[];
}

/** 问答响应 */
export interface AskResponse {
  answer: string;
  sources: SearchResult[];
}

// ── 向量数据库相关 ────────────────────────────────────

/**
 * 向量入库参数（外部调用格式，metadata 为原始对象）
 */
export interface VectorInput {
  id: string;
  vector: number[];
  text: string;
  /** 结构化元数据（会序列化为 JSON 存入 metadata 列） */
  metadata?: Record<string, unknown>;
  /**
   * @deprecated 额外标量字段已弃用，不再展开为独立列。
   * 所有行数据统一存入 metadata JSON，通过 JSON path 查询过滤。
   */
  fields?: Record<string, unknown>;
}

/** 向量记录内部存储格式（metadata 已序列化为 JSON 字符串，fields 为标量列） */
export interface VectorRecord {
  id: string;
  vector: number[];
  text: string;
  metadata: string;
  /** 额外标量字段，允许任意 key，直接存入对应列 */
  [key: string]: unknown;
}

/**
 * 混合检索过滤条件
 *
 * 支持两种模式：
 * 1. 普通列过滤 — field 直接匹配表列名
 * 2. JSON path 过滤 — field 以 `metadata.` 开头时，对 metadata JSON 列做路径查询
 *    例：{ field: "metadata.部门", op: "=", value: "技术部" }
 *
 * 支持的操作符：
 * - "="、"!="、">"、">="、"<"、"<=" — 标量比较
 * - "in" — 值在列表中
 * - "like" — 模糊匹配
 *
 * 多个条件之间为 AND 关系。
 */
export interface SearchFilter {
  /** 字段名（对应入库时 fields 中的 key） */
  field: string;
  /** 操作符 */
  op: "=" | "!=" | ">" | ">=" | "<" | "<=" | "in" | "like";
  /** 比较值 */
  value: unknown;
}

/** 向量搜索结果（外部调用格式） */
export interface VectorOutput {
  id: string;
  score: number;
  text: string;
  metadata: Record<string, unknown>;
}
