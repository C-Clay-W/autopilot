/** S3 无附件 smoke 的内存存储夹具：复用 Core ports，不创建目录或保存模型正文。 */
import { createMemoryPorts, type RuntimePorts } from "@autopilot-agent/core";
import { resolveNodeChatStatePaths, type NodeChatStorage } from "@autopilot-agent/adapters";

/** 为现有 Host 提供内存 ports；路径只作接口占位，附件和知识操作不在此 smoke 范围。 */
export function createS3MemoryChatStorage(globalStateRoot: string, credentialStore: RuntimePorts["credentialStore"]): NodeChatStorage {
  const ports = createMemoryPorts();
  ports.credentialStore = credentialStore;
  /** 无附件 smoke 不允许上传/读取，禁止回退磁盘。 */
  async function unavailable(): Promise<never> { throw new Error("S3_ATTACHMENTS_UNAVAILABLE"); }
  return {
    paths: resolveNodeChatStatePaths({ globalStateRoot }),
    ports,
    attachments: {
      put: unavailable,
      readAttachment: unavailable,
      readBytes: unavailable,
      /** 合成场景没有附件，目录为空。 */
      async list() { return []; },
      /** 无真实附件引用，始终拒绝授权。 */
      async authorizeRef() { return false; },
      /** 外围删除记录复用 Core 内存资源 store。 */
      async deleteBySession(sessionId) { await ports.sessionResourceStore!.deleteBySession(sessionId); },
      /** 无磁盘附件，无到期条目。 */
      async cleanupExpired() { return []; },
      /** 无定时任务或磁盘维护。 */
      async startMaintenance() {
        /** 空维护句柄仍遵守 Host 的停止契约。 */
        return function stop() {};
      },
      /** 无附件删除中间态。 */
      isSessionDeleting() { return false; },
      /** 无附件写入，直接执行同进程操作。 */
      async withActiveSession(_sessionId, operation) { return operation(); },
      /** 没有附件引用需要投影。 */
      sanitizeSession(session) { return session; },
    },
  };
}
