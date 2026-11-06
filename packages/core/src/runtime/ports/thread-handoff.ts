/**
 * runtime/ports/thread-handoff.ts — 显式任务交接的文档写入 Port
 *
 * Core 只定义最小契约和调用顺序，不直接做 Node 文件 IO；由受信宿主注入实现。
 * 路径、目录名和文件名均由宿主按受信工作区派生，模型与浏览器不能指定。
 */

/** 一次交接文档写入；同一 handoffId 的同内容写入必须幂等。 */
export interface ThreadHandoffDocumentInput {
  /** 受信工作区不透明身份；实现据此确认写入目录归属。 */
  workspaceId: string;
  /** 由宿主从发送幂等域派生的稳定标识。 */
  handoffId: string;
  /** 交接标题；已校验为单行且有界。 */
  title: string;
  /** 已规范化的有界交接摘要。 */
  markdown: string;
}

/** 交接文档的安全引用；不包含宿主绝对路径。 */
export interface ThreadHandoffDocument {
  handoffId: string;
  /** 工作区相对路径，供目标会话与人类核对。 */
  relativePath: string;
  /** 摘要文件校验和；回读时据此发现内容漂移。 */
  sha256: string;
}

/** 宿主装配的交接文档写入能力；未装配时协作服务明确返回不可用。 */
export interface ThreadHandoffWriter {
  /**
   * 原子写入固定相对路径：同 ID 同内容返回值不变，同 ID 不同内容必须失败，
   * 不得覆盖其他文件或越出授权工作区。
   */
  write(input: ThreadHandoffDocumentInput): Promise<ThreadHandoffDocument>;
}
