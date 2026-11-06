/** Work 会话图片的受信存储端口，按工作区及会话绑定访问。 */

/** 不可变发送副本的安全元数据。 */
export interface SessionImageRef {
  id: string;
  name: string;
  mimeType: string;
  relativePath: string;
  sha256: string;
  width: number;
  height: number;
  bytes: number;
  gifFirstFrame: boolean;
}

/** 宿主负责规范化、持久化及每次读取时核验归属和哈希。 */
export interface SessionImageStore {
  put(input: { sessionId: string; name: string; mimeType?: string; bytes: Uint8Array }): Promise<SessionImageRef>;
  read(input: { sessionId: string; id: string }): Promise<{ image: SessionImageRef; bytes: Uint8Array }>;
}
