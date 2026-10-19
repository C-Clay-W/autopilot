/**
 * RAG 存储布局解析器。
 *
 * 将向量、原始来源、临时渲染、缓存和资源 manifest 收敛到同一个显式根目录，
 * 使 Web 可以按受信 Workspace 注入隔离目录，同时保留旧调用的兼容默认值。
 */
import path from "node:path";

/** 调用方可注入的 RAG 存储根；正式 Workspace 路径必须显式传入 rootPath。 */
export interface RagStorageOptions {
  rootPath?: string;
}

/** Core 内部使用的完整 RAG 存储布局。 */
export interface ResolvedRagStorage {
  rootPath: string;
  vectorPath: string;
  sourcePath: string;
  cachePath: string;
  manifestPath: string;
  lexicalPath: string;
  tempPath: string;
}

/** 解析并返回同根、互不重叠的 RAG 存储目录。 */
export function resolveRagStorage(options: RagStorageOptions = {}): ResolvedRagStorage {
  const legacyRoot = process.env.RAG_STORAGE_PATH?.trim()
    || (process.env.LANCE_DB_PATH ? path.dirname(path.resolve(process.env.LANCE_DB_PATH)) : "")
    || path.resolve(process.cwd(), ".autopilot-rag");
  const rootPath = path.resolve(options.rootPath?.trim() || legacyRoot);
  return {
    rootPath,
    vectorPath: options.rootPath ? path.join(rootPath, "vectors") : path.resolve(process.env.LANCE_DB_PATH || path.join(rootPath, "vectors")),
    sourcePath: options.rootPath ? path.join(rootPath, "sources") : path.resolve(process.env.RAG_FILE_STORAGE_PATH || path.join(rootPath, "sources")),
    cachePath: path.join(rootPath, "cache"),
    manifestPath: path.join(rootPath, "resources"),
    lexicalPath: path.join(rootPath, "lexical"),
    tempPath: path.join(rootPath, "tmp"),
  };
}
