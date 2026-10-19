/**
 * file-mutation.ts — 文件工具产生的可撤销副作用的私有 durable 领域模型。
 *
 * 正文只保存在 Adapter 的 content-addressed blob，不允许进入 checkpoint、事件或宿主 DTO。
 */

/** 文件变更的有限操作集合；undo 记录只用于审计，不会被再次自动选择。 */
export type FileMutationOperation = "create" | "edit" | "overwrite" | "undo";

/** 写前日志与真实文件替换之间的有限状态。 */
export type FileMutationStatus = "prepared" | "applied" | "failed";

/** 单次 canonical 文件工具产生的 durable 变更记录。 */
export interface FileMutation {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  path: string;
  operation: FileMutationOperation;
  beforeSha: string | null;
  afterSha: string | null;
  beforeRef?: string;
  afterRef?: string;
  status: FileMutationStatus;
  /** 超过受控 blob 配额时仍保留审计记录，但明确不可撤销。 */
  reversible: boolean;
  nonReversibleReason?: "BINARY_FILE" | "FILE_SIZE_LIMIT" | "SESSION_SIZE_LIMIT";
  createdAt: number;
  failedReason?: string;
  undoOf?: string;
  /** 已成功生成 undo mutation 的原始记录不可再被选择，防止重复覆盖。 */
  undoneBy?: string;
}

/** FileMutationStore.prepare 的内部输入；所有 path 均已由 canonical 文件工具验证。 */
export interface PrepareFileMutationInput {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  path: string;
  operation: FileMutationOperation;
  before: Buffer | null;
  after: Buffer | null;
  createdAt: number;
}

/** Undo 多文件提交的 durable journal；文件正文始终只在私有 blob 或同目录 staging 中存在。 */
export interface UndoTransaction {
  id: string;
  sessionId: string;
  turnId: string;
  workspaceRoot: string;
  status: "prepared" | "applying" | "compensating" | "completed" | "failed";
  files: Array<{
    mutationId: string;
    path: string;
    status: "prepared" | "isolated" | "applied" | "compensated" | "failed" | "conflict";
    stagingName?: string;
    isolationName?: string;
    errorCode?: "UNDO_CONFLICT" | "UNDO_IO_FAILED";
  }>;
  createdAt: number;
  updatedAt: number;
}
