/**
 * 数据库能力统一错误协议：为数据源配置、快照同步、语义检索与只读查询提供稳定且可区分的错误码。
 */

/** 数据库领域边界允许传播的稳定错误码。 */
export const DATABASE_ERROR_CODES = {
  CONFIG_MISSING: "DATABASE_CONFIG_MISSING",
  CONFIG_JSON_INVALID: "DATABASE_CONFIG_JSON_INVALID",
  CONFIG_NOT_ARRAY: "DATABASE_CONFIG_NOT_ARRAY",
  CONFIG_SOURCE_INVALID: "DATABASE_CONFIG_SOURCE_INVALID",
  SOURCE_NAME_INVALID: "DATABASE_SOURCE_NAME_INVALID",
  SOURCE_NOT_FOUND: "DATABASE_SOURCE_NOT_FOUND",
  SOURCE_DEFAULT_UNAVAILABLE: "DATABASE_SOURCE_DEFAULT_UNAVAILABLE",
  SOURCE_AMBIGUOUS: "DATABASE_SOURCE_AMBIGUOUS",
  IDENTIFIER_INVALID: "DATABASE_IDENTIFIER_INVALID",
  SYNC_ACCOUNT_NOT_READ_ONLY: "DATABASE_SYNC_ACCOUNT_NOT_READ_ONLY",
  SNAPSHOT_NOT_FOUND: "DATABASE_SNAPSHOT_NOT_FOUND",
  SNAPSHOT_INVALID: "DATABASE_SNAPSHOT_INVALID",
  SNAPSHOT_FILE_MISSING: "DATABASE_SNAPSHOT_FILE_MISSING",
  QUERY_NOT_READ_ONLY: "DATABASE_QUERY_NOT_READ_ONLY",
  QUERY_SYSTEM_ACCESS_FORBIDDEN: "DATABASE_QUERY_SYSTEM_ACCESS_FORBIDDEN",
  QUERY_TABLE_FORBIDDEN: "DATABASE_QUERY_TABLE_FORBIDDEN",
  QUERY_TIMEOUT: "DATABASE_QUERY_TIMEOUT",
  CONNECTION_AUTHENTICATION_FAILED: "DATABASE_CONNECTION_AUTHENTICATION_FAILED",
  CONNECTION_TIMEOUT: "DATABASE_CONNECTION_TIMEOUT",
  CONNECTION_FAILED: "DATABASE_CONNECTION_FAILED",
  INSPECTION_FAILED: "DATABASE_INSPECTION_FAILED",
  SYNC_FAILED: "DATABASE_SYNC_FAILED",
  SEMANTIC_SEARCH_FAILED: "DATABASE_SEMANTIC_SEARCH_FAILED",
  QUERY_FAILED: "DATABASE_QUERY_FAILED",
  SEARCH_FAILED: "DATABASE_SEARCH_FAILED",
} as const;

/** 数据库统一错误码类型。 */
export type DatabaseErrorCode = (typeof DATABASE_ERROR_CODES)[keyof typeof DATABASE_ERROR_CODES];

const DATABASE_ERROR_CODE_SET = new Set<string>(Object.values(DATABASE_ERROR_CODES));

/** 数据库错误码对应的安全默认文案。 */
const DATABASE_ERROR_MESSAGES: Record<DatabaseErrorCode, string> = {
  DATABASE_CONFIG_MISSING: "未配置 MYSQL_SOURCES_JSON",
  DATABASE_CONFIG_JSON_INVALID: "MYSQL_SOURCES_JSON 不是合法 JSON",
  DATABASE_CONFIG_NOT_ARRAY: "MYSQL_SOURCES_JSON 必须是数据源数组",
  DATABASE_CONFIG_SOURCE_INVALID: "MYSQL_SOURCES_JSON 含不完整的数据源配置",
  DATABASE_SOURCE_NAME_INVALID: "databaseName 不合法",
  DATABASE_SOURCE_NOT_FOUND: "databaseName 未映射到已配置的数据源",
  DATABASE_SOURCE_DEFAULT_UNAVAILABLE: "当前默认入口没有可用数据库源",
  DATABASE_SOURCE_AMBIGUOUS: "当前默认入口要求只能配置一个数据库源",
  DATABASE_IDENTIFIER_INVALID: "数据库标识符不合法",
  DATABASE_SYNC_ACCOUNT_NOT_READ_ONLY: "数据库同步账号包含写权限，拒绝同步",
  DATABASE_SNAPSHOT_NOT_FOUND: "数据库快照尚未同步",
  DATABASE_SNAPSHOT_INVALID: "数据库快照清单不合法或已损坏",
  DATABASE_SNAPSHOT_FILE_MISSING: "数据库快照本地文件缺失",
  DATABASE_QUERY_NOT_READ_ONLY: "数据库查询只允许单条只读 SELECT、JOIN 或聚合 SQL",
  DATABASE_QUERY_SYSTEM_ACCESS_FORBIDDEN: "数据库查询禁止访问系统表或跨快照名称",
  DATABASE_QUERY_TABLE_FORBIDDEN: "数据库查询只能访问当前快照允许的业务表",
  DATABASE_QUERY_TIMEOUT: "数据库查询超过 10 秒限制",
  DATABASE_CONNECTION_AUTHENTICATION_FAILED: "数据库连接认证失败",
  DATABASE_CONNECTION_TIMEOUT: "数据库连接超时",
  DATABASE_CONNECTION_FAILED: "数据库连接失败",
  DATABASE_INSPECTION_FAILED: "数据库检查失败",
  DATABASE_SYNC_FAILED: "数据库快照同步失败",
  DATABASE_SEMANTIC_SEARCH_FAILED: "数据库语义检索失败",
  DATABASE_QUERY_FAILED: "数据库只读查询执行失败",
  DATABASE_SEARCH_FAILED: "数据库检索失败",
};

/** 携带稳定 code 与底层 cause 的数据库统一错误。 */
export class DatabaseError extends Error {
  constructor(
    public readonly code: DatabaseErrorCode,
    message: string = DATABASE_ERROR_MESSAGES[code],
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DatabaseError";
  }
}

/** 跨 CJS/ESM 或开发态模块实例安全识别数据库错误码。 */
export function readDatabaseErrorCode(error: unknown): DatabaseErrorCode | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && DATABASE_ERROR_CODE_SET.has(code) ? code as DatabaseErrorCode : undefined;
}

/** 构造已知数据库错误。 */
export function createDatabaseError(code: DatabaseErrorCode, cause?: unknown): DatabaseError {
  return new DatabaseError(code, DATABASE_ERROR_MESSAGES[code], cause);
}

/** 将未知底层异常收敛为当前操作对应的数据库错误，同时保留已知精确错误码。 */
export function toDatabaseError(error: unknown, fallbackCode: DatabaseErrorCode): DatabaseError {
  if (error instanceof DatabaseError) return error;
  const code = readDatabaseErrorCode(error);
  if (code) return createDatabaseError(code, error);
  const causeCode = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (causeCode === "ER_ACCESS_DENIED_ERROR" || causeCode === "ER_DBACCESS_DENIED_ERROR") return createDatabaseError(DATABASE_ERROR_CODES.CONNECTION_AUTHENTICATION_FAILED, error);
  if (causeCode === "ETIMEDOUT" || causeCode === "PROTOCOL_SEQUENCE_TIMEOUT") return createDatabaseError(DATABASE_ERROR_CODES.CONNECTION_TIMEOUT, error);
  if (causeCode === "ECONNREFUSED" || causeCode === "ECONNRESET" || causeCode === "ENOTFOUND" || causeCode === "PROTOCOL_CONNECTION_LOST") return createDatabaseError(DATABASE_ERROR_CODES.CONNECTION_FAILED, error);
  if (causeCode === "ENOENT") return createDatabaseError(DATABASE_ERROR_CODES.SNAPSHOT_FILE_MISSING, error);
  return createDatabaseError(fallbackCode, error);
}
