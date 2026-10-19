/** Chat Node 存储装配：复用共享 durable Ports，以独立根和附件删除屏障隔离 Work。 */
import type { RuntimePorts } from "@autopilot-agent/core";
import { createNodeRuntimePorts } from "./create-node-runtime-ports";
import { initializeNodeChatDirectories, resolveNodeChatStatePaths } from "./chat-state";
import { initializeNodeStateRoot } from "./state-root";
import { createNodeChatAttachmentStore, type NodeChatAttachmentStoreOptions } from "./stores/node-chat-attachment-store";

/** 仅接受宿主用户环境与解析端口，不接受工作区参数。 */
export interface CreateNodeChatStorageOptions {
  globalStateRoot?: string;
  env?: NodeJS.ProcessEnv;
  userSettingsPath?: string;
  now?: () => number;
  parseDocument?: NodeChatAttachmentStoreOptions["parseDocument"];
}

/** 创建可交给 Runtime 的 Chat Ports；维护循环由 Host 生命周期显式启动和停止。 */
export function createNodeChatStorage(options: CreateNodeChatStorageOptions = {}) {
  const paths = resolveNodeChatStatePaths(options);
  initializeNodeChatDirectories(paths);
  initializeNodeStateRoot(paths.stateRoot);
  const base = createNodeRuntimePorts({ stateRoot: paths.stateRoot, productMode: "chat", env: options.env, userSettingsPath: options.userSettingsPath });
  const attachments = createNodeChatAttachmentStore({ paths, sessionStore: base.sessionStore, now: options.now, parseDocument: options.parseDocument });
  const ports: RuntimePorts = {
    ...base,
    clock: options.now ? {
      now: options.now,
      /** 所有宿主时间投影使用同一个可注入时钟。 */
      timestamp() { return new Date(options.now!()).toISOString(); },
    } : base.clock,
    sessionResourceStore: attachments,
    sessionStore: {
      ...base.sessionStore,
      /** 过期引用在读取投影时立即隐藏，不等待下一轮维护。 */
      async get(id) { const session = await base.sessionStore.get(id); return session ? attachments.sanitizeSession(session) : null; },
      /** 会话列表同样不返回已失效的附件元数据。 */
      async list() { return (await base.sessionStore.list()).map(attachments.sanitizeSession); },
      /** 会话保存与删除互斥，旧投影不能重新写入已退休引用。 */
      async save(session) {
        /** 在删除屏障内执行原有身份校验和原子写入。 */
        return attachments.withActiveSession(session.id, function saveActiveSession() { return base.sessionStore.save(attachments.sanitizeSession(session)); });
      },
    },
    turnStore: {
      ...base.turnStore,
      /** 在删除屏障内创建/更新 Turn，拒绝删除期间的新任务记录。 */
      async save(turn) {
        /** 与附件清理共享跨进程锁，关闭检查与写入之间的竞态。 */
        return attachments.withActiveSession(turn.sessionId, function saveActiveTurn() { return base.turnStore.save(turn); });
      },
    },
  };
  return { paths, ports, attachments };
}

export type NodeChatStorage = ReturnType<typeof createNodeChatStorage>;
